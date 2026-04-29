// Shared deterministic hashing utilities. Pure, dependency-free.
//
// The IFC writer (Phase 3-6) uses cyrb128 to derive stable IfcGloballyUniqueId
// values from Pascal node ids; the room-partition wall emitter (Phase 3-7,
// Task 5) uses it to derive stable wall ids from canonical edge coordinates.
// Both consumers want determinism — same input string → same output bytes —
// without paying for cryptographic strength or async Web Crypto plumbing.
//
// cyrb128 is a public-domain non-cryptographic 128-bit hash by bryc. See the
// IFC GUID derivation in `ifc/guid.ts` for the longer rationale; the gist is
// that we only need uniqueness within a single export (a few thousand
// entities), not collision resistance against adversaries.

/**
 * cyrb128 — a 128-bit non-cryptographic hash. Returns a tuple of four
 * 32-bit unsigned integers; concatenate them MSB-first to get 16 bytes /
 * 128 bits. Public-domain reference implementation, ported as-is.
 */
export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/**
 * Convenience: cyrb128 packed as a lowercase hex string (32 chars).
 * Useful for ID derivation where the consumer wants a string slice
 * rather than four uint32s. Phase 3-7 wall ids use the first 12 chars.
 */
export function cyrb128Hex(str: string): string {
  return cyrb128(str)
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('')
}
