// Compliance objective — fraction of zoning constraints satisfied.
//
// Score = (passing checks) / (total checks). The five checks live in
// ./checks.ts; this objective just composes them into the [0,1] shape
// the rest of the optimizer expects.
//
// Notes are *failing-only* — a passing candidate gets no notes (the
// gallery shows ✓ implicitly). Each failing-check note is the check's
// `detail` string so the user gets actionable feedback like
// "FAR 2.31 exceeds limit 2.0" rather than just "compliance failed".
//
// Why not a hard 0/1 gate (filter out non-compliant before scoring):
//   - A candidate failing one of five checks (e.g. coverage by 2%) is
//     informative — the gallery can show it greyed out so the user
//     learns *why* the search couldn't satisfy that constraint.
//   - Weighting compliance at ≥ 1.0 in DEFAULT_WEIGHTS makes
//     non-compliance dominate naturally; 1/5 is a 0.2 score, which
//     pulls a candidate well below any compliant peer.

import { runComplianceChecks } from './checks'
import type {
  CandidateEvaluation,
  Objective,
  ObjectiveResult,
} from './types'

export const compliance: Objective = (
  ctx: CandidateEvaluation,
): ObjectiveResult => {
  const results = runComplianceChecks(ctx)
  const total = results.length
  const passed = results.filter((r) => r.pass).length
  const score = total === 0 ? 1 : passed / total
  const failNotes = results
    .filter((r) => !r.pass)
    .map((r) => `${r.name}: ${r.detail}`)
  return {
    score,
    raw: score,
    notes: failNotes.length > 0 ? failNotes : undefined,
  }
}
