import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, sha256Hex } from './api'
import { getPageSizes, loadPdf, type PDFDocumentProxy } from '../lib/pdf'
import type { Annotation, PageSize } from '../types'
import { PageView } from '../components/PageView'

type OpenState =
  | { state: 'invalid' | 'expired' | 'revoked' | 'completed' }
  | { state: 'verified' | 'password_required' | 'otp_required'; mode: string; senderName: string; expiresAt: string; locked?: boolean; retryAfterSec?: number }

interface RecipientDoc { title: string; senderName: string; pageCount: number; sha256: string; url: string; expiresAt: string; status: string }

type Screen =
  | { kind: 'loading' }
  | { kind: 'message'; title: string; body: string }
  | { kind: 'password'; senderName: string; token: string; locked: boolean; retryAfterSec?: number }
  | { kind: 'otp'; senderName: string }
  | { kind: 'document' }

const NO_ANNOTATIONS: Annotation[] = []
const noop = () => {}

const MESSAGES = {
  invalid: { title: 'This link isn’t valid', body: 'Check that you opened the full link from your invitation email, or ask the sender to send a new one.' },
  expired: { title: 'This invitation has expired', body: 'Signing links are valid for 7 days. Ask the sender to send you a new invitation.' },
  revoked: { title: 'This invitation was withdrawn', body: 'The sender has cancelled this signing request. Contact them if you think this is a mistake.' },
  completed: { title: 'Already signed', body: 'This document has already been signed using this invitation.' },
  noLink: { title: 'Open your invitation link', body: 'For your security, please open the link from your invitation email again.' },
} as const

const minutes = (s?: number) => (s ? Math.max(1, Math.ceil(s / 60)) : 15)

/** Pull the token from the URL fragment, then remove it so it isn't left in history or the address bar. */
function takeToken(): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash)
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
  return m ? m[1] : null
}

// Read once, when this page's module loads — not inside an effect, which React may run twice.
const initialToken = takeToken()

export default function RecipientApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [doc, setDoc] = useState<RecipientDoc | null>(null)
  const started = useRef(false)

  const showDocument = useCallback(async () => {
    try {
      setDoc(await api<RecipientDoc>('r/document'))
      setScreen({ kind: 'document' })
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) setScreen({ kind: 'message', ...MESSAGES.expired })
      else setScreen({ kind: 'message', ...MESSAGES.noLink })
    }
  }, [])

  useEffect(() => {
    if (started.current) return
    started.current = true
    const token = initialToken
    if (!token) {
      // Maybe a reload with an existing session cookie.
      showDocument()
      return
    }
    api<OpenState>('r/open', { body: { token } }).then((r) => {
      if (r.state === 'verified') showDocument()
      else if (r.state === 'password_required') setScreen({ kind: 'password', senderName: r.senderName, token, locked: !!r.locked, retryAfterSec: r.retryAfterSec })
      else if (r.state === 'otp_required') setScreen({ kind: 'otp', senderName: r.senderName })
      else setScreen({ kind: 'message', ...MESSAGES[r.state] })
    }, () => setScreen({ kind: 'message', title: 'Something went wrong', body: 'Please try opening the link again in a moment.' }))
  }, [showDocument])

  return (
    <div className="min-h-dvh bg-slate-100">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <span className="font-semibold">Papirma</span>
        {screen.kind === 'document' && (
          <button type="button" className="ml-auto rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            onClick={async () => { await api('r/logout', { body: {} }).catch(noop); setScreen({ kind: 'message', title: 'Signed out', body: 'You can open your invitation link again at any time before it expires.' }) }}>
            Leave
          </button>
        )}
      </header>
      {screen.kind === 'loading' && <p className="p-10 text-center text-sm text-slate-400">Opening…</p>}
      {screen.kind === 'message' && <Card title={screen.title}><p className="text-sm text-slate-600">{screen.body}</p></Card>}
      {screen.kind === 'otp' && (
        <Card title={`${screen.senderName} asked you to sign a document`}>
          <p className="text-sm text-slate-600">This invitation uses email verification, which isn’t available yet. Please ask the sender to send a new invitation.</p>
        </Card>
      )}
      {screen.kind === 'password' && <PasswordStep {...screen} onVerified={showDocument} />}
      {screen.kind === 'document' && doc && <DocumentReview doc={doc} />}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto mt-10 max-w-md px-4">
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="mt-2 space-y-3">{children}</div>
      </div>
    </main>
  )
}

function PrivacyNote() {
  return (
    <p className="text-xs text-slate-500">
      To keep a reliable record for the sender, Papirma logs when this invitation is opened and verified, including your IP address and browser type.
    </p>
  )
}

function PasswordStep({ senderName, token, locked, retryAfterSec, onVerified }: {
  senderName: string; token: string; locked: boolean; retryAfterSec?: number; onVerified: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(locked ? `Too many attempts. Try again in about ${minutes(retryAfterSec)} minutes, or ask ${senderName} for a new password.` : null)

  return (
    <Card title={`${senderName} asked you to sign a document`}>
      <p className="text-sm text-slate-600">Enter the password {senderName} gave you. It isn’t in the invitation email — they will have shared it another way, such as by phone or chat.</p>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await api('r/verify-password', { body: { token, password } })
          onVerified()
        } catch (err) {
          setPassword('')
          if (err instanceof ApiError && err.code === 'locked') {
            const s = Number(err.body.retryAfterSec)
            setError(s > 86400 ? `This invitation is locked after too many attempts. Ask ${senderName} to send you a new password.` : `Too many attempts. Try again in about ${minutes(s)} minutes.`)
          } else if (err instanceof ApiError && err.status === 429) setError('Too many attempts from this connection. Please try again later.')
          else setError('That password didn’t work. Check it and try again.')
        } finally {
          setBusy(false)
        }
      }}>
        <input type="password" autoComplete="off" required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !password} className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
      <PrivacyNote />
    </Card>
  )
}

function DocumentReview({ doc }: { doc: RecipientDoc }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [integrity, setIntegrity] = useState<'checking' | 'ok' | 'mismatch'>('checking')
  const [failed, setFailed] = useState(false)
  const [width, setWidth] = useState(() => Math.min(window.innerWidth - 32, 900))

  useEffect(() => {
    const onResize = () => setWidth(Math.min(window.innerWidth - 32, 900))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Fetch as bytes (never navigate to the file URL), check the fingerprint, then render.
        const res = await fetch(doc.url)
        if (!res.ok) throw new Error('download failed')
        const buf = await res.arrayBuffer()
        const hex = await sha256Hex(buf)
        if (cancelled) return
        setIntegrity(hex === doc.sha256 ? 'ok' : 'mismatch')
        if (hex !== doc.sha256) return
        const loaded = await loadPdf(new Uint8Array(buf))
        const s = await getPageSizes(loaded)
        if (cancelled) return
        setPdf(loaded)
        setSizes(s)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [doc.url, doc.sha256])

  const zoom = sizes.length ? Math.min(1.5, width / Math.max(...sizes.map((s) => s.width))) : 1

  return (
    <main className="mx-auto max-w-4xl px-4 py-5">
      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <p className="text-sm text-slate-500">{doc.senderName} asked you to review and sign</p>
        <h1 className="truncate text-lg font-semibold">{doc.title}</h1>
        <p className="mt-1 text-xs text-slate-500">
          {doc.pageCount} page{doc.pageCount === 1 ? '' : 's'} · invitation expires {new Date(doc.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
        <p className="mt-2 font-mono text-xs text-slate-400" title="SHA-256 fingerprint of this exact file">
          {integrity === 'ok' ? '✓ File fingerprint verified' : integrity === 'mismatch' ? '✗ Fingerprint mismatch' : 'Checking file…'} · SHA-256 {doc.sha256.slice(0, 16)}…
        </p>
        <p className="mt-3 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900">Please read the whole document. Signing tools will appear here in the next update.</p>
      </div>
      {integrity === 'mismatch' && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">The file received doesn’t match the one the sender uploaded, so it won’t be shown. Please try again later.</p>}
      {failed && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">The document couldn’t be loaded. Refresh the page to try again.</p>}
      {pdf && (
        <div className="mt-5 flex flex-col items-center gap-5">
          {sizes.map((size, i) => (
            <PageView key={i} pdf={pdf} index={i} size={size} zoom={zoom} root={null} annotations={NO_ANNOTATIONS}
              tool="select" penSize={3} penColor="#111827" selectedId={null} onSelect={noop} dispatch={noop} />
          ))}
        </div>
      )}
    </main>
  )
}
