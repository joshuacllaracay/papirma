export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: Record<string, unknown>
  constructor(status: number, code: string, body: Record<string, unknown>) {
    super(code)
    this.status = status
    this.code = code
    this.body = body
  }
}

/** JSON call to the Papirma API. Cookies (recipient session) ride along same-origin. */
export async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`/api/${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'error', data)
  return data as T
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const PDF_REASONS: Record<string, string> = {
  not_pdf: 'That file is not a PDF.',
  encrypted: 'This PDF is password-protected. Remove the password and upload it again.',
  unreadable: 'This PDF looks damaged and could not be read.',
  too_large: 'This PDF is larger than 25 MB.',
  too_many_pages: 'This PDF has more than 300 pages.',
  no_pages: 'This PDF has no pages.',
  empty: 'The file is empty.',
}

/** Plain-language message for an API error. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Check your connection and try again.'
  if (err.code === 'invalid_pdf') return PDF_REASONS[String(err.body.reason)] ?? 'That PDF could not be used.'
  if (err.code === 'weak_password') return String(err.body.message ?? 'That password is too weak.')
  const messages: Record<string, string> = {
    pro_required: 'This feature needs a Papirma Pro plan.',
    unauthorized: 'Please sign in again.',
    duplicate_recipient: 'Each email address can only be added once.',
    has_open_invitations: 'Revoke the open invitations for this document before deleting it.',
    invitation_closed: 'This invitation is no longer active.',
    already_revoked: 'This invitation was already revoked.',
    already_completed: 'This invitation has already been signed.',
    rate_limited: 'Too many attempts. Please wait a while and try again.',
    invalid_request: 'Please check the form and try again.',
  }
  return messages[err.code] ?? 'Something went wrong. Please try again.'
}
