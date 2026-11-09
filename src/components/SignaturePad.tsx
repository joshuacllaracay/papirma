import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Point } from '../types'
import { outlinePath, strokeOutline } from '../lib/ink'
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

export function SignaturePad({ initialColor, onSave, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<PadStroke[]>([])
  const current = useRef<(PadStroke & { pointerId: number }) | null>(null)
  const raf = useRef(0)
  const [color, setColor] = useState(initialColor)
  const [empty, setEmpty] = useState(true)

  const paint = useCallback(() => {
    raf.current = 0
    const c = canvasRef.current
    if (!c) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const ctx = c.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = color
    const all = current.current ? [...strokes.current, current.current] : strokes.current
    for (const s of all) ctx.fill(new Path2D(outlinePath(strokeOutline(s.points, PAD_SIZE, s.simulate))))
  }, [color])

  useLayoutEffect(() => {
    const c = canvasRef.current!
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      c.width = Math.round(c.clientWidth * dpr)
      c.height = Math.round(c.clientHeight * dpr)
      paint()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(c)
    return () => ro.disconnect()
  }, [paint])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pt = (e: PointerEvent): Point => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5]
  }

  const clear = () => {
    strokes.current = []
    current.current = null
    setEmpty(true)
    paint()
  }

  const save = () => {
    if (!strokes.current.length) return
    const c = canvasRef.current!
    const scale = 3
    const out = document.createElement('canvas')
    out.width = c.clientWidth * scale
    out.height = c.clientHeight * scale
    const ctx = out.getContext('2d')!
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.fillStyle = color
    for (const s of strokes.current) ctx.fill(new Path2D(outlinePath(strokeOutline(s.points, PAD_SIZE, s.simulate))))
    const trimmed = trimCanvas(out, 6)
    onSave({ src: trimmed.toDataURL('image/png'), w: trimmed.width, h: trimmed.height })
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm"
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
          <canvas
            ref={canvasRef}
            className="block h-52 w-full cursor-crosshair"
            style={{ touchAction: 'none' }}
            onPointerDown={(e) => {
              if (current.current) return
              capturePointer(e.currentTarget, e.pointerId)
              current.current = { pointerId: e.pointerId, points: [pt(e.nativeEvent)], simulate: e.pointerType !== 'pen' }
              setEmpty(false)
              raf.current ||= requestAnimationFrame(paint)
            }}
            onPointerMove={(e) => {
              const s = current.current
              if (!s || s.pointerId !== e.pointerId) return
              const evs = e.nativeEvent.getCoalescedEvents?.() ?? []
              for (const ev of evs.length ? evs : [e.nativeEvent]) s.points.push(pt(ev))
              raf.current ||= requestAnimationFrame(paint)
            }}
            onPointerUp={(e) => {
              const s = current.current
              if (!s || s.pointerId !== e.pointerId) return
              strokes.current.push({ points: s.points, simulate: s.simulate })
              current.current = null
              paint()
            }}
            onPointerCancel={() => {
              current.current = null
              paint()
            }}
          />
          <div className="pointer-events-none absolute right-8 bottom-12 left-8 border-b border-dashed border-slate-300" />
          {empty && (
            <span className="pointer-events-none absolute inset-x-0 bottom-5 text-center text-xs text-slate-400">
              Sign above the line with your mouse, finger or stylus
            </span>
          )}
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
