import { PDFDocument, degrees, rgb, type PDFImage } from 'pdf-lib'
import type { PDFDocumentProxy } from './pdf'
import type { Annotation } from '../types'
import { outlinePath, strokeOutline } from './ink'

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

function dataUrlToBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Burn strokes and signature images into the original PDF.
 * Annotation coordinates live in pdf.js viewport space (scale 1, top-left origin,
 * page rotation applied); viewport.convertToPdfPoint maps them back to PDF user
 * space, so rotated pages and offset crop boxes come out right.
 */
export async function exportSignedPdf(
  originalBytes: Uint8Array,
  pdf: PDFDocumentProxy,
  annotations: Annotation[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true })
  const pages = doc.getPages()
  const images = new Map<string, PDFImage>()

  const byPage = new Map<number, Annotation[]>()
  for (const a of annotations) {
    const list = byPage.get(a.page) ?? []
    list.push(a)
    byPage.set(a.page, list)
  }

  for (const [pageIndex, anns] of byPage) {
    const page = pages[pageIndex]
    if (!page) continue
    const vp = (await pdf.getPage(pageIndex + 1)).getViewport({ scale: 1 })
    const toPdf = (x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number]

    for (const a of anns) {
      if (a.kind === 'stroke') {
        const outline = strokeOutline(a.points, a.size, a.simulatePressure)
        // drawSvgPath flips Y (SVG is y-down), so feed it -y to land on PDF coordinates.
        const d = outlinePath(outline, (x, y) => {
          const [px, py] = toPdf(x, y)
          return [px, -py]
        })
        if (d) page.drawSvgPath(d, { x: 0, y: 0, color: hexToRgb(a.color), borderWidth: 0 })
      } else {
        let img = images.get(a.src)
        if (!img) {
          img = await doc.embedPng(dataUrlToBytes(a.src))
          images.set(a.src, img)
        }
        const [x0, y0] = toPdf(a.x, a.y + a.h) // bottom-left of the box
        const [x1, y1] = toPdf(a.x + a.w, a.y + a.h) // bottom-right
        const angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI
        page.drawImage(img, { x: x0, y: y0, width: a.w, height: a.h, rotate: degrees(angle) })
      }
    }
  }

  return doc.save()
}

export function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
