const KEY = 'papirma.rating'

/** True until this browser has rated or dismissed the rating prompt once. */
export function shouldAskForRating(): boolean {
  try {
    return !localStorage.getItem(KEY)
  } catch {
    return false // storage blocked: don't nag on every download
  }
}

/** Remember the rating (1–5) or "dismissed" so the prompt never shows again. */
export function rememberRating(value: string) {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* ignore */
  }
}
