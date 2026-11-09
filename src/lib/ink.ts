import { getStroke } from 'perfect-freehand'
import type { Point, StrokeAnn } from '../types'

export function strokeOutline(points: Point[], size: number, simulatePressure: boolean): number[][] {
  return getStroke(points, {
    size,
    thinning: 0.55,
    smoothing: 0.5,
    // Low streamline = ink stays right under the pointer (high values make the line trail behind).
    streamline: 0.2,
    simulatePressure,
    last: true,
  })
}

type MapPoint = (x: number, y: number) => [number, number]
const identity: MapPoint = (x, y) => [x, y]

/** Closed, smoothed SVG path through an outline polygon (quadratic curves via midpoints). */
export function outlinePath(outline: number[][], map: MapPoint = identity): string {
  const n = outline.length
  if (n < 2) return ''
  const fmt = (x: number, y: number) => {
    const [a, b] = map(x, y)
    return `${a.toFixed(2)},${b.toFixed(2)}`
  }
  const mid = (p: number[], q: number[]) => fmt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
  let d = `M${mid(outline[n - 1], outline[0])}`
  for (let i = 0; i < n; i++) {
    const p = outline[i]
    const q = outline[(i + 1) % n]
    d += ` Q${fmt(p[0], p[1])} ${mid(p, q)}`
  }
  return d + 'Z'
}

/**
 * 2D context tuned for live ink: `desynchronized` lets the browser show strokes
 * without waiting for the page compositor (lower latency where supported).
 */
export function liveContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return (canvas.getContext('2d', { desynchronized: true }) ?? canvas.getContext('2d'))!
}

/** Points the browser predicts the pointer will reach next — drawn, never stored. */
export function predictedPoints(e: PointerEvent, toPoint: (ev: PointerEvent) => Point): Point[] {
  const pred = e.getPredictedEvents?.() ?? []
  return pred.slice(0, 2).map(toPoint)
}

const pathCache =new WeakMap<StrokeAnn, Path2D>()

export function strokePath2D(s: StrokeAnn): Path2D {
  let p = pathCache.get(s)
  if (!p) {
    p = new Path2D(outlinePath(strokeOutline(s.points, s.size, s.simulatePressure)))
    pathCache.set(s, p)
  }
  return p
}

/** Backing-store scale for a canvas covering a page, capped so huge zooms don't exhaust memory. */
export function canvasScale(width: number, height: number, zoom: number): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  return Math.min(zoom * dpr, Math.sqrt(14_000_000 / (width * height)))
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Does the eraser path a→b (radius r) touch this stroke? */
export function strokeHit(s: StrokeAnn, a: Point, b: Point, r: number): boolean {
  const rr = r + s.size / 2
  for (const p of s.points) {
    if (distToSegment(p[0], p[1], a[0], a[1], b[0], b[1]) <= rr) return true
  }
  return false
}
