// Phase 3-7 Fix A: opt-in trace logger for the generation pipeline.
//
// Set `localStorage.bimai-debug = 'true'` in DevTools to enable verbose
// `[BimAI Generation Trace]` logs — packer outputs, bisection results,
// emit-stage room-zone counts. Off by default so the production console
// stays quiet. Use `localStorage.removeItem('bimai-debug')` to disable.
//
// SSR-safe: returns false during server-side rendering / Node tests
// (no `window`), so calling code does not need its own typeof guards.

export function bimaiDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem('bimai-debug') === 'true'
  } catch {
    // localStorage can throw under Safari private mode etc.
    return false
  }
}

/** Cheap no-op-when-disabled wrappers so call sites stay readable. */
export const traceLog = (...args: unknown[]): void => {
  if (bimaiDebugEnabled()) console.log(...args)
}
export const traceWarn = (...args: unknown[]): void => {
  if (bimaiDebugEnabled()) console.warn(...args)
}
export const traceGroup = (label: string): void => {
  if (bimaiDebugEnabled()) console.group(label)
}
export const traceGroupEnd = (): void => {
  if (bimaiDebugEnabled()) console.groupEnd()
}
