import { useRef } from 'react'
import type { SavedSignature } from '../types'
import { Icon } from './Icon'

interface Props {
  signatures: SavedSignature[]
  canPlace: boolean
  onDraw: () => void
  onUpload: (file: File) => void
  onPlace: (sig: SavedSignature) => void
  onDelete: (id: string) => void
}

export function SignaturePanel({ signatures, canPlace, onDraw, onUpload, onPlace, onDelete }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const action =
    'flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700'

  return (
    <aside className="flex shrink-0 gap-2 overflow-x-auto border-b border-slate-200 bg-white p-3 md:w-64 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0">
      <h2 className="hidden px-1 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase md:block">
        My signatures
      </h2>
      <button type="button" className={action} onClick={onDraw}>
        <Icon name="signature" className="h-4 w-4" />
        Draw signature
      </button>
      <button type="button" className={action} onClick={() => input.current?.click()}>
        <Icon name="image" className="h-4 w-4" />
        Upload signature
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onUpload(f)
          e.target.value = ''
        }}
      />

      {signatures.length > 0 && (
        <p className="hidden px-1 pt-3 text-xs text-slate-400 md:block">
          {canPlace ? 'Click a signature to place it on the page.' : 'Open a PDF to place a signature.'}
        </p>
      )}

      {signatures.map((s) => (
        <div key={s.id} className="group relative shrink-0">
          <button
            type="button"
            title={canPlace ? 'Place on page' : 'Open a PDF first'}
            disabled={!canPlace}
            onClick={() => onPlace(s)}
            className="flex h-16 w-36 items-center justify-center rounded-lg border border-slate-200 bg-[repeating-conic-gradient(#f8fafc_0_25%,#fff_0_50%)] bg-[length:12px_12px] p-2 transition hover:border-indigo-400 hover:shadow-sm disabled:cursor-not-allowed md:w-full"
          >
            <img src={s.src} alt="Saved signature" className="max-h-full max-w-full object-contain" draggable={false} />
          </button>
          <button
            type="button"
            title="Delete saved signature"
            aria-label="Delete saved signature"
            onClick={() => onDelete(s.id)}
            className="absolute top-1 right-1 grid h-6 w-6 place-items-center rounded-full bg-white/90 text-slate-500 opacity-100 shadow-sm ring-1 ring-slate-200 transition hover:text-red-600 md:opacity-0 md:group-hover:opacity-100"
          >
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </aside>
  )
}
