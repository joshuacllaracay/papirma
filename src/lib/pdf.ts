import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PageSize } from '../types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type { PDFDocumentProxy }

/** pdf.js takes ownership of the buffer it is given, so it gets a copy. */
export function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: bytes.slice() }).promise
}

export async function getPageSizes(pdf: PDFDocumentProxy): Promise<PageSize[]> {
  return Promise.all(
    Array.from({ length: pdf.numPages }, async (_, i) => {
      const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 })
      return { width: vp.width, height: vp.height }
    }),
  )
}
