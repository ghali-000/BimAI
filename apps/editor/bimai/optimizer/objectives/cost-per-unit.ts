// Cost-per-unit objective — lower €/unit is better.
//
// Score model: a *target budget* per unit (€150,000 by default for
// mid-market residential). score = clamp(target / actual, 0, 1). A
// candidate hitting the target lands at 1.0; a candidate at 2× the
// budget lands at 0.5; below the target stays capped at 1 because
// "underspent" doesn't mean "better than perfect" — it usually means
// the building is small or under-fit.
//
// Why a fixed target rather than ranking-relative:
//   - Lets one candidate be scored in isolation (the worker doesn't
//     need to see the rest of the batch).
//   - Stable across runs — re-running the search with one extra
//     candidate doesn't shuffle the others' scores.
//   - Reviewer can read the absolute number and form an opinion;
//     "this candidate scored 0.7" maps directly to "≈€215k/unit".
//
// Phase 3-7 may add a `budgetPerUnit` override on Site. For now the
// target is a module constant — easy to find, easy to bump.
//
// Edge cases:
//   - unitCount == 0: cost.perUnit is 0 by construction. Score 0 with
//     a note. (Sellable-area / mix-accuracy already penalize this.)
//   - cost.perUnit < target: cap at 1 (don't reward under-spending).
//   - cost.perUnit ≤ 0 with unitCount > 0: degenerate cost. Score 0.

import type {
  CandidateEvaluation,
  Objective,
  ObjectiveResult,
} from './types'

/** Default mid-market residential target, EUR / unit. */
export const DEFAULT_TARGET_COST_PER_UNIT = 150_000

export interface CostPerUnitOptions {
  targetCostPerUnit?: number
}

export function makeCostPerUnit(opts: CostPerUnitOptions = {}): Objective {
  const target = opts.targetCostPerUnit ?? DEFAULT_TARGET_COST_PER_UNIT
  return (ctx: CandidateEvaluation): ObjectiveResult => {
    const perUnit = ctx.cost.perUnit
    const totalUnits = ctx.schedule.residential.totalUnits
    if (totalUnits <= 0) {
      return { score: 0, raw: 0, notes: ['no units placed'] }
    }
    if (!Number.isFinite(perUnit) || perUnit <= 0) {
      return { score: 0, raw: perUnit, notes: ['cost-per-unit is zero or invalid'] }
    }
    const ratio = target / perUnit
    const score = ratio > 1 ? 1 : ratio < 0 ? 0 : ratio
    return { score, raw: perUnit }
  }
}

/** Default-target instance for direct import. */
export const costPerUnit: Objective = makeCostPerUnit()
