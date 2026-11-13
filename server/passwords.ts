import { randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core'
import * as zxcvbnCommon from '@zxcvbn-ts/language-common'

/**
 * Argon2id with OWASP's minimum recommended parameters
 * (m = 19 MiB, t = 2, p = 1). `algorithm: 2` is Argon2id in @node-rs/argon2.
 */
const ARGON2 = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const

/** Unambiguous alphabet (no I, L, O, 0, 1) — easy to read aloud or over chat. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const GENERATED_LENGTH = 16 // 16 × log2(31) ≈ 79 bits

export const MIN_CUSTOM_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 128

/** Generated passwords are displayed grouped ("K7QF-M2XR-…") but hashed without separators. */
export function generatePassword(): { display: string; canonical: string } {
  let canonical = ''
  for (let i = 0; i < GENERATED_LENGTH; i++) canonical += ALPHABET[randomInt(ALPHABET.length)]
  return { display: canonical.match(/.{4}/g)!.join('-'), canonical }
}

/** What a typed generated password would look like once spaces/hyphens and case are normalized. */
function canonicalForm(input: string): string | null {
  const c = input.replace(/[\s-]/g, '').toUpperCase()
  return c.length === GENERATED_LENGTH && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null
}

let zxcvbnReady = false
function strength(password: string, userInputs: string[]) {
  if (!zxcvbnReady) {
    zxcvbnOptions.setOptions({
      dictionary: { ...zxcvbnCommon.dictionary },
      graphs: zxcvbnCommon.adjacencyGraphs,
    })
    zxcvbnReady = true
  }
  return zxcvbn(password, userInputs)
}

/** Sender-chosen passwords must be long and not guessable. Returns a reason when rejected. */
export function checkCustomPassword(password: string, userInputs: string[]): string | null {
  if (password.length < MIN_CUSTOM_LENGTH) return `Use at least ${MIN_CUSTOM_LENGTH} characters.`
  if (password.length > MAX_PASSWORD_LENGTH) return 'Password is too long.'
  const lower = password.toLowerCase()
  for (const input of userInputs) {
    if (input.length >= 3 && lower.includes(input.toLowerCase())) return 'Do not include the recipient’s email or name.'
  }
  if (strength(password, userInputs).score < 3) return 'This password is too easy to guess. Use a longer, less predictable one.'
  return null
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2)
}

/** Checks the password as typed and, if it looks like a generated one, in canonical form. */
export async function verifyPassword(stored: string, input: string): Promise<boolean> {
  const candidates = new Set([input])
  const canonical = canonicalForm(input)
  if (canonical) candidates.add(canonical)
  let ok = false
  for (const c of candidates) {
    // evaluate every candidate so timing doesn't depend on which one matched
    if (await verify(stored, c).catch(() => false)) ok = true
  }
  return ok
}

let dummyHash: Promise<string> | null = null
/** Burn comparable CPU when there is no real hash, so unknown links can't be told apart by timing. */
export async function verifyAgainstDummy(input: string): Promise<false> {
  dummyHash ??= hashPassword(generatePassword().canonical)
  await verify(await dummyHash, input).catch(() => false)
  return false
}
