import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from '../lib/pdf'
import type { HistoryAction } from '../lib/history'
import type { Annotation, Box, ImageAnn, PageSize, Point, StrokeAnn, Tool } from '../types'
import { canvasScale, outlinePath, strokeHit, strokeOutline, strokePath2D } from '../lib/ink'
import { capturePointer, uid } from '../lib/uid'
import { ImageBox } from './ImageBox'

interface Props {
  pdf: PDFDocumentProxy
  index: number
  size: PageSize
  zoom: number
  root: HTMLElement | null
  annotations: Annotation[]
  tool: Tool
  penSize: number
  penColor: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  dispatch: (a: HistoryAction) => void
}

const ERASER_PX = 10
const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22'><circle cx='11' cy='11' r='${ERASER_PX}' fill='rgba(255,255,255,.6)' stroke='#334155' stroke-width='1.5'/></svg>`,
)}") 11 11, auto`

interface Drawing {
  pointerId: number
  rect: DOMRect
  points: Point[]
  simulate: boolean
  scale: number
}

function PageViewImpl({
  pdf,
  index,
  size,
  zoom,
  root,
  annotations,
  tool,
  penSize,
  penColor,
  selectedId,
  onSelect,
  dispatch,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pdfCanvas = useRef<HTMLCanvasElement>(null)
  const inkCanvas = useRef<HTMLCanvasElement>(null)
  const liveCanvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [erasing, setErasing] = useState<ReadonlySet<string>>(() => new Set())
  const erasingRef = useRef(new Set<string>())
  const drawing = useRef<Drawing | null>(null)
  const eraser = useRef<{ pointerId: number; rect: DOMRect; last: Point } | null>(null)
  const raf = useRef(0)

  // Only pages near the viewport keep canvases alive.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root,
      rootMargin: '1200px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  // Render the PDF page off-screen, then blit — so zooming never flashes blank.
  useEffect(() => {
    const canvas = pdfCanvas.current
    if (!canvas) return
    if (!visible) {
      canvas.width = 0
      canvas.height = 0
      setRendered(false)
      return
    }
    let cancelled = false
    let task: { cancel(): void } | null = null
    ;(async () => {
      const page = await pdf.getPage(index + 1)
      if (cancelled) return
      const vp = page.getViewport({ scale: canvasScale(size.width, size.height, zoom) })
      const off = document.createElement('canvas')
      off.width = Math.floor(vp.width)
      off.height = Math.floor(vp.height)
      const renderTask = page.render({ canvasContext: off.getContext('2d')!, viewport: vp })
      task = renderTask
      try {
        await renderTask.promise
      } catch {
        return
      }
      if (cancelled) return
      canvas.width = off.width
      canvas.height = off.height
      canvas.getContext('2d')!.drawImage(off, 0, 0)
      setRendered(true)
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, index, zoom, visible, size.width, size.height])

  // Committed ink. Layout effect so a finished stroke swaps from live → ink in the same frame.
  useLayoutEffect(() => {
    const c = inkCanvas.current
    if (!c) return
    if (!drawing.current && liveCanvas.current) {
      liveCanvas.current.width = 0
      liveCanvas.current.height = 0
    }
    if (!visible) {
      c.width = 0
      c.height = 0
      return
    }
    const s = canvasScale(size.width, size.height, zoom)
    c.width = Math.round(size.width * s)
    c.height = Math.round(size.height * s)
    const ctx = c.getContext('2d')!
    ctx.setTransform(s, 0, 0, s, 0, 0)
    for (const a of annotations) {
      if (a.kind !== 'stroke' || erasing.has(a.id)) continue
      ctx.fillStyle = a.color
      ctx.fill(strokePath2D(a))
    }
  }, [annotations, zoom, visible, erasing, size.width, size.height])

  const paintLive = useCallback(() => {
    raf.current = 0
    const d = drawing.current
    const c = liveCanvas.current
    if (!d || !c) return
    const ctx = c.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.setTransform(d.scale, 0, 0, d.scale, 0, 0)
    ctx.fillStyle = penColor
    ctx.fill(new Path2D(outlinePath(strokeOutline(d.points, penSize, d.simulate))))
  }, [penColor, penSize])

  const toPoint = (ev: PointerEvent, rect: DOMRect): Point => [
    (ev.clientX - rect.left) / zoom,
    (ev.clientY - rect.top) / zoom,
    ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5,
  ]

  const eraseAlong = (a: Point, b: Point) => {
    const r = ERASER_PX / zoom
    let hit = false
    for (const ann of annotations) {
      if (erasingRef.current.has(ann.id)) continue
      const touched =
        ann.kind === 'stroke'
          ? strokeHit(ann, a, b, r)
          : b[0] >= ann.x - r && b[0] <= ann.x + ann.w + r && b[1] >= ann.y - r && b[1] <= ann.y + ann.h + r
      if (touched) {
        erasingRef.current.add(ann.id)
        hit = true
      }
    }
    if (hit) setErasing(new Set(erasingRef.current))
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (tool === 'select') {
      if (e.target === e.currentTarget) onSelect(null)
      return
    }
    if (drawing.current || eraser.current) return // ignore a second finger
    e.preventDefault()
    capturePointer(e.currentTarget, e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const p = toPoint(e.nativeEvent, rect)
    if (tool === 'pen') {
      const scale = canvasScale(size.width, size.height, zoom)
      const c = liveCanvas.current!
      c.width = Math.round(size.width * scale)
      c.height = Math.round(size.height * scale)
      drawing.current = { pointerId: e.pointerId, rect, points: [p], simulate: e.pointerType !== 'pen', scale }
      raf.current ||= requestAnimationFrame(paintLive)
    } else {
      eraser.current = { pointerId: e.pointerId, rect, last: p }
      eraseAlong(p, p)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const native = e.nativeEvent
    const events = native.getCoalescedEvents?.() ?? []
    const list = events.length ? events : [native]
    const d = drawing.current
    if (d && d.pointerId === e.pointerId) {
      for (const ev of list) d.points.push(toPoint(ev, d.rect))
      raf.current ||= requestAnimationFrame(paintLive)
      return
    }
    const er = eraser.current
    if (er && er.pointerId === e.pointerId) {
      for (const ev of list) {
        const p = toPoint(ev, er.rect)
        eraseAlong(er.last, p)
        er.last = p
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drawing.current
    if (d && d.pointerId === e.pointerId) {
      drawing.current = null
      cancelAnimationFrame(raf.current)
      raf.current = 0
      const stroke: StrokeAnn = {
        id: uid(),
        kind: 'stroke',
        page: index,
        points: d.points,
        size: penSize,
        color: penColor,
        simulatePressure: d.simulate,
      }
      dispatch({ type: 'add', item: stroke })
      return
    }
    const er = eraser.current
    if (er && er.pointerId === e.pointerId) {
      eraser.current = null
      const ids = [...erasingRef.current]
      erasingRef.current = new Set()
      setErasing(new Set())
      if (ids.length) dispatch({ type: 'remove', ids })
    }
  }

  const onImageChange = useCallback(
    (id: string, box: Box) => dispatch({ type: 'update', id, patch: box }),
    [dispatch],
  )
  const onImageDelete = useCallback((id: string) => dispatch({ type: 'remove', ids: [id] }), [dispatch])

  const images = annotations.filter((a): a is ImageAnn => a.kind === 'image' && !erasing.has(a.id))
  const cursor = tool === 'pen' ? 'crosshair' : tool === 'eraser' ? ERASER_CURSOR : 'default'

  return (
    <div
      ref={wrapRef}
      data-page={index}
      className="relative shrink-0 bg-white shadow-md ring-1 ring-slate-900/5"
      style={{ width: size.width * zoom, height: size.height * zoom }}
    >
      {!rendered && (
        <div className="absolute inset-0 grid place-items-center text-sm text-slate-300">Page {index + 1}</div>
      )}
      <canvas ref={pdfCanvas} className="absolute inset-0 h-full w-full" />
      <canvas ref={inkCanvas} className="pointer-events-none absolute inset-0 h-full w-full" />
      <canvas ref={liveCanvas} className="pointer-events-none absolute inset-0 h-full w-full" />
      <div
        className="absolute inset-0 select-none"
        style={{ cursor, touchAction: tool === 'select' ? 'auto' : 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {images.map((img) => (
          <ImageBox
            key={img.id}
            ann={img}
            zoom={zoom}
            pageSize={size}
            interactive={tool === 'select'}
            selected={img.id === selectedId}
            onSelect={onSelect}
            onChange={onImageChange}
            onDelete={onImageDelete}
          />
        ))}
      </div>
    </div>
  )
}

export const PageView = memo(PageViewImpl)
