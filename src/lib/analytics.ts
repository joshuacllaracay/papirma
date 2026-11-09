/**
 * Google Analytics 4, loaded only when VITE_GA_MEASUREMENT_ID is set and only in
 * production builds (so local testing doesn't pollute the numbers).
 *
 * Privacy rule for this file: never send file names, document text or images —
 * only counts and choices (pages, method, rating).
 */
type Params = Record<string, string | number | boolean>

declare global {
  interface Window {
    dataLayer: unknown[]
    gtag: (...args: unknown[]) => void
  }
}

const ID = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim()
let enabled = false

export function initAnalytics() {
  if (enabled || !ID || import.meta.env.DEV) return
  enabled = true
  window.dataLayer = window.dataLayer || []
  window.gtag = function gtag() {
    // gtag.js expects the real `arguments` object, not an array.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer.push(arguments)
  }
  window.gtag('js', new Date())
  window.gtag('config', ID)
  const s = document.createElement('script')
  s.async = true
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ID)}`
  document.head.appendChild(s)
}

export function track(event: string, params: Params = {}) {
  if (import.meta.env.DEV) console.debug('[analytics]', event, params)
  if (enabled) window.gtag('event', event, params)
}
