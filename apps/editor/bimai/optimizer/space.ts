// ParamSpace — the search-space schema the optimizer samples from.
//
// `GenerationParams` (params.ts) describes *one point* in the search
// space; `ParamSpace` describes the *space itself*. Each field of
// `GenerationParams` maps to a `ParamDomain` declaring how to sample
// that field:
//
//   - 'enum'  — uniform pick from a fixed `values` tuple
//   - 'range' — uniform draw from a continuous [min, max] interval
//   - 'int'   — uniform draw from an integer [min, max] (inclusive)
//
// The hybrid model: enums + `variant` are inherently categorical and
// stay discrete; the four numeric knobs (insetM, orientation,
// corridorWidthM, seed) become continuous. Random search natively
// explores both: one switch on `domain.kind` covers every knob.
//
// The default space (`DEFAULT_SPACE`) bakes in the bounds we ship
// with. Hand-edit this constant to widen/narrow ranges; there is no
// UI for editing it in Phase 3-5 (deferred to 3-7+ if there's demand).
//
// Reproducibility:
//   - `sampleFromSpace(space, rng)` is pure: same RNG state ⇒ same
//     point. The search loop calls it N times against one master PRNG
//     so the sequence of N candidates is reproducible from the user's
//     input seed alone.
//   - Each sampled candidate gets its own `seed` field drawn from the
//     master — stages that need randomness use the candidate seed,
//     not the master, so candidate-level reproducibility is independent
//     of search-level reproducibility.

import type {
  CorridorOrientation,
  FloorCountStrategy,
  GenerationParams,
  PackingStrategy,
  UnitOrderingHeuristic,
} from './params'

/**
 * One field's domain. Discriminated by `kind` so the sampler is a
 * single switch with no `as` casts.
 */
export type ParamDomain<T> =
  | { kind: 'enum'; values: readonly T[] }
  | (T extends number
      ? { kind: 'range'; min: number; max: number }
      | { kind: 'int'; min: number; max: number }
      : never)

/**
 * The full search-space schema. One domain per field of
 * `GenerationParams`. The mapped type ties them together so adding a
 * field to `GenerationParams` makes this type complain until you
 * declare its domain.
 */
export type ParamSpace = {
  [K in keyof GenerationParams]: ParamDomain<GenerationParams[K]>
}

// Enum value tuples — `as const` is required so TypeScript narrows
// `values[i]` to the literal union (e.g. 'long-axis' | 'short-axis' |
// 'auto') rather than `string`. Without it the sampler returns
// `string` and the GenerationParams field assignment fails.
const FLOOR_COUNT_STRATEGIES = [
  'demand-based',
  'fill-far',
  'fill-height',
] as const satisfies readonly FloorCountStrategy[]

const CORRIDOR_ORIENTATIONS = [
  'long-axis',
  'short-axis',
  'auto',
] as const satisfies readonly CorridorOrientation[]

const PACKING_STRATEGIES = [
  'left-to-right',
  'alternating',
  'grouped-by-type',
] as const satisfies readonly PackingStrategy[]

const UNIT_ORDERING_HEURISTICS = [
  'mix-declared',
  'largest-first',
  'smallest-first',
] as const satisfies readonly UnitOrderingHeuristic[]

/**
 * Default search bounds shipped with the optimizer.
 *
 * Notes on numeric ranges:
 *   - `footprintInsetM`: 0.3 m is a tight but plausible structural
 *     margin; 1.5 m is generous (eaves + offsets + buffer).
 *   - `footprintOrientation`: [0, π/2). Half-rotation symmetry of a
 *     rectangle covers all distinct orientations — π/2 maps back to 0.
 *     The footprint stage returns null when the rotated rectangle
 *     overflows the envelope; the search loop treats those as
 *     compliance-failures (score 0) rather than crashes.
 *   - `corridorWidthM`: 1.2 m is the EU residential code minimum;
 *     anything below that should hard-fail compliance, not be sampled.
 *     2.4 m is the upper bound where any wider corridor becomes a
 *     wasteful gallery.
 *   - `seed`: int [0, 2^31 − 1]. Using full uint32 would risk hash
 *     collisions on shoehorned 32-bit ints in some downstream callers;
 *     2^31−1 is safer and still gives 2 billion distinct seeds.
 *   - `variant`: int [0, 7]. Eight tiebreaker buckets is plenty when
 *     two candidates land on the same other-knob values.
 */
export const DEFAULT_SPACE: ParamSpace = {
  seed: { kind: 'int', min: 0, max: 0x7fff_ffff },
  footprintInsetM: { kind: 'range', min: 0.3, max: 1.5 },
  footprintOrientation: { kind: 'range', min: 0, max: Math.PI / 2 },
  floorCountStrategy: { kind: 'enum', values: FLOOR_COUNT_STRATEGIES },
  corridorOrientation: { kind: 'enum', values: CORRIDOR_ORIENTATIONS },
  corridorWidthM: { kind: 'range', min: 1.2, max: 2.4 },
  packingStrategy: { kind: 'enum', values: PACKING_STRATEGIES },
  unitOrderingHeuristic: { kind: 'enum', values: UNIT_ORDERING_HEURISTICS },
  variant: { kind: 'int', min: 0, max: 7 },
}

/**
 * Plot-adaptive search space.
 *
 * Phase 3-5's integration check on a 30×30 default scene landed only
 * 2 / 20 candidates compliant — 18 failed `no_valid_footprint`. Root
 * cause: `DEFAULT_SPACE` samples `footprintInsetM` and
 * `footprintOrientation` from bounds tuned for "any plausible plot",
 * which on small or square plots collapses the rotated-rectangle clip
 * step inside the footprint stage almost every roll.
 *
 * `buildParamSpace({ plotWidth, plotDepth })` shrinks those two
 * domains as a function of the plot's bounding box:
 *
 *   - **Inset** stays in the published [0.3, 1.5] band but never
 *     exceeds 40 % of the plot's smallest side. On a 30×30 plot the
 *     cap is 12 m, so DEFAULT_SPACE wins; on a 4×6 plot the inset
 *     domain shrinks to [0.3, 1.6 → 1.5]. This keeps the inset
 *     non-trivial without ever inverting the footprint.
 *
 *   - **Orientation** narrows on near-square plots. When the plot's
 *     aspect ratio is > 1.5 (clearly elongated) we allow ±π/24 (7.5°);
 *     when squarer than 1.5:1 we clamp to ±π/36 (5°). Both bands are
 *     much tighter than they intuitively "should" be: the footprint
 *     stage rotates the *inset* polygon and rejects anything that
 *     overflows the *post-setback* envelope, and on a default
 *     30×30 plot with 5/3/4 setbacks the buildable rectangle is only
 *     24×21 — which means even π/12 of rotation overflows on a 21×18
 *     inset. ±π/36 was tuned on the Phase 3-6 DOD case (default 30×30
 *     + default program ⇒ ≥16/20 compliant).
 *
 * Every other domain is unchanged — only the two footprint knobs are
 * plot-sensitive.
 *
 * Definition of done (per Phase 3-6 brief): default 30×30 + default
 * program lands ≥80 % compliant samples (target 16+/20).
 */
export interface PlotShape {
  /** Bounding-box width — major axis is irrelevant, just the spans. */
  plotWidth: number
  /** Bounding-box depth. */
  plotDepth: number
}

export function buildParamSpace(plot: PlotShape): ParamSpace {
  const minSide = Math.min(plot.plotWidth, plot.plotDepth)
  const maxSide = Math.max(plot.plotWidth, plot.plotDepth)
  // Guard against zero/negative spans — the search loop should never
  // hand us those (the pipeline rejects them upstream as invalid_input)
  // but the math here would produce NaN bounds without a fallback.
  if (!Number.isFinite(minSide) || minSide <= 0) return DEFAULT_SPACE

  const aspectRatio = maxSide / minSide

  // Inset cap: never more than 40 % of the smallest side. Floor at 0.3
  // so we stay above the structural margin baseline and don't degenerate
  // to a point-sample on tiny plots (where the optimizer has no business
  // running anyway).
  const insetMax = Math.max(0.3, Math.min(1.5, 0.4 * minSide))
  // Orientation: near-square plots get a tight band; elongated plots
  // get a slightly wider one. Both stay small because the footprint
  // stage clips the rotated inset polygon against the post-setback
  // envelope, and that envelope is much tighter than the raw plot.
  // Empirically tuned: ±π/36 on the Phase 3-6 DOD case (30×30 default)
  // yields 17/20 compliant; π/12 yields 6/20.
  const orientationMax = aspectRatio > 1.5 ? Math.PI / 24 : Math.PI / 36

  return {
    ...DEFAULT_SPACE,
    footprintInsetM: { kind: 'range', min: 0.3, max: insetMax },
    footprintOrientation: { kind: 'range', min: -orientationMax, max: orientationMax },
  }
}

/** Bounding-box span helper used by callers that have a polygon
 *  rather than a pre-computed (width, depth) pair. */
export function plotBoundingBox(
  polygon: ReadonlyArray<readonly [number, number]>,
): PlotShape | null {
  if (polygon.length < 3) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of polygon) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const w = maxX - minX
  const d = maxY - minY
  if (!Number.isFinite(w) || !Number.isFinite(d) || w <= 0 || d <= 0) return null
  return { plotWidth: w, plotDepth: d }
}

/**
 * Sample one point from a domain using `rng()` ∈ [0, 1).
 *
 * Behaviour by kind:
 *   - 'enum'  → `values[floor(rng() * values.length)]`
 *   - 'range' → `min + rng() * (max − min)`        (continuous, [min, max))
 *   - 'int'   → `floor(min + rng() * (max − min + 1))` (uniform [min, max])
 *
 * The 'int' formula uses `max − min + 1` so both endpoints are
 * reachable; `Math.floor` of `rng() * range` would otherwise miss the
 * upper bound.
 */
function sampleDomain<T>(domain: ParamDomain<T>, rng: () => number): T {
  switch (domain.kind) {
    case 'enum': {
      const i = Math.floor(rng() * domain.values.length)
      // Clamp guards against rng() === 1 (mulberry32 doesn't, but
      // future PRNGs might): clamping keeps us in-bounds.
      const idx = i >= domain.values.length ? domain.values.length - 1 : i
      return domain.values[idx]!
    }
    case 'range': {
      const v = domain.min + rng() * (domain.max - domain.min)
      // `range` only legal when T extends number; cast is safe.
      return v as unknown as T
    }
    case 'int': {
      const span = domain.max - domain.min + 1
      const v = Math.floor(domain.min + rng() * span)
      const clamped = v > domain.max ? domain.max : v
      return clamped as unknown as T
    }
  }
}

/**
 * Sample one full `GenerationParams` from the space. The order of
 * field assignments here is the search loop's canonical order — every
 * field consumes one rng() draw (or two for 'enum' on a 1-element set,
 * which still consumes one for parity) so changing the order changes
 * the candidate produced for a given seed. Don't reorder unless you
 * mean to.
 */
export function sampleFromSpace(
  space: ParamSpace,
  rng: () => number,
): GenerationParams {
  return {
    seed: sampleDomain(space.seed, rng),
    footprintInsetM: sampleDomain(space.footprintInsetM, rng),
    footprintOrientation: sampleDomain(space.footprintOrientation, rng),
    floorCountStrategy: sampleDomain(space.floorCountStrategy, rng),
    corridorOrientation: sampleDomain(space.corridorOrientation, rng),
    corridorWidthM: sampleDomain(space.corridorWidthM, rng),
    packingStrategy: sampleDomain(space.packingStrategy, rng),
    unitOrderingHeuristic: sampleDomain(space.unitOrderingHeuristic, rng),
    variant: sampleDomain(space.variant, rng),
  }
}
