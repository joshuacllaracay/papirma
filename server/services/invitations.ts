import { z } from 'zod'
import type { Deps } from '../deps.js'
import type { Queryable } from '../db.js'
import { one } from '../db.js'
import type { Sender } from './senders.js'
import { requirePro } from './senders.js'
import { audit } from '../audit.js'
import { badRequest, conflict, notFound, tooMany } from '../errors.js'
import { randomToken, sha256 } from '../crypto.js'
import { checkCustomPassword, generatePassword, hashPassword } from '../passwords.js'
import { invitationEmail } from '../email.js'
import { hit } from '../rateLimit.js'

export const MAX_RECIPIENTS = 5
const INVITATION_TTL_DAYS = 7

/** Modes available in this release. Email OTP ships in Phase 3. */
const ENABLED_MODES = new Set(['link', 'password'])

const Email = z.string().trim().toLowerCase().max(254).email()

export const CreateInvitations = z.object({
  documentVersionId: z.string().uuid(),
  hideTitle: z.boolean().default(false),
  recipients: z.array(z.object({
    email: Email,
    mode: z.enum(['link', 'password', 'email_otp']),
    /** Optional sender-chosen password (Mode B). Omit to have a strong one generated. */
    password: z.string().max(128).optional(),
  }).strict()).min(1).max(MAX_RECIPIENTS),
}).strict()

export const RevokeInvitation = z.object({ reason: z.string().trim().max(200).optional() }).strict()

interface NewInvitation {
  id: string
  email: string
  mode: 'link' | 'password' | 'email_otp'
  token: string
  expiresAt: Date
  /** Only for generated passwords; returned once, never stored. */
  generatedPassword?: string
}

export const signingLink = (appOrigin: string, token: string) => `${appOrigin}/s#t=${token}`

async function insertInvitation(
  q: Queryable,
  args: { versionId: string; senderId: string; email: string; mode: string; passwordHash: string | null; hideTitle: boolean; workflowVersion: string; replacesId?: string },
) {
  const token = randomToken()
  const row = await one<{ id: string; expires_at: Date }>(q,
    `insert into public.invitations
       (document_version_id, sender_id, recipient_email, security_mode, token_hash, password_hash, password_set_at,
        workflow_version, hide_title, expires_at, replaces_id)
     values ($1, $2, $3, $4, $5, $6, case when $6::text is null then null else now() end, $7, $8,
             now() + make_interval(days => ${INVITATION_TTL_DAYS}), $9)
     returning id, expires_at`,
    [args.versionId, args.senderId, args.email, args.mode, sha256(token), args.passwordHash, args.workflowVersion, args.hideTitle, args.replacesId ?? null])
  return { id: row!.id, token, expiresAt: new Date(row!.expires_at) }
}

async function sendInvitationEmail(deps: Deps, sender: Sender, inv: NewInvitation, title: string | null) {
  try {
    await deps.mailer.send(invitationEmail({
      to: inv.email,
      senderName: sender.displayName,
      documentTitle: title,
      link: signingLink(deps.config.appOrigin, inv.token),
      expiresAt: inv.expiresAt,
      mode: inv.mode,
    }))
    await audit(deps.db, { invitationId: inv.id, actorType: 'system', eventType: 'invitation_email_sent' })
    return true
  } catch {
    await audit(deps.db, { invitationId: inv.id, actorType: 'system', eventType: 'invitation_email_failed' })
    return false
  }
}

export async function createInvitations(deps: Deps, sender: Sender, input: z.infer<typeof CreateInvitations>) {
  requirePro(sender)
  const emails = input.recipients.map((r) => r.email)
  if (new Set(emails).size !== emails.length) throw badRequest('duplicate_recipient')
  input.recipients.forEach((r, i) => {
    if (!ENABLED_MODES.has(r.mode)) throw badRequest('mode_not_available', { index: i, mode: r.mode })
    if (r.password !== undefined && r.mode !== 'password') throw badRequest('password_not_allowed', { index: i })
  })

  const version = await one<{ id: string; title: string; document_id: string }>(deps.db,
    `select v.id, d.title, d.id as document_id from public.document_versions v join public.documents d on d.id = v.document_id
      where v.id = $1 and v.status = 'ready' and d.owner_id = $2 and d.deleted_at is null`,
    [input.documentVersionId, sender.id])
  if (!version) throw notFound()

  // Hash passwords before opening the transaction (Argon2id is deliberately slow).
  const prepared = await Promise.all(input.recipients.map(async (r, i) => {
    if (r.mode !== 'password') return { ...r, passwordHash: null, generated: undefined }
    if (r.password !== undefined) {
      const reason = checkCustomPassword(r.password, [r.email, r.email.split('@')[0], sender.displayName])
      if (reason) throw badRequest('weak_password', { index: i, message: reason })
      return { ...r, passwordHash: await hashPassword(r.password), generated: undefined }
    }
    const pw = generatePassword()
    return { ...r, passwordHash: await hashPassword(pw.canonical), generated: pw.display }
  }))

  const created: NewInvitation[] = await deps.db.tx(async (q) => {
    const out: NewInvitation[] = []
    for (const r of prepared) {
      const inv = await insertInvitation(q, {
        versionId: version.id, senderId: sender.id, email: r.email, mode: r.mode,
        passwordHash: r.passwordHash, hideTitle: input.hideTitle, workflowVersion: deps.config.workflowVersion,
      })
      await audit(q, {
        invitationId: inv.id, documentId: version.document_id, actorType: 'sender', actorId: sender.id,
        eventType: 'invitation_created',
        details: { mode: r.mode, chosen_by: r.mode === 'password' ? (r.generated ? 'generated' : 'sender') : null },
      })
      out.push({ ...inv, email: r.email, mode: r.mode, generatedPassword: r.generated })
    }
    return out
  })

  const title = input.hideTitle ? null : version.title
  const results = []
  for (const inv of created) {
    const emailSent = await sendInvitationEmail(deps, sender, inv, title)
    results.push({
      invitationId: inv.id, email: inv.email, mode: inv.mode, expiresAt: inv.expiresAt, emailSent,
      ...(inv.generatedPassword ? { password: inv.generatedPassword } : {}),
    })
  }
  return { invitations: results }
}

export async function listInvitations(deps: Deps, sender: Sender, documentId: string | null) {
  const rows = await deps.db.query(
    `select i.id, i.recipient_email, i.security_mode, i.status, i.expires_at, i.first_opened_at, i.revoked_at,
            i.created_at, i.locked_until, v.version, v.document_id
       from public.invitations i join public.document_versions v on v.id = i.document_version_id
      where i.sender_id = $1 and ($2::uuid is null or v.document_id = $2::uuid)
      order by i.created_at desc limit 500`,
    [sender.id, documentId],
  )
  return rows.map((r) => ({
    id: r.id, email: r.recipient_email, mode: r.security_mode,
    status: r.status !== 'revoked' && r.status !== 'completed' && new Date(r.expires_at as string) <= new Date() ? 'expired' : r.status,
    expiresAt: r.expires_at, firstOpenedAt: r.first_opened_at, revokedAt: r.revoked_at, createdAt: r.created_at,
    locked: r.locked_until ? new Date(r.locked_until as string) > new Date() : false,
    documentId: r.document_id, version: r.version,
  }))
}

async function lockOwned(q: Queryable, sender: Sender, id: string) {
  const inv = await one<{ id: string; status: string; security_mode: string; expires_at: Date; recipient_email: string;
    password_hash: string | null; hide_title: boolean; document_version_id: string }>(q,
    `select id, status, security_mode, expires_at, recipient_email, password_hash, hide_title, document_version_id
       from public.invitations where id = $1 and sender_id = $2 for update`, [id, sender.id])
  if (!inv) throw notFound()
  return inv
}

const isOpen = (inv: { status: string; expires_at: Date }) =>
  (inv.status === 'pending' || inv.status === 'opened') && new Date(inv.expires_at) > new Date()

export async function revokeInvitation(deps: Deps, sender: Sender, id: string, input: z.infer<typeof RevokeInvitation>) {
  await deps.db.tx(async (q) => {
    const inv = await lockOwned(q, sender, id)
    if (inv.status === 'completing' || inv.status === 'completed') throw conflict('already_completed')
    if (inv.status === 'revoked') throw conflict('already_revoked')
    await q.query(
      `update public.invitations set status = 'revoked', revoked_at = now(), revoked_reason = $2 where id = $1`,
      [id, input.reason ?? null])
    await q.query(`update public.recipient_sessions set revoked_at = now() where invitation_id = $1 and revoked_at is null`, [id])
    await audit(q, { invitationId: id, actorType: 'sender', actorId: sender.id, eventType: 'invitation_revoked' })
  })
  return { ok: true }
}

/** New generated password, shown once. Unlocks the invitation and signs out any open sessions. */
export async function resetPassword(deps: Deps, sender: Sender, id: string) {
  const pw = generatePassword()
  const passwordHash = await hashPassword(pw.canonical)
  await deps.db.tx(async (q) => {
    const inv = await lockOwned(q, sender, id)
    if (inv.security_mode !== 'password') throw badRequest('not_password_mode')
    if (!isOpen(inv)) throw conflict('invitation_closed')
    await q.query(
      `update public.invitations set password_hash = $2, password_set_at = now(), failed_attempts = 0,
              total_failed = 0, locked_until = null where id = $1`, [id, passwordHash])
    await q.query(`update public.recipient_sessions set revoked_at = now() where invitation_id = $1 and revoked_at is null`, [id])
    await audit(q, { invitationId: id, actorType: 'sender', actorId: sender.id, eventType: 'password_reset' })
  })
  return { password: pw.display }
}

/**
 * Resend = reissue. Tokens are stored only as hashes, so the old link can't be
 * re-sent; instead the old invitation is revoked and a new one (same recipient,
 * mode, document version and password) gets a fresh link and 7-day expiry.
 */
export async function reissueInvitation(deps: Deps, sender: Sender, id: string) {
  if ((await hit(deps.db, `reissue:${id}`, 3600)) > 3) throw tooMany(3600)
  const result = await deps.db.tx(async (q) => {
    const inv = await lockOwned(q, sender, id)
    if (!isOpen(inv)) throw conflict('invitation_closed')
    await q.query(
      `update public.invitations set status = 'revoked', revoked_at = now(), revoked_reason = 'reissued' where id = $1`, [id])
    await q.query(`update public.recipient_sessions set revoked_at = now() where invitation_id = $1 and revoked_at is null`, [id])
    const next = await insertInvitation(q, {
      versionId: inv.document_version_id, senderId: sender.id, email: inv.recipient_email, mode: inv.security_mode,
      passwordHash: inv.password_hash, hideTitle: inv.hide_title, workflowVersion: deps.config.workflowVersion, replacesId: id,
    })
    await audit(q, { invitationId: id, actorType: 'sender', actorId: sender.id, eventType: 'invitation_reissued', details: { new_invitation: next.id } })
    await audit(q, { invitationId: next.id, actorType: 'sender', actorId: sender.id, eventType: 'invitation_created', details: { mode: inv.security_mode, replaces: id } })
    const title = await one<{ title: string }>(q,
      `select d.title from public.document_versions v join public.documents d on d.id = v.document_id where v.id = $1`, [inv.document_version_id])
    return { inv, next, title: inv.hide_title ? null : title!.title }
  })
  const newInv: NewInvitation = {
    id: result.next.id, email: result.inv.recipient_email, mode: result.inv.security_mode as NewInvitation['mode'],
    token: result.next.token, expiresAt: result.next.expiresAt,
  }
  const emailSent = await sendInvitationEmail(deps, sender, newInv, result.title)
  return { invitationId: newInv.id, replaces: id, expiresAt: newInv.expiresAt, emailSent }
}
