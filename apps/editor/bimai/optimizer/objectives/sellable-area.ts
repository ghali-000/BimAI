// Sellable-area objective — how well the candidate uses its FAR
// allowance.
//
// Score = NIA / (zoning.maxFAR × plotArea). The numerator is what the
// owner can actually sell; the denominator is the legal upper bound on
// GFA, used here as an approximation of the upper bound on NIA. The
// approximation is conservative (NIA ≤ GEA ≤ GFA-budget), so a score
// of 1 is unreachable in practice — typical mid-rise residential lands
// in the 0.5–0.7 range, which is exactly the band where the optimizer
// has room to differentiate candidates.
//
// Why not "NIA absolute" with a hard normalizer (e.g. divide by 10000):
// the natural normalizer changes per project. FAR-relative scoring
// stays meaningful from a 500m² plot to a 50000m² plot without retuning.
//
// Edge cases:
//   - plotArea == 0 or maxFAR == 0: degenerate inputs. Return score 0
//     so the candidate is dominated by anything sane. We don't crash.
//   - NIA > maxFAR × plotArea: the candidate over-built. Cap the score
//     at 1 and emit a note — the compliance objective will mark it
//     non-compliant.

import type {
  CandidateEvaluation,
  Objective,
  ObjectiveResult,
} from './types'

export const sellableArea: Objective = (
  ctx: CandidateEvaluation,
): ObjectiveResult => {
  const nia = ctx.schedule.totals.nia
  const cap = ctx.zoning.maxFAR * ctx.plotArea
  if (cap <= 0) {
    return { score: 0, raw: nia, notes: ['plot area or maxFAR is zero'] }
  }
  const ratio = nia / cap
  const notes: string[] = []
  let score = ratio
  if (ratio > 1) {
    notes.push(`NIA ${nia.toFixed(0)}m² exceeds FAR cap ${cap.toFixed(0)}m²`)
    score = 1
  } else if (ratio < 0) {
    // schedule shouldn't return negative area, but guard anyway.
    score = 0
  }
  return { score, raw: nia, notes: notes.length > 0 ? notes : undefined }
}
