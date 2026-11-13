import type { Queryable } from './db.js'

export interface AuditEvent {
  invitationId?: string | null
  documentId?: string | null
  actorType: 'sender' | 'recipient' | 'system' | 'admin'
  actorId?: string | null
  eventType: string
  details?: Record<string, string | number | boolean | null>
  ip?: string | null
  userAgent?: string | null
}

/** Keys that must never be written to the audit log, whatever the value. */
const FORBIDDEN_KEY = /pass|token|secret|otp|code|cookie|hash_input/i

/**
 * Append an event. The database sets the timestamp (server time) and the hash
 * chain; this function only refuses obviously secret-bearing details.
 */
export async function audit(q: Queryable, e: AuditEvent): Promise<void> {
  const details = e.details ?? {}
  for (const k of Object.keys(details)) {
    if (FORBIDDEN_KEY.test(k)) throw new Error(`audit detail key not allowed: ${k}`)
  }
  await q.query(
    `insert into public.audit_events
       (invitation_id, document_id, actor_type, actor_id, event_type, details, ip_address, user_agent)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::inet, $8)`,
    [
      e.invitationId ?? null,
      e.documentId ?? null,
      e.actorType,
      e.actorId ?? null,
      e.eventType,
      JSON.stringify(details),
      e.ip ?? null,
      e.userAgent ? e.userAgent.slice(0, 300) : null,
    ],
  )
}
