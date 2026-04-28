// Compliance checks — five pure predicates over a CandidateEvaluation,
// each returning a structured result the compliance objective composes
// into a score and the gallery surfaces as failure-detail tooltips.
//
// Why one file with five exports rather than five files:
//   - The checks share the same return shape and the same units
//     vocabulary (m, m², ratio). Splitting them spreads small functions
//     across multiple files for no gain.
//   - The objective imports a flat array of checks; iteration is
//     trivial (`pass = checks.filter(c => c.pass).length / checks.length`).
//   - Adding a sixth check is one new function + one entry in the
//     CHECKS array.
//
// The five checks (matching Phase 3-5 brief, Task 4):
//
//   1. envelopeContainment — every footprint vertex lies inside the
//      legal envelope (the polygon already inset from the plot by
//      zoning setbacks). Implemented via polygon-clipping difference:
//      `footprint \ envelope` should be empty (within ε).
//
//   2. far — gross floor area / plot area ≤ zoning.maxFAR. We use the
//      schedule's GEA, which is the slab area summed across floors —
//      our own emitter ensures slab outline === footprint, so this
//      matches the regulator's "GFA = sum of floor plates" definition.
//
//   3. coverage — footprint area / plot area ≤ zoning.maxCoverage.
//      Single-floor metric, applied at ground level.
//
//   4. height — floorCount × floorHeight ≤ zoning.maxHeight. The plan
//      records both numbers; we don't try to recompute height from
//      level node positions because the plan is the source of truth
//      before the writer applies.
//
//   5. openSpace — (plotArea − footprintArea) / plotArea ≥
//      zoning.minOpenSpace. Complementary to coverage but framed as
//      a minimum rather than a maximum — they're not redundant when
//      the regulator sets coverage and openSpace independently
//      (e.g. coverage 0.6 + openSpace 0.3 leaves a 10% buffer band
//      that's neither footprint nor mandated open space).
//
// Numerical tolerance: each check applies a small ε (1e-6 for ratios,
// 1e-3 m² for the envelope area) so floating-point noise from polygon
// inset / setback math doesn't flip a pass/fail.

import polygonClipping from 'polygon-clipping'
import { computeEnvelope, type Polygon2D } from '../../lib/envelope'
import { calculatePolygonArea } from '../../lib/geometry'
import type { CandidateEvaluation } from './types'

export interface CheckResult {
  /** Stable id used by the UI to address a specific check. */
  name:
    | 'envelopeContainment'
    | 'far'
    | 'coverage'
    | 'height'
    | 'openSpace'
  pass: boolean
  /** Human-readable summary (always populated, even on pass — useful
   *  for tooltips that want to show "FAR 1.83 / 2.0 ✓"). */
  detail: string
  /** The numeric measurement the check evaluated. Ratio for FAR /
   *  coverage / openSpace, metres for height, m² for envelope. */
  measured: number
  /** The limit the measurement was compared against. */
  limit: number
}

const EPS_RATIO = 1e-6
const EPS_AREA_M2 = 1e-3

// ── 1. envelope containment ────────────────────────────────────────────────

function envelopeContainment(ctx: CandidateEvaluation): CheckResult {
  // Recompute the envelope from plot + setbacks. Cheap (one inset).
  // We could cache it on CandidateEvaluation but adding a field to the
  // public type for a single check's intermediate isn't worth it.
  const env = computeEnvelope(ctx.plotPolygon, ctx.zoning)
  if (!env.ok) {
    // No envelope to contain anything. Treat as a hard fail with a
    // diagnostic — the candidate shouldn't have been generated, but
    // if it was, flagging the upstream issue is more useful than
    // crashing here.
    return {
      name: 'envelopeContainment',
      pass: false,
      detail: `envelope unavailable (${env.reason})`,
      measured: 0,
      limit: 0,
    }
  }
  const footprintRing = closeRing(ctx.plan.footprint)
  const envelopeRing = closeRing(env.polygon)
  // polygon-clipping signature: difference([subject], [clip]). Both
  // arguments are MultiPolygon-shaped; we wrap each ring in two extra
  // arrays for the [polygon][ring][point] shape.
  const diff = polygonClipping.difference(
    [[footprintRing]],
    [[envelopeRing]],
  )
  const overflowArea = diff.reduce(
    (sum, poly) => sum + calculatePolygonArea(poly[0] ?? []),
    0,
  )
  const pass = overflowArea <= EPS_AREA_M2
  return {
    name: 'envelopeContainment',
    pass,
    detail: pass
      ? 'footprint inside envelope'
      : `footprint overflows envelope by ${overflowArea.toFixed(2)} m²`,
    measured: overflowArea,
    limit: 0,
  }
}

// ── 2. FAR ─────────────────────────────────────────────────────────────────

function far(ctx: CandidateEvaluation): CheckResult {
  const gfa = ctx.schedule.totals.gea
  const ratio = ctx.plotArea > 0 ? gfa / ctx.plotArea : Number.POSITIVE_INFINITY
  const limit = ctx.zoning.maxFAR
  const pass = ratio <= limit + EPS_RATIO
  return {
    name: 'far',
    pass,
    detail: pass
      ? `FAR ${ratio.toFixed(2)} ≤ ${limit}`
      : `FAR ${ratio.toFixed(2)} exceeds limit ${limit}`,
    measured: ratio,
    limit,
  }
}

// ── 3. coverage ────────────────────────────────────────────────────────────

function coverage(ctx: CandidateEvaluation): CheckResult {
  const footArea = calculatePolygonArea(ctx.plan.footprint)
  const ratio = ctx.plotArea > 0 ? footArea / ctx.plotArea : Number.POSITIVE_INFINITY
  const limit = ctx.zoning.maxCoverage
  const pass = ratio <= limit + EPS_RATIO
  return {
    name: 'coverage',
    pass,
    detail: pass
      ? `coverage ${(ratio * 100).toFixed(1)}% ≤ ${(limit * 100).toFixed(0)}%`
      : `coverage ${(ratio * 100).toFixed(1)}% exceeds ${(limit * 100).toFixed(0)}%`,
    measured: ratio,
    limit,
  }
}

// ── 4. height ──────────────────────────────────────────────────────────────

function height(ctx: CandidateEvaluation): CheckResult {
  const h = ctx.plan.floorCount * ctx.plan.floorHeight
  const limit = ctx.zoning.maxHeight
  // Height limit comparison is in metres so EPS_AREA_M2 is already mm-scale.
  const pass = h <= limit + EPS_AREA_M2
  return {
    name: 'height',
    pass,
    detail: pass
      ? `${h.toFixed(1)}m ≤ ${limit}m`
      : `${h.toFixed(1)}m exceeds ${limit}m`,
    measured: h,
    limit,
  }
}

// ── 5. open space ──────────────────────────────────────────────────────────

function openSpace(ctx: CandidateEvaluation): CheckResult {
  const footArea = calculatePolygonArea(ctx.plan.footprint)
  const open = ctx.plotArea > 0 ? (ctx.plotArea - footArea) / ctx.plotArea : 0
  const limit = ctx.zoning.minOpenSpace
  // Note: this is a *minimum*, so the pass condition is open >= limit.
  const pass = open >= limit - EPS_RATIO
  return {
    name: 'openSpace',
    pass,
    detail: pass
      ? `open ${(open * 100).toFixed(1)}% ≥ ${(limit * 100).toFixed(0)}%`
      : `open ${(open * 100).toFixed(1)}% below minimum ${(limit * 100).toFixed(0)}%`,
    measured: open,
    limit,
  }
}

// ── registry ───────────────────────────────────────────────────────────────

/** All checks in stable order. The compliance objective scores
 *  `(passing) / (total)` over this array, so adding a check rebalances
 *  the score automatically. */
export const COMPLIANCE_CHECKS: ReadonlyArray<
  (ctx: CandidateEvaluation) => CheckResult
> = [envelopeContainment, far, coverage, height, openSpace]

/** Run every check and return the per-check breakdown. The compliance
 *  objective composes this into a score; gallery / panel UIs render
 *  the breakdown as a checklist. */
export function runComplianceChecks(
  ctx: CandidateEvaluation,
): CheckResult[] {
  return COMPLIANCE_CHECKS.map((c) => c(ctx))
}

// ── helpers ────────────────────────────────────────────────────────────────

/** polygon-clipping wants closed rings (first === last). Our internal
 *  polygons are open by convention, so we close once at the boundary. */
function closeRing(poly: Polygon2D): Array<[number, number]> {
  if (poly.length === 0) return []
  const first = poly[0]!
  const last = poly[poly.length - 1]!
  if (first[0] === last[0] && first[1] === last[1]) {
    return poly.map((p) => [p[0], p[1]])
  }
  return [...poly.map((p) => [p[0], p[1]] as [number, number]), [first[0], first[1]]]
}
