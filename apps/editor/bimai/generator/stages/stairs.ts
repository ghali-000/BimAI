// Stair core placement.
//
// Phase 3-8 (`'end-of-corridor'`): one fire-rated stair core, placed
// at the corridor's east end. Single-floor buildings get no stair.
//
// Phase 3-9 (`'end-plus-central'`, default): same end core for any
// multi-floor building. When `corridorLength > FIRE_EGRESS_THRESHOLD_M`
// (default 30 m, configurable via `options.fireEgressThresholdM`),
// add a second core at the corridor's geometric midpoint so the
// max walking-distance to the nearest stair stays below code limits
// for fire egress.
//
// Threshold is strictly greater-than: a 30.00 m corridor stays single
// core; 30.01 m flips to two. Boundary cases pinned in the suite.
//
// Geometry (per core):
//   - Shaft outer rectangle: `template.width × template.depth` (default
//     2.5 m × 4.0 m). End core: east edge coincides with corridor east
//     end. Central core: rectangle centered on the corridor midpoint,
//     extending ±template.depth/2 along the run-axis.
//   - The packer treats each shaft's u-interval as reserved
//     (`reservedRegions`) — `computeStairReservations` returns one entry
//     per core. The shaft's perpendicular overhang into each strip
//     ((shaftWidth − corridorWidth) / 2 = 0.5 m default) sits in empty
//     u-space the packer skipped — no unit conflict.
//   - One `StairFlightPlan` per inter-floor span per core
//     (`floorCount - 1` × `cores.length` flights total).
//
// East-end pick (deterministic — Phase 3-7 door-positioning convention):
//   - Larger world x.
//   - Tie on x → larger world y.
//   - "Refines to primary-facade detection in Phase 3-10+."
//
// Identifier convention (Phase 3-9):
//   - Stair core ids are positional, not content-hashed. Index 0 is
//     ALWAYS the end-of-corridor core; index 1 is ALWAYS the central
//     core. A sub-threshold building has only `stair_core_0`. The
//     underscore separator (not hyphen) satisfies Pascal's StairNode
//     schema constraint `^stair_<rest>$`.
//   - Canonical wall edge ids embed the core id as a path prefix:
//     `stair_core_{N}/wall-<canonicalEdgeHash>`. These are the
//     `enclosingWallIds` exposed on `StairCorePlan`; they live on
//     `metadata.bimai.canonicalEdgeId` of the emitted WallNode (the
//     wall *node* id stays Pascal-schema-compliant via `generateId`).
//     The hash is the same canonical-edge hash Phase 3-7 partition
//     walls use; same scene + same seed produces byte-identical hashes
//     across regenerations.
//   - The positional convention means downstream consumers (cost,
//     IFC, schedule) can write `cores[0]` for the end core in any
//     building without scanning, while `cores.length > 1` flags the
//     fire-egress branch.

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
 * Placement strategy. `'end-of-corridor'` is the legacy Phase 3-8
 * single-core path, kept for callers that explicitly want it.
 * `'end-plus-central'` (default in Phase 3-9) adds the central core
 * when corridor length exceeds the fire-egress threshold.
 */
export type StairLocationStrategy = 'end-of-corridor' | 'end-plus-central'

/**
 * Default fire-egress threshold. EU residential mid-rise typically
 * caps walking distance to the nearest stair at 30 m; doubling-back
 * along a corridor hits that limit at corridor length 60 m for one
 * end core, 30 m for two opposite ends, and ~30 m for end-plus-central
 * (longest leg = corridor / 4 ≈ 7.5 m on a 30 m run).
 *
 * Override at the call site via `options.fireEgressThresholdM` when a
 * project's local code dictates otherwise.
 */
export const FIRE_EGRESS_THRESHOLD_M = 30

/**
 * Optional knobs for `placeStairCores`. Strategy stays positional in
 * the call signature for legibility; the threshold sits here because
 * it's rarely overridden.
 */
export interface PlaceStairCoresOptions {
  /** Strictly greater-than. Default: `FIRE_EGRESS_THRESHOLD_M` (30 m). */
  fireEgressThresholdM?: number
}

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
 * Compute the u-axis reservations the packer must skip. Returns one
 * `ReservedCorridorRegion` per stair core that will be placed.
 *
 * - Single-floor buildings: `[]` (no stair → no reservation).
 * - Sub-threshold corridors: one entry, an interval of length
 *   `template.depth` touching the east end of `[-halfL, +halfL]`
 *   (Phase 3-8 behaviour).
 * - Threshold-tripped corridors (`runLength > fireEgressThresholdM`):
 *   end reservation plus a centred reservation `[-template.depth/2,
 *   +template.depth/2]` for the central core.
 *
 * Pure: doesn't touch the corridor; the packer subtracts these from
 * its u-axis range when laying out unit strips.
 */
export function computeStairReservations(
  template: StairTemplate,
  floorCount: number,
  corridor: CorridorPlan,
  options: PlaceStairCoresOptions = {},
): ReservedCorridorRegion[] {
  if (floorCount < 2) return []
  const runLength = corridor.runLength
  if (runLength === undefined || runLength <= template.depth) return []
  const halfL = runLength / 2
  const eastIdx = pickEastEndIndex(corridor.centerline)
  // The corridor.ts convention: centerline[0] = center - halfL × u,
  // centerline[1] = center + halfL × u. So when east = centerline[1]
  // (eastIdx=1), the +u direction is east and the reserved interval
  // is at the upper end of u. When east = centerline[0] (eastIdx=0),
  // +u points west and the reserved interval is at -halfL.
  const out: ReservedCorridorRegion[] = []
  if (eastIdx === 1) {
    out.push({
      uMin: halfL - template.depth,
      uMax: halfL,
      reason: 'stair-shaft',
    })
  } else {
    out.push({
      uMin: -halfL,
      uMax: -halfL + template.depth,
      reason: 'stair-shaft',
    })
  }
  // Central core reservation (Phase 3-9). Strictly greater-than
  // threshold, mirroring `placeStairCores`.
  const threshold = options.fireEgressThresholdM ?? FIRE_EGRESS_THRESHOLD_M
  if (runLength > threshold) {
    const halfDepth = template.depth / 2
    out.push({
      uMin: -halfDepth,
      uMax: +halfDepth,
      reason: 'stair-shaft',
    })
  }
  return out
}

/**
 * Backwards-compat single-reservation helper. Phase 3-8 callers used
 * `computeStairReservation` (singular) and got either one region or
 * `null`. Kept so the existing pipeline works unchanged when the
 * end-plus-central path doesn't fire; new callers should prefer
 * `computeStairReservations`.
 *
 * @deprecated Phase 3-9. Use `computeStairReservations` to get all
 *   reservations including the central core when threshold-tripped.
 */
export function computeStairReservation(
  template: StairTemplate,
  floorCount: number,
  corridor: CorridorPlan,
): ReservedCorridorRegion | null {
  const all = computeStairReservations(template, floorCount, corridor)
  return all[0] ?? null
}

/**
 * Phase 3-9 entry point. Returns 0, 1, or 2 stair cores depending on
 * `floorCount` and corridor length:
 *  - `floorCount < 2` ⇒ `[]` (single-storey, no stair needed)
 *  - corridor too short for shaft depth ⇒ `[]`
 *  - corridor `≤ fireEgressThresholdM` ⇒ 1 core (end-of-corridor)
 *  - corridor `> fireEgressThresholdM` ⇒ 2 cores (end + central)
 *
 * Strategy: `'end-of-corridor'` clamps to single-core behaviour even
 * past threshold (legacy callers); `'end-plus-central'` (default)
 * adds the central core when threshold-tripped.
 *
 * Index 0 is ALWAYS the end core; index 1 is ALWAYS the central core
 * when present. Sub-threshold buildings have only `cores[0]`.
 */
export function placeStairCores(
  input: PlaceStairCoresInput,
  template: StairTemplate,
  strategy: StairLocationStrategy = 'end-plus-central',
  options: PlaceStairCoresOptions = {},
): StairCorePlan[] {
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
  const toWorld = (u: number, v: number): Point2D => [
    cx + u * ux + v * vx,
    cy + u * uy + v * vy,
  ]

  const eastIdx = pickEastEndIndex(corridor.centerline)
  const halfDepth = template.depth / 2
  const halfW = template.width / 2

  // u-coordinates of the END core's shaft edges. East is at
  // u = +halfL when centerline[1] is east; -halfL otherwise.
  const eastU = eastIdx === 1 ? halfL : -halfL
  const endWestU = eastIdx === 1 ? halfL - template.depth : -halfL + template.depth

  // Build the end core (positional index 0) — always present when we
  // get here.
  const cores: StairCorePlan[] = []
  cores.push(
    buildCore({
      coreIndex: 0,
      uCenter: (eastU + endWestU) / 2,
      template,
      floorCount,
      floorHeight,
      toWorld,
      halfDepth,
      halfW,
    }),
  )

  // Central core (positional index 1) — only when strategy enables it
  // AND corridor is strictly longer than the threshold.
  const threshold = options.fireEgressThresholdM ?? FIRE_EGRESS_THRESHOLD_M
  const needsCentralCore =
    strategy === 'end-plus-central' && corridor.runLength > threshold
  if (needsCentralCore) {
    cores.push(
      buildCore({
        coreIndex: 1,
        // Geometric midpoint of the corridor centerline ⇒ u = 0.
        uCenter: 0,
        template,
        floorCount,
        floorHeight,
        toWorld,
        halfDepth,
        halfW,
      }),
    )
  }

  // Trace logging (opt-in via `localStorage.bimai-debug = 'true'`).
  traceGroup('[BimAI] stair placement')
  traceLog(
    `corridor length: ${corridor.runLength.toFixed(2)}m, threshold: ${threshold}m`,
  )
  traceLog(`cores to emit: ${cores.length}`)
  cores.forEach((core, i) => {
    traceLog(
      `  core ${i} (${core.id}): position=(${core.position[0].toFixed(2)}, ${core.position[1].toFixed(2)})`,
    )
  })
  traceGroupEnd()

  return cores
}

/**
 * Build one StairCorePlan. Common between the end and central cores —
 * they differ only in their `uCenter` (where on the corridor's u-axis
 * the shaft is centred). Wall ids embed `stair-core-{N}/wall-<hash>`
 * with the same canonical-edge hash format Phase 3-7 partition walls
 * use; positional N keeps "the end core" stable across regen.
 */
function buildCore(args: {
  coreIndex: 0 | 1
  uCenter: number
  template: StairTemplate
  floorCount: number
  floorHeight: number
  toWorld: (u: number, v: number) => Point2D
  halfDepth: number
  halfW: number
}): StairCorePlan {
  const {
    coreIndex,
    uCenter,
    template,
    floorCount,
    floorHeight,
    toWorld,
    halfDepth,
    halfW,
  } = args
  const uMin = uCenter - halfDepth
  const uMax = uCenter + halfDepth
  const shaftPolygon: Polygon2D = [
    toWorld(uMin, -halfW),
    toWorld(uMax, -halfW),
    toWorld(uMax, +halfW),
    toWorld(uMin, +halfW),
  ]

  // Positional core id. Index 0 = end core; index 1 = central core.
  // Phase 3-8 used a content-hashed `stair_<12hex>` id; the positional
  // form is more legible downstream and lets cost / IFC writers refer
  // to "the end core" without re-deriving the hash from inputs.
  // Underscore separators (not hyphens) so the id satisfies Pascal's
  // StairNode `^stair_<rest>$` schema constraint.
  const stairId = `stair_core_${coreIndex}`

  // Wall ids: one per shaft polygon edge (4 since shafts are rect).
  // The canonical-edge hash bits stay the same as the Phase 3-7
  // partition-wall convention, so determinism (same input ⇒ same hash)
  // carries through.
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

  return {
    id: stairId,
    position: toWorld(uMin, -halfW),
    width: template.width,
    depth: template.depth,
    flights,
    shaftPolygon,
    enclosingWallIds,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SNAP_EPSILON = 1e-4

function snap(n: number): string {
  const r = Math.round(n / SNAP_EPSILON) * SNAP_EPSILON
  return (Math.abs(r) < SNAP_EPSILON / 2 ? 0 : r).toFixed(4)
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
  // Phase 3-9 wall-id format: `stair-core-{N}/wall-<hash>`. The hash
  // is the same canonical-edge hash Phase 3-7 partition walls use
  // (cyrb128 of "<stair-id>|<minVertex>→<maxVertex>"), keyed under the
  // positional stair id so the same scene + same seed produces the
  // same wall id across regenerations.
  const key = `${stairId}|${p[0]},${p[1]}→${q[0]},${q[1]}`
  return `${stairId}/wall-${cyrb128Hex(key).slice(0, 12)}`
}
