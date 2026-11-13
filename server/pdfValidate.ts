import { PDFDocument } from 'pdf-lib'

export const MAX_PDF_BYTES = 25 * 1024 * 1024
export const MAX_PDF_PAGES = 300

export type PdfCheck = { ok: true; pageCount: number } | { ok: false; reason: string }

/** Server-side gate for uploaded originals: size, signature bytes, parseable, unencrypted, page limit. */
export async function validatePdf(bytes: Uint8Array): Promise<PdfCheck> {
  if (bytes.length === 0) return { ok: false, reason: 'empty' }
  if (bytes.length > MAX_PDF_BYTES) return { ok: false, reason: 'too_large' }
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  if (!head.includes('%PDF-')) return { ok: false, reason: 'not_pdf' }
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (err) {
    const msg = err instanceof Error ? `${err.name} ${err.message}` : ''
    return { ok: false, reason: /encrypt/i.test(msg) ? 'encrypted' : 'unreadable' }
  }
  const pageCount = doc.getPageCount()
  if (pageCount < 1) return { ok: false, reason: 'no_pages' }
  if (pageCount > MAX_PDF_PAGES) return { ok: false, reason: 'too_many_pages' }
  return { ok: true, pageCount }
}
