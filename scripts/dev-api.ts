/**
 * LOCAL DEVELOPMENT ONLY — never deployed (it isn't under /api).
 *
 * Runs the real API router against an in-process Postgres (PGlite) with the real
 * migration, plus local stand-ins for Supabase Auth, Storage and email:
 *   • sign in with any email (no password) — made Pro automatically, unless the
 *     address contains "+free@" (e.g. you+free@example.com), to test the free-plan flow
 *   • files are kept in memory and served through short-lived signed URLs
 *   • emails are printed here and listed at http://localhost:5173/__dev/mail
 *
 * Start with `npm run dev:api` (and `npm run dev` for the UI). Data resets on restart.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { handle } from '../server/router.js'
import { WORKFLOW_VERSION } from '../server/config.js'
import type { Deps } from '../server/deps.js'
import type { OutgoingEmail } from '../server/email.js'
import { createTestDb } from '../tests/helpers/harness.js'

const PORT = 8787
const APP_ORIGIN = 'http://localhost:5173'
const SIGN_KEY = randomUUID()

const sign = (kind: string, path: string, exp: number) =>
  createHmac('sha256', SIGN_KEY).update(`${kind}|${path}|${exp}`).digest('base64url')

const files = new Map<string, Uint8Array>()
const outbox: Array<OutgoingEmail & { at: string }> = []

async function main() {
  const db = await createTestDb()

  const deps: Deps = {
    db: db.app,
    config: { appOrigin: APP_ORIGIN, ipHmacKey: randomUUID() + randomUUID(), cronSecret: randomUUID() + randomUUID(), workflowVersion: WORKFLOW_VERSION },
    auth: {
      // Dev tokens are "devtoken.<base64url(email)>" — accepted only by this local server.
      async verify(token) {
        const m = /^devtoken\.([A-Za-z0-9_-]+)$/.exec(token)
        if (!m) return null
        const email = Buffer.from(m[1], 'base64url').toString('utf8').toLowerCase()
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) return null
        const id = createHmac('sha256', 'dev-user').update(email).digest('hex')
        const userId = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`
        await db.admin.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, email])
        await db.admin.query(
          `insert into public.profiles (id, display_name, plan) values ($1, $2, $3) on conflict (id) do nothing`,
          [userId, email.split('@')[0], email.includes('+free@') ? 'free' : 'pro'])
        return { userId, email }
      },
    },
    storage: {
      async createUploadUrl(path) {
        const exp = Date.now() + 10 * 60_000
        return `${APP_ORIGIN}/__dev/storage?op=upload&path=${encodeURIComponent(path)}&exp=${exp}&sig=${sign('upload', path, exp)}`
      },
      async createDownloadUrl(path, ttlSec) {
        const exp = Date.now() + ttlSec * 1000
        return `${APP_ORIGIN}/__dev/storage?op=download&path=${encodeURIComponent(path)}&exp=${exp}&sig=${sign('download', path, exp)}`
      },
      async get(path) { return files.get(path) ?? null },
      async put(path, bytes) {
        if (files.has(path)) throw new Error('object exists')
        files.set(path, bytes)
      },
      async remove(path) { files.delete(path) },
    },
    mailer: {
      async send(email) {
        outbox.unshift({ ...email, at: new Date().toISOString() })
        console.log(`\n📧 email to ${email.to}: ${email.subject}\n${email.text}\n`)
      },
    },
  }

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > 30 * 1024 * 1024) reject(new Error('too large'))
        else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  const send = (res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string> = {}) => {
    res.writeHead(status, headers)
    res.end(body)
  }

  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', APP_ORIGIN)

      if (url.pathname === '/__dev/storage') {
        const op = url.searchParams.get('op')!
        const path = url.searchParams.get('path') ?? ''
        const exp = Number(url.searchParams.get('exp'))
        if (!(exp > Date.now()) || url.searchParams.get('sig') !== sign(op, path, exp)) return send(res, 403, 'expired or invalid signature')
        if (op === 'upload' && req.method === 'PUT') {
          if (files.has(path)) return send(res, 409, 'exists')
          files.set(path, new Uint8Array(await readBody(req)))
          return send(res, 200, '{}', { 'content-type': 'application/json' })
        }
        if (op === 'download' && req.method === 'GET') {
          const f = files.get(path)
          return f ? send(res, 200, f, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="document.pdf"' }) : send(res, 404, 'missing')
        }
        return send(res, 405, 'method not allowed')
      }

      if (url.pathname === '/__dev/mail') {
        const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
        const items = outbox.map((m) => `<article style="border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:12px 0">
          <div style="color:#64748b;font-size:12px">${esc(m.at)} · to <b>${esc(m.to)}</b></div>
          <h3 style="margin:6px 0">${esc(m.subject)}</h3>${m.html.replace(/^<!doctype html><html><body[^>]*>|<\/body><\/html>$/g, '')}</article>`).join('')
        return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Dev mailbox</title>
          <body style="font-family:system-ui;max-width:720px;margin:24px auto;padding:0 16px">
          <h1>📬 Dev mailbox</h1><p style="color:#64748b">Local development only. Newest first. Refresh to update.</p>${items || '<p>No emails yet.</p>'}</body>`,
          { 'content-type': 'text/html; charset=utf-8' })
      }

      if (url.pathname.startsWith('/api/')) {
        const body = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : await readBody(req)
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
        headers.set('x-forwarded-for', req.socket.remoteAddress ?? '127.0.0.1')
        const response = await handle(new Request(url, { method: req.method, headers, body }), deps)
        const out: Record<string, string> = {}
        response.headers.forEach((v, k) => { out[k] = v })
        return send(res, response.status, Buffer.from(await response.arrayBuffer()), out)
      }
      send(res, 404, 'not found')
    } catch (err) {
      console.error('dev-api error', err instanceof Error ? err.name : err)
      send(res, 500, 'dev server error')
    }
  }).listen(PORT, () => {
    console.log(`PirmaNest dev API on http://localhost:${PORT} (proxied from ${APP_ORIGIN}/api)`)
    console.log(`Dev mailbox: ${APP_ORIGIN}/__dev/mail`)
  })
}

main()
