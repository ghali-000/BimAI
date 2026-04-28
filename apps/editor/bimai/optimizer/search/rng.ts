// mulberry32 — small, fast, deterministic 32-bit PRNG.
//
// Why inline (not `import 'mulberry32'`):
//   - We need byte-identical reproducibility across Node, browser, and
//     Web Worker. Pulling a dependency adds version drift risk for ~12
//     lines of arithmetic.
//   - The optimizer's contract — same seed ⇒ same N candidates ⇒ same
//     building per candidate — depends on this function never changing
//     under our feet. Inlining freezes it at this revision.
//
// Two-level seeding model used by the search loop:
//   - One *master* PRNG seeded from the user's input seed. Drives every
//     `sampleFromSpace` call so the *sequence of GenerationParams* is
//     reproducible.
//   - Each sampled `GenerationParams.seed` is a fresh draw from the
//     master. Stages that need randomness (BIM material picks, future
//     stochastic substages) read the candidate's seed via a second-level
//     PRNG. So same master seed → same candidate set; same candidate
//     seed → same building. Two reproducibility levels, independent.
//
// Reference: Tommy Ettinger's mulberry32 (public domain).

/**
 * Build a deterministic 32-bit PRNG from `seed`. Returns a function that
 * yields uniform doubles in [0, 1).
 *
 * Seeds are reduced to uint32 via `>>> 0`, so any finite integer works
 * (including negatives and values > 2^31). Non-integer seeds are
 * truncated by the bit-op, which is fine — callers should pass ints.
 */
export function mulberry32(seed: number): () => number {
  // `state` is the 32-bit register the algorithm mutates each call.
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Draw a uint32 from the PRNG (for seeding child PRNGs). */
export function nextU32(rng: () => number): number {
  return Math.floor(rng() * 0x1_0000_0000) >>> 0
}
