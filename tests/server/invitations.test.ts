import { beforeAll, describe, expect, it } from 'vitest'
import { createHarness, tokenFromEmail, type Harness } from '../helpers/harness.js'

describe('invitations', () => {
  let h: Harness
  let a: Awaited<ReturnType<Harness['createSender']>>
  let doc: Awaited<ReturnType<Harness['uploadDocument']>>

  beforeAll(async () => {
    h = await createHarness()
    a = await h.createSender({ name: 'Alice Santos' })
    doc = await h.uploadDocument(a)
  })

  it('sends one unique link per recipient; tokens are stored only as hashes', async () => {
    const invs = await h.invite(a, doc.versionId, [
      { email: 'Ana@Example.com', mode: 'link' },
      { email: 'ben@example.com', mode: 'link' },
    ])
    expect(invs.map((i) => i.email)).toEqual(['ana@example.com', 'ben@example.com'])
    const t1 = tokenFromEmail(h.mailer, 'ana@example.com')
    const t2 = tokenFromEmail(h.mailer, 'ben@example.com')
    expect(t1).not.toBe(t2)
    const dump = JSON.stringify(await h.db.admin.query(`select * from public.invitations`))
    expect(dump).not.toContain(t1)
    expect(dump).not.toContain(t2)
  })

  it('expires 7 days after creation (server time)', async () => {
    const [inv] = await h.invite(a, doc.versionId, [{ email: 'exp@example.com', mode: 'link' }])
    const days = (new Date(inv.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.99)
    expect(days).toBeLessThanOrEqual(7)
  })

  it('Mode A emails warn that the link alone gives access', async () => {
    await h.invite(a, doc.versionId, [{ email: 'warn@example.com', mode: 'link' }])
    expect(h.mailer.outbox.at(-1)!.text).toMatch(/Anyone with this link can open the document/)
  })

  describe('Mode B passwords', () => {
    it('generates a strong password, returns it once, stores only an Argon2id hash and never emails it', async () => {
      const [inv] = await h.invite(a, doc.versionId, [{ email: 'pw@example.com', mode: 'password' }])
      expect(inv.password).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)
      const canonical = inv.password.replace(/-/g, '')
      const [row] = await h.db.admin.query<{ password_hash: string }>(`select password_hash from public.invitations where id = $1`, [inv.invitationId])
      expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
      const mail = h.mailer.outbox.at(-1)!
      for (const secret of [inv.password, canonical]) {
        expect(mail.text).not.toContain(secret)
        expect(mail.html).not.toContain(secret)
      }
      expect(mail.text).toMatch(/password separately/)
      const list = await h.call('GET', `invitations?documentId=${doc.documentId}`, { bearer: a.bearer })
      expect(JSON.stringify(list.body)).not.toMatch(/argon2|password_hash|token/)
    })

    it('accepts a strong sender-chosen password without echoing it back', async () => {
      const r = await h.call('POST', 'invitations', { bearer: a.bearer, body: {
        documentVersionId: doc.versionId, recipients: [{ email: 'custom@example.com', mode: 'password', password: 'lantern-orbit-mango-73!' }] } })
      expect(r.status).toBe(201)
      expect(JSON.stringify(r.body)).not.toContain('lantern-orbit-mango-73!')
      expect(r.body.invitations[0].password).toBeUndefined()
    })

    it('rejects weak or personal sender-chosen passwords (without echoing them)', async () => {
      for (const password of ['short1!', 'password12345', 'qwertyuiop123', 'weak.example.com.pass']) {
        const r = await h.call('POST', 'invitations', { bearer: a.bearer, body: {
          documentVersionId: doc.versionId, recipients: [{ email: 'weak@example.com', mode: 'password', password }] } })
        expect(r.status, password).toBe(400)
        expect(r.body.error).toBe('weak_password')
        expect(JSON.stringify(r.body)).not.toContain(password)
      }
    })

    it('reset issues a new password; the old one stops working', async () => {
      const [inv] = await h.invite(a, doc.versionId, [{ email: 'reset@example.com', mode: 'password' }])
      const token = tokenFromEmail(h.mailer, 'reset@example.com')
      const reset = await h.call('POST', `invitations/${inv.invitationId}/reset-password`, { bearer: a.bearer, body: {} })
      expect(reset.body.password).not.toBe(inv.password)
      expect((await h.call('POST', 'r/verify-password', { body: { token, password: inv.password } })).status).toBe(401)
      expect((await h.call('POST', 'r/verify-password', { body: { token, password: reset.body.password } })).status).toBe(200)
    })
  })

  it('enforces at most five recipients and no duplicates', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ email: `r${i}@example.com`, mode: 'link' }))
    expect((await h.call('POST', 'invitations', { bearer: a.bearer, body: { documentVersionId: doc.versionId, recipients: six } })).status).toBe(400)
    const dup = [{ email: 'd@example.com', mode: 'link' }, { email: 'D@example.com', mode: 'link' }]
    const r = await h.call('POST', 'invitations', { bearer: a.bearer, body: { documentVersionId: doc.versionId, recipients: dup } })
    expect(r.body.error).toBe('duplicate_recipient')
  })

  it('rejects modes not yet available and passwords on non-password modes', async () => {
    const otp = await h.call('POST', 'invitations', { bearer: a.bearer, body: { documentVersionId: doc.versionId, recipients: [{ email: 'o@example.com', mode: 'email_otp' }] } })
    expect(otp.body.error).toBe('mode_not_available')
    const pwOnLink = await h.call('POST', 'invitations', { bearer: a.bearer, body: {
      documentVersionId: doc.versionId, recipients: [{ email: 'l@example.com', mode: 'link', password: 'lantern-orbit-mango-73!' }] } })
    expect(pwOnLink.body.error).toBe('password_not_allowed')
  })

  it('rejects unknown fields (no smuggling extra options)', async () => {
    const r = await h.call('POST', 'invitations', { bearer: a.bearer, body: {
      documentVersionId: doc.versionId, recipients: [{ email: 'x@example.com', mode: 'link' }], expiresInDays: 365 } })
    expect(r.status).toBe(400)
  })

  it('still creates the invitation if the email fails, and records the failure', async () => {
    h.mailer.fail = true
    try {
      const [inv] = await h.invite(a, doc.versionId, [{ email: 'bounce@example.com', mode: 'link' }])
      expect(inv.emailSent).toBe(false)
      const ev = await h.db.admin.query(`select 1 from public.audit_events where invitation_id = $1 and event_type = 'invitation_email_failed'`, [inv.invitationId])
      expect(ev).toHaveLength(1)
    } finally {
      h.mailer.fail = false
    }
  })

  it('resend issues a fresh link and kills the old one; the password carries over', async () => {
    const [inv] = await h.invite(a, doc.versionId, [{ email: 'again@example.com', mode: 'password' }])
    const oldToken = tokenFromEmail(h.mailer, 'again@example.com')
    const re = await h.call('POST', `invitations/${inv.invitationId}/resend`, { bearer: a.bearer, body: {} })
    expect(re.status).toBe(200)
    const newToken = tokenFromEmail(h.mailer, 'again@example.com')
    expect(newToken).not.toBe(oldToken)
    expect((await h.call('POST', 'r/open', { body: { token: oldToken } })).body.state).toBe('revoked')
    expect((await h.call('POST', 'r/verify-password', { body: { token: newToken, password: inv.password } })).status).toBe(200)
  })

  it('revoking twice is a conflict, and revoked invitations cannot be reset or resent', async () => {
    const [inv] = await h.invite(a, doc.versionId, [{ email: 'rev@example.com', mode: 'password' }])
    expect((await h.call('POST', `invitations/${inv.invitationId}/revoke`, { bearer: a.bearer, body: {} })).status).toBe(200)
    expect((await h.call('POST', `invitations/${inv.invitationId}/revoke`, { bearer: a.bearer, body: {} })).status).toBe(409)
    expect((await h.call('POST', `invitations/${inv.invitationId}/reset-password`, { bearer: a.bearer, body: {} })).status).toBe(409)
    expect((await h.call('POST', `invitations/${inv.invitationId}/resend`, { bearer: a.bearer, body: {} })).status).toBe(409)
  })

  it("other senders cannot manage someone else's invitations", async () => {
    const b = await h.createSender()
    const [inv] = await h.invite(a, doc.versionId, [{ email: 'mine@example.com', mode: 'password' }])
    for (const action of ['revoke', 'reset-password', 'resend']) {
      expect((await h.call('POST', `invitations/${inv.invitationId}/${action}`, { bearer: b.bearer, body: {} })).status, action).toBe(404)
    }
    const list = await h.call('GET', 'invitations', { bearer: b.bearer })
    expect(list.body.invitations).toHaveLength(0)
  })
})
