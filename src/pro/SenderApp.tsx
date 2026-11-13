import { useCallback, useEffect, useRef, useState } from 'react'
import { api, describeError } from './api'
import { getAuth, type ProAuth, type SenderSession } from './auth'

type Mode = 'link' | 'password' | 'email_otp'

interface Me { email: string; displayName: string; plan: 'free' | 'pro' }
interface DocumentItem {
  id: string
  title: string
  createdAt: string
  latestVersion: { id: string; version: number; pageCount: number; sha256: string } | null
  openInvitations: number
}
interface InvitationItem {
  id: string
  email: string
  mode: Mode
  status: 'pending' | 'opened' | 'completing' | 'completed' | 'revoked' | 'expired'
  expiresAt: string
  firstOpenedAt: string | null
  locked: boolean
  version: number
}
interface CreatedInvitation { invitationId: string; email: string; mode: Mode; emailSent: boolean; password?: string }

const MODE_LABEL: Record<Mode, string> = { link: 'Link only', password: 'Password', email_otp: 'Email code' }
const STATUS_STYLE: Record<InvitationItem['status'], string> = {
  pending: 'bg-slate-100 text-slate-600',
  opened: 'bg-blue-50 text-blue-700',
  completing: 'bg-amber-50 text-amber-700',
  completed: 'bg-emerald-50 text-emerald-700',
  revoked: 'bg-red-50 text-red-700',
  expired: 'bg-slate-100 text-slate-400',
}
const fmt = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const btn = 'rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40'
const primary = `${btn} bg-indigo-600 text-white hover:bg-indigo-700`
const secondary = `${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`
const input = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'

export default function SenderApp() {
  const [auth, setAuth] = useState<ProAuth | null | undefined>(undefined)
  const [session, setSession] = useState<SenderSession | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let off = () => {}
    getAuth().then(async (a) => {
      setAuth(a)
      if (!a) return
      setSession(await a.getSession())
      off = a.onChange(setSession)
    })
    return () => off()
  }, [])

  useEffect(() => {
    setMe(null)
    if (!session) return
    api<Me>('me', { token: session.accessToken }).then(setMe, (e) => setError(describeError(e)))
  }, [session])

  if (auth === undefined) return <Centered>Loading…</Centered>
  if (auth === null) return <Centered>Papirma Pro sign-in isn’t configured on this site yet.</Centered>

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <a href="/" className="flex items-center gap-2 font-semibold"><img src="/favicon.svg" alt="" className="h-7 w-7" />Papirma</a>
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700">Pro</span>
        {auth.kind === 'dev' && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Local dev</span>}
        {session && (
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-500">
            <span className="hidden sm:inline">{session.email}</span>
            <button type="button" className={secondary} onClick={() => auth.signOut()}>Sign out</button>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-4xl p-4 sm:p-6">
        {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
        {!session ? <SignIn auth={auth} /> : !me ? <p className="text-sm text-slate-400">Loading your account…</p>
          : me.plan !== 'pro' ? <Banner tone="info">Sending documents for signature is part of Papirma Pro. Your account ({me.email}) is on the free plan.</Banner>
          : <Library token={session.accessToken} onError={setError} />}
      </main>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-6 text-center text-sm text-slate-500">{children}</div>
}

function Banner({ tone, children, onClose }: { tone: 'error' | 'info' | 'warn'; children: React.ReactNode; onClose?: () => void }) {
  const styles = { error: 'bg-red-50 text-red-800 ring-red-200', info: 'bg-indigo-50 text-indigo-900 ring-indigo-200', warn: 'bg-amber-50 text-amber-900 ring-amber-200' }
  return (
    <div className={`mb-4 flex items-start gap-3 rounded-xl px-4 py-3 text-sm ring-1 ${styles[tone]}`} role={tone === 'error' ? 'alert' : undefined}>
      <div className="flex-1">{children}</div>
      {onClose && <button type="button" aria-label="Dismiss" onClick={onClose} className="opacity-60 hover:opacity-100">✕</button>}
    </div>
  )
}

function SignIn({ auth }: { auth: ProAuth }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  return (
    <div className="mx-auto mt-10 max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h1 className="text-lg font-semibold">Sign in to Papirma Pro</h1>
      <p className="mt-1 text-sm text-slate-500">
        {auth.kind === 'dev' ? 'Local development: any email signs you in as a Pro user. No email is sent.' : 'We’ll email you a sign-in link. No password needed.'}
      </p>
      {state === 'sent' ? (
        <p className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Check your inbox for the sign-in link.</p>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setState('sending')
            try {
              const r = await auth.signInWithEmail(email)
              setState(r === 'link_sent' ? 'sent' : 'idle')
            } catch {
              setState('error')
            }
          }}
        >
          <input type="email" required autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
          <button type="submit" disabled={state === 'sending'} className={`${primary} w-full`}>
            {auth.kind === 'dev' ? 'Sign in (dev)' : state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
          {auth.signInWithGoogle && (
            <button type="button" className={`${secondary} w-full`} onClick={() => auth.signInWithGoogle!()}>Continue with Google</button>
          )}
          {state === 'error' && <p className="text-sm text-red-600">Couldn’t sign you in. Please try again.</p>}
        </form>
      )}
    </div>
  )
}

function Library({ token, onError }: { token: string; onError: (m: string) => void }) {
  const [docs, setDocs] = useState<DocumentItem[] | null>(null)
  const [selected, setSelected] = useState<DocumentItem | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ documents: DocumentItem[] }>('documents', { token })
      setDocs(r.documents)
      setSelected((cur) => (cur ? r.documents.find((d) => d.id === cur.id) ?? null : null))
    } catch (e) {
      onError(describeError(e))
    }
  }, [token, onError])

  useEffect(() => { refresh() }, [refresh])

  const upload = async (file: File) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return onError('Please choose a PDF file.')
    if (file.size > 25 * 1024 * 1024) return onError('This PDF is larger than 25 MB.')
    setUploading(true)
    try {
      const title = file.name.replace(/\.pdf$/i, '').slice(0, 200) || 'Untitled document'
      const created = await api<{ versionId: string; uploadUrl: string }>('documents', { token, body: { title } })
      const put = await fetch(created.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } })
      if (!put.ok) throw new Error('upload failed')
      await api(`document-versions/${created.versionId}/finalize`, { token, body: {} })
      await refresh()
    } catch (e) {
      onError(describeError(e))
      await refresh()
    } finally {
      setUploading(false)
    }
  }

  if (selected) return <DocumentPage token={token} doc={selected} onBack={() => { setSelected(null); refresh() }} onError={onError} />

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Document library</h1>
        <button type="button" className={primary} disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? 'Uploading…' : 'Upload PDF'}
        </button>
        <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload(f)
          e.target.value = ''
        }} />
      </div>
      <p className="mb-4 text-sm text-slate-500">Documents you upload here are stored privately so you can send them for signature. Only you and the recipients you invite can open them.</p>
      {docs === null ? <p className="text-sm text-slate-400">Loading…</p> : docs.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">No documents yet. Upload a PDF to get started.</div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {docs.map((d) => (
            <li key={d.id} className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="truncate font-medium" title={d.title}>{d.title}</div>
              <div className="mt-1 text-xs text-slate-500">
                {d.latestVersion ? `${d.latestVersion.pageCount} page${d.latestVersion.pageCount === 1 ? '' : 's'} · v${d.latestVersion.version}` : 'Upload incomplete'}
                {' · '}{fmt(d.createdAt)}
                {d.openInvitations > 0 && ` · ${d.openInvitations} open invitation${d.openInvitations === 1 ? '' : 's'}`}
              </div>
              <button type="button" disabled={!d.latestVersion} className={`${secondary} mt-3`} onClick={() => setSelected(d)}>
                Send for signature
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

interface RecipientRow { email: string; mode: Mode; ownPassword: boolean; password: string }
const emptyRow = (): RecipientRow => ({ email: '', mode: 'password', ownPassword: false, password: '' })

function DocumentPage({ token, doc, onBack, onError }: { token: string; doc: DocumentItem; onBack: () => void; onError: (m: string) => void }) {
  const [rows, setRows] = useState<RecipientRow[]>([emptyRow()])
  const [hideTitle, setHideTitle] = useState(false)
  const [sending, setSending] = useState(false)
  const [created, setCreated] = useState<CreatedInvitation[] | null>(null)
  const [invitations, setInvitations] = useState<InvitationItem[]>([])
  const [shownPassword, setShownPassword] = useState<{ email: string; password: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api<{ invitations: InvitationItem[] }>(`invitations?documentId=${doc.id}`, { token })
      setInvitations(r.invitations)
    } catch (e) {
      onError(describeError(e))
    }
  }, [doc.id, token, onError])
  useEffect(() => { load() }, [load])

  const update = (i: number, patch: Partial<RecipientRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const send = async () => {
    setSending(true)
    try {
      const r = await api<{ invitations: CreatedInvitation[] }>('invitations', {
        token,
        body: {
          documentVersionId: doc.latestVersion!.id,
          hideTitle,
          recipients: rows.map((r) => ({
            email: r.email.trim(),
            mode: r.mode,
            ...(r.mode === 'password' && r.ownPassword ? { password: r.password } : {}),
          })),
        },
      })
      setCreated(r.invitations)
      setRows([emptyRow()])
      await load()
    } catch (e) {
      onError(describeError(e))
    } finally {
      setSending(false)
    }
  }

  const act = async (inv: InvitationItem, action: 'revoke' | 'reset-password' | 'resend') => {
    if (action === 'revoke' && !window.confirm(`Revoke the invitation for ${inv.email}? Their link will stop working immediately.`)) return
    try {
      const r = await api<{ password?: string }>(`invitations/${inv.id}/${action}`, { token, body: {} })
      if (r.password) setShownPassword({ email: inv.email, password: r.password })
      await load()
    } catch (e) {
      onError(describeError(e))
    }
  }

  const valid = rows.every((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email.trim()) && (!(r.mode === 'password' && r.ownPassword) || r.password.length >= 12))

  return (
    <>
      <button type="button" onClick={onBack} className="mb-3 text-sm text-indigo-700 hover:underline">← Library</button>
      <h1 className="truncate text-xl font-semibold">{doc.title}</h1>
      <p className="mt-1 font-mono text-xs text-slate-400" title="SHA-256 fingerprint of the file recipients will sign">
        v{doc.latestVersion?.version} · SHA-256 {doc.latestVersion?.sha256.slice(0, 16)}…
      </p>

      <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold">Invite recipients <span className="text-sm font-normal text-slate-400">(up to 5)</span></h2>
        <div className="mt-3 space-y-3">
          {rows.map((r, i) => (
            <div key={i} className="rounded-xl bg-slate-50 p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input type="email" placeholder="recipient@example.com" value={r.email} onChange={(e) => update(i, { email: e.target.value })} className={input} aria-label={`Recipient ${i + 1} email`} />
                <select value={r.mode} onChange={(e) => update(i, { mode: e.target.value as Mode })} className={`${input} sm:w-44`} aria-label={`Recipient ${i + 1} security`}>
                  <option value="password">Password (recommended)</option>
                  <option value="link">Link only</option>
                  <option value="email_otp" disabled>Email code (coming soon)</option>
                </select>
                {rows.length > 1 && <button type="button" className={secondary} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</button>}
              </div>
              {r.mode === 'link' && (
                <p className="mt-2 text-xs text-amber-700">Anyone who gets this link can open and sign the document until it expires or you revoke it.</p>
              )}
              {r.mode === 'password' && (
                <div className="mt-2 text-xs text-slate-600">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={r.ownPassword} onChange={(e) => update(i, { ownPassword: e.target.checked, password: '' })} />
                    Set my own password (otherwise a strong one is generated)
                  </label>
                  {r.ownPassword && (
                    <input type="text" autoComplete="off" spellCheck={false} placeholder="At least 12 characters, hard to guess" value={r.password}
                      onChange={(e) => update(i, { password: e.target.value })} className={`${input} mt-2`} aria-label="Custom password" />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {rows.length < 5 && <button type="button" className={secondary} onClick={() => setRows((rs) => [...rs, emptyRow()])}>+ Add recipient</button>}
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={hideTitle} onChange={(e) => setHideTitle(e.target.checked)} /> Don’t show the document title in the email
          </label>
          <button type="button" className={`${primary} ml-auto`} disabled={!valid || sending} onClick={send}>{sending ? 'Sending…' : 'Send invitations'}</button>
        </div>
        <p className="mt-3 text-xs text-slate-500">Each recipient gets their own link, valid for 7 days. Passwords are never included in the email — share them separately, for example by phone or chat.</p>
      </section>

      <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold">Invitations</h2>
        {invitations.length === 0 ? <p className="mt-2 text-sm text-slate-400">None yet.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {invitations.map((inv) => {
              const open = inv.status === 'pending' || inv.status === 'opened'
              return (
                <li key={inv.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{inv.email}</span>
                  <span className="text-xs text-slate-500">{MODE_LABEL[inv.mode]} · v{inv.version} · expires {fmt(inv.expiresAt)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[inv.status]}`}>{inv.status}</span>
                  {inv.locked && open && <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">locked</span>}
                  {open && (
                    <span className="flex gap-1">
                      {inv.mode === 'password' && <button type="button" className={secondary} onClick={() => act(inv, 'reset-password')}>New password</button>}
                      <button type="button" className={secondary} onClick={() => act(inv, 'resend')}>Resend</button>
                      <button type="button" className={`${secondary} text-red-700`} onClick={() => act(inv, 'revoke')}>Revoke</button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {created && <CreatedDialog created={created} onClose={() => setCreated(null)} />}
      {shownPassword && (
        <PasswordDialog title={`New password for ${shownPassword.email}`} items={[shownPassword]} onClose={() => setShownPassword(null)} />
      )}
    </>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button type="button" className={secondary} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked */ }
    }}>{copied ? 'Copied' : 'Copy'}</button>
  )
}

function PasswordDialog({ title, items, onClose, children }: { title: string; items: Array<{ email: string; password: string }>; onClose: () => void; children?: React.ReactNode }) {
  const [ack, setAck] = useState(items.length === 0)
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4">
      <div role="dialog" aria-label={title} className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
        {items.length > 0 && (
          <>
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              Share each password with its recipient <b>separately — by phone, SMS or chat, not email</b>. Papirma stores only a scrambled version, so these can’t be shown again.
            </p>
            <ul className="mt-3 space-y-2">
              {items.map((it) => (
                <li key={it.email} className="flex items-center gap-2 rounded-lg bg-slate-50 p-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{it.email}</span>
                  <code className="rounded bg-white px-2 py-1 font-mono text-sm ring-1 ring-slate-200">{it.password}</code>
                  <CopyButton text={it.password} />
                </li>
              ))}
            </ul>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I’ve saved these passwords
            </label>
          </>
        )}
        <div className="mt-4 text-right"><button type="button" className={primary} disabled={!ack} onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function CreatedDialog({ created, onClose }: { created: CreatedInvitation[]; onClose: () => void }) {
  const withPasswords = created.filter((c) => c.password).map((c) => ({ email: c.email, password: c.password! }))
  return (
    <PasswordDialog title="Invitations sent" items={withPasswords} onClose={onClose}>
      <ul className="mt-3 space-y-1 text-sm">
        {created.map((c) => (
          <li key={c.invitationId} className="flex items-center gap-2">
            <span>{c.emailSent ? '✅' : '⚠️'}</span>
            <span className="truncate">{c.email}</span>
            <span className="text-slate-400">· {MODE_LABEL[c.mode]}{c.mode === 'password' && !c.password ? ' (your password)' : ''}</span>
            {!c.emailSent && <span className="text-amber-700">email failed — use Resend</span>}
          </li>
        ))}
      </ul>
    </PasswordDialog>
  )
}
