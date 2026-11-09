export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Capture a pointer so moves keep arriving outside the element; never fatal if the browser refuses. */
export function capturePointer(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId)
  } catch {
    /* pointer already released or synthetic */
  }
}
