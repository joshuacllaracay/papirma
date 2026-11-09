import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Point } from '../types'
import { liveContext, outlinePath, predictedPoints, strokeOutline } from '../lib/ink'
import { trimCanvas } from '../lib/image'
import { capturePointer } from '../lib/uid'
import { PEN_COLORS } from '../lib/colors'

interface Props {
  initialColor: string
  onSave: (sig: { src: string; w: number; h: number }) => void
  onClose: () => void
}

interface PadStroke {
  points: Point[]
  simulate: boolean
}

const PAD_SIZE = 4
const dprOf = () => Math.min(window.devicePixelRatio || 1, 2)
const strokeFill = (s: PadStroke, extra: Point[] = []) =>
  new Path2D(outlinePath(strokeOutline(extra.length ? [...s.points, ...extra] : s.points, PAD_SIZE, s.simulate)))

export function SignaturePad({ initialColor, onSave, onClose }: Props) {
  // Two layers: finished strokes are painted once onto `base`; only the stroke
  // in progress is redrawn each frame on `live`, so cost doesn't grow as you write.
  const baseRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<PadStroke[]>([])
  const current = useRef<(PadStroke & { pointerId: number; predicted: Point[] }) | null>(null)
  const raf = useRef(0)
  const [color, setColor] = useState(initialColor)
  const [empty, setEmpty] = useState(true)

  const paintBase = useCallback(() => {
    const c = baseRef.current
    if (!c) return
    const dpr = dprOf()
    const ctx = c.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = color
    for (const s of strokes.current) ctx.fill(strokeFill(s))
  }, [color])

  const paintLive = useCallback(() => {
    raf.current = 0
    const c = liveRef.current
    if (!c) return
    const dpr = dprOf()
    const ctx = liveContext(c)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    const s = current.current
    if (!s) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = color
    ctx.fill(strokeFill(s, s.predicted))
  }, [color])

  useLayoutEffect(() => {
    const base = baseRef.current!
    const live = liveRef.current!
    const resize = () => {
      const dpr = dprOf()
      for (const c of [base, live]) {
        c.width = Math.round(base.clientWidth * dpr)
        c.height = Math.round(base.clientHeight * dpr)
      }
      paintBase()
      paintLive()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(base)
    return () => ro.disconnect()
  }, [paintBase, paintLive])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rectRef = useRef<DOMRect | null>(null)
  const pt = (e: PointerEvent): Point => {
    const r = rectRef.current ?? liveRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5]
  }

  const finish = (keep: boolean) => {
    const s = current.current
    current.current = null
    cancelAnimationFrame(raf.current)
    raf.current = 0
    if (s && keep) {
      const stroke = { points: s.points, simulate: s.simulate }
      strokes.current.push(stroke)
      // Paint just the new stroke onto the base layer — no full redraw.
      const c = baseRef.current!
      const ctx = c.getContext('2d')!
      const dpr = dprOf()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = color
      ctx.fill(strokeFill(stroke))
    }
    paintLive()
  }

  const clear = () => {
    strokes.current = []
    current.current = null
    setEmpty(true)
    paintBase()
    paintLive()
  }

  const save = () => {
    if (!strokes.current.length) return
    const c = baseRef.current!
    const scale = 3
    const out = document.createElement('canvas')
    out.width = c.clientWidth * scale
    out.height = c.clientHeight * scale
    const ctx = out.getContext('2d')!
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.fillStyle = color
    for (const s of strokes.current) ctx.fill(strokeFill(s))
    const trimmed = trimCanvas(out, 6)
    onSave({ src: trimmed.toDataURL('image/png'), w: trimmed.width, h: trimmed.height })
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl" role="dialog" aria-label="Draw your signature">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Draw your signature</h2>
          <div className="flex items-center gap-1.5">
            {PEN_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-label={`${c.label} ink`}
                onClick={() => setColor(c.value)}
                className={`h-6 w-6 rounded-full ring-offset-2 ${color === c.value ? 'ring-2 ring-indigo-500' : 'ring-1 ring-slate-300'}`}
                style={{ background: c.value }}
              />
            ))}
          </div>
        </div>
        <div className="relative rounded-xl border border-slate-200 bg-slate-50">
          <div className="pointer-events-none absolute right-8 bottom-12 left-8 border-b border-dashed border-slate-300" />
          {empty && (
            <span className="pointer-events-none absolute inset-x-0 bottom-5 text-center text-xs text-slate-400">
              Sign above the line with your mouse, finger or stylus
            </span>
          )}
          <canvas ref={baseRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          <canvas
            ref={liveRef}
            className="relative block h-52 w-full cursor-crosshair"
            style={{ touchAction: 'none' }}
            onPointerDown={(e) => {
              if (current.current) return
              capturePointer(e.currentTarget, e.pointerId)
              rectRef.current = e.currentTarget.getBoundingClientRect()
              current.current = {
                pointerId: e.pointerId,
                points: [pt(e.nativeEvent)],
                simulate: e.pointerType !== 'pen',
                predicted: [],
              }
              setEmpty(false)
              paintLive()
            }}
            onPointerMove={(e) => {
              const s = current.current
              if (!s || s.pointerId !== e.pointerId) return
              const native = e.nativeEvent
              const evs = native.getCoalescedEvents?.() ?? []
              for (const ev of evs.length ? evs : [native]) s.points.push(pt(ev))
              s.predicted = predictedPoints(native, pt)
              raf.current ||= requestAnimationFrame(paintLive)
            }}
            onPointerUp={(e) => {
              if (current.current?.pointerId === e.pointerId) finish(true)
            }}
            onPointerCancel={() => finish(false)}
          />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <button type="button" onClick={clear} className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">
            Clear
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={empty}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              Save & place
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
