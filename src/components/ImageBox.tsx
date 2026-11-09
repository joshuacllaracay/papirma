import { memo, useRef, useState } from 'react'
import type { Box, ImageAnn, PageSize } from '../types'
import { Icon } from './Icon'
import { capturePointer } from '../lib/uid'

interface Props {
  ann: ImageAnn
  zoom: number
  pageSize: PageSize
  interactive: boolean
  selected: boolean
  onSelect: (id: string) => void
  onChange: (id: string, box: Box) => void
  onDelete: (id: string) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const ImageBox = memo(function ImageBox({
  ann,
  zoom,
  pageSize,
  interactive,
  selected,
  onSelect,
  onChange,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<Box | null>(null)
  const draftRef = useRef<Box | null>(null)
  const drag = useRef<{ mode: 'move' | 'resize'; cx: number; cy: number; start: Box } | null>(null)
  const g = draft ?? ann

  const begin = (mode: 'move' | 'resize') => (e: React.PointerEvent<HTMLElement>) => {
    if (!interactive || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.stopPropagation()
    e.preventDefault()
    onSelect(ann.id)
    capturePointer(e.currentTarget, e.pointerId)
    drag.current = { mode, cx: e.clientX, cy: e.clientY, start: { x: ann.x, y: ann.y, w: ann.w, h: ann.h } }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.cx) / zoom
    const dy = (e.clientY - d.cy) / zoom
    const s = d.start
    let next: Box
    if (d.mode === 'move') {
      next = {
        ...s,
        x: clamp(s.x + dx, 0, Math.max(0, pageSize.width - s.w)),
        y: clamp(s.y + dy, 0, Math.max(0, pageSize.height - s.h)),
      }
    } else {
      const aspect = s.h / s.w
      let w = clamp(s.w + dx, 24, pageSize.width - s.x)
      let h = w * aspect
      if (s.y + h > pageSize.height) {
        h = pageSize.height - s.y
        w = h / aspect
      }
      next = { ...s, w, h }
    }
    draftRef.current = next
    setDraft(next)
  }

  const end = () => {
    const d = draftRef.current
    drag.current = null
    draftRef.current = null
    if (d && (d.x !== ann.x || d.y !== ann.y || d.w !== ann.w)) onChange(ann.id, d)
    setDraft(null)
  }

  const active = selected && interactive

  return (
    <div
      className={`absolute ${interactive ? 'cursor-move' : ''} ${
        active ? 'outline-2 outline-offset-2 outline-indigo-500 outline-dashed' : interactive ? 'hover:outline hover:outline-indigo-300' : ''
      }`}
      style={{
        left: g.x * zoom,
        top: g.y * zoom,
        width: g.w * zoom,
        height: g.h * zoom,
        pointerEvents: interactive ? 'auto' : 'none',
        touchAction: 'none',
      }}
      onPointerDown={begin('move')}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img src={ann.src} alt="Signature" draggable={false} className="pointer-events-none h-full w-full select-none" />
      {active && (
        <>
          <button
            type="button"
            title="Remove (Delete)"
            className="absolute -top-3.5 -right-3.5 grid h-7 w-7 place-items-center rounded-full bg-white text-slate-600 shadow ring-1 ring-slate-200 hover:bg-red-50 hover:text-red-600"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onDelete(ann.id)}
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
          <div
            title="Resize"
            className="absolute -right-2 -bottom-2 h-4 w-4 cursor-nwse-resize rounded-sm border-2 border-indigo-500 bg-white"
            onPointerDown={begin('resize')}
          />
        </>
      )}
    </div>
  )
})
