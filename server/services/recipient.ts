import { z } from 'zod'
import type { Deps } from '../deps.js'
import type { Queryable } from '../db.js'
import { one } from '../db.js'
import { audit } from '../audit.js'
import { HttpError, tooMany, unauthorized } from '../errors.js'
import { TOKEN_RE, randomToken, sha256, toHex } from '../crypto.js'
import { verifyAgainstDummy, verifyPassword } from '../passwords.js'
import { hit, peek } from '../rateLimit.js'
import { SESSION_COOKIE, getCookie, sessionCookie, type ClientInfo } from '../http.js'

const SESSION_IDLE_MIN = 30
const SESSION_MAX_MIN = 120
const DOWNLOAD_URL_TTL_SEC = 60

/** Per-IP limits (keys use an HMAC of the IP, never the raw address). */
const OPEN_PER_IP_HOUR = 120
const PW_FAIL_PER_IP_HOUR = 30
/** Per-invitation lockout policy. */
const FAILS_BEFORE_LOCK = 5
const LOCK_BASE_MIN = 15
const FAILS_BEFORE_HARD_LOCK = 15

const Token = z.string().regex(TOKEN_RE)
export const OpenInput = z.object({ token: Token }).strict()
export const PasswordInput = z.object({ token: Token, password: z.string().min(1).max(128) }).strict()

type InvitationRow = {
  id: string
  status: string
  security_mode: 'link' | 'password' | 'email_otp'
  expires_at: Date
  locked_until: Date | null
  password_hash: string | null
  hide_title: boolean
  sender_name: string
  document_id: string
}

async function findByToken(q: Queryable, token: string, lock = false) {
  return one<InvitationRow>(q,
    `select i.id, i.status, i.security_mode, i.expires_at, i.locked_until, i.password_hash, i.hide_title,
            p.display_name as sender_name, v.document_id
       from public.invitations i
       join public.profiles p on p.id = i.sender_id
       join public.document_versions v on v.id = i.document_version_id
      where i.token_hash = $1 ${lock ? 'for update of i' : ''}`,
    [sha256(token)])
}

type Closed = 'revoked' | 'expired' | 'completed'
function closedState(inv: InvitationRow): Closed | null {
  if (inv.status === 'completed') return 'completed'
  if (inv.status === 'revoked') return 'revoked'
  if (inv.status === 'expired' || new Date(inv.expires_at) <= new Date()) return 'expired'
  return null
}

/** Seconds until unlock (0 if not locked). An unparseable lock time is treated as locked. */
function lockedSeconds(inv: Pick<InvitationRow, 'locked_until'>): number {
  if (inv.locked_until == null) return 0
  const t = new Date(inv.locked_until).getTime()
  if (Number.isNaN(t)) return 365 * 24 * 3600
  const s = Math.ceil((t - Date.now()) / 1000)
  return s > 0 ? Math.min(s, 365 * 24 * 3600) : 0
}

/** Create an invitation-scoped session; marks the invitation opened on first verification. */
async function startSession(q: Queryable, inv: InvitationRow, via: InvitationRow['security_mode'], client: ClientInfo) {
  const token = randomToken()
  await q.query(
    `insert into public.recipient_sessions (invitation_id, token_hash, verified_via, expires_at, absolute_expires_at)
     values ($1, $2, $3, now() + make_interval(mins => ${SESSION_IDLE_MIN}), now() + make_interval(mins => ${SESSION_MAX_MIN}))`,
    [inv.id, sha256(token), via])
  if (inv.status === 'pending') {
    await q.query(`update public.invitations set status = 'opened', first_opened_at = now() where id = $1 and status = 'pending'`, [inv.id])
    await audit(q, { invitationId: inv.id, actorType: 'recipient', eventType: 'invitation_opened', details: { via }, ip: client.ip, userAgent: client.userAgent })
  }
  return sessionCookie(token, SESSION_MAX_MIN * 60)
}

export interface OpenResult {
  body: Record<string, unknown>
  setCookie?: string
}

/** Step 1 for every recipient. Reveals only what's needed to continue — never document content. */
export async function openInvitation(deps: Deps, input: z.infer<typeof OpenInput>, client: ClientInfo): Promise<OpenResult> {
  if ((await hit(deps.db, `open:ip:${client.ipKey}`, 3600)) > OPEN_PER_IP_HOUR) throw tooMany(3600)
  const inv = await findByToken(deps.db, input.token)
  if (!inv) return { body: { state: 'invalid' } }
  const closed = closedState(inv)
  if (closed) return { body: { state: closed } }
  const common = { mode: inv.security_mode, senderName: inv.sender_name, expiresAt: inv.expires_at }

  if (inv.security_mode === 'link') {
    const setCookie = await deps.db.tx(async (q) => {
      const locked = await findByToken(q, input.token, true)
      if (!locked || closedState(locked)) throw unauthorized('invalid_link')
      return startSession(q, locked, 'link', client)
    })
    return { body: { state: 'verified', ...common }, setCookie }
  }
  if (inv.security_mode === 'password') {
    const retryAfterSec = lockedSeconds(inv)
    return { body: { state: 'password_required', ...common, locked: retryAfterSec > 0, ...(retryAfterSec ? { retryAfterSec } : {}) } }
  }
  return { body: { state: 'otp_required', ...common } }
}

/** Mode B. Generic failures, per-invitation lockout and per-IP throttling. */
export async function verifyInvitationPassword(deps: Deps, input: z.infer<typeof PasswordInput>, client: ClientInfo): Promise<OpenResult> {
  const ipKey = `pwfail:ip:${client.ipKey}`
  if ((await peek(deps.db, ipKey, 3600)) >= PW_FAIL_PER_IP_HOUR) throw tooMany(3600)

  const inv = await findByToken(deps.db, input.token)
  if (!inv || inv.security_mode !== 'password' || !inv.password_hash || closedState(inv)) {
    await verifyAgainstDummy(input.password)
    await hit(deps.db, ipKey, 3600)
    throw unauthorized('invalid_credentials')
  }
  const wait = lockedSeconds(inv)
  if (wait > 0) throw tooMany(wait, 'locked')

  const ok = await verifyPassword(inv.password_hash, input.password)

  if (!ok) {
    await hit(deps.db, ipKey, 3600)
    const r = await deps.db.tx(async (q) => {
      const row = await one<{ locked_until: Date | null; total_failed: number }>(q,
        `update public.invitations set
           failed_attempts = case when failed_attempts + 1 >= ${FAILS_BEFORE_LOCK} then 0 else failed_attempts + 1 end,
           total_failed = total_failed + 1,
           locked_until = case
             -- hard lock until the sender resets the password (far-future date, not 'infinity',
             -- which JS drivers can turn into an invalid Date that would read as "unlocked")
             when total_failed + 1 >= ${FAILS_BEFORE_HARD_LOCK} then now() + interval '100 years'
             when failed_attempts + 1 >= ${FAILS_BEFORE_LOCK}
               then now() + make_interval(mins => ${LOCK_BASE_MIN} * power(2, greatest((total_failed + 1) / ${FAILS_BEFORE_LOCK} - 1, 0))::int)
             else locked_until end
         where id = $1 and status in ('pending', 'opened')
         returning locked_until, total_failed`, [inv.id])
      await audit(q, { invitationId: inv.id, actorType: 'recipient', eventType: 'password_failed', ip: client.ip, userAgent: client.userAgent })
      if (row && lockedSeconds(row) > 0) {
        await audit(q, {
          invitationId: inv.id, actorType: 'system', eventType: 'password_locked',
          details: { total_failed: row.total_failed, until_reset: row.total_failed >= FAILS_BEFORE_HARD_LOCK },
        })
      }
      return row
    })
    if (r && lockedSeconds(r) > 0) throw tooMany(lockedSeconds(r), 'locked')
    throw unauthorized('invalid_credentials')
  }

  const setCookie = await deps.db.tx(async (q) => {
    const locked = await findByToken(q, input.token, true)
    // re-check under lock: revoked/reset/locked between verify and now?
    if (!locked || closedState(locked) || locked.password_hash !== inv.password_hash || lockedSeconds(locked) > 0) {
      throw unauthorized('invalid_credentials')
    }
    await q.query(`update public.invitations set failed_attempts = 0, locked_until = null where id = $1`, [inv.id])
    await audit(q, { invitationId: inv.id, actorType: 'recipient', eventType: 'password_verified', ip: client.ip, userAgent: client.userAgent })
    return startSession(q, locked, 'password', client)
  })
  return { body: { state: 'verified', mode: inv.security_mode, senderName: inv.sender_name, expiresAt: inv.expires_at }, setCookie }
}

export interface RecipientSession {
  sessionId: string
  invitationId: string
  verifiedVia: string
  status: string
  documentVersionId: string
  documentId: string
  title: string
  hideTitle: boolean
  storagePath: string
  sha256: Uint8Array
  pageCount: number
  senderName: string
  expiresAt: Date
}

/**
 * Every recipient request goes through here. The session cookie maps to exactly
 * one invitation, and the document is always taken from that invitation — never
 * from anything the client sends.
 */
export async function requireRecipientSession(deps: Deps, request: Request, opts: { allowCompleted?: boolean } = {}): Promise<RecipientSession> {
  const token = getCookie(request, SESSION_COOKIE)
  if (!token || !TOKEN_RE.test(token)) throw unauthorized('session_required')
  const s = await one<{
    session_id: string; invitation_id: string; verified_via: string; status: string; inv_expires_at: Date
    document_version_id: string; document_id: string; title: string; hide_title: boolean; storage_path: string
    sha256: Uint8Array; page_count: number; sender_name: string
  }>(deps.db,
    `update public.recipient_sessions s
        set expires_at = least(now() + make_interval(mins => ${SESSION_IDLE_MIN}), s.absolute_expires_at)
       from public.invitations i, public.document_versions v, public.documents d, public.profiles p
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and s.absolute_expires_at > now()
        and i.id = s.invitation_id and v.id = i.document_version_id and d.id = v.document_id and p.id = i.sender_id
      returning s.id as session_id, s.invitation_id, s.verified_via, i.status, i.expires_at as inv_expires_at,
                v.id as document_version_id, d.id as document_id, d.title, i.hide_title, v.storage_path,
                v.sha256, v.page_count, p.display_name as sender_name`,
    [sha256(token)])
  if (!s) throw unauthorized('session_expired')
  const usable = s.status === 'opened' || s.status === 'completing' || (opts.allowCompleted && s.status === 'completed')
  if (!usable || (s.status !== 'completed' && new Date(s.inv_expires_at) <= new Date())) {
    throw new HttpError(410, 'invitation_closed')
  }
  return {
    sessionId: s.session_id, invitationId: s.invitation_id, verifiedVia: s.verified_via, status: s.status,
    documentVersionId: s.document_version_id, documentId: s.document_id, title: s.title, hideTitle: s.hide_title,
    storagePath: s.storage_path, sha256: s.sha256, pageCount: s.page_count, senderName: s.sender_name,
    expiresAt: s.inv_expires_at,
  }
}

/** The intended PDF only, via a 60-second signed URL, after authorization. */
export async function getRecipientDocument(deps: Deps, request: Request, client: ClientInfo) {
  const s = await requireRecipientSession(deps, request)
  const url = await deps.storage.createDownloadUrl(s.storagePath, DOWNLOAD_URL_TTL_SEC, 'document.pdf')
  await audit(deps.db, { invitationId: s.invitationId, actorType: 'recipient', eventType: 'document_viewed', ip: client.ip, userAgent: client.userAgent })
  return {
    title: s.title,
    senderName: s.senderName,
    pageCount: s.pageCount,
    sha256: toHex(s.sha256),
    url,
    urlExpiresInSec: DOWNLOAD_URL_TTL_SEC,
    expiresAt: s.expiresAt,
    status: s.status,
  }
}

export async function endRecipientSession(deps: Deps, request: Request) {
  const token = getCookie(request, SESSION_COOKIE)
  if (token && TOKEN_RE.test(token)) {
    await deps.db.query(`update public.recipient_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, [sha256(token)])
  }
}
