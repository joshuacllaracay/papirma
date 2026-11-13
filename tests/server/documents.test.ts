import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { createHarness, makePdf, type Harness } from '../helpers/harness.js'

describe('document library', () => {
  let h: Harness
  let a: Awaited<ReturnType<Harness['createSender']>>
  let b: Awaited<ReturnType<Harness['createSender']>>

  beforeAll(async () => {
    h = await createHarness()
    a = await h.createSender()
    b = await h.createSender()
  })

  it('fingerprints the uploaded original with SHA-256 computed on the server', async () => {
    const pdf = await makePdf(2)
    const doc = await h.uploadDocument(a, pdf)
    expect(doc.sha256).toBe(createHash('sha256').update(pdf).digest('hex'))
    const list = await h.call('GET', 'documents', { bearer: a.bearer })
    expect(list.body.documents[0].latestVersion).toMatchObject({ pageCount: 2, sha256: doc.sha256 })
  })

  it('requires the Pro plan', async () => {
    const free = await h.createSender({ plan: 'free' })
    const r = await h.call('POST', 'documents', { bearer: free.bearer, body: { title: 'x' } })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('pro_required')
  })

  it('requires sign-in', async () => {
    expect((await h.call('GET', 'documents')).status).toBe(401)
    expect((await h.call('GET', 'documents', { bearer: 'test-token-not-a-real-user-0000' })).status).toBe(401)
  })

  it('a new upload becomes a new version; the old version is untouched', async () => {
    const doc = await h.uploadDocument(a)
    const v2 = await h.call('POST', `documents/${doc.documentId}/versions`, { bearer: a.bearer })
    expect(v2.status).toBe(201)
    expect(v2.body.version).toBe(2)
    expect(v2.body.versionId).not.toBe(doc.versionId)
    const [old] = await h.db.admin.query<{ status: string }>(`select status from public.document_versions where id = $1`, [doc.versionId])
    expect(old.status).toBe('ready')
  })

  it('cannot finalize twice', async () => {
    const doc = await h.uploadDocument(a)
    const again = await h.call('POST', `document-versions/${doc.versionId}/finalize`, { bearer: a.bearer })
    expect(again.status).toBe(409)
  })

  describe('T-11 cross-user access isolation', () => {
    it("another sender cannot see, change or use someone else's documents", async () => {
      const doc = await h.uploadDocument(a)
      const created = await h.call('POST', 'documents', { bearer: a.bearer, body: { title: 'Pending' } })
      const bList = await h.call('GET', 'documents', { bearer: b.bearer })
      expect(bList.body.documents.some((d: { id: string }) => d.id === doc.documentId)).toBe(false)
      expect((await h.call('POST', `documents/${doc.documentId}/versions`, { bearer: b.bearer })).status).toBe(404)
      expect((await h.call('DELETE', `documents/${doc.documentId}`, { bearer: b.bearer })).status).toBe(404)
      expect((await h.call('POST', `document-versions/${created.body.versionId}/finalize`, { bearer: b.bearer })).status).toBe(404)
      const inv = await h.call('POST', 'invitations', { bearer: b.bearer, body: { documentVersionId: doc.versionId, recipients: [{ email: 'x@example.com', mode: 'link' }] } })
      expect(inv.status).toBe(404)
    })
  })

  describe('T-27 PDF validation', () => {
    const tryUpload = async (bytes: Uint8Array) => {
      const created = await h.call('POST', 'documents', { bearer: a.bearer, body: { title: 'Bad file' } })
      const path = h.storage.issued.at(-1)!.path
      h.storage.simulateClientUpload(path, bytes)
      const fin = await h.call('POST', `document-versions/${created.body.versionId}/finalize`, { bearer: a.bearer })
      const [v] = await h.db.admin.query<{ status: string }>(`select status from public.document_versions where id = $1`, [created.body.versionId])
      return { fin, status: v.status, stillStored: h.storage.objects.has(path) }
    }

    it('rejects a non-PDF renamed to .pdf', async () => {
      const r = await tryUpload(new TextEncoder().encode('<html><script>alert(1)</script></html>'))
      expect(r.fin.status).toBe(422)
      expect(r.fin.body.reason).toBe('not_pdf')
      expect(r.status).toBe('rejected')
      expect(r.stillStored).toBe(false)
    })

    it('rejects encrypted PDFs', async () => {
      const doc = await PDFDocument.create()
      doc.addPage()
      doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2 })
      const r = await tryUpload(await doc.save())
      expect(r.fin.body.reason).toBe('encrypted')
    })

    it('rejects truncated or corrupt PDFs', async () => {
      const r = await tryUpload(new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog'))
      expect(r.fin.status).toBe(422)
      expect(['unreadable', 'no_pages']).toContain(r.fin.body.reason)
    })

    it('rejects files over 25 MiB', async () => {
      const big = new Uint8Array(25 * 1024 * 1024 + 1)
      big.set(new TextEncoder().encode('%PDF-1.7\n'))
      const r = await tryUpload(big)
      expect(r.fin.body.reason).toBe('too_large')
    })

    it('rejects more than 300 pages', async () => {
      const r = await tryUpload(await makePdf(301))
      expect(r.fin.body.reason).toBe('too_many_pages')
    })

    it('reports a missing upload instead of finalizing', async () => {
      const created = await h.call('POST', 'documents', { bearer: a.bearer, body: { title: 'Never uploaded' } })
      const fin = await h.call('POST', `document-versions/${created.body.versionId}/finalize`, { bearer: a.bearer })
      expect(fin.status).toBe(409)
      expect(fin.body.error).toBe('upload_missing')
    })
  })

  it('refuses to delete a document while invitations are open', async () => {
    const doc = await h.uploadDocument(a)
    const [inv] = await h.invite(a, doc.versionId, [{ email: 'del@example.com', mode: 'link' }])
    expect((await h.call('DELETE', `documents/${doc.documentId}`, { bearer: a.bearer })).body.error).toBe('has_open_invitations')
    await h.call('POST', `invitations/${inv.invitationId}/revoke`, { bearer: a.bearer, body: {} })
    expect((await h.call('DELETE', `documents/${doc.documentId}`, { bearer: a.bearer })).status).toBe(200)
  })
})
