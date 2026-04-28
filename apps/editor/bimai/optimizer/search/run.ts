// Random-search optimizer entry point.
//
// runSearch is pure: takes a seed and an input bundle, returns an
// OptimizationResult. No useScene reads, no DOM, no Worker setup —
// Task 7 wraps this in a Web Worker; the Node CLI calls it directly.
//
// Two-tier candidate shape (per Phase 3-5 Task 6 brief):
//   - During the search loop every candidate carries the lightweight
//     payload only: params, composedScore, breakdown, failure. This
//     is what postMessage moves between Worker and main thread.
//   - After ranking, the top-K candidates (K=6 by default) are
//     re-evaluated via a second pipeline run to attach the heavy
//     fields (plan, schedule, cost, snapshot). Cost: 6 extra runs;
//     benefit: a 1000-sample run doesn't ship 1000 BuildingPlans
//     across the worker boundary.
//
// Sort order:
//   1. Compliant candidates (failure === null), descending composedScore.
//   2. Failed candidates (failure !== null), in insertion order.
//
// "Compliant" here means "the pipeline produced a plan". The
// per-objective compliance score (0..1 over the five zoning checks)
// further differentiates compliant candidates inside the top region;
// the gallery may use it as a secondary filter, but the core
// ScoredCandidate.compliant boolean is the planning-success bit.

import type { AnyNodeId } from '@pascal-app/core'
import { computeCost } from '../../cost/compute'
import { runGenerator } from '../../generator/pipeline'
import type {
  BuildingPlan,
  GeneratorInput,
  GeneratorOutput,
} from '../../generator/types'
import { calculatePolygonArea } from '../../lib/geometry'
import { computeSchedule } from '../../schedule/compute'
import type { CostResult } from '../../cost/types'
import type { ScheduleResult } from '../../schedule/types'
import {
  composeObjectives,
  DEFAULT_WEIGHTS,
  type CandidateEvaluation,
  type ObjectiveName,
  type ObjectiveResult,
  type ObjectiveWeights,
} from '../objectives'
import type { GenerationParams } from '../params'
import { mulberry32 } from './rng'
import { uniformRandomSampler, uniformSamplerFromSpace, type Sampler } from './sampler'
import { buildParamSpace, plotBoundingBox } from '../space'
import { createOptimizerWriter } from '../writer'

/** Reasons a candidate's pipeline can fail. Mirrors the GeneratorOutput
 *  failure reasons; expressed as a string so postMessage can ferry it
 *  without the discriminated-union helper. */
export type FailureReason =
  | 'invalid_input'
  | 'envelope_collapsed'
  | 'no_valid_footprint'
  | 'corridor_layout_failed'
  | 'unit_packing_failed'
  | 'program_exceeds_capacity'

export interface CandidateFailure {
  reason: FailureReason
  /** Diagnostic strings from the pipeline. */
  issues: string[]
}

/**
 * Lightweight candidate payload — what the search loop produces and
 * what postMessage carries between worker and main thread. Heavy
 * fields (plan / schedule / cost / snapshot) are populated only on
 * top-K candidates after ranking.
 */
export interface ScoredCandidate {
  /** Stable index for traceability. Equals the candidate's position
   *  in the master RNG draw sequence (0-based), not its post-sort
   *  position — so the same seed always tags the same params with
   *  the same index. */
  candidateIndex: number
  params: GenerationParams
  /** Composed weighted score in [0, 1]. NaN-free. Failures get 0. */
  composedScore: number
  /** Per-objective breakdown. `null` for failed candidates (objectives
   *  can't run without a successful pipeline). */
  breakdown: Record<ObjectiveName, ObjectiveResult> | null
  /** True iff the pipeline succeeded. Independent of zoning compliance —
   *  see the per-objective `breakdown.compliance` for that. */
  compliant: boolean
  failure: CandidateFailure | null

  // Heavy fields — only populated on the top-K candidates after the
  // re-evaluation pass. Preserved as optional so non-top-K shipping
  // through postMessage is small.
  plan?: BuildingPlan
  schedule?: ScheduleResult
  cost?: CostResult
  /** Snapshot of the writer's `nodes` dict after pipeline apply. The
   *  gallery reads this to render thumbnails. */
  snapshot?: { nodes: Record<AnyNodeId, unknown> }
}

export interface OptimizationStats {
  sampled: number
  /** Pipeline-success candidates. */
  compliant: number
  /** Bucketed by failure.reason. Keys are FailureReason; missing
   *  reasons mean zero candidates failed that way. */
  failures: Partial<Record<FailureReason, number>>
  durationMs: number
  /** composedScore of the highest-ranked candidate. 0 when nothing
   *  was compliant. */
  bestScore: number
}

export interface OptimizationResult {
  /** Every candidate, sorted: compliant by composedScore desc, then
   *  failures in insertion order. Length === stats.sampled. */
  candidates: ScoredCandidate[]
  /** First K from `candidates`. Only these carry plan/schedule/cost/
   *  snapshot. Empty when no compliant candidates were found. */
  topK: ScoredCandidate[]
  stats: OptimizationStats
}

export interface RunSearchInput {
  /** Generator input minus `params` — those are sampled per candidate. */
  input: Omit<GeneratorInput, 'params'>
  /** Number of samples to evaluate. */
  count: number
  /** Master seed. Same seed + same input ⇒ identical OptimizationResult. */
  seed: number
  /** Composition weights. Defaults to DEFAULT_WEIGHTS. */
  weights?: ObjectiveWeights
  /** Sampler. Defaults to uniformRandomSampler over DEFAULT_SPACE. */
  sampler?: Sampler
  /** Number of candidates to re-evaluate with full data. Defaults to 6. */
  topK?: number
  /** Optional progress callback. Fires every `progressEveryN` samples
   *  during the lightweight scoring loop, plus once at the end (right
   *  before the sort). Worker integration uses this to forward
   *  postMessage progress events; Node CLI usage can leave it out. */
  onProgress?: (sampled: number, total: number, compliantSoFar: number) => void
  /** How often to fire onProgress. Defaults to ~20 events over the run
   *  (count/20, floored at 1). */
  progressEveryN?: number
}

const DEFAULT_TOP_K = 6

/**
 * Run a random-search optimization over `count` samples drawn from
 * `sampler`, scored under `weights`.
 */
export function runSearch(args: RunSearchInput): OptimizationResult {
  const {
    input,
    count,
    seed,
    weights = DEFAULT_WEIGHTS,
    topK = DEFAULT_TOP_K,
    onProgress,
    progressEveryN = Math.max(1, Math.floor(count / 20)),
  } = args

  // Sampler resolution. Phase 3-6 Task 1: when the caller doesn't pin a
  // sampler, build a plot-adaptive ParamSpace from the input's plot
  // bounding box. Falls back to the published `uniformRandomSampler`
  // (DEFAULT_SPACE) when the bbox math degenerates — same behaviour
  // as Phase 3-5 for any caller that overrides the sampler explicitly.
  const sampler: Sampler =
    args.sampler ??
    (() => {
      const box = plotBoundingBox(input.plotPolygon)
      return box ? uniformSamplerFromSpace(buildParamSpace(box)) : uniformRandomSampler
    })()

  const t0 = nowMs()
  const masterRng = mulberry32(seed)
  const plotArea = calculatePolygonArea(input.plotPolygon)

  // ── Phase 1: lightweight scoring pass ─────────────────────────────────────
  // For every sample: run pipeline once, score it, drop the heavy data.
  // We deliberately don't attach plan/schedule/cost during this loop so the
  // post-sort top-K re-evaluation is the only path that pays for them.
  const candidates: ScoredCandidate[] = []
  const failureCounts: Partial<Record<FailureReason, number>> = {}
  let compliantCount = 0

  for (let i = 0; i < count; i++) {
    const params = sampler(masterRng)
    const evalResult = evaluateCandidate({
      input,
      params,
      plotArea,
      weights,
      candidateIndex: i,
    })
    candidates.push(evalResult.lightweight)
    if (evalResult.lightweight.failure) {
      const reason = evalResult.lightweight.failure.reason
      failureCounts[reason] = (failureCounts[reason] ?? 0) + 1
    } else {
      compliantCount++
    }
    // Fire progress at the configured cadence and on the final sample.
    // Indexing on `i+1` so the very first emit reports a non-zero count.
    if (onProgress && ((i + 1) % progressEveryN === 0 || i === count - 1)) {
      onProgress(i + 1, count, compliantCount)
    }
  }

  // ── Phase 2: stable sort ──────────────────────────────────────────────────
  // Compliant first, descending composedScore. Failed last, original order.
  // We split-then-concatenate (rather than one comparator) so the failure
  // order matches insertion (== candidateIndex), which is what the panel
  // displays in the "failed" bucket for traceability.
  const compliant = candidates.filter((c) => c.compliant)
  const failed = candidates.filter((c) => !c.compliant)
  compliant.sort((a, b) => b.composedScore - a.composedScore)
  const sorted = [...compliant, ...failed]

  // ── Phase 3: top-K re-evaluation ──────────────────────────────────────────
  // Re-run the pipeline for the top-K compliant candidates and attach the
  // heavy fields in place. Failures never make it into top-K because they
  // sort to the bottom.
  const top = sorted.slice(0, Math.max(0, topK)).filter((c) => c.compliant)
  for (const candidate of top) {
    const heavy = repopulateHeavy(input, candidate.params)
    if (heavy) {
      candidate.plan = heavy.plan
      candidate.schedule = heavy.schedule
      candidate.cost = heavy.cost
      candidate.snapshot = heavy.snapshot
    }
  }

  const bestScore = compliant.length > 0 ? compliant[0]!.composedScore : 0
  const durationMs = nowMs() - t0

  return {
    candidates: sorted,
    topK: top,
    stats: {
      sampled: candidates.length,
      compliant: compliantCount,
      failures: failureCounts,
      durationMs,
      bestScore,
    },
  }
}

// ── candidate evaluation ────────────────────────────────────────────────────

interface EvaluateArgs {
  input: Omit<GeneratorInput, 'params'>
  params: GenerationParams
  plotArea: number
  weights: ObjectiveWeights
  candidateIndex: number
}

function evaluateCandidate(args: EvaluateArgs): {
  lightweight: ScoredCandidate
} {
  const { input, params, plotArea, weights, candidateIndex } = args
  const writer = createOptimizerWriter({
    buildingId: input.buildingId,
    siteId: input.siteId,
  })
  const out = runGenerator({ ...input, params }, writer)
  if (!out.ok) {
    return {
      lightweight: {
        candidateIndex,
        params,
        composedScore: 0,
        breakdown: null,
        compliant: false,
        failure: {
          reason: out.reason as FailureReason,
          issues: out.issues ?? [],
        },
      },
    }
  }
  const snapshot = writer.getSnapshot()
  const schedule = computeSchedule(snapshot, { buildingId: input.buildingId })
  const cost = computeCost(snapshot, {
    buildingId: input.buildingId,
    schedule,
  })
  const ctx: CandidateEvaluation = {
    program: input.program,
    zoning: input.zoning,
    plotPolygon: input.plotPolygon,
    plotArea,
    plan: out.plan,
    schedule,
    cost,
  }
  const composed = composeObjectives(ctx, weights)
  return {
    lightweight: {
      candidateIndex,
      params,
      composedScore: composed.score,
      breakdown: composed.breakdown,
      compliant: true,
      failure: null,
    },
  }
}

// ── heavy-field re-evaluation ───────────────────────────────────────────────

function repopulateHeavy(
  input: Omit<GeneratorInput, 'params'>,
  params: GenerationParams,
): {
  plan: BuildingPlan
  schedule: ScheduleResult
  cost: CostResult
  snapshot: { nodes: Record<AnyNodeId, unknown> }
} | null {
  const writer = createOptimizerWriter({
    buildingId: input.buildingId,
    siteId: input.siteId,
  })
  const out: GeneratorOutput = runGenerator({ ...input, params }, writer)
  if (!out.ok) return null
  const snapshot = writer.getSnapshot()
  const schedule = computeSchedule(snapshot, { buildingId: input.buildingId })
  const cost = computeCost(snapshot, {
    buildingId: input.buildingId,
    schedule,
  })
  return {
    plan: out.plan,
    schedule,
    cost,
    snapshot: snapshot as unknown as { nodes: Record<AnyNodeId, unknown> },
  }
}

// ── timing helper ───────────────────────────────────────────────────────────

/** performance.now() exists in modern Node 16+, browsers, and Web Workers.
 *  Wrap to keep imports clean. Falls back to Date.now() in any environment
 *  that mysteriously lacks it. */
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}
