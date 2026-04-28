// Compliance objective — fraction of zoning constraints satisfied.
//
// Phase 3-5 Task 3 ships this as a stub returning 1.0 with a note. The
// actual constraint checks (envelope containment, FAR, coverage, height,
// open space) land in Task 4 — they need a few helpers (slab area sums
// vs plot area, building height = floorCount × floorHeight, etc.) that
// also belong in this module so we don't fork the math.
//
// Contract for Task 4: this objective will return:
//   - score = (passing checks) / (total checks)
//   - raw  = same as score
//   - notes lists the *failing* checks with details
// The composer treats compliance like any other objective — weight it
// high (e.g. 1.0 with others at 0.3) to make non-compliance dominate.
//
// Why not a hard 0/1 gate (filter out non-compliant before scoring):
//   - A candidate failing one of five checks (e.g. coverage by 2%) is
//     informative — the gallery can show it greyed out so the user
//     learns *why* the search couldn't satisfy that constraint.
//   - A weighted-sum compliance with weight ≥ 1 effectively gates
//     anyway, since 0/5 → score 0 dominates other objectives.

import type {
  CandidateEvaluation,
  Objective,
  ObjectiveResult,
} from './types'

export const compliance: Objective = (
  _ctx: CandidateEvaluation,
): ObjectiveResult => {
  // Stub: every candidate passes until Task 4 wires the real checks.
  return {
    score: 1,
    raw: 1,
    notes: ['compliance checks stubbed — Task 4 wires envelope/FAR/coverage/height/openSpace'],
  }
}
