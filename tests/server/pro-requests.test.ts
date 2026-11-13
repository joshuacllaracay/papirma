import { describe, expect, it } from 'vitest'
import { createHarness } from '../helpers/harness.js'

describe('Pro early-access requests', () => {
  it('a free user can request Pro; the request is recorded once and never grants Pro by itself', async () => {
    const h = await createHarness()
    const s = await h.createSender({ plan: 'free' })
    const me = await h.call('GET', 'me', { bearer: s.bearer })
    expect(me.body).toMatchObject({ plan: 'free', proRequestedAt: null })

    const r1 = await h.call('POST', 'me/pro-request', { bearer: s.bearer, body: {} })
    expect(r1.status).toBe(200)
    expect(r1.body.plan).toBe('free')
    const first = r1.body.proRequestedAt
    const r2 = await h.call('POST', 'me/pro-request', { bearer: s.bearer, body: {} })
    expect(r2.body.proRequestedAt).toBe(first)

    const events = await h.db.admin.query(`select 1 from public.audit_events where actor_id = $1 and event_type = 'pro_requested'`, [s.id])
    expect(events).toHaveLength(1)
    // still blocked from Pro features until the owner upgrades the plan
    expect((await h.call('POST', 'documents', { bearer: s.bearer, body: { title: 'x' } })).status).toBe(403)
  })

  it('the request cannot smuggle a plan change', async () => {
    const h = await createHarness()
    const s = await h.createSender({ plan: 'free' })
    const r = await h.call('POST', 'me/pro-request', { bearer: s.bearer, body: { plan: 'pro' } })
    expect(r.status).toBe(400)
    const [p] = await h.db.admin.query<{ plan: string }>(`select plan from public.profiles where id = $1`, [s.id])
    expect(p.plan).toBe('free')
  })

  it('requires sign-in and a same-origin request', async () => {
    const h = await createHarness()
    const s = await h.createSender({ plan: 'free' })
    expect((await h.call('POST', 'me/pro-request', { body: {} })).status).toBe(401)
    expect((await h.call('POST', 'me/pro-request', { bearer: s.bearer, origin: 'https://evil.example', body: {} })).status).toBe(403)
  })

  it('the owner approval SQL in the migration works', async () => {
    const h = await createHarness()
    const s = await h.createSender({ plan: 'free' })
    await h.call('POST', 'me/pro-request', { bearer: s.bearer, body: {} })
    const pending = await h.db.admin.query<{ email: string }>(
      `select u.email from public.profiles p join auth.users u on u.id = p.id
        where p.plan = 'free' and p.pro_requested_at is not null`)
    expect(pending.map((r) => r.email)).toContain(s.email)
    await h.db.admin.query(`update public.profiles set plan = 'pro' where id = (select id from auth.users where email = $1)`, [s.email])
    expect((await h.call('POST', 'documents', { bearer: s.bearer, body: { title: 'x' } })).status).toBe(201)
  })
})
