import { z } from 'zod'
import type { Deps } from '../deps.js'
import { one } from '../db.js'
import { forbidden, unauthorized } from '../errors.js'

export interface Sender {
  id: string
  email: string
  displayName: string
  plan: 'free' | 'pro'
}

/** Resolve the Bearer token to a sender, creating their profile on first use. */
export async function authenticateSender(deps: Deps, request: Request): Promise<Sender> {
  const header = request.headers.get('authorization') ?? ''
  const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header)
  if (!m) throw unauthorized()
  const identity = await deps.auth.verify(m[1])
  if (!identity) throw unauthorized()
  const fallbackName = identity.email.split('@')[0].slice(0, 80) || 'Papirma user'
  await deps.db.query(
    `insert into public.profiles (id, display_name) values ($1, $2) on conflict (id) do nothing`,
    [identity.userId, fallbackName],
  )
  const p = await one<{ display_name: string; plan: 'free' | 'pro' }>(
    deps.db,
    `select display_name, plan from public.profiles where id = $1`,
    [identity.userId],
  )
  return { id: identity.userId, email: identity.email, displayName: p!.display_name, plan: p!.plan }
}

export function requirePro(sender: Sender) {
  if (sender.plan !== 'pro') throw forbidden('pro_required')
}

export const UpdateProfile = z.object({ displayName: z.string().trim().min(1).max(80) }).strict()

export async function updateProfile(deps: Deps, sender: Sender, input: z.infer<typeof UpdateProfile>) {
  await deps.db.query(`update public.profiles set display_name = $2 where id = $1`, [sender.id, input.displayName])
  return { ...sender, displayName: input.displayName }
}
