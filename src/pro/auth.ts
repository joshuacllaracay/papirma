/**
 * Sender sign-in. Uses Supabase Auth (email magic link + Google) when configured.
 * In local development without Supabase it falls back to a dev sign-in that only
 * the local dev backend (scripts/dev-api.ts) accepts.
 */
export interface SenderSession {
  accessToken: string
  email: string
}

export interface ProAuth {
  kind: 'supabase' | 'dev'
  getSession(): Promise<SenderSession | null>
  onChange(cb: (s: SenderSession | null) => void): () => void
  /** Supabase: emails a magic link. Dev: signs in immediately. */
  signInWithEmail(email: string): Promise<'link_sent' | 'signed_in'>
  signInWithGoogle?: () => Promise<void>
  signOut(): Promise<void>
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let instance: Promise<ProAuth> | null = null

/** Null in a production build without Supabase settings (Pro sign-in not configured yet). */
export function getAuth(): Promise<ProAuth | null> {
  instance ??=
    SUPABASE_URL && SUPABASE_ANON_KEY
      ? supabaseAuth(SUPABASE_URL, SUPABASE_ANON_KEY)
      : import.meta.env.DEV
        ? Promise.resolve(devAuth())
        : Promise.resolve(null as unknown as ProAuth)
  return instance as Promise<ProAuth | null>
}

async function supabaseAuth(url: string, anonKey: string): Promise<ProAuth> {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  const toSession = (s: { access_token: string; user: { email?: string } } | null): SenderSession | null =>
    s?.access_token && s.user.email ? { accessToken: s.access_token, email: s.user.email } : null
  const redirectTo = `${window.location.origin}/app`
  return {
    kind: 'supabase',
    async getSession() {
      const { data } = await client.auth.getSession()
      return toSession(data.session)
    },
    onChange(cb) {
      const { data } = client.auth.onAuthStateChange((_e, s) => cb(toSession(s)))
      return () => data.subscription.unsubscribe()
    },
    async signInWithEmail(email) {
      const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } })
      if (error) throw error
      return 'link_sent'
    },
    async signInWithGoogle() {
      const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })
      if (error) throw error
    },
    async signOut() {
      await client.auth.signOut()
    },
  }
}

function devAuth(): ProAuth {
  const KEY = 'papirma.devSenderEmail'
  const listeners = new Set<(s: SenderSession | null) => void>()
  const session = (): SenderSession | null => {
    let email: string | null = null
    try { email = localStorage.getItem(KEY) } catch { /* storage blocked */ }
    if (!email) return null
    const b64 = btoa(unescape(encodeURIComponent(email))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return { accessToken: `devtoken.${b64}`, email }
  }
  const emit = () => listeners.forEach((l) => l(session()))
  return {
    kind: 'dev',
    async getSession() { return session() },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async signInWithEmail(email) {
      try { localStorage.setItem(KEY, email.trim().toLowerCase()) } catch { /* ignore */ }
      emit()
      return 'signed_in'
    },
    async signOut() {
      try { localStorage.removeItem(KEY) } catch { /* ignore */ }
      emit()
    },
  }
}
