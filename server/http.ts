import type { z } from 'zod'
import { HttpError, badRequest, forbidden } from './errors.js'
import { hmacSha256 } from './crypto.js'

export const SESSION_COOKIE = '__Host-papirma_rs'
const MAX_JSON_BYTES = 64 * 1024

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } })
}

export function errorResponse(err: HttpError): Response {
  const headers: Record<string, string> = {}
  if (typeof err.extra.retryAfterSec === 'number') headers['Retry-After'] = String(err.extra.retryAfterSec)
  return json({ error: err.code, ...err.extra }, err.status, headers)
}

/** Parse and validate a JSON body. Unknown fields are rejected by the (strict) schema. */
export async function readJson<S extends z.ZodTypeAny>(request: Request, schema: S, maxBytes = MAX_JSON_BYTES): Promise<z.infer<S>> {
  const type = request.headers.get('content-type') ?? ''
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json_required')
  const text = await request.text()
  if (text.length > maxBytes) throw new HttpError(413, 'body_too_large')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw badRequest('invalid_json')
  }
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    // field paths only — never echo submitted values (they may be passwords)
    throw badRequest('invalid_request', { fields: parsed.error.issues.map((i) => i.path.join('.')).slice(0, 10) })
  }
  return parsed.data
}

/** CSRF defence for state-changing requests: the Origin must be Papirma's own. */
export function requireSameOrigin(request: Request, appOrigin: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
  if (request.headers.get('origin') !== appOrigin) throw forbidden('bad_origin')
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export function sessionCookie(value: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export interface ClientInfo {
  ip: string | null
  /** HMAC of the IP for rate-limit keys, so raw IPs never sit in counters. */
  ipKey: string
  userAgent: string | null
}

export function clientInfo(request: Request, ipHmacKey: string): ClientInfo {
  const fwd = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const raw = fwd || request.headers.get('x-real-ip') || null
  const ip = raw && /^[0-9a-fA-F:.]{2,45}$/.test(raw) ? raw : null
  return {
    ip,
    ipKey: hmacSha256(ipHmacKey, ip ?? 'unknown').toString('base64url').slice(0, 22),
    userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
  }
}
