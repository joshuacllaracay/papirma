import { z } from 'zod'
import type { Deps } from './deps.js'
import { HttpError, notFound, unauthorized } from './errors.js'
import { bytesEqual } from './crypto.js'
import { clearSessionCookie, clientInfo, errorResponse, json, readJson, requireSameOrigin } from './http.js'
import { UpdateProfile, authenticateSender, getProfile, requestPro, updateProfile } from './services/senders.js'
import { CreateDocument, createDocument, createVersion, deleteDocument, finalizeVersion, listDocuments } from './services/documents.js'
import {
  CreateInvitations, RevokeInvitation, createInvitations, listInvitations, reissueInvitation, resetPassword, revokeInvitation,
} from './services/invitations.js'
import {
  OpenInput, PasswordInput, endRecipientSession, getRecipientDocument, openInvitation, verifyInvitationPassword,
} from './services/recipient.js'
import { runCleanup } from './services/maintenance.js'

type Handler = (ctx: { request: Request; deps: Deps; params: string[]; url: URL }) => Promise<Response>
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
const Empty = z.object({}).strict()

const routes: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  // ---- sender ----
  ['GET', /^me$/, async ({ request, deps }) =>
    json(await getProfile(deps, await authenticateSender(deps, request)))],
  ['POST', /^me\/pro-request$/, async ({ request, deps }) => {
    const s = await authenticateSender(deps, request)
    await readJson(request, Empty)
    return json(await requestPro(deps, s))
  }],
  ['PATCH', /^me$/, async ({ request, deps }) => {
    const s = await authenticateSender(deps, request)
    const out = await updateProfile(deps, s, await readJson(request, UpdateProfile))
    return json({ email: out.email, displayName: out.displayName, plan: out.plan })
  }],
  ['GET', /^documents$/, async ({ request, deps }) =>
    json({ documents: await listDocuments(deps, await authenticateSender(deps, request)) })],
  ['POST', /^documents$/, async ({ request, deps }) => {
    const s = await authenticateSender(deps, request)
    return json(await createDocument(deps, s, await readJson(request, CreateDocument)), 201)
  }],
  ['DELETE', new RegExp(`^documents/${UUID}$`), async ({ request, deps, params }) =>
    json(await deleteDocument(deps, await authenticateSender(deps, request), params[0]))],
  ['POST', new RegExp(`^documents/${UUID}/versions$`), async ({ request, deps, params }) =>
    json(await createVersion(deps, await authenticateSender(deps, request), params[0]), 201)],
  ['POST', new RegExp(`^document-versions/${UUID}/finalize$`), async ({ request, deps, params }) =>
    json(await finalizeVersion(deps, await authenticateSender(deps, request), params[0]))],
  ['GET', /^invitations$/, async ({ request, deps, url }) => {
    const s = await authenticateSender(deps, request)
    const documentId = url.searchParams.get('documentId')
    if (documentId !== null && !new RegExp(`^${UUID}$`).test(documentId)) throw new HttpError(400, 'invalid_request')
    return json({ invitations: await listInvitations(deps, s, documentId) })
  }],
  ['POST', /^invitations$/, async ({ request, deps }) => {
    const s = await authenticateSender(deps, request)
    return json(await createInvitations(deps, s, await readJson(request, CreateInvitations)), 201)
  }],
  ['POST', new RegExp(`^invitations/${UUID}/revoke$`), async ({ request, deps, params }) => {
    const s = await authenticateSender(deps, request)
    return json(await revokeInvitation(deps, s, params[0], await readJson(request, RevokeInvitation)))
  }],
  ['POST', new RegExp(`^invitations/${UUID}/reset-password$`), async ({ request, deps, params }) => {
    const s = await authenticateSender(deps, request)
    await readJson(request, Empty)
    return json(await resetPassword(deps, s, params[0]))
  }],
  ['POST', new RegExp(`^invitations/${UUID}/resend$`), async ({ request, deps, params }) => {
    const s = await authenticateSender(deps, request)
    await readJson(request, Empty)
    return json(await reissueInvitation(deps, s, params[0]))
  }],

  // ---- recipient ----
  ['POST', /^r\/open$/, async ({ request, deps }) => {
    const r = await openInvitation(deps, await readJson(request, OpenInput), clientInfo(request, deps.config.ipHmacKey))
    return json(r.body, 200, r.setCookie ? { 'Set-Cookie': r.setCookie } : {})
  }],
  ['POST', /^r\/verify-password$/, async ({ request, deps }) => {
    const r = await verifyInvitationPassword(deps, await readJson(request, PasswordInput), clientInfo(request, deps.config.ipHmacKey))
    return json(r.body, 200, r.setCookie ? { 'Set-Cookie': r.setCookie } : {})
  }],
  ['GET', /^r\/document$/, async ({ request, deps }) =>
    json(await getRecipientDocument(deps, request, clientInfo(request, deps.config.ipHmacKey)))],
  ['POST', /^r\/logout$/, async ({ request, deps }) => {
    await endRecipientSession(deps, request)
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() })
  }],

  // ---- system ----
  ['GET', /^cron\/cleanup$/, async ({ request, deps }) => {
    const given = Buffer.from(request.headers.get('authorization') ?? '')
    const expected = Buffer.from(`Bearer ${deps.config.cronSecret}`)
    if (!bytesEqual(given, expected)) throw unauthorized()
    return json(await runCleanup(deps))
  }],
]

/** Resolve the API sub-path from either /api/<path> or the rewrite's ?__path=<path>. */
function apiPath(url: URL): string {
  const fromRewrite = url.searchParams.get('__path')
  const raw = fromRewrite ?? url.pathname.replace(/^\/api\/?/, '')
  return raw.replace(/^\/+|\/+$/g, '')
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url)
  const path = apiPath(url)
  try {
    requireSameOrigin(request, deps.config.appOrigin)
    let pathMatched = false
    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(path)
      if (!m) continue
      pathMatched = true
      if (method !== request.method) continue
      return await handler({ request, deps, params: m.slice(1), url })
    }
    throw pathMatched ? new HttpError(405, 'method_not_allowed') : notFound()
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err)
    // Log the error type and route only — never request bodies, cookies or headers.
    // Postgres SQLSTATE codes are safe to log; messages are not (they can contain values).
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined
    console.error('api_error', { method: request.method, path, name: err instanceof Error ? err.name : 'unknown', code })
    return json({ error: 'internal' }, 500)
  }
}
