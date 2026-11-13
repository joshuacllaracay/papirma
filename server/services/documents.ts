import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Deps } from '../deps.js'
import type { Sender } from './senders.js'
import { requirePro } from './senders.js'
import { one } from '../db.js'
import { audit } from '../audit.js'
import { conflict, notFound, HttpError } from '../errors.js'
import { sha256, toHex } from '../crypto.js'
import { validatePdf } from '../pdfValidate.js'

export const CreateDocument = z.object({ title: z.string().trim().min(1).max(200) }).strict()

const versionPath = (ownerId: string, documentId: string, versionId: string) =>
  `orig/${ownerId}/${documentId}/${versionId}.pdf`

/** Create a library item and its first (pending) version; returns a signed upload URL. */
export async function createDocument(deps: Deps, sender: Sender, input: z.infer<typeof CreateDocument>) {
  requirePro(sender)
  const documentId = randomUUID()
  const versionId = randomUUID()
  const path = versionPath(sender.id, documentId, versionId)
  await deps.db.tx(async (q) => {
    await q.query(`insert into public.documents (id, owner_id, title) values ($1, $2, $3)`, [documentId, sender.id, input.title])
    await q.query(
      `insert into public.document_versions (id, document_id, version, storage_path) values ($1, $2, 1, $3)`,
      [versionId, documentId, path],
    )
    await audit(q, { documentId, actorType: 'sender', actorId: sender.id, eventType: 'document_created', details: { version: 1 } })
  })
  return { documentId, versionId, version: 1, uploadUrl: await deps.storage.createUploadUrl(path) }
}

async function ownedDocument(deps: Deps, sender: Sender, documentId: string) {
  const doc = await one<{ id: string; title: string }>(
    deps.db,
    `select id, title from public.documents where id = $1 and owner_id = $2 and deleted_at is null`,
    [documentId, sender.id],
  )
  if (!doc) throw notFound()
  return doc
}

/** A new file never replaces an old one: it becomes the next version. */
export async function createVersion(deps: Deps, sender: Sender, documentId: string) {
  requirePro(sender)
  await ownedDocument(deps, sender, documentId)
  const versionId = randomUUID()
  const path = versionPath(sender.id, documentId, versionId)
  const version = await deps.db.tx(async (q) => {
    await q.query(`select id from public.documents where id = $1 for update`, [documentId])
    const next = await one<{ v: number }>(q, `select coalesce(max(version), 0) + 1 as v from public.document_versions where document_id = $1`, [documentId])
    await q.query(
      `insert into public.document_versions (id, document_id, version, storage_path) values ($1, $2, $3, $4)`,
      [versionId, documentId, next!.v, path],
    )
    await audit(q, { documentId, actorType: 'sender', actorId: sender.id, eventType: 'document_version_created', details: { version: next!.v } })
    return next!.v
  })
  return { documentId, versionId, version, uploadUrl: await deps.storage.createUploadUrl(path) }
}

/** Validate the uploaded file server-side, fingerprint it and freeze the version. */
export async function finalizeVersion(deps: Deps, sender: Sender, versionId: string) {
  requirePro(sender)
  const v = await one<{ id: string; document_id: string; version: number; storage_path: string; status: string }>(
    deps.db,
    `select v.id, v.document_id, v.version, v.storage_path, v.status
       from public.document_versions v join public.documents d on d.id = v.document_id
      where v.id = $1 and d.owner_id = $2 and d.deleted_at is null`,
    [versionId, sender.id],
  )
  if (!v) throw notFound()
  if (v.status !== 'pending') throw conflict('already_finalized')

  const bytes = await deps.storage.get(v.storage_path)
  if (!bytes) throw conflict('upload_missing')

  const check = await validatePdf(bytes)
  if (!check.ok) {
    await deps.db.tx(async (q) => {
      await q.query(`update public.document_versions set status = 'rejected' where id = $1 and status = 'pending'`, [v.id])
      await audit(q, { documentId: v.document_id, actorType: 'system', eventType: 'document_version_rejected', details: { version: v.version, reason: check.reason } })
    })
    await deps.storage.remove(v.storage_path)
    throw new HttpError(422, 'invalid_pdf', { reason: check.reason })
  }

  const digest = sha256(bytes)
  const updated = await deps.db.tx(async (q) => {
    const row = await one(q,
      `update public.document_versions
          set status = 'ready', sha256 = $2, byte_size = $3, page_count = $4, ready_at = now()
        where id = $1 and status = 'pending' returning id`,
      [v.id, digest, bytes.length, check.pageCount])
    if (!row) return false
    await audit(q, {
      documentId: v.document_id, actorType: 'system', eventType: 'document_version_ready',
      details: { version: v.version, sha256: toHex(digest), pages: check.pageCount, bytes: bytes.length },
    })
    return true
  })
  if (!updated) throw conflict('already_finalized')
  return { versionId: v.id, version: v.version, sha256: toHex(digest), pageCount: check.pageCount, byteSize: bytes.length }
}

export async function listDocuments(deps: Deps, sender: Sender) {
  const rows = await deps.db.query<{
    id: string; title: string; created_at: Date; version_id: string | null; version: number | null
    page_count: number | null; sha256: Uint8Array | null; open_invitations: number
  }>(
    `select d.id, d.title, d.created_at, v.id as version_id, v.version, v.page_count, v.sha256,
            (select count(*)::int from public.invitations i join public.document_versions dv on dv.id = i.document_version_id
              where dv.document_id = d.id and i.status in ('pending','opened','completing')) as open_invitations
       from public.documents d
       left join lateral (
         select id, version, page_count, sha256 from public.document_versions
          where document_id = d.id and status = 'ready' order by version desc limit 1) v on true
      where d.owner_id = $1 and d.deleted_at is null
      order by d.created_at desc limit 200`,
    [sender.id],
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    latestVersion: r.version_id
      ? { id: r.version_id, version: r.version, pageCount: r.page_count, sha256: r.sha256 ? toHex(r.sha256) : null }
      : null,
    openInvitations: r.open_invitations,
  }))
}

/** Soft delete; refused while any invitation could still be signed. Files are purged by the retention job. */
export async function deleteDocument(deps: Deps, sender: Sender, documentId: string) {
  await ownedDocument(deps, sender, documentId)
  await deps.db.tx(async (q) => {
    const open = await one<{ n: number }>(q,
      `select count(*)::int as n from public.invitations i join public.document_versions v on v.id = i.document_version_id
        where v.document_id = $1 and i.status in ('pending','opened','completing')`, [documentId])
    if (open!.n > 0) throw conflict('has_open_invitations', { openInvitations: open!.n })
    await q.query(`update public.documents set deleted_at = now() where id = $1 and deleted_at is null`, [documentId])
    await audit(q, { documentId, actorType: 'sender', actorId: sender.id, eventType: 'document_deleted' })
  })
  return { ok: true }
}
