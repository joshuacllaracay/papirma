import { beforeAll, describe, expect, it } from 'vitest'
import { createHarness, tokenFromEmail, cookieFrom, type Harness } from '../helpers/harness.js'

/** Database-level guarantees: they hold even if application code has a bug. */
describe('database integrity, grants and RLS', () => {
  let h: Harness
  let a: Awaited<ReturnType<Harness['createSender']>>
  let b: Awaited<ReturnType<Harness['createSender']>>
  let docA: Awaited<ReturnType<Harness['uploadDocument']>>
  let invId: string

  beforeAll(async () => {
    h = await createHarness()
    a = await h.createSender({ name: 'Alice' })
    b = await h.createSender({ name: 'Bob' })
    docA = await h.uploadDocument(a)
    await h.uploadDocument(b)
    invId = (await h.invite(a, docA.versionId, [{ email: 'ana@example.com', mode: 'link' }]))[0].invitationId
    // produce a few recipient events in the chain
    const open = await h.call('POST', 'r/open', { body: { token: tokenFromEmail(h.mailer, 'ana@example.com') } })
    await h.call('GET', 'r/document', { cookie: cookieFrom(open.headers) })
  })

  describe('T-21 document replacement after invitations are issued', () => {
    it('a ready version cannot have its hash, size or file path changed', async () => {
      await expect(h.db.app.query(`update public.document_versions set sha256 = sha256('x'::bytea) where id = $1`, [docA.versionId]))
        .rejects.toThrow(/immutable/)
      await expect(h.db.app.query(`update public.document_versions set storage_path = 'orig/evil.pdf' where id = $1`, [docA.versionId]))
        .rejects.toThrow(/immutable/)
      // not even a superuser bypasses the trigger by accident
      await expect(h.db.admin.query(`update public.document_versions set page_count = 2 where id = $1`, [docA.versionId]))
        .rejects.toThrow(/immutable/)
    })

    it('document versions and invitations cannot be deleted', async () => {
      await expect(h.db.admin.query(`delete from public.document_versions where id = $1`, [docA.versionId])).rejects.toThrow(/cannot be deleted/)
      await expect(h.db.admin.query(`delete from public.invitations where id = $1`, [invId])).rejects.toThrow(/cannot be deleted/)
    })

    it('an invitation cannot be pointed at a different document, recipient, mode or token', async () => {
      const other = await h.db.admin.query<{ id: string }>(`select id from public.document_versions where id <> $1 limit 1`, [docA.versionId])
      for (const [col, val] of <Array<[string, unknown]>>[
        ['document_version_id', other[0].id],
        ['recipient_email', 'mallory@example.com'],
        ['security_mode', 'password'],
        ['token_hash', Buffer.alloc(32)],
        ['expires_at', '2099-01-01'],
      ]) {
        await expect(h.db.app.query(`update public.invitations set ${col} = $2 where id = $1`, [invId, val]), col).rejects.toThrow(/immutable/)
      }
    })

    it('status follows the state machine (no un-revoking, no skipping to completed)', async () => {
      await expect(h.db.app.query(`update public.invitations set status = 'completed' where id = $1`, [invId])).rejects.toThrow(/invalid invitation status/)
      await h.call('POST', `invitations/${invId}/revoke`, { bearer: a.bearer, body: {} })
      await expect(h.db.app.query(`update public.invitations set status = 'opened', revoked_at = null where id = $1`, [invId]))
        .rejects.toThrow(/invalid invitation status/)
    })

    it('invitations can only target a ready version owned by the sender', async () => {
      const bVersion = await h.db.admin.query<{ id: string }>(
        `select v.id from public.document_versions v join public.documents d on d.id = v.document_id where d.owner_id = $1`, [b.id])
      await expect(h.db.app.query(
        `insert into public.invitations (document_version_id, sender_id, recipient_email, security_mode, token_hash, workflow_version, expires_at)
         values ($1, $2, 'x@example.com', 'link', sha256('t'::bytea), 'pro-sign/1', now() + interval '1 day')`, [bVersion[0].id, a.id]))
        .rejects.toThrow(/ready document version owned by the sender/)
    })

    it('expiry is capped at 7 days by the database', async () => {
      await expect(h.db.admin.query(
        `insert into public.invitations (document_version_id, sender_id, recipient_email, security_mode, token_hash, workflow_version, expires_at)
         values ($1, $2, 'y@example.com', 'link', sha256('u'::bytea), 'pro-sign/1', now() + interval '8 days')`, [docA.versionId, a.id]))
        .rejects.toThrow(/check constraint/)
    })
  })

  describe('T-25 unauthorized changes to audit records', () => {
    it('the app role cannot update, delete or truncate audit events', async () => {
      await expect(h.db.app.query(`update public.audit_events set event_type = 'nothing_happened'`)).rejects.toThrow()
      await expect(h.db.app.query(`delete from public.audit_events`)).rejects.toThrow()
      await expect(h.db.app.query(`truncate public.audit_events`)).rejects.toThrow()
    })

    it('even the owner is stopped by the append-only triggers', async () => {
      await expect(h.db.admin.query(`update public.audit_events set details = '{}'`)).rejects.toThrow(/append-only/)
      await expect(h.db.admin.query(`delete from public.audit_events`)).rejects.toThrow(/append-only/)
      await expect(h.db.admin.query(`truncate public.audit_events`)).rejects.toThrow(/append-only/)
    })

    it('timestamps are set by the server, not the caller', async () => {
      await h.db.app.query(
        `insert into public.audit_events (actor_type, event_type, occurred_at) values ('system', 'clock_test', '2000-01-01')`)
      const [row] = await h.db.admin.query<{ occurred_at: Date }>(`select occurred_at from public.audit_events where event_type = 'clock_test'`)
      expect(new Date(row.occurred_at).getFullYear()).toBeGreaterThan(2020)
    })

    it('the hash chain verifies, and detects an out-of-band edit', async () => {
      const [ok] = await h.db.app.query<{ broken: string | null }>(`select public.verify_audit_chain($1) as broken`, [invId])
      expect(ok.broken).toBeNull()
      const events = await h.db.admin.query<{ id: string }>(`select id from public.audit_events where invitation_id = $1 order by id`, [invId])
      expect(events.length).toBeGreaterThanOrEqual(3)
      // A superuser disabling triggers can still edit a row — the chain must expose it.
      await h.db.admin.query(`set session_replication_role = replica`)
      await h.db.admin.query(`update public.audit_events set details = '{"forged":true}' where id = $1`, [events[1].id])
      await h.db.admin.query(`set session_replication_role = origin`)
      const [bad] = await h.db.app.query<{ broken: string | null }>(`select public.verify_audit_chain($1) as broken`, [invId])
      expect(String(bad.broken)).toBe(String(events[1].id))
    })
  })

  describe('T-24 unauthenticated / client access to private data', () => {
    const tables = ['profiles', 'documents', 'document_versions', 'invitations', 'otp_challenges',
      'recipient_sessions', 'signing_completions', 'audit_events', 'rate_limits']

    it('anon (public API key) cannot read any table', async () => {
      for (const t of tables) {
        await expect(h.db.asRole('anon', null, `select * from public.${t} limit 1`), t).rejects.toThrow(/permission denied/)
      }
    })

    it('signed-in senders can read only their own rows', async () => {
      const docs = await h.db.asRole<{ owner_id: string }>('authenticated', a.id, `select owner_id from public.documents`)
      expect(docs.length).toBeGreaterThan(0)
      expect(docs.every((d) => d.owner_id === a.id)).toBe(true)
      const bInv = await h.db.asRole('authenticated', b.id, `select id from public.sender_invitations`)
      expect(bInv).toHaveLength(0)
    })

    it('senders cannot read token or password hashes, or session/OTP tables', async () => {
      await expect(h.db.asRole('authenticated', a.id, `select token_hash from public.invitations`)).rejects.toThrow(/permission denied/)
      await expect(h.db.asRole('authenticated', a.id, `select password_hash from public.invitations`)).rejects.toThrow(/permission denied/)
      await expect(h.db.asRole('authenticated', a.id, `select * from public.recipient_sessions`)).rejects.toThrow(/permission denied/)
      await expect(h.db.asRole('authenticated', a.id, `select * from public.otp_challenges`)).rejects.toThrow(/permission denied/)
    })

    it('clients cannot write anything directly', async () => {
      await expect(h.db.asRole('authenticated', a.id, `insert into public.documents (owner_id, title) values ($1, 'x')`, [a.id]))
        .rejects.toThrow(/permission denied/)
      await expect(h.db.asRole('authenticated', a.id, `update public.profiles set plan = 'pro' where id = $1`, [a.id]))
        .rejects.toThrow(/permission denied/)
    })

    it('the storage bucket is private with no client policies', async () => {
      const [bucket] = await h.db.admin.query<{ public: boolean; file_size_limit: string }>(`select public, file_size_limit from storage.buckets where id = 'documents'`)
      expect(bucket.public).toBe(false)
      expect(Number(bucket.file_size_limit)).toBe(26214400)
      const policies = await h.db.admin.query(`select * from pg_policies where schemaname = 'storage'`)
      expect(policies).toHaveLength(0)
    })
  })
})
