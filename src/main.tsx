import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initAnalytics } from './lib/analytics'

// Pro screens load on demand so the free editor stays as light as before.
const SenderApp = lazy(() => import('./pro/SenderApp'))
const RecipientApp = lazy(() => import('./pro/RecipientApp'))

const path = window.location.pathname
const isRecipient = path === '/s' || path.startsWith('/s/')
const isSender = path === '/app' || path.startsWith('/app/')

// Recipients didn't sign up for Papirma: no analytics on signing pages (data minimization).
if (!isRecipient) initAnalytics()

const loading = <div className="grid h-dvh place-items-center text-sm text-slate-400">Loading…</div>

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isRecipient ? (
      <Suspense fallback={loading}>
        <RecipientApp />
      </Suspense>
    ) : isSender ? (
      <Suspense fallback={loading}>
        <SenderApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
