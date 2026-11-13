import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness, cookieFrom, tokenFromEmail, type Harness } from '../helpers/harness.js'

/**
 * T-23 accidental exposure of credentials or tokens. Runs a realistic flow, then
 * searches every table, every email, every recipient-facing response and every
 * log line for the secrets involved.
 */
describe('T-23 secrets never leak', () => {
  let h: Harness
  const logs: string[] = []
  const secrets: string[] = []
  const recipientResponses: string[] = []

  beforeAll(async () => {
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map((x) => JSON.stringify(x)).join(' ')) })
    }
    h = await createHarness()
    const a = await h.createSender()
    const doc = await h.uploadDocument(a)
    const custom = 'harbor-violet-quasar-58#'
    const [gen, chosen] = await h.invite(a, doc.versionId, [
      { email: 'gen@example.com', mode: 'password' },
      { email: 'chosen@example.com', mode: 'password', password: custom },
    ])
    const genToken = tokenFromEmail(h.mailer, 'gen@example.com')
    const chosenToken = tokenFromEmail(h.mailer, 'chosen@example.com')
    secrets.push(gen.password, gen.password.replace(/-/g, ''), custom, genToken, chosenToken)

    const record = (r: { body: unknown; headers: Headers }) => {
      recipientResponses.push(JSON.stringify(r.body))
      return r
    }
    record(await h.call('POST', 'r/open', { body: { token: genToken } }))
    record(await h.call('POST', 'r/verify-password', { body: { token: genToken, password: 'a-wrong-password-attempt' } }))
    const ok = record(await h.call('POST', 'r/verify-password', { body: { token: genToken, password: gen.password } }))
    const cookie = cookieFrom(ok.headers)
    secrets.push(cookie.split('=')[1])
    record(await h.call('GET', 'r/document', { cookie }))
    record(await h.call('POST', 'r/verify-password', { body: { token: chosenToken, password: custom } }))
    secrets.push('a-wrong-password-attempt')
    // a deliberately broken request still must not echo the password
    record(await h.call('POST', 'r/verify-password', { body: { token: genToken, password: gen.password, extra: 1 } }))
    expect(chosen.password).toBeUndefined()
  })

  afterAll(() => vi.restoreAllMocks())

  it('no table contains a password, token or session cookie in plaintext', async () => {
    const tables = await h.db.admin.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public'`)
    for (const { tablename } of tables) {
      const rows = JSON.stringify(await h.db.admin.query(`select * from public.${tablename}`))
      for (const s of secrets) expect(rows, `${tablename} leaks a secret`).not.toContain(s)
    }
  })

  it('no email contains a password or session value', () => {
    const mail = JSON.stringify(h.mailer.outbox)
    for (const s of secrets.filter((x) => !/^[A-Za-z0-9_-]{43}$/.test(x) || !mail.includes(`#t=${x}`))) {
      // invitation tokens legitimately appear in their own link; nothing else may
      expect(mail).not.toContain(s)
    }
  })

  it('recipient-facing responses never contain passwords or tokens', () => {
    const all = recipientResponses.join('\n')
    for (const s of secrets) expect(all).not.toContain(s)
  })

  it('logs never contain secrets', () => {
    const all = logs.join('\n')
    for (const s of secrets) expect(all).not.toContain(s)
  })
})
