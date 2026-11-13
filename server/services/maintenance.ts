import type { Deps } from '../deps.js'
import { audit } from '../audit.js'

/** Daily retention job (Vercel Cron). See docs/pro-signing/phase1-assessment.md §10. */
export async function runCleanup(deps: Deps) {
  const expired = await deps.db.tx(async (q) => {
    const rows = await q.query<{ id: string }>(
      `update public.invitations set status = 'expired'
        where status in ('pending', 'opened') and expires_at <= now() returning id`)
    for (const r of rows) await audit(q, { invitationId: r.id, actorType: 'system', eventType: 'invitation_expired' })
    await q.query(
      `update public.recipient_sessions set revoked_at = now()
        where revoked_at is null and invitation_id = any($1::uuid[])`, [rows.map((r) => r.id)])
    return rows.length
  })
  const sessions = await deps.db.query(
    `delete from public.recipient_sessions where coalesce(revoked_at, absolute_expires_at) < now() - interval '24 hours' returning id`)
  const otps = await deps.db.query(`delete from public.otp_challenges where created_at < now() - interval '24 hours' returning id`)
  const limits = await deps.db.query(`delete from public.rate_limits where window_start < now() - interval '24 hours' returning key`)
  return { expiredInvitations: expired, deletedSessions: sessions.length, deletedOtps: otps.length, deletedRateLimits: limits.length }
}
