// Recursive-bisection room packer (Phase 3-7, Task 4).
//
// Given a unit polygon (rectangular by Phase 3-3 construction) and a
// `UnitTemplate` from `rooms-templates.ts`, produce one `RoomPlan` per
// leaf slice. The algorithm is a pure depth-first walk of the
// `SubdivideSpec` tree, slicing the unit's oriented bounding box (OBB)
// by the fractions on each level. No mutation of inputs; deterministic
// for fixed (polygon, template).
//
// The packer operates in **unit-local OBB coordinates** rather than
// world coordinates. The OBB has its origin at the start of the unit's
// longest CCW edge, +x along that edge (the long axis), +y
// perpendicular (the short axis). Every leaf rectangle is computed
// in OBB-local space and only transformed back to world when the
// `RoomPlan` is materialised. Rationale:
//   - decouples subdivision from world orientation (the optimizer
//     already rotates buildings via `footprintOrientation`),
//   - works unchanged when Phase 3-10 introduces non-axis-aligned
//     rectangles inside non-rectangular footprints,
//   - "along" and "across" in template specs map to +x and +y locally
//     without per-template orientation logic.
//
// Constraint application order:
//   1. Walk the tree, applying the bathroom-area clamp at each
//      subdivide that contains a leaf bathroom (single-pass; surplus
//      flows to the next sibling in the slice array).
//   2. After the walk, run two post-checks:
//        a. minRoomDimensionM — fail-and-fallback if any leaf is
//           narrower than the floor on either side,
//        b. bedroomNeedsFacade — fail-and-fallback if a bedroom rect
//           doesn't touch a facade-mapped OBB edge.
//   3. On success, transform each leaf rect to world coords and
//      compute `windowAccess` from the same facade-edge mapping.
//
// Failure is not recoverable inside the algorithm: we don't try to
// rebalance fractions or swap templates. The packer returns
// `{ ok: false, ... }` and the caller (planRooms) falls the unit
// back to a single `unit-shell` room. This keeps the algorithm a
// pure tree walk and concentrates policy in the caller.

import type { RoomKind, RoomPlan, UnitPlan } from '../types'
import {
  type ProportionalSlice,
  type SubdivideSpec,
  type UnitTemplate,
  type UnitTemplateConstraints,
} from './rooms-templates'
import { placeRoomDoors } from './rooms-doors'
import { buildRoomWalls, unitSeedFor } from './rooms-walls'

// ─────────────────────────────────────────────────────────────────────
// Geometry primitives
// ─────────────────────────────────────────────────────────────────────

/**
 * Oriented bounding box for a rectangular unit polygon. World-space
 * affine frame: a point `(lx, ly)` in OBB-local coords maps to
 * `origin + xAxis*lx + yAxis*ly` in world coords.
 *
 * `xAxis` and `yAxis` are unit vectors. `width` is the length along
 * `xAxis` (the long axis); `height` is the length along `yAxis`.
 *
 * Convention: origin sits at the start vertex of the longest CCW edge.
 * For a square, ties are broken by the lowest vertex index — this is
 * the "rotation-invariance" we test for: a rectangle defined CCW
 * starting from any vertex still produces the same OBB origin and
 * axes (modulo which corner is origin) once the longest-edge rule
 * picks the same physical edge.
 */
export interface OrientedBoundingBox {
  origin: [number, number]
  xAxis: [number, number]
  yAxis: [number, number]
  width: number
  height: number
}

/** Axis-aligned rectangle in OBB-local coordinates. */
export interface LocalRect {
  x: number
  y: number
  w: number
  h: number
}

/** Snap-tolerance for "rect touches OBB edge" checks. */
const EDGE_EPSILON = 1e-6

/**
 * Build the OBB for a 4-vertex CCW rectangular polygon. Throws on
 * non-quadrilateral input — this is a programmer error (the unit
 * packer only emits rectangles in Phase 3-7).
 */
export function computeOrientedBoundingBox(
  polygon: [number, number][],
): OrientedBoundingBox {
  if (polygon.length !== 4) {
    throw new Error(
      `computeOrientedBoundingBox: expected 4-vertex rectangle, got ${polygon.length}`,
    )
  }
  // Compute each edge's length and direction.
  const edges = polygon.map((a, i) => {
    const b = polygon[(i + 1) % 4]!
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    return { startIdx: i, dx, dy, len: Math.hypot(dx, dy) }
  })
  // Find the longest length first (modulo float tolerance).
  let maxLen = edges[0]!.len
  for (let i = 1; i < 4; i++) maxLen = Math.max(maxLen, edges[i]!.len)
  // Among edges within tolerance of max, pick the one whose start
  // vertex is lex-min (smallest x, then smallest y). This is the
  // rotation-invariance tiebreaker: the same physical rectangle
  // defined CCW from any starting vertex picks the same physical
  // corner as origin.
  let chosen: typeof edges[number] | undefined
  for (let i = 0; i < 4; i++) {
    const e = edges[i]!
    if (e.len < maxLen - EDGE_EPSILON) continue
    if (!chosen) {
      chosen = e
      continue
    }
    const a = polygon[e.startIdx]!
    const b = polygon[chosen.startIdx]!
    if (a[0] < b[0] - EDGE_EPSILON || (Math.abs(a[0] - b[0]) <= EDGE_EPSILON && a[1] < b[1] - EDGE_EPSILON)) {
      chosen = e
    }
  }
  const longest = chosen!
  const next = edges[(longest.startIdx + 1) % 4]!
  const xAxis: [number, number] = [longest.dx / longest.len, longest.dy / longest.len]
  const yAxis: [number, number] = [next.dx / next.len, next.dy / next.len]
  const origin = polygon[longest.startIdx]!
  return {
    origin: [origin[0], origin[1]],
    xAxis,
    yAxis,
    width: longest.len,
    height: next.len,
  }
}

/** Map an OBB-local rect back to a CCW world polygon (4 vertices). */
export function transformRectToWorld(
  rect: LocalRect,
  obb: OrientedBoundingBox,
): [number, number][] {
  const { origin, xAxis, yAxis } = obb
  const corner = (lx: number, ly: number): [number, number] => [
    origin[0] + xAxis[0] * lx + yAxis[0] * ly,
    origin[1] + xAxis[1] * lx + yAxis[1] * ly,
  ]
  return [
    corner(rect.x, rect.y),
    corner(rect.x + rect.w, rect.y),
    corner(rect.x + rect.w, rect.y + rect.h),
    corner(rect.x, rect.y + rect.h),
  ]
}

/**
 * Slice an OBB-local rectangle by a list of fractions. `axis = 'along'`
 * stacks slices in +x (each slice has full height, partial width);
 * `axis = 'across'` stacks in +y.
 *
 * Fractions are assumed to already sum to 1.0 (validated upstream by
 * the template loader, possibly modified by `applyBathroomClamp`).
 */
export function sliceByFractions(
  rect: LocalRect,
  axis: 'along' | 'across',
  fractions: number[],
): LocalRect[] {
  const out: LocalRect[] = []
  let acc = 0
  for (const f of fractions) {
    if (axis === 'along') {
      out.push({
        x: rect.x + rect.w * acc,
        y: rect.y,
        w: rect.w * f,
        h: rect.h,
      })
    } else {
      out.push({
        x: rect.x,
        y: rect.y + rect.h * acc,
        w: rect.w,
        h: rect.h * f,
      })
    }
    acc += f
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// Facade-edge mapping
// ─────────────────────────────────────────────────────────────────────

/**
 * Which OBB-local edges (as a 4-bit mask: bottom/right/top/left) the
 * unit's facade edges map to. Polygon edge index i means the segment
 * from `polygon[i]` to `polygon[(i+1)%4]`. With OBB origin at vertex
 * `longestStartIdx`:
 *   - polygon edge `longestStartIdx` is OBB bottom (y=0)
 *   - +1 is OBB right (x=width)
 *   - +2 is OBB top (y=height)
 *   - +3 is OBB left (x=0)
 */
interface FacadeMask {
  bottom: boolean
  right: boolean
  top: boolean
  left: boolean
}

function buildFacadeMask(
  polygon: [number, number][],
  facadeEdges: number[],
  obb: OrientedBoundingBox,
): FacadeMask {
  // Recover longestStartIdx by matching origin to a polygon vertex.
  let longestStartIdx = 0
  for (let i = 0; i < 4; i++) {
    const v = polygon[i]!
    if (
      Math.abs(v[0] - obb.origin[0]) < EDGE_EPSILON &&
      Math.abs(v[1] - obb.origin[1]) < EDGE_EPSILON
    ) {
      longestStartIdx = i
      break
    }
  }
  const m: FacadeMask = { bottom: false, right: false, top: false, left: false }
  for (const e of facadeEdges) {
    const offset = ((e - longestStartIdx) % 4 + 4) % 4
    if (offset === 0) m.bottom = true
    else if (offset === 1) m.right = true
    else if (offset === 2) m.top = true
    else if (offset === 3) m.left = true
  }
  return m
}

function rectTouchesFacade(
  rect: LocalRect,
  obb: OrientedBoundingBox,
  facade: FacadeMask,
): boolean {
  if (facade.bottom && rect.y < EDGE_EPSILON) return true
  if (facade.top && Math.abs(rect.y + rect.h - obb.height) < EDGE_EPSILON) return true
  if (facade.left && rect.x < EDGE_EPSILON) return true
  if (facade.right && Math.abs(rect.x + rect.w - obb.width) < EDGE_EPSILON) return true
  return false
}

// ─────────────────────────────────────────────────────────────────────
// Bathroom clamp
// ─────────────────────────────────────────────────────────────────────

/**
 * Single-pass clamp. For each leaf bathroom slice whose absolute area
 * (`fraction * parentArea`) exceeds `bathroomMaxAreaM2`, cap it and
 * push the surplus fraction to the next sibling. If the bathroom is
 * the last sibling, no-op (template-authoring problem flagged at load
 * time — see `rooms-templates.ts`).
 *
 * Returns a new array with adjusted fractions; never mutates input.
 */
export function applyBathroomClamp(
  slices: ProportionalSlice[],
  parentAreaM2: number,
  constraints: UnitTemplateConstraints,
): ProportionalSlice[] {
  const out = slices.map((s) => ({ ...s }))
  for (let i = 0; i < out.length; i++) {
    const s = out[i]!
    if (s.kind !== 'bathroom') continue
    const sliceArea = s.fraction * parentAreaM2
    if (sliceArea <= constraints.bathroomMaxAreaM2) continue
    if (i === out.length - 1) continue // last sibling — no absorber
    const cappedFraction = constraints.bathroomMaxAreaM2 / parentAreaM2
    const surplus = s.fraction - cappedFraction
    s.fraction = cappedFraction
    out[i + 1]!.fraction += surplus
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// Tree walk
// ─────────────────────────────────────────────────────────────────────

interface Leaf {
  kind: RoomKind
  rect: LocalRect
}

function walkSubdivide(
  rect: LocalRect,
  spec: SubdivideSpec,
  constraints: UnitTemplateConstraints,
  out: Leaf[],
): void {
  const parentArea = rect.w * rect.h
  const adjusted = applyBathroomClamp(spec.slices, parentArea, constraints)
  const subRects = sliceByFractions(
    rect,
    spec.axis,
    adjusted.map((s) => s.fraction),
  )
  for (let i = 0; i < adjusted.length; i++) {
    const slice = adjusted[i]!
    const subRect = subRects[i]!
    if (slice.subdivide) {
      walkSubdivide(subRect, slice.subdivide, constraints, out)
    } else if (slice.kind) {
      out.push({ kind: slice.kind, rect: subRect })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export type BisectFailureReason =
  | 'rooms_too_small'
  | 'bedroom_no_facade'
  | 'unit_not_rectangular'

export interface BisectFailure {
  ok: false
  reason: BisectFailureReason
  /** Best-effort detail for the warning string. */
  detail: string
  /** The kind of the room that triggered the failure, if applicable. */
  failingRoom?: RoomKind
}

export interface BisectSuccess {
  ok: true
  rooms: RoomPlan[]
}

export type BisectResult = BisectSuccess | BisectFailure

/**
 * Subdivide a unit by recursive bisection of its OBB. Pure, deterministic.
 * On failure the caller should fall back to a unit-shell layout — this
 * function does not produce one itself.
 */
export function bisectUnit(unit: UnitPlan, template: UnitTemplate): BisectResult {
  if (unit.polygon.length !== 4) {
    return {
      ok: false,
      reason: 'unit_not_rectangular',
      detail: `unit polygon has ${unit.polygon.length} vertices, packer expects 4`,
    }
  }
  const obb = computeOrientedBoundingBox(unit.polygon)
  const facade = buildFacadeMask(unit.polygon, unit.facadeEdges, obb)
  const rootRect: LocalRect = { x: 0, y: 0, w: obb.width, h: obb.height }

  const leaves: Leaf[] = []
  walkSubdivide(rootRect, template.rootSplit, template.constraints, leaves)

  // Post-check 1: dimension floor.
  for (const l of leaves) {
    const minDim = Math.min(l.rect.w, l.rect.h)
    if (minDim < template.constraints.minRoomDimensionM - EDGE_EPSILON) {
      return {
        ok: false,
        reason: 'rooms_too_small',
        failingRoom: l.kind,
        detail: `${l.kind} is ${minDim.toFixed(2)} m wide, minimum ${template.constraints.minRoomDimensionM} m`,
      }
    }
  }

  // Post-check 2: bedroom facade requirement.
  if (template.constraints.bedroomNeedsFacade) {
    for (const l of leaves) {
      if (l.kind !== 'bedroom') continue
      if (!rectTouchesFacade(l.rect, obb, facade)) {
        return {
          ok: false,
          reason: 'bedroom_no_facade',
          failingRoom: 'bedroom',
          detail: `bedroom rectangle does not touch any facade edge of the unit`,
        }
      }
    }
  }

  const rooms: RoomPlan[] = leaves.map((l) => ({
    kind: l.kind,
    polygon: transformRectToWorld(l.rect, obb),
    area: l.rect.w * l.rect.h,
    walls: [], // populated below once all polygons are known
    doors: [], // Task 8 places doors
    windowAccess: rectTouchesFacade(l.rect, obb, facade),
  }))

  // Phase 3-7 Task 5: derive partition-wall ownership. Each room carries
  // every boundary segment with a stable shared id; segments shared
  // between two rooms (count ≥ 2) are interior partitions to be emitted
  // as new WallNodes, segments touching the unit envelope (count = 1)
  // are flagged `isExterior: true` and reference the unit-packer's
  // existing perimeter walls implicitly.
  const seed = unitSeedFor(unit.type, unit.polygon)
  const { perRoom } = buildRoomWalls(rooms, seed)
  for (let i = 0; i < rooms.length; i++) {
    rooms[i]!.walls = perRoom[i]!
  }

  // Phase 3-7 Task 8: place doors on partition walls between hallway and
  // non-hallway rooms. Mutates rooms[*].doors in-place.
  placeRoomDoors(rooms)

  return { ok: true, rooms }
}
