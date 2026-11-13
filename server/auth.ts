import { createClient } from '@supabase/supabase-js'

export interface SenderIdentity {
  userId: string
  email: string
}

/** Verifies a sender's Supabase access token. */
export interface SenderAuth {
  verify(accessToken: string): Promise<SenderIdentity | null>
}

export function createSupabaseAuth(url: string, serviceRoleKey: string): SenderAuth {
  const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  return {
    async verify(accessToken) {
      const { data, error } = await client.auth.getUser(accessToken)
      if (error || !data.user?.email) return null
      return { userId: data.user.id, email: data.user.email.toLowerCase() }
    },
  }
}
