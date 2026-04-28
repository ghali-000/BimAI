// Objective composition.
//
// Four objectives, one weighted-sum composer. The composer treats each
// weight as the objective's contribution under perfect performance, so
// `{ mixAccuracy: 1, sellableArea: 0.5, costPerUnit: 0.5, compliance: 1 }`
// is read as "I care twice as much about hitting the mix and being
// compliant as I do about size and cost". Total weight doesn't have to
// be 1 — the composer normalizes by the sum.
//
// Defaults: mix-accuracy and compliance are the load-bearing
// constraints (the user explicitly requested these), so they ship at 1.
// Sellable-area and cost-per-unit are the "shape the optimizer's
// preference" knobs — start at 0.5 each so a perfectly-mixed but
// medium-FAR candidate beats a half-mixed but high-FAR one.

import { compliance } from './compliance'
import { costPerUnit } from './cost-per-unit'
import { mixAccuracy } from './mix-accuracy'
import { sellableArea } from './sellable-area'
import type {
  CandidateEvaluation,
  Objective,
  ObjectiveName,
  ObjectiveResult,
  ObjectiveWeights,
} from './types'

export type {
  CandidateEvaluation,
  Objective,
  ObjectiveName,
  ObjectiveResult,
  ObjectiveWeights,
} from './types'
export { mixAccuracy } from './mix-accuracy'
export { sellableArea } from './sellable-area'
export { costPerUnit, makeCostPerUnit, DEFAULT_TARGET_COST_PER_UNIT } from './cost-per-unit'
export { compliance } from './compliance'

/**
 * The fixed registry of objectives. Adding one is a code change here
 * plus an `ObjectiveName` extension in ./types.ts plus a default weight.
 */
export const OBJECTIVES: Record<ObjectiveName, Objective> = {
  mixAccuracy,
  sellableArea,
  costPerUnit,
  compliance,
}

/**
 * Default weight bag. Equal-importance for the two hard requirements
 * (mix + compliance), half-importance for the two preference shapers.
 */
export const DEFAULT_WEIGHTS: ObjectiveWeights = {
  mixAccuracy: 1,
  sellableArea: 0.5,
  costPerUnit: 0.5,
  compliance: 1,
}

export interface ComposedObjectives {
  /** Weighted-mean composite in [0, 1]. Higher is better. */
  score: number
  /** Per-objective breakdown. Always populated for every name in the
   *  registry, even when the corresponding weight is 0 (so the UI can
   *  show "this objective is currently muted"). */
  breakdown: Record<ObjectiveName, ObjectiveResult>
}

/**
 * Score a candidate against every registered objective and return the
 * weighted composite plus the per-objective breakdown.
 *
 * Behaviour:
 *   - Each objective runs once. Failures inside an objective are not
 *     caught here — they propagate. Objectives are pure-math; if one
 *     throws it's a bug, not a user input issue.
 *   - Negative or zero weights count as 0 (objective contributes
 *     nothing but is still in the breakdown).
 *   - If every effective weight is 0 (e.g. user muted everything),
 *     the composite score is 0. The breakdown is still complete.
 */
export function composeObjectives(
  ctx: CandidateEvaluation,
  weights: ObjectiveWeights = DEFAULT_WEIGHTS,
): ComposedObjectives {
  // Evaluate every objective. Order matches OBJECTIVES insertion.
  const breakdown = {
    mixAccuracy: OBJECTIVES.mixAccuracy(ctx),
    sellableArea: OBJECTIVES.sellableArea(ctx),
    costPerUnit: OBJECTIVES.costPerUnit(ctx),
    compliance: OBJECTIVES.compliance(ctx),
  } as Record<ObjectiveName, ObjectiveResult>

  let weightedSum = 0
  let totalWeight = 0
  for (const name of Object.keys(breakdown) as ObjectiveName[]) {
    const w = Math.max(0, weights[name] ?? 0)
    if (w === 0) continue
    weightedSum += breakdown[name].score * w
    totalWeight += w
  }
  const score = totalWeight > 0 ? weightedSum / totalWeight : 0
  return { score, breakdown }
}
