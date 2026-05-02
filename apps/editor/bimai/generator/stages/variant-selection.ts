// Phase 3-9 Task 9: per-unit variant selection.
//
// Greedy-by-score [GATE 2]. Each unit is scored independently against
// the variant catalog and the best-scoring eligible template wins.
// Determinism + tie-breaks are pinned (alphabetical id ascending) so
// regen produces the same selections.
//
// Why greedy and not constraint-propagating: the architectural-
// plausibility win comes from having multiple templates per unit type
// (Task 4 shipped 13 variants across 5 types) — not from cross-unit
// constraint propagation. Phase 3-5's optimizer already does building-
// level optimisation at the parameter level (corridor orientation,
// unit depth); template selection is a unit-level concern and stays
// simple. Phase 3-10+ can revisit if data shows greedy mismatches.
//
// Optimizer interaction note. Adding template selection grows the
// generator's output space without growing the optimizer's parameter
// space — the optimizer doesn't currently see template ids, so it
// can't search over them. A future `template_fit` objective in
// Phase 3-10 could either (a) expose a per-unit template-selection
// knob to the optimizer, or (b) treat the greedy selection as a
// dependent variable and fold its score into the existing objectives.
// Documented here, not addressed in 3-9.

import { traceGroup, traceGroupEnd, traceLog } from '../debug'
import {
  type SubdivideSpec,
  type UnitTemplate as Phase37Template,
  getUnitTemplate as getPhase37Template,
} from './rooms-templates'
import { VARIANT_CATALOG } from '../templates/units'
import type {
  UnitVariantCatalog,
  UnitVariantTemplate,
} from '../templates/units/types'

/**
 * Per-unit conditions the selector reads. Computed at the call site
 * by the room emitter (Task 10) from the packed UnitPlan + Program
 * setting; the selector itself stays pure.
 */
export interface UnitConditions {
  /** Stable id for trace logs and selection records. */
  unitId: string
  /** UnitMix.type the unit was generated for. */
  unitType: string
  /** Unit polygon area in m². */
  area: number
  /** Unit depth (perpendicular to corridor) in m — feeds the deepPlate score. */
  depthM: number
  /** Count of unit edges that touch the building exterior. */
  facadeEdges: number
  /** True iff `facadeEdges >= 2`. Cached so the score function reads cleanly. */
  isCorner: boolean
  /** User's opt-in setting from `Program.generateBalconies`. */
  generateBalconies: boolean
}

/**
 * Score weights. Pinned inline so the test fixtures can assert
 * specific point contributions without re-deriving them. Tweaking
 * any weight is a behaviour change — bump the test corpus.
 */
export const SCORE_WEIGHTS = {
  /** Both corner-preferred AND unit is corner. */
  cornerMatchPositive: 3.0,
  /** Both NON-corner-preferred AND unit is non-corner. */
  cornerMatchNegative: 1.0,
  /** facadeEdges exact match. */
  facadeEdgesExact: 2.0,
  /** Variant prefers deep plate AND unit depth ≥ DEEP_PLATE_THRESHOLD_M. */
  deepPlateMatch: 1.5,
  /**
   * User opted into balconies AND variant has one AND unit has at
   * least one facade edge. The strongest single signal: a 4-point
   * bonus dominates the area-fit penalty for any reasonable area.
   */
  balconyBonus: 4.0,
  /**
   * Linear penalty against template-center distance, normalised by
   * half the template's area band. weight × (|c.area - center| /
   * (range/2)) is subtracted. Penalty = 1.0 at the band edge,
   * smoothly grows past it (the eligibility filter already caps
   * c.area to the band, so in practice penalty ∈ [0, 1]).
   */
  areaFitWeight: 1.0,
} as const

/** Depth threshold above which `deepPlate` preference fires (metres). */
export const DEEP_PLATE_THRESHOLD_M = 9.0

/** Result of one selector call. Carries the picked template plus a
 * compact `score` for logging / tests. `fallback` flags the synthesized
 * Phase-3-7 path so the pipeline can record a `template_fallback_used`
 * warning. */
export interface SelectionResult {
  template: UnitVariantTemplate
  score: number
  fallback: boolean
}

/**
 * Pure score function. No side effects, no logging — `selectTemplate`
 * does the wrapping. Exported for test-side assertions on individual
 * weight contributions.
 */
export function scoreTemplate(
  t: UnitVariantTemplate,
  c: UnitConditions,
): number {
  let score = 0

  // Corner match — symmetric. Both prefer-corner-and-corner OR
  // both no-preference-and-non-corner. The `preferredConditions.corner`
  // field is `true | undefined` (not `false`), so we treat the
  // undefined case as "indifferent → matches non-corner unit."
  const tCornerPref = t.preferredConditions.corner === true
  if (tCornerPref && c.isCorner) {
    score += SCORE_WEIGHTS.cornerMatchPositive
  } else if (!tCornerPref && !c.isCorner) {
    score += SCORE_WEIGHTS.cornerMatchNegative
  }

  // facadeEdges exact match. Only fires when the variant declares a
  // specific count and it matches.
  if (
    t.preferredConditions.facadeEdges !== undefined &&
    t.preferredConditions.facadeEdges === c.facadeEdges
  ) {
    score += SCORE_WEIGHTS.facadeEdgesExact
  }

  // Deep-plate preference. Only fires when the variant prefers it AND
  // the unit's depth clears the threshold.
  if (
    t.preferredConditions.deepPlate === true &&
    c.depthM >= DEEP_PLATE_THRESHOLD_M
  ) {
    score += SCORE_WEIGHTS.deepPlateMatch
  }

  // Balcony bonus. Strongest single signal — see weight rationale.
  if (c.generateBalconies && t.hasBalcony && c.facadeEdges >= 1) {
    score += SCORE_WEIGHTS.balconyBonus
  }

  // Area-fit penalty. Normalised against half the band so the penalty
  // is exactly 1.0 at the band edges. Eligibility filter already
  // bounds c.area to the band, so in practice this is in [0, 1].
  const center = (t.areaBand.minM2 + t.areaBand.maxM2) / 2
  const halfRange = (t.areaBand.maxM2 - t.areaBand.minM2) / 2
  if (halfRange > 0) {
    const penalty =
      SCORE_WEIGHTS.areaFitWeight * (Math.abs(c.area - center) / halfRange)
    score -= penalty
  }

  return score
}

/**
 * Filter the catalog down to eligible variants for a unit. A variant
 * is eligible when:
 *   - `unitType` matches
 *   - the unit's area lies in `[areaBand.minM2, areaBand.maxM2]`
 *   - balcony eligibility: indoor-only variants are always eligible;
 *     balcony variants require `generateBalconies === true`.
 */
function eligibleVariants(
  c: UnitConditions,
  catalog: UnitVariantCatalog,
): UnitVariantTemplate[] {
  return catalog.filter((t) => {
    if (t.unitType !== c.unitType) return false
    if (c.area < t.areaBand.minM2 || c.area > t.areaBand.maxM2) return false
    if (t.hasBalcony && !c.generateBalconies) return false
    return true
  })
}

/**
 * Synthesize a fallback variant from the Phase-3-7 `getUnitTemplate`
 * registry. Wraps the proven SubdivideSpec into a
 * `UnitVariantTemplate` shape so the rest of the pipeline never sees
 * a typed-difference between catalog hits and fallbacks. The id
 * convention `fallback-${unitType}` is what the pipeline records via
 * its `template_fallback_used` warning.
 *
 * Returns `null` only when the unit type is itself unknown (no
 * Phase-3-7 template either) — at that point the caller must surface
 * a hard error rather than silently dropping into unit-shell.
 */
function synthesizeFallback(
  unitType: string,
): UnitVariantTemplate | null {
  const phase37: Phase37Template | undefined = getPhase37Template(unitType)
  if (!phase37) return null
  return {
    id: `fallback-${unitType}`,
    unitType,
    label: `Fallback ${unitType} (Phase 3-7 default)`,
    areaBand: {
      minM2: phase37.areaRangeM2.min,
      maxM2: phase37.areaRangeM2.max,
    },
    preferredConditions: {},
    hasBalcony: false,
    slices: phase37.rootSplit as SubdivideSpec,
  }
}

/**
 * Pick one variant for a unit. Greedy: score every eligible variant,
 * return the highest scorer. Ties broken alphabetically by id
 * (deterministic — same unit + same catalog = same selection).
 *
 * No catalog entry matches → synthesize the Phase-3-7 fallback. The
 * return's `fallback === true` is the call site's signal to push a
 * `template_fallback_used` warning.
 */
export function selectTemplate(
  c: UnitConditions,
  catalog: UnitVariantCatalog = VARIANT_CATALOG,
): SelectionResult {
  const eligible = eligibleVariants(c, catalog)
  if (eligible.length === 0) {
    const fallback = synthesizeFallback(c.unitType)
    if (!fallback) {
      throw new Error(
        `selectTemplate: no variant or fallback for unitType '${c.unitType}'`,
      )
    }
    return { template: fallback, score: 0, fallback: true }
  }
  // Score then sort: highest score first; tie-break alphabetical id.
  const scored = eligible
    .map((t) => ({ template: t, score: scoreTemplate(t, c) }))
    .sort((a, b) =>
      a.score !== b.score
        ? b.score - a.score
        : a.template.id.localeCompare(b.template.id),
    )
  const top = scored[0]!
  return { template: top.template, score: top.score, fallback: false }
}

/**
 * Bulk-select for a list of units, with a single trace log group.
 * Used by the room emitter (Task 10) so the trace stays compact in
 * `localStorage.bimai-debug = 'true'` mode.
 */
export function selectTemplatesForUnits(
  units: ReadonlyArray<UnitConditions>,
  catalog: UnitVariantCatalog = VARIANT_CATALOG,
): SelectionResult[] {
  const results = units.map((u) => selectTemplate(u, catalog))
  traceGroup('[BimAI] variant selection')
  traceLog(`${units.length} units to template`)
  units.forEach((unit, i) => {
    const r = results[i]!
    traceLog(
      `  unit ${i} (${unit.unitId}, ${unit.unitType}, ${unit.area.toFixed(1)}m²): → ${r.template.id}${r.fallback ? ' (fallback)' : ''}`,
    )
  })
  traceGroupEnd()
  return results
}
