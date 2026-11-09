export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not read that image'))
    img.src = src
  })
}

/** Crop a canvas to its non-transparent pixels (plus padding). */
export function trimCanvas(canvas: HTMLCanvasElement, pad = 4): HTMLCanvasElement {
  const ctx = canvas.getContext('2d')!
  const { width, height } = canvas
  const data = ctx.getImageData(0, 0, width, height).data
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return canvas
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)
  const out = document.createElement('canvas')
  out.width = maxX - minX + 1
  out.height = maxY - minY + 1
  out.getContext('2d')!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
  return out
}

/**
 * Turn an uploaded signature photo/scan into a transparent PNG:
 * white/light paper becomes transparent, the image is trimmed and downscaled.
 */
export async function prepareSignatureImage(src: string): Promise<{ src: string; w: number; h: number }> {
  const img = await loadImage(src)
  const maxDim = 1000
  const s = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * s))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * s))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = image.data
  let hasTransparency = false
  for (let i = 3; i < d.length; i += 4 * 16) {
    if (d[i] < 250) {
      hasTransparency = true
      break
    }
  }
  if (!hasTransparency) {
    const hi = 225, lo = 150
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      if (lum >= hi) d[i + 3] = 0
      else if (lum > lo) d[i + 3] = Math.round(d[i + 3] * ((hi - lum) / (hi - lo)))
    }
    ctx.putImageData(image, 0, 0)
  }

  const trimmed = trimCanvas(canvas)
  return { src: trimmed.toDataURL('image/png'), w: trimmed.width, h: trimmed.height }
}
