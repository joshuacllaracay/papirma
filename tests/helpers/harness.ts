import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { PDFDocument } from 'pdf-lib'
import type { Db, Queryable, Row } from '../../server/db.js'
import type { Deps } from '../../server/deps.js'
import type { ObjectStorage } from '../../server/storage.js'
import type { Mailer, OutgoingEmail } from '../../server/email.js'
import type { SenderAuth, SenderIdentity } from '../../server/auth.js'
import { handle } from '../../server/router.js'
import { WORKFLOW_VERSION } from '../../server/config.js'

export const APP_ORIGIN = 'https://papirma.test'

/** Minimal stand-ins for the Supabase-managed schemas the migration depends on. */
const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
`

const MIGRATIONS_DIR = new URL('../../supabase/migrations/', import.meta.url)
/** Every migration, applied in filename order — exactly what production runs. */
const MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))

export interface TestDb {
  pg: PGlite
  /** Runs as papirma_app — exactly the privileges production has. */
  app: Db
  /** Superuser, for test setup and for simulating out-of-band tampering. */
  admin: Queryable
  /** Run a query as a Supabase role (anon/authenticated) with an optional JWT subject. */
  asRole<T extends Row = Row>(role: 'anon' | 'authenticated', sub: string | null, text: string, params?: unknown[]): Promise<T[]>
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite()
  await pg.exec(SUPABASE_STUBS)
  for (const m of MIGRATIONS) await pg.exec(m)

  // PGlite is a single connection: switch role around each statement.
  let chain = Promise.resolve() as Promise<unknown>
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }
  const run = async <T extends Row>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows

  const admin: Queryable = {
    query: <T extends Row>(text: string, params?: unknown[]) => serial(() => run<T>(text, params)),
  }
  const app: Db = {
    query: <T extends Row>(text: string, params?: unknown[]) =>
      serial(async () => {
        await pg.exec('set role papirma_app')
        try { return await run<T>(text, params) } finally { await pg.exec('reset role') }
      }),
    tx: <T>(fn: (q: Queryable) => Promise<T>) =>
      serial(async () => {
        await pg.exec('set role papirma_app')
        try {
          return await pg.transaction(async (t) => fn({
            query: async <R extends Row>(text: string, params: unknown[] = []) => (await t.query<R>(text, params)).rows,
          }))
        } finally { await pg.exec('reset role') }
      }),
  }
  const asRole = <T extends Row>(role: 'anon' | 'authenticated', sub: string | null, text: string, params: unknown[] = []) =>
    serial(async () => {
      await pg.exec(`set role ${role}`)
      await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub ?? ''])
      try { return await run<T>(text, params) } finally {
        await pg.exec('reset role')
        await pg.query(`select set_config('request.jwt.claim.sub', '', false)`)
      }
    })
  return { pg, app, admin, asRole }
}

export class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>()
  issued: Array<{ kind: 'upload' | 'download'; path: string }> = []
  failPut = false
  async createUploadUrl(path: string) {
    this.issued.push({ kind: 'upload', path })
    return `memory://upload/${encodeURIComponent(path)}?sig=${randomUUID()}`
  }
  async createDownloadUrl(path: string) {
    this.issued.push({ kind: 'download', path })
    return `memory://download/${encodeURIComponent(path)}?sig=${randomUUID()}`
  }
  async get(path: string) { return this.objects.get(path) ?? null }
  async put(path: string, bytes: Uint8Array) {
    if (this.failPut) throw new Error('simulated storage failure')
    if (this.objects.has(path)) throw new Error('object exists')
    this.objects.set(path, bytes)
  }
  async remove(path: string) { this.objects.delete(path) }
  /** What a browser PUT to the signed upload URL would do. */
  simulateClientUpload(path: string, bytes: Uint8Array) { this.objects.set(path, bytes) }
}

export class FakeMailer implements Mailer {
  outbox: OutgoingEmail[] = []
  fail = false
  async send(email: OutgoingEmail) {
    if (this.fail) throw new Error('simulated email failure')
    this.outbox.push(email)
  }
}

export class FakeAuth implements SenderAuth {
  users = new Map<string, SenderIdentity>()
  async verify(token: string) { return this.users.get(token) ?? null }
}

export interface InvitationResult {
  invitationId: string
  email: string
  mode: string
  expiresAt: string
  emailSent: boolean
  password: string
}

export interface Harness {
  db: TestDb
  storage: MemoryStorage
  mailer: FakeMailer
  auth: FakeAuth
  deps: Deps
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are inspected loosely
  call(method: string, path: string, opts?: { body?: unknown; bearer?: string; cookie?: string; origin?: string | null; ip?: string; rawBody?: string }): Promise<{ status: number; body: Record<string, any>; headers: Headers }>
  createSender(opts?: { plan?: 'free' | 'pro'; name?: string }): Promise<{ id: string; email: string; bearer: string }>
  uploadDocument(sender: { bearer: string }, pdf?: Uint8Array, title?: string): Promise<{ documentId: string; versionId: string; sha256: string }>
  invite(sender: { bearer: string }, versionId: string, recipients: Array<{ email: string; mode: string; password?: string }>): Promise<InvitationResult[]>
}

export async function createHarness(): Promise<Harness> {
  const db = await createTestDb()
  const storage = new MemoryStorage()
  const mailer = new FakeMailer()
  const auth = new FakeAuth()
  const deps: Deps = {
    db: db.app, storage, mailer, auth,
    config: { appOrigin: APP_ORIGIN, ipHmacKey: 'test-ip-hmac-key-0123456789abcdef0123', cronSecret: 'test-cron-secret-0123456789abcdef01234', workflowVersion: WORKFLOW_VERSION },
  }

  const call: Harness['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? '203.0.113.10', 'user-agent': 'vitest' }
    if (opts.origin !== null) headers.origin = opts.origin ?? APP_ORIGIN
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
    if (opts.cookie) headers.cookie = opts.cookie
    let body: string | undefined
    if (opts.rawBody !== undefined || opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = opts.rawBody ?? JSON.stringify(opts.body)
    }
    const res = await handle(new Request(`${APP_ORIGIN}/api/${path}`, { method, headers, body }), deps)
    return { status: res.status, body: await res.json(), headers: res.headers }
  }

  const createSender: Harness['createSender'] = async ({ plan = 'pro', name } = {}) => {
    const id = randomUUID()
    const email = `sender-${id.slice(0, 8)}@example.com`
    const bearer = `test-token-${randomUUID()}`
    await db.admin.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email])
    auth.users.set(bearer, { userId: id, email })
    await call('GET', 'me', { bearer })
    await db.admin.query(`update public.profiles set plan = $2, display_name = coalesce($3, display_name) where id = $1`, [id, plan, name ?? null])
    return { id, email, bearer }
  }

  const uploadDocument: Harness['uploadDocument'] = async (sender, pdf, title = 'Service Agreement') => {
    const created = await call('POST', 'documents', { bearer: sender.bearer, body: { title } })
    if (created.status !== 201) throw new Error(`create failed ${created.status} ${JSON.stringify(created.body)}`)
    const path = storage.issued.at(-1)!.path
    storage.simulateClientUpload(path, pdf ?? (await makePdf()))
    const fin = await call('POST', `document-versions/${created.body.versionId}/finalize`, { bearer: sender.bearer })
    if (fin.status !== 200) throw new Error(`finalize failed ${fin.status} ${JSON.stringify(fin.body)}`)
    return { documentId: created.body.documentId, versionId: created.body.versionId, sha256: fin.body.sha256 }
  }

  const invite: Harness['invite'] = async (sender, versionId, recipients) => {
    const r = await call('POST', 'invitations', { bearer: sender.bearer, body: { documentVersionId: versionId, recipients } })
    if (r.status !== 201) throw new Error(`invite failed ${r.status} ${JSON.stringify(r.body)}`)
    return r.body.invitations
  }

  return { db, storage, mailer, auth, deps, call, createSender, uploadDocument, invite }
}

export async function makePdf(pages = 1, text = 'Hello'): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`${text} ${i + 1}`, { x: 50, y: 700 })
  return doc.save()
}

/** Pull the token out of the most recent invitation email sent to `to`. */
export function tokenFromEmail(mailer: FakeMailer, to: string): string {
  const mail = [...mailer.outbox].reverse().find((m) => m.to === to)
  if (!mail) throw new Error(`no email to ${to}`)
  const m = /#t=([A-Za-z0-9_-]{43})/.exec(mail.text)
  if (!m) throw new Error('no token in email')
  return m[1]
}

export function cookieFrom(headers: Headers): string {
  const set = headers.get('set-cookie')
  if (!set) throw new Error('no set-cookie')
  return set.split(';')[0]
}
