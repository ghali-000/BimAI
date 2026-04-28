// Objective types — the contract every objective implements.
//
// Two layers:
//   - `Objective` — pure function from a CandidateEvaluation to a
//     0..1 score plus a raw value (the underlying metric, kept around
//     for the gallery's "why this candidate?" tooltips).
//   - `composeObjectives` (in ./index.ts) — weighted average over a
//     fixed set of named objectives, returning one [0,1] composite
//     score plus the per-objective breakdown.
//
// Why [0,1] for every objective:
//   - Lets the search loop sort candidates by composite score directly.
//   - Lets the UI render objectives as bars without per-objective
//     normalization rules baked in.
//   - Makes the weights interpretable: the weight is exactly the
//     objective's contribution under perfect performance.

import type { ZoningRules } from '../../schemas'
import type { Program } from '../../schemas'
import type { BuildingPlan } from '../../generator/types'
import type { ScheduleResult } from '../../schedule/types'
import type { CostResult } from '../../cost/types'

/**
 * Everything an objective needs to score one candidate. Built once
 * per candidate by the search loop and passed to every objective.
 *
 * `plotArea` is precomputed so objectives don't each re-walk the
 * polygon; it's the absolute area of `program`-paired plot polygon.
 */
export interface CandidateEvaluation {
  program: Program
  zoning: ZoningRules
  plotArea: number
  plan: BuildingPlan
  schedule: ScheduleResult
  cost: CostResult
}

export interface ObjectiveResult {
  /** [0, 1]. Higher is better. NaN/Infinity-free. */
  score: number
  /** The underlying metric (e.g. "0.93" for mix-accuracy, "4250" €/unit
   *  for cost-per-unit). Kept around so the UI can show context-aware
   *  formatting without reverse-engineering it from the score. */
  raw: number
  /** Optional notes — e.g. "1BR over-placed: 7 of 6 requested". */
  notes?: string[]
}

export type Objective = (ctx: CandidateEvaluation) => ObjectiveResult

/** Names of the four built-in objectives. Composition uses these keys. */
export type ObjectiveName =
  | 'mixAccuracy'
  | 'sellableArea'
  | 'costPerUnit'
  | 'compliance'

/** Per-objective weight bag for composeObjectives. Sum != 1 is fine — the
 *  composer normalizes by total weight. Zero or negative weights are
 *  treated as zero (objective contributes nothing). */
export type ObjectiveWeights = Record<ObjectiveName, number>
