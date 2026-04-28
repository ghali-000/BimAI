// Sampler — one function from RNG to GenerationParams.
//
// Phase 3-5 ships a single implementation: uniform random over the
// DEFAULT_SPACE. The brief mandates random search; LHS / evolutionary
// are a future-phase concern. When that lands the signature widens
// (probably to `(rng, index, total) => GenerationParams`) and a new
// sampler is added alongside this one — don't pre-build for that
// signature now.

import type { GenerationParams } from '../params'
import { DEFAULT_SPACE, sampleFromSpace } from '../space'

export type Sampler = (masterRng: () => number) => GenerationParams

/**
 * Uniform random draw from DEFAULT_SPACE. Same master RNG state ⇒
 * same GenerationParams. The search loop calls this N times against
 * a single master RNG so the sequence is reproducible from the user's
 * input seed alone.
 */
export const uniformRandomSampler: Sampler = (rng) =>
  sampleFromSpace(DEFAULT_SPACE, rng)
