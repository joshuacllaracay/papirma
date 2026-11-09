import type { Tool } from '../types'
import { Icon } from './Icon'
import { PEN_COLORS } from '../lib/colors'

interface Props {
  disabled: boolean
  tool: Tool
  onTool: (t: Tool) => void
  penSize: number
  onPenSize: (n: number) => void
  penColor: string
  onPenColor: (c: string) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
}

const btn =
  'grid h-9 w-9 place-items-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40'

function ToolButton({ active, label, onClick, disabled, children }: {
  active: boolean
  label: string
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`${btn} ${active ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50 hover:text-indigo-700' : ''}`}
    >
      {children}
    </button>
  )
}

const Divider = () => <div className="mx-1 h-6 w-px bg-slate-200" />

export function Toolbar(p: Props) {
  const d = p.disabled
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5">
      <ToolButton active={p.tool === 'select'} label="Select & move (V)" onClick={() => p.onTool('select')} disabled={d}>
        <Icon name="select" />
      </ToolButton>
      <ToolButton active={p.tool === 'pen'} label="Pen (P)" onClick={() => p.onTool('pen')} disabled={d}>
        <Icon name="pen" />
      </ToolButton>
      <ToolButton active={p.tool === 'eraser'} label="Eraser (E)" onClick={() => p.onTool('eraser')} disabled={d}>
        <Icon name="eraser" />
      </ToolButton>

      <Divider />

      <label className={`flex items-center gap-2 px-1 text-xs text-slate-500 ${d ? 'opacity-40' : ''}`} title="Ink thickness">
        <span className="hidden sm:inline">Thickness</span>
        <input
          type="range"
          min={1}
          max={16}
          step={0.5}
          value={p.penSize}
          disabled={d}
          onChange={(e) => {
            p.onPenSize(Number(e.target.value))
            p.onTool('pen')
          }}
          className="w-24 accent-indigo-600"
        />
        <span className="grid h-7 w-7 place-items-center">
          <span
            className="rounded-full"
            style={{ width: Math.max(2, p.penSize * 1.2), height: Math.max(2, p.penSize * 1.2), background: p.penColor }}
          />
        </span>
      </label>

      <div className="flex items-center gap-1 px-1">
        {PEN_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            title={c.label}
            aria-label={`${c.label} ink`}
            aria-pressed={p.penColor === c.value}
            disabled={d}
            onClick={() => {
              p.onPenColor(c.value)
              p.onTool('pen')
            }}
            className={`h-6 w-6 rounded-full ring-offset-2 transition disabled:opacity-40 ${
              p.penColor === c.value ? 'ring-2 ring-indigo-500' : 'ring-1 ring-slate-300 hover:ring-slate-400'
            }`}
            style={{ background: c.value }}
          />
        ))}
      </div>

      <Divider />

      <button type="button" className={btn} title="Undo (Ctrl+Z)" aria-label="Undo" disabled={d || !p.canUndo} onClick={p.onUndo}>
        <Icon name="undo" />
      </button>
      <button type="button" className={btn} title="Redo (Ctrl+Y)" aria-label="Redo" disabled={d || !p.canRedo} onClick={p.onRedo}>
        <Icon name="redo" />
      </button>

      <div className="ml-auto flex items-center gap-1">
        <button type="button" className={btn} title="Zoom out" aria-label="Zoom out" disabled={d} onClick={p.onZoomOut}>
          <Icon name="minus" />
        </button>
        <span className="w-12 text-center text-xs tabular-nums text-slate-500">{Math.round(p.zoom * 100)}%</span>
        <button type="button" className={btn} title="Zoom in" aria-label="Zoom in" disabled={d} onClick={p.onZoomIn}>
          <Icon name="plus" />
        </button>
        <button type="button" className={btn} title="Fit width" aria-label="Fit width" disabled={d} onClick={p.onFit}>
          <Icon name="fit" />
        </button>
      </div>
    </div>
  )
}
