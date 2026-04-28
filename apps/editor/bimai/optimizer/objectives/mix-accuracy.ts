// Mix-accuracy objective — how closely the placed unit mix matches what
// `program.unitMix` requested.
//
// Per-type accuracy = min(placed[type] / requested[type], 1). Capping at 1
// means "we placed 7 1BRs when 6 were requested" doesn't beat "we placed
// exactly 6". Over-placement is a separate concern (sellable-area) — for
// mix-accuracy we want the *requested* shape, not bigger.
//
// Aggregate is a *weighted* per-type average where the weight is the
// requested count. Why: with a {Studio:1, 1BR:99} program, missing the
// only studio shouldn't tank the score the way it would under a plain
// average. The unit-weighted version reads "fraction of requested units
// actually placed", which matches the reviewer's mental model.
//
// Edge cases:
//   - requested == 0 for some type that was placed (e.g. zone with stale
//     unitType): ignored. The objective only scores against what was
//     asked for.
//   - requested == 0 across the entire program: score = 1. An empty
//     request is trivially satisfied.
//   - placed == 0 across the board with requested > 0: score = 0.

import type {
  CandidateEvaluation,
  Objective,
  ObjectiveResult,
} from './types'

export const mixAccuracy: Objective = (
  ctx: CandidateEvaluation,
): ObjectiveResult => {
  const requested = new Map<string, number>()
  for (const entry of ctx.program.unitMix) {
    if (entry.count <= 0) continue
    requested.set(entry.type, (requested.get(entry.type) ?? 0) + entry.count)
  }
  const placed = new Map<string, number>()
  for (const t of ctx.schedule.residential.byUnitType) {
    placed.set(t.type, t.count)
  }

  let totalRequested = 0
  let totalCovered = 0
  const notes: string[] = []
  for (const [type, req] of requested) {
    const got = placed.get(type) ?? 0
    const covered = Math.min(got, req)
    totalRequested += req
    totalCovered += covered
    if (got < req) notes.push(`${type}: ${got}/${req} placed`)
    else if (got > req) notes.push(`${type}: ${got} placed (${got - req} over)`)
  }

  if (totalRequested === 0) {
    return { score: 1, raw: 1, notes: ['no units requested'] }
  }
  const score = totalCovered / totalRequested
  return { score, raw: score, notes: notes.length > 0 ? notes : undefined }
}
