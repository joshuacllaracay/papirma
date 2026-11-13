/** An error that is safe to show to the caller: a status, a stable code and optional public fields. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly extra: Record<string, unknown>

  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export const notFound = () => new HttpError(404, 'not_found')
export const unauthorized = (code = 'unauthorized') => new HttpError(401, code)
export const forbidden = (code = 'forbidden') => new HttpError(403, code)
export const conflict = (code: string, extra?: Record<string, unknown>) => new HttpError(409, code, extra)
export const badRequest = (code: string, extra?: Record<string, unknown>) => new HttpError(400, code, extra)
export const tooMany = (retryAfterSec: number, code = 'rate_limited') => new HttpError(429, code, { retryAfterSec })
