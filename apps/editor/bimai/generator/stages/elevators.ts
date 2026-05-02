// Phase 3-9 Task 12: elevator placement.
//
// Pascal has no `ElevatorNode`. We compose the elevator from
// existing primitives:
//   - 4 shaft walls per floor forming a 1.5 m × 1.5 m rectangle,
//     fire-rated like the stair shaft (`metadata.bimai.wallRole =
//     'elevator-shaft'`)
//   - 1 DoorNode per floor on the corridor-facing wall
//     (`metadata.bimai.doorRole = 'elevator-access'`)
//   - 1 ZoneNode marker (parented to the ground level) tagged
//     `metadata.bimai.elevatorRole = 'elevator-cabin'` — the IFC
//     writer maps this to `IfcTransportElement` with
//     `PredefinedType: 'ELEVATOR'`. No body in Pascal: the cabin is
//     the absence of structure inside the shaft walls; the marker
//     polygon is the shaft interior so consumers can highlight the
//     cabin's footprint without re-deriving geometry.
//
// Placement (Phase 3-9 first cut):
//   - One elevator per multi-floor building (≥ 3 floors). Phase 3-10
//     may add a user opt-in checkbox like balconies; Phase 3-11 may
//     add multi-elevator for large plates.
//   - Adjacent to the primary stair core (`stair_core_0`), sharing
//     the stair's WEST wall. Centred on the corridor centerline so
//     the corridor-facing wall becomes the natural door edge.
//   - Reservation: extends the end-of-corridor stair reservation by
//     `ELEVATOR_SHAFT_DEPTH_M` (1.5 m) along the corridor's u-axis so
//     the unit packer skips the combined service-core footprint.
//     `placeElevators` returns the additional reservation entry; the
//     pipeline merges it with the stair reservations before packing.
//
// Identifier convention:
//   - Elevator id: `elevator_0` (positional). Phase 3-10+ extends to
//     `elevator_{N}` if multi-elevator lands.
//   - Shaft wall ids: `elevator_0/wall-<canonicalEdgeHash>` —
//     mirrors the Phase 3-9 stair-core wall id convention. The hash
//     bits stay deterministic across regen.
//
// Phase 3-8 follow-up parenting invariant carries through: every
// emitted elevator node parents to a level (shaft walls and per-
// floor doors per floor; cabin marker on level 0), never the
// building.

import { cyrb128Hex } from '../../lib/hash'
import type { Point2D, Polygon2D } from '../../lib/envelope'
import type {
  ElevatorPlan,
  ReservedCorridorRegion,
  StairCorePlan,
} from '../types'

export type { ElevatorPlan }

/** Shaft outer dimension along both axes (square shaft). */
export const ELEVATOR_SHAFT_WIDTH_M = 1.5
export const ELEVATOR_SHAFT_DEPTH_M = 1.5

/** Buildings below this floor count get no elevator. EU residential
 *  mid-rise convention; matches the brief's >2-floors threshold. */
export const ELEVATOR_MIN_FLOORS = 3

export interface PlaceElevatorsInput {
  /** Multi-floor count. `< ELEVATOR_MIN_FLOORS` ⇒ no elevator. */
  floorCount: number
  floorHeight: number
  /** Stair cores from `placeStairCores`. The elevator attaches to
   *  `stair_core_0` (the end-of-corridor core). */
  stairs: ReadonlyArray<StairCorePlan>
}

/**
 * Place at most one elevator per building. Returns `[]` for single-
 * or two-floor buildings, or for buildings with no stair core
 * (degenerate — should never happen in practice since elevators
 * imply multi-floor).
 */
export function placeElevators(
  input: PlaceElevatorsInput,
): ElevatorPlan[] {
  if (input.floorCount < ELEVATOR_MIN_FLOORS) return []
  // Attach to the primary (end-of-corridor) stair core.
  const stair = input.stairs.find((s) => s.id === 'stair_core_0')
  if (!stair) return []

  // Build the elevator shaft polygon adjacent to the stair's WEST
  // edge (the side facing the corridor interior). Stair shaft is
  // oriented with its long axis along the corridor's u-axis; we
  // mirror that orientation so the elevator's first edge (index 0)
  // faces the same way the stair's first edge faced.
  //
  // Stair shaft polygon convention from `stages/stairs.ts#buildCore`:
  //   [uMin,-halfW], [uMax,-halfW], [uMax,+halfW], [uMin,+halfW]
  // where uMin/uMax span 4 m and halfW = 1.25 m (template width / 2).
  // The "corridor side" is at u = uMax (east-end stair core: uMax =
  // halfL — coincides with the corridor's east end) — wait, that's
  // the END of the corridor, not the corridor side. The corridor
  // SIDE is the long axis facing -v / +v.
  //
  // Concretely, the stair shaft sits AT the corridor's east end with
  // its long axis perpendicular to the corridor flow. The elevator
  // sits IMMEDIATELY WEST of the stair (corridor-inboard), sharing
  // the stair's western edge (vertices at u=uMin).
  const stairPoly = stair.shaftPolygon
  if (stairPoly.length < 4) return []
  // Determine the stair's u-axis range from the polygon. The shaft
  // is a rectangle; min/max x and y extents differ by orientation.
  // Use the corner at index 0 (= [uMin, -halfW]) and index 3
  // (= [uMin, +halfW]) — both share uMin, so their x/y collapse to
  // the "stair's west edge" segment in world coords.
  const west0 = stairPoly[0]!
  const west3 = stairPoly[3]!
  const east1 = stairPoly[1]!
  const east2 = stairPoly[2]!

  // Corridor-axis unit vector: from west to east of the stair shaft.
  // (The stair's long axis runs along this direction; the elevator
  // displaces the same direction.)
  const ux = east1[0] - west0[0]
  const uy = east1[1] - west0[1]
  const ulen = Math.hypot(ux, uy)
  if (ulen < 1e-9) return []
  const uHatX = ux / ulen
  const uHatY = uy / ulen
  // Perpendicular (across the corridor): from -halfW to +halfW edge.
  const vx = west3[0] - west0[0]
  const vy = west3[1] - west0[1]
  const vlen = Math.hypot(vx, vy)
  if (vlen < 1e-9) return []
  const vHatX = vx / vlen
  const vHatY = vy / vlen

  // Elevator's east edge coincides with the stair's west edge.
  // Centre the 1.5 m × 1.5 m shaft on the v-midpoint of the stair's
  // west edge (i.e. on the corridor centerline).
  const eastMidX = (west0[0] + west3[0]) / 2
  const eastMidY = (west0[1] + west3[1]) / 2
  const halfV = ELEVATOR_SHAFT_WIDTH_M / 2
  // Elevator polygon, walked CCW so the first edge is the
  // corridor-facing one (consistent with stair shaft winding).
  //   [west0_elev] = eastMid - uHat*depth - vHat*halfV
  //   [west1_elev] = eastMid              - vHat*halfV
  //   [west2_elev] = eastMid              + vHat*halfV
  //   [west3_elev] = eastMid - uHat*depth + vHat*halfV
  const depth = ELEVATOR_SHAFT_DEPTH_M
  const eastNeg: Point2D = [
    eastMidX - vHatX * halfV,
    eastMidY - vHatY * halfV,
  ]
  const eastPos: Point2D = [
    eastMidX + vHatX * halfV,
    eastMidY + vHatY * halfV,
  ]
  const westNeg: Point2D = [
    eastNeg[0] - uHatX * depth,
    eastNeg[1] - uHatY * depth,
  ]
  const westPos: Point2D = [
    eastPos[0] - uHatX * depth,
    eastPos[1] - uHatY * depth,
  ]
  const shaftPolygon: Polygon2D = [westNeg, eastNeg, eastPos, westPos]

  // Door edge is the corridor-facing edge — perpendicular to the
  // u-axis. The shaft has two corridor-facing edges (one each side
  // along v). Phase 3-9 picks edge index 1 (eastNeg → eastPos)
  // because it's the one nearer the corridor-side wall of the
  // stair core, where a door opening reads cleanly. Brief says
  // "corridor-facing wall" — both v-perpendicular edges qualify; we
  // pick the one closer to the corridor centerline, which is
  // edge 0 (westNeg → eastNeg) for negative-side strip layouts.
  // For this Phase 3-9 first cut we settle on edge 0 since the
  // stair's west edge (the side nearest the corridor inboard) is
  // the natural attach point for a corridor-facing door.
  const doorEdgeIndex = 0

  const id = 'elevator_0'
  const enclosingWallIds: string[] = []
  for (let i = 0; i < shaftPolygon.length; i++) {
    const p = shaftPolygon[i]!
    const q = shaftPolygon[(i + 1) % shaftPolygon.length]!
    enclosingWallIds.push(canonicalElevatorWallId(id, p, q))
  }

  const elevator: ElevatorPlan = {
    id,
    position: westNeg,
    width: ELEVATOR_SHAFT_WIDTH_M,
    depth: ELEVATOR_SHAFT_DEPTH_M,
    shaftPolygon,
    doorEdgeIndex,
    enclosingWallIds,
    stairId: stair.id,
  }
  return [elevator]
}

/**
 * Predicate: does this building qualify for elevator emission?
 * Pulled out so the pipeline can extend stair reservations BEFORE
 * placing actual stair cores (chicken-and-egg avoidance).
 */
export function willPlaceElevator(floorCount: number): boolean {
  return floorCount >= ELEVATOR_MIN_FLOORS
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SNAP_EPSILON = 1e-4

function snap(n: number): string {
  const r = Math.round(n / SNAP_EPSILON) * SNAP_EPSILON
  return (Math.abs(r) < SNAP_EPSILON / 2 ? 0 : r).toFixed(4)
}

function canonicalElevatorWallId(
  elevatorId: string,
  a: Point2D,
  b: Point2D,
): string {
  const ax = snap(a[0])
  const ay = snap(a[1])
  const bx = snap(b[0])
  const by = snap(b[1])
  const aFirst = ax < bx || (ax === bx && ay <= by)
  const [p, q] = aFirst ? [[ax, ay], [bx, by]] : [[bx, by], [ax, ay]]
  const key = `${elevatorId}|${p[0]},${p[1]}→${q[0]},${q[1]}`
  return `${elevatorId}/wall-${cyrb128Hex(key).slice(0, 12)}`
}
