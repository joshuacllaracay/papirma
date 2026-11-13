import type { Queryable } from '../../server/db.js'

/**
 * Simulate the passage of time for an invitation by shifting its timestamps back.
 * The integrity triggers rightly forbid this, so it runs with triggers disabled
 * (superuser-only `session_replication_role = replica`) — test setup only.
 */
export async function ageInvitation(admin: Queryable, invitationId: string, days: number) {
  await admin.query(`set session_replication_role = replica`)
  try {
    await admin.query(
      `update public.invitations set created_at = created_at - make_interval(days => $2),
              expires_at = expires_at - make_interval(days => $2) where id = $1`,
      [invitationId, days])
  } finally {
    await admin.query(`set session_replication_role = origin`)
  }
}
