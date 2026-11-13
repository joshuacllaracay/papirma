import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes, base64url (43 chars). Used for invitation and session tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Shape of tokens produced by randomToken(32); anything else is rejected before any lookup. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest()
}

export function hmacSha256(key: string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** Bytea values come back as Buffer (postgres.js) or Uint8Array (PGlite). */
export function asBuffer(v: unknown): Buffer {
  if (v instanceof Uint8Array) return Buffer.from(v)
  throw new Error('expected bytes')
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
