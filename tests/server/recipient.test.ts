import { randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { createHarness, cookieFrom, tokenFromEmail, makePdf, type Harness } from '../helpers/harness.js'
import { ageInvitation } from '../helpers/time.js'

let ipCounter = 1
/** Fresh client IP per test so per-IP throttles don't bleed between tests. */
const freshIp = () => `198.51.100.${ipCounter++}`
const randomTokenShape = () => randomBytes(32).toString('base64url')

describe('recipient access', () => {
  let h: Harness
  let a: Awaited<ReturnType<Harness['createSender']>>
  let doc: Awaited<ReturnType<Harness['uploadDocument']>>
  let n = 0

  beforeAll(async () => {
    h = await createHarness()
    a = await h.createSender({ name: 'Alice' })
    doc = await h.uploadDocument(a, await makePdf(1, 'Contract A'), 'Contract A')
  })

  const invite = async (mode: 'link' | 'password') => {
    const email = `r${n++}@example.com`
    const [inv] = await h.invite(a, doc.versionId, [{ email, mode }])
    return { ...inv, email, token: tokenFromEmail(h.mailer, email) }
  }

  it('Mode A: the link opens a session and the intended PDF only', async () => {
    const inv = await invite('link')
    const open = await h.call('POST', 'r/open', { body: { token: inv.token } })
    expect(open.body).toMatchObject({ state: 'verified', mode: 'link', senderName: 'Alice' })
    const setCookie = open.headers.get('set-cookie')!
    expect(setCookie).toMatch(/^__Host-papirma_rs=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict/)
    const docRes = await h.call('GET', 'r/document', { cookie: cookieFrom(open.headers) })
    expect(docRes.status).toBe(200)
    expect(docRes.body).toMatchObject({ title: 'Contract A', pageCount: 1, sha256: doc.sha256, urlExpiresInSec: 60 })
    expect(h.storage.issued.at(-1)).toMatchObject({ kind: 'download' })
  })

  it('reveals nothing about the document before verification', async () => {
    const inv = await invite('password')
    const open = await h.call('POST', 'r/open', { body: { token: inv.token } })
    expect(open.body.state).toBe('password_required')
    expect(open.headers.get('set-cookie')).toBeNull()
    expect(JSON.stringify(open.body)).not.toMatch(/Contract A|sha256|url/)
  })

  it('unknown or malformed tokens get a generic answer', async () => {
    expect((await h.call('POST', 'r/open', { body: { token: randomTokenShape() } })).body).toEqual({ state: 'invalid' })
    expect((await h.call('POST', 'r/open', { body: { token: '../../etc/passwd' } })).status).toBe(400)
  })

  describe('T-01 / T-02 / T-03 password protection', () => {
    it('T-01 wrong password: generic 401, failure recorded without the password', async () => {
      const inv = await invite('password')
      const r = await h.call('POST', 'r/verify-password', { ip: freshIp(), body: { token: inv.token, password: 'definitely-wrong-guess' } })
      expect(r.status).toBe(401)
      expect(r.body).toEqual({ error: 'invalid_credentials' })
      const [row] = await h.db.admin.query<{ failed_attempts: number }>(`select failed_attempts from public.invitations where id = $1`, [inv.invitationId])
      expect(row.failed_attempts).toBe(1)
      const audit = JSON.stringify(await h.db.admin.query(`select * from public.audit_events where invitation_id = $1`, [inv.invitationId]))
      expect(audit).toContain('password_failed')
      expect(audit).not.toContain('definitely-wrong-guess')
    })

    it('accepts the generated password with or without hyphens, any case', async () => {
      const inv = await invite('password')
      const loose = inv.password.replace(/-/g, '').toLowerCase()
      const r = await h.call('POST', 'r/verify-password', { ip: freshIp(), body: { token: inv.token, password: loose } })
      expect(r.status).toBe(200)
      expect(r.body.state).toBe('verified')
    })

    it('T-02 locks after 5 failures — even the right password is refused until the lock expires', async () => {
      const inv = await invite('password')
      const ip = freshIp()
      for (let i = 0; i < 4; i++) {
        expect((await h.call('POST', 'r/verify-password', { ip, body: { token: inv.token, password: `wrong-${i}` } })).status).toBe(401)
      }
      const fifth = await h.call('POST', 'r/verify-password', { ip, body: { token: inv.token, password: 'wrong-4' } })
      expect(fifth.status).toBe(429)
      expect(fifth.body.error).toBe('locked')
      expect(fifth.body.retryAfterSec).toBeGreaterThan(14 * 60)
      const right = await h.call('POST', 'r/verify-password', { ip, body: { token: inv.token, password: inv.password } })
      expect(right.status).toBe(429)
      expect((await h.call('POST', 'r/open', { body: { token: inv.token } })).body.locked).toBe(true)
      // lock expires
      await h.db.admin.query(`update public.invitations set locked_until = now() - interval '1 second' where id = $1`, [inv.invitationId])
      expect((await h.call('POST', 'r/verify-password', { ip, body: { token: inv.token, password: inv.password } })).status).toBe(200)
    })

    it('T-02 lockouts escalate; after 15 failures only the sender can unlock (by resetting)', async () => {
      const inv = await invite('password')
      const ip = freshIp()
      await h.db.admin.query(`update public.invitations set total_failed = 14, failed_attempts = 4 where id = $1`, [inv.invitationId])
      const r = await h.call('POST', 'r/verify-password', { ip, body: { token: inv.token, password: 'wrong-again' } })
      expect(r.status).toBe(429)
      expect(r.body.retryAfterSec).toBeGreaterThan(300 * 24 * 3600) // effectively permanent
      const reset = await h.call('POST', `invitations/${inv.invitationId}/reset-password`, { bearer: a.bearer, body: {} })
      expect((await h.call('POST', 'r/verify-password', { ip, body: { token: inv.token, password: reset.body.password } })).status).toBe(200)
    })

    it('T-03 throttles one client guessing across many invitations', async () => {
      const ip = freshIp()
      for (let i = 0; i < 30; i++) {
        await h.call('POST', 'r/verify-password', { ip, body: { token: randomTokenShape(), password: 'guess' } })
      }
      const inv = await invite('password')
      const blocked = await h.call('POST', 'r/verify-password', { ip, body: { token: inv.token, password: inv.password } })
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBe('3600')
      // a different client is unaffected
      expect((await h.call('POST', 'r/verify-password', { ip: freshIp(), body: { token: inv.token, password: inv.password } })).status).toBe(200)
    }, 60_000)
  })

  it('T-08 expired links: no session, no document', async () => {
    const inv = await invite('link')
    await ageInvitation(h.db.admin, inv.invitationId, 8)
    const open = await h.call('POST', 'r/open', { body: { token: inv.token } })
    expect(open.body).toEqual({ state: 'expired' })
    expect(open.headers.get('set-cookie')).toBeNull()
    const pw = await invite('password')
    await ageInvitation(h.db.admin, pw.invitationId, 8)
    expect((await h.call('POST', 'r/verify-password', { ip: freshIp(), body: { token: pw.token, password: pw.password } })).status).toBe(401)
  })

  it('T-08 an open session stops working once the invitation expires', async () => {
    const inv = await invite('link')
    const cookie = cookieFrom((await h.call('POST', 'r/open', { body: { token: inv.token } })).headers)
    await ageInvitation(h.db.admin, inv.invitationId, 8)
    expect((await h.call('GET', 'r/document', { cookie })).status).toBe(410)
  })

  it('T-09 revoked links, including revocation in the middle of a session', async () => {
    const inv = await invite('link')
    const cookie = cookieFrom((await h.call('POST', 'r/open', { body: { token: inv.token } })).headers)
    expect((await h.call('GET', 'r/document', { cookie })).status).toBe(200)
    await h.call('POST', `invitations/${inv.invitationId}/revoke`, { bearer: a.bearer, body: { reason: 'sent to wrong person' } })
    expect((await h.call('GET', 'r/document', { cookie })).status).toBe(401)
    expect((await h.call('POST', 'r/open', { body: { token: inv.token } })).body).toEqual({ state: 'revoked' })
  })

  it('T-10 a recipient session only ever reaches its own invitation’s document', async () => {
    const b = await h.createSender({ name: 'Bob' })
    const docB = await h.uploadDocument(b, await makePdf(3, 'Secret B'), 'Secret B')
    const [invB] = await h.invite(b, docB.versionId, [{ email: 'victim@example.com', mode: 'link' }])
    const inv = await invite('link')
    const cookie = cookieFrom((await h.call('POST', 'r/open', { body: { token: inv.token } })).headers)
    // try to smuggle the other invitation / version / document ids every way we can
    for (const q of [`?invitationId=${invB.invitationId}`, `?documentVersionId=${docB.versionId}`, `?documentId=${docB.documentId}`]) {
      const r = await h.call('GET', `r/document${q}`, { cookie })
      expect(r.body.sha256).toBe(doc.sha256)
      expect(r.body.title).toBe('Contract A')
    }
    const forged = await h.call('GET', 'r/document', { cookie: `${cookie}; __Host-papirma_rs=${randomTokenShape()}` })
    expect(forged.body.sha256 ?? doc.sha256).toBe(doc.sha256)
  })

  it('T-12 no document without a valid session', async () => {
    expect((await h.call('GET', 'r/document')).status).toBe(401)
    expect((await h.call('GET', 'r/document', { cookie: `__Host-papirma_rs=${randomTokenShape()}` })).status).toBe(401)
    expect((await h.call('GET', 'r/document', { cookie: '__Host-papirma_rs=not-a-token' })).status).toBe(401)
    const inv = await invite('link')
    const cookie = cookieFrom((await h.call('POST', 'r/open', { body: { token: inv.token } })).headers)
    await h.db.admin.query(`update public.recipient_sessions set expires_at = now() - interval '1 second' where invitation_id = $1`, [inv.invitationId])
    expect((await h.call('GET', 'r/document', { cookie })).status).toBe(401)
  })

  it('logout ends the session', async () => {
    const inv = await invite('link')
    const cookie = cookieFrom((await h.call('POST', 'r/open', { body: { token: inv.token } })).headers)
    const out = await h.call('POST', 'r/logout', { cookie })
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await h.call('GET', 'r/document', { cookie })).status).toBe(401)
  })

  it('T-13 a completed invitation’s token cannot start a new signing session', async () => {
    const inv = await invite('link')
    const cookie = cookieFrom((await h.call('POST', 'r/open', { body: { token: inv.token } })).headers)
    await h.db.admin.query(`update public.invitations set status = 'completing' where id = $1`, [inv.invitationId])
    await h.db.admin.query(`update public.invitations set status = 'completed' where id = $1`, [inv.invitationId])
    const again = await h.call('POST', 'r/open', { body: { token: inv.token } })
    expect(again.body).toEqual({ state: 'completed' })
    expect(again.headers.get('set-cookie')).toBeNull()
    expect((await h.call('GET', 'r/document', { cookie })).status).toBe(410)
  })

  describe('T-22 security mode cannot be bypassed from the client', () => {
    it('a password-protected link never yields a session from open', async () => {
      const inv = await invite('password')
      const r = await h.call('POST', 'r/open', { body: { token: inv.token } })
      expect(r.headers.get('set-cookie')).toBeNull()
      const smuggled = await h.call('POST', 'r/open', { body: { token: inv.token, mode: 'link' } })
      expect(smuggled.status).toBe(400)
    })

    it('a link-mode token is not accepted by password verification', async () => {
      const inv = await invite('link')
      const r = await h.call('POST', 'r/verify-password', { ip: freshIp(), body: { token: inv.token, password: 'anything-at-all' } })
      expect(r.status).toBe(401)
    })
  })

  it('T-28 rejects cross-site requests (Origin check)', async () => {
    const inv = await invite('link')
    expect((await h.call('POST', 'r/open', { origin: 'https://evil.example', body: { token: inv.token } })).status).toBe(403)
    expect((await h.call('POST', 'r/open', { origin: null, body: { token: inv.token } })).status).toBe(403)
    expect((await h.call('POST', 'r/verify-password', { origin: 'https://evil.example', body: { token: inv.token, password: 'x' } })).status).toBe(403)
  })

  it('throttles link opening per client', async () => {
    const ip = freshIp()
    let last = 0
    for (let i = 0; i < 121; i++) last = (await h.call('POST', 'r/open', { ip, body: { token: randomTokenShape() } })).status
    expect(last).toBe(429)
  }, 60_000)

  it('cleanup job expires stale invitations and requires its secret', async () => {
    const inv = await invite('link')
    await ageInvitation(h.db.admin, inv.invitationId, 8)
    expect((await h.call('GET', 'cron/cleanup')).status).toBe(401)
    const r = await h.call('GET', 'cron/cleanup', { bearer: 'test-cron-secret-0123456789abcdef01234' })
    expect(r.status).toBe(200)
    expect(r.body.expiredInvitations).toBeGreaterThanOrEqual(1)
    const [row] = await h.db.admin.query<{ status: string }>(`select status from public.invitations where id = $1`, [inv.invitationId])
    expect(row.status).toBe('expired')
  })
})
