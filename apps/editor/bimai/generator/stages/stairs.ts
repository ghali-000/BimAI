// Phase 3-8 Task 4: Stair core placement (end-of-corridor strategy).
//
// One fire-rated stair core per multi-storey building. Single core,
// placed at the corridor's east end (the deterministic "rear" until
// Phase 3-9 adds primary-facade detection). Single-floor buildings get
// no stair (`[]`).
//
// Geometry:
//   - Shaft outer rectangle: `template.width × template.depth` (default
//     2.5 m × 4.0 m), centered on the corridor centerline, east-aligned
//     so the shaft's east edge coincides with the corridor's east end.
//   - Shaft is `template.depth` deep along the corridor's u-axis. The
//     packer treats this u-interval as reserved (`reservedRegions`) and
//     the unit-strip on each side stops `template.depth` short of the
//     east end. The shaft's perpendicular overhang into each strip
//     ((shaftWidth − corridorWidth) / 2 = 0.5 m default) sits in empty
//     u-space the packer skipped — no unit conflict.
//   - One `StairFlightPlan` per inter-floor span (`floorCount - 1` total).
//
// East-end pick (deterministic — Phase 3-7 door-positioning convention):
//   - Larger world x.
//   - Tie on x → larger world y.
//   - "Refines to primary-facade detection in Phase 3-9."
//
// Wall ids: canonical-edge-hashed under a per-stair seed so the same
// plan ⇒ same `stair_<12hex>` id and same four `stair-shaft_<12hex>`
// wall ids across regen. Pattern matches Phase 3-7's partition walls.

import { cyrb128Hex } from '../../lib/hash'
import type { Polygon2D, Point2D } from '../../lib/envelope'
import { traceGroup, traceGroupEnd, traceLog } from '../debug'
import type {
  CorridorPlan,
  ReservedCorridorRegion,
  StairCorePlan,
  StairFlightPlan,
} from '../types'
import { type StairTemplate, buildFlightPlan } from './stairs-templates'

/**
 * Strategy slot — Phase 3-8 only ships `'end-of-corridor'`. The
 * narrower union exists so the call site reads explicitly and the
 * Phase 3-9 upgrade to `'central'` / `'end-plus-central'` is a single
 * type extension + new branch.
 */
export type StairLocationStrategy = 'end-of-corridor'

export interface PlaceStairCoresInput {
  /** Top-level building outline (rectangular). Same as `BuildingPlan.footprint`. */
  footprint: Polygon2D
  /** Number of storeys. `< 2` ⇒ no stair core needed. */
  floorCount: number
  /** Floor-to-floor height in metres. */
  floorHeight: number
  /** First-floor corridor — geometry is identical per floor in 3-8. */
  corridor: CorridorPlan
}

/**
 * Pick the corridor centerline endpoint with the larger world x; tie
 * on x → larger y. Mirrors Phase 3-7's door-positioning tie-break for
 * deterministic regen behaviour. Returns the index (0 or 1) into
 * `centerline` so callers can derive both the "east" point and the
 * sign of the +u direction (whether east = centerline[1] = +halfL or
 * east = centerline[0] = -halfL).
 */
export function pickEastEndIndex(
  centerline: readonly [Point2D, Point2D],
): 0 | 1 {
  const [a, b] = centerline
  if (b[0] > a[0]) return 1
  if (b[0] < a[0]) return 0
  // x ties: larger y wins.
  return b[1] >= a[1] ? 1 : 0
}

/**
 * Compute the u-axis reservation the packer must skip. Single
 * end-of-corridor reservation in 3-8: an interval of length
 * `template.depth` touching the east end of the strip range
 * `[-halfL, +halfL]`.
 *
 * Returns `null` for single-floor buildings (no stair → no reservation).
 */
export function computeStairReservation(
  template: StairTemplate,
  floorCount: number,
  corridor: CorridorPlan,
): ReservedCorridorRegion | null {
  if (floorCount < 2) return null
  const runLength = corridor.runLength
  if (runLength === undefined || runLength <= template.depth) return null
  const halfL = runLength / 2
  const eastIdx = pickEastEndIndex(corridor.centerline)
  // The corridor.ts convention: centerline[0] = center - halfL × u,
  // centerline[1] = center + halfL × u. So when east = centerline[1]
  // (eastIdx=1), the +u direction is east and the reserved interval
  // is at the upper end of u. When east = centerline[0] (eastIdx=0),
  // +u points west and the reserved interval is at -halfL.
  if (eastIdx === 1) {
    return { uMin: halfL - template.depth, uMax: halfL, reason: 'stair-shaft' }
  }
  return { uMin: -halfL, uMax: -halfL + template.depth, reason: 'stair-shaft' }
}

/**
 * Phase 3-8 entry point. Returns 0 or 1 stair cores depending on
 * `floorCount`. Multi-stair-core for fire-egress on large plots is
 * Phase 3-9.
 */
export function placeStairCores(
  input: PlaceStairCoresInput,
  template: StairTemplate,
  // Strategy is single-valued today but the parameter exists so the
  // call site is explicit about which gate decision it's honoring.
  strategy: StairLocationStrategy = 'end-of-corridor',
): StairCorePlan[] {
  if (strategy !== 'end-of-corridor') return []
  if (input.floorCount < 2) return []
  const { corridor, floorCount, floorHeight } = input
  if (corridor.runLength === undefined) return []
  if (corridor.runLength <= template.depth) {
    // Corridor too short for the shaft to fit. Single-loaded fallback
    // on a tiny plate. Caller can surface this to the panel; here we
    // just refuse to place a stair.
    traceGroup('[BimAI] stair placement')
    traceLog(
      `corridor too short (${corridor.runLength.toFixed(2)} m) for stair depth ${template.depth} m — no stair placed`,
    )
    traceGroupEnd()
    return []
  }
  const halfL = corridor.runLength / 2

  // Build the corridor's basis. u-direction matches `corridor.ts`:
  // u = (centerline[1] - centerline[0]) / |...|. Perpendicular is
  // rotate-+90° of u.
  const [a, b] = corridor.centerline
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return []
  const ux = dx / len
  const uy = dy / len
  const vx = -uy
  const vy = ux
  const cx = (a[0] + b[0]) / 2
  const cy = (a[1] + b[1]) / 2

  // u-coordinates of the shaft's east + west edges. East is at
  // u = +halfL when centerline[1] is east; -halfL otherwise.
  const eastIdx = pickEastEndIndex(corridor.centerline)
  const eastU = eastIdx === 1 ? halfL : -halfL
  const westU = eastIdx === 1 ? halfL - template.depth : -halfL + template.depth
  const halfW = template.width / 2

  // Shaft polygon (CCW for eastIdx=1, CW for eastIdx=0; downstream
  // emitters key off canonical edge ids, not winding). World coords.
  const toWorld = (u: number, v: number): Point2D => [
    cx + u * ux + v * vx,
    cy + u * uy + v * vy,
  ]
  const shaftPolygon: Polygon2D = [
    toWorld(westU, -halfW),
    toWorld(eastU, -halfW),
    toWorld(eastU, +halfW),
    toWorld(westU, +halfW),
  ]

  // Stair id — hash a stable seed (footprint lex-min vertex + corridor
  // mode + east-side flag). Same plan ⇒ same id across regen.
  const lexMin = lexMinVertex(input.footprint)
  const stairSeed = `stair|${snap(lexMin[0])},${snap(lexMin[1])}|${corridor.mode ?? 'double-loaded'}|east=${eastIdx}`
  const stairId = `stair_${cyrb128Hex(stairSeed).slice(0, 12)}`

  // Wall ids: one per shaft polygon edge (4 in 3-8 since shafts are
  // rectangular). Canonical-edge hash matches Phase 3-7 partition
  // walls so anyone reading the id can tell which shaft + which side.
  const enclosingWallIds: string[] = []
  for (let i = 0; i < shaftPolygon.length; i++) {
    const p = shaftPolygon[i]!
    const q = shaftPolygon[(i + 1) % shaftPolygon.length]!
    enclosingWallIds.push(canonicalShaftWallId(stairId, p, q))
  }

  // Flights: one per inter-storey span. Elevation 0 = ground floor
  // base; flight n connects level n to level n+1.
  const flights: StairFlightPlan[] = []
  for (let lv = 0; lv < floorCount - 1; lv++) {
    flights.push(
      buildFlightPlan(template, lv, lv * floorHeight, floorHeight),
    )
  }

  const core: StairCorePlan = {
    id: stairId,
    position: toWorld(westU, -halfW),
    width: template.width,
    depth: template.depth,
    flights,
    shaftPolygon,
    enclosingWallIds,
  }

  // Trace logging (opt-in via `localStorage.bimai-debug = 'true'`).
  // Same gating as Phase 3-7's pipeline trace.
  traceGroup('[BimAI] stair placement')
  traceLog(
    `east end (world): (${(eastIdx === 1 ? b : a)[0].toFixed(2)}, ${(eastIdx === 1 ? b : a)[1].toFixed(2)})`,
  )
  traceLog(
    `shaft footprint: ${shaftPolygon.map((p) => `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})`).join(' ')}`,
  )
  traceLog(`flights: ${flights.length} (level 0 → ${floorCount - 1})`)
  traceLog(`stair id: ${stairId}`)
  traceGroupEnd()

  return [core]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SNAP_EPSILON = 1e-4

function snap(n: number): string {
  const r = Math.round(n / SNAP_EPSILON) * SNAP_EPSILON
  return (Math.abs(r) < SNAP_EPSILON / 2 ? 0 : r).toFixed(4)
}

function lexMinVertex(poly: ReadonlyArray<Point2D>): Point2D {
  let lex = poly[0]!
  for (const p of poly) {
    if (p[0] < lex[0] || (p[0] === lex[0] && p[1] < lex[1])) lex = p
  }
  return lex
}

function canonicalShaftWallId(
  stairId: string,
  a: Point2D,
  b: Point2D,
): string {
  const ax = snap(a[0])
  const ay = snap(a[1])
  const bx = snap(b[0])
  const by = snap(b[1])
  const aFirst = ax < bx || (ax === bx && ay <= by)
  const [p, q] = aFirst ? [[ax, ay], [bx, by]] : [[bx, by], [ax, ay]]
  const key = `${stairId}|${p[0]},${p[1]}→${q[0]},${q[1]}`
  return `stair-shaft_${cyrb128Hex(key).slice(0, 12)}`
}
