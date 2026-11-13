import { useEffect } from 'react'
import { track } from '../lib/analytics'

const PRICE = '₱999'

type Status = 'yes' | 'soon' | 'no'
const FEATURES: Array<{ name: string; detail?: string; free: Status; pro: Status }> = [
  { name: 'Sign your own PDFs', detail: 'Draw with an adjustable pen, or upload a signature image', free: 'yes', pro: 'yes' },
  { name: 'Download the signed PDF', free: 'yes', pro: 'yes' },
  { name: 'Your files stay on your device when signing them yourself', free: 'yes', pro: 'yes' },
  { name: 'Private document library', detail: 'Keep PDFs ready to send again', free: 'no', pro: 'yes' },
  { name: 'Send a PDF to up to 5 people to sign', detail: 'Each person gets their own private link', free: 'no', pro: 'yes' },
  { name: 'Password-protected signing links', detail: 'You share the password separately, by phone or chat', free: 'no', pro: 'yes' },
  { name: 'Revoke, resend or reset a link at any time', free: 'no', pro: 'yes' },
  { name: 'Recipients sign in their browser — no account needed', free: 'no', pro: 'soon' },
  { name: 'Email code verification for recipients', free: 'no', pro: 'soon' },
  { name: 'Signing record and document fingerprint', detail: 'An audit trail of who opened and signed, and when, plus a SHA-256 fingerprint of each file', free: 'no', pro: 'soon' },
  { name: 'Signed copies for you and each signer', free: 'no', pro: 'soon' },
]

function Cell({ s }: { s: Status }) {
  if (s === 'yes') return <span className="text-emerald-600" aria-label="Included">✓</span>
  if (s === 'soon') return <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">Coming soon</span>
  return <span className="text-slate-300" aria-label="Not included">—</span>
}

export default function ProPage() {
  useEffect(() => {
    document.title = 'PirmaNest Pro'
    track('pro_page_viewed')
  }, [])

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <a href="/" className="flex items-center gap-2 font-semibold"><img src="/favicon.svg" alt="" className="h-7 w-7" />PirmaNest</a>
        <a href="/" className="ml-auto rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">Back to the free editor</a>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
        <section className="text-center">
          <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">✦ PirmaNest Pro · early access</span>
          <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">Get documents signed by other people</h1>
          <p className="mx-auto mt-3 max-w-xl text-slate-600">
            Upload a PDF once, send each person their own private signing link, and protect it with a password you share separately.
          </p>
        </section>

        <section className="mx-auto mt-10 max-w-md rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-200">
          <div className="text-sm font-medium text-slate-500">PirmaNest Pro</div>
          <div className="mt-2 flex items-baseline justify-center gap-1">
            <span className="text-4xl font-bold">{PRICE}</span>
            <span className="text-slate-500">/ month</span>
          </div>
          <p className="mt-3 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900">
            Online payment isn’t open yet. Request early access and we’ll upgrade your account.
          </p>
          <a
            href="/app"
            onClick={() => track('pro_request_started', { from: 'pro_page' })}
            className="mt-4 block rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Request Pro access
          </a>
          <a href="/" className="mt-2 block rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Keep using Free</a>
        </section>

        <section className="mt-12 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Feature</th>
                <th className="w-20 px-2 py-3 text-center font-semibold sm:w-28">Free</th>
                <th className="w-28 px-2 py-3 text-center font-semibold">Pro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {FEATURES.map((f) => (
                <tr key={f.name}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{f.name}</div>
                    {f.detail && <div className="mt-0.5 text-xs text-slate-500">{f.detail}</div>}
                  </td>
                  <td className="px-2 py-3 text-center"><Cell s={f.free} /></td>
                  <td className="px-2 py-3 text-center"><Cell s={f.pro} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-12 grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="font-semibold">Where are my documents kept?</h2>
            <p className="mt-1 text-sm text-slate-600">
              With the free editor, nothing is uploaded — files stay in your browser. With Pro, documents you put in your library are stored privately, encrypted in transit and at rest, and only you and the people you invite can open them.
            </p>
          </div>
          <div>
            <h2 className="font-semibold">Do the people I send to need an account?</h2>
            <p className="mt-1 text-sm text-slate-600">No. They open their private link, enter the password if you set one, and review the document. They never pay or register.</p>
          </div>
          <div>
            <h2 className="font-semibold">Is a PirmaNest signature legally valid?</h2>
            <p className="mt-1 text-sm text-slate-600">
              PirmaNest places electronic signatures and keeps a record to help you show who signed and when. Whether an electronic signature is enough depends on the document and the law that applies — some documents must be notarized or have other formalities. If you’re unsure, ask a lawyer.
            </p>
          </div>
          <div>
            <h2 className="font-semibold">What happens after I request access?</h2>
            <p className="mt-1 text-sm text-slate-600">Sign in with your email, tap “Request Pro access”, and we’ll upgrade your account. You’ll see your document library the next time you sign in.</p>
          </div>
        </section>
      </main>
    </div>
  )
}
