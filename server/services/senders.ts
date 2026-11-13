import { z } from 'zod'
import type { Deps } from '../deps.js'
import { one } from '../db.js'
import { forbidden, unauthorized } from '../errors.js'
import { audit } from '../audit.js'

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
  const fallbackName = identity.email.split('@')[0].slice(0, 80) || 'PirmaNest user'
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

/**
 * Early access (no payments yet): record that a free user wants Pro. Idempotent —
 * the first request time is kept. Never changes `plan`; only the owner does that.
 */
export async function requestPro(deps: Deps, sender: Sender) {
  if (sender.plan === 'pro') return { plan: 'pro' as const, proRequestedAt: null }
  return deps.db.tx(async (q) => {
    const first = await one<{ pro_requested_at: Date }>(q,
      `update public.profiles set pro_requested_at = now()
        where id = $1 and pro_requested_at is null returning pro_requested_at`, [sender.id])
    if (first) {
      await audit(q, { actorType: 'sender', actorId: sender.id, eventType: 'pro_requested' })
      return { plan: sender.plan, proRequestedAt: first.pro_requested_at }
    }
    const existing = await one<{ pro_requested_at: Date }>(q,
      `select pro_requested_at from public.profiles where id = $1`, [sender.id])
    return { plan: sender.plan, proRequestedAt: existing!.pro_requested_at }
  })
}

export async function getProfile(deps: Deps, sender: Sender) {
  const row = await one<{ pro_requested_at: Date | null }>(deps.db,
    `select pro_requested_at from public.profiles where id = $1`, [sender.id])
  return { email: sender.email, displayName: sender.displayName, plan: sender.plan, proRequestedAt: row?.pro_requested_at ?? null }
}

export const UpdateProfile =z.object({ displayName: z.string().trim().min(1).max(80) }).strict()

export async function updateProfile(deps: Deps, sender: Sender, input: z.infer<typeof UpdateProfile>) {
  await deps.db.query(`update public.profiles set display_name = $2 where id = $1`, [sender.id, input.displayName])
  return { ...sender, displayName: input.displayName }
}
