// GenerationParams — the knob bag the optimizer varies.
//
// Phase 3-3 baked one fixed strategy into each generator stage (left-to-right
// packing, long-axis corridor, demand-based floor count, 0.5 m structural
// margin, declared unit ordering). Phase 3-5 turns each of those into a
// parameter so the search loop can produce many candidates from one program.
//
// Two design rules:
//
//   1. **Defaults reproduce Phase 3-3 byte-for-byte.** When a caller passes
//      no `params` (or only some fields), the pipeline must produce the same
//      building it did before this phase landed. Tests for the prior
//      generator behaviour stay green without changes.
//
//   2. **Stages read params, never the optimizer.** The pipeline accepts a
//      `GenerationParams` and threads it down. Stages never reach back up
//      into an optimizer module — the dependency arrow is one-way so the
//      generator stays usable from the CLI and from individual test cases
//      without any optimizer code in scope.
//
// `seed` is reproducibility's load-bearing field. Same seed + same input =
// byte-identical candidate. Stages that introduce stochastic substages
// (mostly Phase 3-5b material) read `params.seed` (and `params.variant`
// for further substage tiebreaking) rather than calling Math.random.

export type FloorCountStrategy =
  | 'fill-far' // pack as many floors as the FAR cap allows (clamped by height)
  | 'fill-height' // pack as many floors as the height cap allows (clamped by FAR)
  | 'demand-based' // smallest floor count that satisfies the program (current default)

export type CorridorOrientation =
  | 'long-axis' // corridor runs along the rectangle's long edge (current default)
  | 'short-axis' // corridor runs along the short edge
  | 'auto' // pick whichever yields more habitable strip depth

export type PackingStrategy =
  | 'left-to-right' // greedy strip-fill, continues on same strip until full (current default)
  | 'alternating' // toggle strip per unit; produces a balanced two-façade layout
  | 'grouped-by-type' // when the unit type changes, switch strips to keep types contiguous

export type UnitOrderingHeuristic =
  | 'mix-declared' // declared order from program.unitMix (current default)
  | 'largest-first' // sort queue by targetArea descending
  | 'smallest-first' // sort queue by targetArea ascending

export interface GenerationParams {
  /** RNG seed; reproducibility key. Defaults to 42. */
  seed: number

  // Footprint stage
  /** Structural inset beyond envelope, metres. Range 0.0–2.0. */
  footprintInsetM: number
  /**
   * Rotation of the footprint about its centroid, radians.
   * 0 = align with envelope's natural axis (current behaviour).
   * Non-zero rotates the inset and re-clips against the envelope; if the
   * rotated rectangle would overflow, the footprint stage returns null and
   * the orchestrator surfaces `no_valid_footprint`.
   */
  footprintOrientation: number

  // Floor count stage
  floorCountStrategy: FloorCountStrategy

  // Corridor stage
  corridorOrientation: CorridorOrientation
  /** Width across the corridor, metres. Range 1.2–2.0. */
  corridorWidthM: number

  // Unit packing stage
  packingStrategy: PackingStrategy
  unitOrderingHeuristic: UnitOrderingHeuristic

  /**
   * Tiebreaker for stochastic substages — same seed + same variant always
   * produces the same candidate, but two candidates can differ on `variant`
   * alone when the search loop wants neighbouring points in parameter space
   * without changing seeds.
   */
  variant: number
}

/**
 * Phase 3-3-equivalent defaults. Critically: passing no `params` (or partial
 * params merged with these defaults) must reproduce the pre-3-5 pipeline
 * behaviour exactly. Any change here is a behaviour-change of the public
 * generator and must be intentional.
 */
export const DEFAULT_PARAMS: GenerationParams = {
  seed: 42,
  footprintInsetM: 0.5, // matches STRUCTURAL_MARGIN_M from Phase 3-3
  footprintOrientation: 0,
  floorCountStrategy: 'demand-based',
  corridorOrientation: 'long-axis',
  corridorWidthM: 1.5, // matches DEFAULT_CORRIDOR_WIDTH_M from Phase 3-3
  packingStrategy: 'left-to-right',
  unitOrderingHeuristic: 'mix-declared',
  variant: 0,
}

/**
 * Merge a partial params override over defaults. Convenience helper used by
 * the pipeline to handle the optional `input.params` field — callers can
 * pass nothing, some fields, or all fields.
 */
export function withDefaults(
  partial?: Partial<GenerationParams>,
): GenerationParams {
  if (!partial) return { ...DEFAULT_PARAMS }
  return { ...DEFAULT_PARAMS, ...partial }
}
