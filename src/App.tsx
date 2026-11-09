import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Annotation, ImageAnn, PageSize, SavedSignature, Tool } from './types'
import { historyReducer, initialHistory } from './lib/history'
import { getPageSizes, loadPdf, type PDFDocumentProxy } from './lib/pdf'
import { prepareSignatureImage, readFileAsDataURL } from './lib/image'
import { uid } from './lib/uid'
import { PageView } from './components/PageView'
import { Toolbar } from './components/Toolbar'
import { PEN_COLORS } from './lib/colors'
import { SignaturePanel } from './components/SignaturePanel'
import { SignaturePad } from './components/SignaturePad'
import { Icon } from './components/Icon'

const SIG_KEY = 'papirma.signatures'
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const clampZoom = (z: number) => Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100

function loadSignatures(): SavedSignature[] {
  try {
    const raw = localStorage.getItem(SIG_KEY)
    return raw ? (JSON.parse(raw) as SavedSignature[]) : []
  } catch {
    return []
  }
}

/** Group annotations per page, reusing the previous array for pages that didn't change (keeps memoized pages idle). */
function useByPage(annotations: Annotation[], pageCount: number): Annotation[][] {
  const prev = useRef<Annotation[][]>([])
  return useMemo(() => {
    const groups: Annotation[][] = Array.from({ length: pageCount }, () => [])
    for (const a of annotations) groups[a.page]?.push(a)
    const out = groups.map((g, i) => {
      const p = prev.current[i]
      return p && p.length === g.length && p.every((x, j) => x === g[j]) ? p : g
    })
    prev.current = out
    return out
  }, [annotations, pageCount])
}

export default function App() {
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageSizes, setPageSizes] = useState<PageSize[]>([])
  const [zoom, setZoom] = useState(1)
  const [tool, setTool] = useState<Tool>('pen')
  const [penSize, setPenSize] = useState(3)
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value)
  const [history, dispatch] = useReducer(historyReducer, initialHistory)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [signatures, setSignatures] = useState<SavedSignature[]>(loadSignatures)
  const [padOpen, setPadOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const scrollAnchor = useRef<number | null>(null)

  const annotations = history.present
  const byPage = useByPage(annotations, pageSizes.length)
  const maxPageWidth = useMemo(() => Math.max(0, ...pageSizes.map((s) => s.width)), [pageSizes])

  useEffect(() => {
    try {
      localStorage.setItem(SIG_KEY, JSON.stringify(signatures))
    } catch {
      /* storage full or blocked — signatures just won't persist */
    }
  }, [signatures])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    if (!annotations.length) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [annotations.length])

  // ---- zoom (keeps the centre of the view steady) ----
  const changeZoom = useCallback(
    (next: number) => {
      if (scrollEl) scrollAnchor.current = (scrollEl.scrollTop + scrollEl.clientHeight / 2) / scrollEl.scrollHeight
      setZoom(clampZoom(next))
    },
    [scrollEl],
  )

  useLayoutEffect(() => {
    if (scrollEl && scrollAnchor.current != null) {
      scrollEl.scrollTop = scrollAnchor.current * scrollEl.scrollHeight - scrollEl.clientHeight / 2
      scrollAnchor.current = null
    }
  }, [zoom, scrollEl])

  const fitZoom = useCallback(
    (widest = maxPageWidth) => {
      if (!scrollEl || !widest) return 1
      // 48px page padding + room for a vertical scrollbar that may not exist yet
      return Math.floor(Math.min(1.5, (scrollEl.clientWidth - 68) / widest) * 100) / 100
    },
    [scrollEl, maxPageWidth],
  )

  useEffect(() => {
    if (!scrollEl || !pdf) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      changeZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))
    }
    scrollEl.addEventListener('wheel', onWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', onWheel)
  }, [scrollEl, pdf, zoom, changeZoom])

  // ---- open a document ----
  const openFile = async (f: File) => {
    const name = f.name.toLowerCase()
    if (name.endsWith('.doc') || name.endsWith('.docx')) {
      setNotice('Word files are coming soon. For now, save your document as a PDF and open that.')
      return
    }
    if (f.type !== 'application/pdf' && !name.endsWith('.pdf')) {
      setNotice('Please choose a PDF file.')
      return
    }
    if (annotations.length && !window.confirm('Open a new file? Signatures on the current document will be lost.')) return
    setLoading(true)
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const doc = await loadPdf(bytes)
      const sizes = await getPageSizes(doc)
      pdf?.destroy()
      setPdf(doc)
      setFile({ name: f.name, bytes })
      setPageSizes(sizes)
      dispatch({ type: 'reset' })
      setSelectedId(null)
      setTool('pen')
      setZoom(fitZoom(Math.max(...sizes.map((s) => s.width))))
      scrollEl?.scrollTo({ top: 0 })
    } catch (err) {
      const isPassword = err instanceof Error && err.name === 'PasswordException'
      setNotice(isPassword ? 'This PDF is password-protected. Remove the password and try again.' : 'Sorry, that PDF could not be opened.')
    } finally {
      setLoading(false)
    }
  }

  // ---- signatures ----
  const placeSignature = useCallback(
    (sig: SavedSignature) => {
      if (!scrollEl || !pageSizes.length) return
      const view = scrollEl.getBoundingClientRect()
      const cx = view.left + view.width / 2
      const cy = view.top + view.height / 2
      let best: HTMLElement | null = null
      let bestDist = Infinity
      for (const el of scrollEl.querySelectorAll<HTMLElement>('[data-page]')) {
        const r = el.getBoundingClientRect()
        const dist = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0
        if (dist < bestDist) {
          bestDist = dist
          best = el
        }
      }
      if (!best) return
      const page = Number(best.dataset.page)
      const size = pageSizes[page]
      const rect = best.getBoundingClientRect()
      const w = Math.min(180, size.width * 0.4)
      const h = (w * sig.h) / sig.w
      const x = Math.min(Math.max(0, (cx - rect.left) / zoom - w / 2), size.width - w)
      const y = Math.min(Math.max(0, (cy - rect.top) / zoom - h / 2), size.height - h)
      const item: ImageAnn = { id: uid(), kind: 'image', page, x, y, w, h, src: sig.src }
      dispatch({ type: 'add', item })
      setSelectedId(item.id)
      setTool('select')
    },
    [scrollEl, pageSizes, zoom],
  )

  const addSignature = (s: { src: string; w: number; h: number }) => {
    const sig: SavedSignature = { id: uid(), ...s }
    setSignatures((list) => [sig, ...list])
    if (pdf) placeSignature(sig)
  }

  const uploadSignature = async (f: File) => {
    try {
      addSignature(await prepareSignatureImage(await readFileAsDataURL(f)))
    } catch {
      setNotice('That image could not be read. Try a PNG or JPG.')
    }
  }

  // ---- export ----
  const download = async () => {
    if (!pdf || !file) return
    setExporting(true)
    try {
      // pdf-lib is only needed here, so it's loaded on demand to keep first load fast.
      const { exportSignedPdf, downloadBytes } = await import('./lib/exportPdf')
      const bytes = await exportSignedPdf(file.bytes, pdf, annotations)
      downloadBytes(bytes, file.name.replace(/\.pdf$/i, '') + '-signed.pdf')
    } catch (err) {
      console.error(err)
      setNotice('Something went wrong while creating the PDF.')
    } finally {
      setExporting(false)
    }
  }

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (padOpen || t.closest('input, textarea, [contenteditable="true"]')) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === 'z') {
        e.preventDefault()
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
      } else if (mod && k === 'y') {
        e.preventDefault()
        dispatch({ type: 'redo' })
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        dispatch({ type: 'remove', ids: [selectedId] })
        setSelectedId(null)
      } else if (e.key === 'Escape') {
        setSelectedId(null)
      } else if (!mod && !e.altKey && pdf) {
        if (k === 'v') setTool('select')
        else if (k === 'p') setTool('pen')
        else if (k === 'e') setTool('eraser')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [padOpen, selectedId, pdf])

  const changeTool = useCallback((t: Tool) => {
    setTool(t)
    if (t !== 'select') setSelectedId(null)
  }, [])

  const hasDoc = !!pdf

  return (
    <div
      className="flex h-dvh flex-col"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files[0]
        if (f) openFile(f)
      }}
    >
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          Papirma
        </div>
        {file && (
          <span className="flex min-w-0 items-center gap-1.5 truncate text-sm text-slate-500">
            <Icon name="file" className="h-4 w-4 shrink-0" />
            <span className="truncate">{file.name}</span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Icon name="upload" className="h-4 w-4" />
            <span className="hidden sm:inline">{hasDoc ? 'Open another' : 'Open PDF'}</span>
          </button>
          <button
            type="button"
            onClick={download}
            disabled={!hasDoc || exporting}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-40"
          >
            <Icon name="download" className="h-4 w-4" />
            <span className="hidden sm:inline">{exporting ? 'Preparing…' : 'Download PDF'}</span>
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,application/pdf,.doc,.docx"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) openFile(f)
            e.target.value = ''
          }}
        />
      </header>

      <Toolbar
        disabled={!hasDoc}
        tool={tool}
        onTool={changeTool}
        penSize={penSize}
        onPenSize={setPenSize}
        penColor={penColor}
        onPenColor={setPenColor}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        zoom={zoom}
        onZoomIn={() => changeZoom(zoom * 1.2)}
        onZoomOut={() => changeZoom(zoom / 1.2)}
        onFit={() => changeZoom(fitZoom())}
      />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <SignaturePanel
          signatures={signatures}
          canPlace={hasDoc}
          onDraw={() => setPadOpen(true)}
          onUpload={uploadSignature}
          onPlace={placeSignature}
          onDelete={(id) => setSignatures((list) => list.filter((s) => s.id !== id))}
        />

        <main ref={setScrollEl} className="relative min-h-0 flex-1 overflow-auto">
          {pdf ? (
            <div className="mx-auto flex w-max min-w-full flex-col items-center gap-6 p-6">
              {pageSizes.map((size, i) => {
                const anns = byPage[i] ?? []
                return (
                  <PageView
                    key={i}
                    pdf={pdf}
                    index={i}
                    size={size}
                    zoom={zoom}
                    root={scrollEl}
                    annotations={anns}
                    tool={tool}
                    penSize={penSize}
                    penColor={penColor}
                    selectedId={selectedId && anns.some((a) => a.id === selectedId) ? selectedId : null}
                    onSelect={setSelectedId}
                    dispatch={dispatch}
                  />
                )
              })}
            </div>
          ) : (
            <div className="grid h-full place-items-center p-6">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="flex w-full max-w-lg flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 bg-white px-8 py-14 text-center transition hover:border-indigo-400 hover:bg-indigo-50/40"
              >
                <span className="grid h-14 w-14 place-items-center rounded-full bg-indigo-50 text-indigo-600">
                  <Icon name="upload" className="h-6 w-6" />
                </span>
                <span className="text-lg font-semibold">{loading ? 'Opening…' : 'Open a PDF to sign'}</span>
                <span className="text-sm text-slate-500">Drag and drop a file here, or click to choose one.</span>
                <span className="text-xs text-slate-400">Your document stays on your device — nothing is uploaded.</span>
              </button>
            </div>
          )}
          {loading && pdf && (
            <div className="absolute inset-0 grid place-items-center bg-white/60 text-sm font-medium">Opening…</div>
          )}
        </main>
      </div>

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-indigo-500 bg-indigo-50/80 text-lg font-semibold text-indigo-700">
          Drop your PDF to open it
        </div>
      )}

      {notice && (
        <div className="fixed bottom-5 left-1/2 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg">
          {notice}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-slate-400 hover:text-white">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
      )}

      {padOpen && (
        <SignaturePad
          initialColor={penColor}
          onClose={() => setPadOpen(false)}
          onSave={(s) => {
            setPadOpen(false)
            addSignature(s)
          }}
        />
      )}
    </div>
  )
}
