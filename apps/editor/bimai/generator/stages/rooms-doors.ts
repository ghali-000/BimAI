// Room-door placement (Phase 3-7, Task 8).
//
// Walks the partition walls produced by `rooms-walls.ts` and emits one
// `RoomDoor` per partition where exactly one side is the unit's hallway.
// Phase 3-7 convention (Gate 3, default 1): the hallway is the
// circulation spine — every non-hallway room reaches the unit's front
// door via a single hallway-adjacent door. Bedroom-to-bathroom doors,
// kitchen-to-living openings, etc. are out of scope until we have richer
// circulation rules (Phase 3-8+).
//
// Door positioning (Gate 3, override 2): center-of-partition produces
// architecturally-implausible "door in the middle of a long wall" plans
// that force furniture against end walls. Real apartments have doors
// near the corner closest to the hallway entry, so the resident "walks
// in from the corner". We model this by:
//
//   1. Identifying the partition's two endpoints.
//   2. Computing the hallway room's centroid (vertex average — exact
//      for axis-aligned rectangles after the unit's OBB transform; close
//      enough for any convex shape we'd produce).
//   3. Picking the endpoint *closer* to the hallway centroid as the
//      "corner" — that's the side a person walking out of the hallway
//      most naturally turns toward.
//   4. Offsetting `DOOR_CORNER_OFFSET_M` (0.5 m) along the partition,
//      away from that corner. This leaves room for a door swing without
//      blocking the corner itself.
//
// Short-wall fallback: if the partition is shorter than
// `2 * DOOR_CORNER_OFFSET_M + DEFAULT_DOOR_WIDTH_M` (≈ 1.9 m), the
// corner-offset choice can't honor itself — placing a 0.9 m door 0.5 m
// from one end would leave the door extending past the other end. Fall
// back to the partition midpoint and let `emitDoorOnWall`'s clamp handle
// the rest. The deterministic emitter clamp will still center-snap on
// walls too short for any door, which yields `null` and skips emission.
//
// Tie-break: when the hallway centroid is equidistant from both
// endpoints (rare — happens when the centroid lies on the partition's
// perpendicular bisector), we pick the *east* endpoint (larger x; if x
// also ties, larger y). Determinism is the reason — same room layout,
// same regen, byte-identical door positions.
//
// Door identity: deterministic. The host partition wall already has an
// id of the form `partition_<12hex>`; the door inherits the hash slice
// as `door_<12hex>`. Same regen ⇒ same door id, so persisted Pascal
// scenes don't drift between runs.

import type { RoomDoor, RoomKind, RoomPlan } from '../types'

type Point2D = [number, number]

/** Distance from the partition endpoint at which the door is placed. */
export const DOOR_CORNER_OFFSET_M = 0.5

/**
 * Default residential door clear width. Mirrors `DEFAULT_DOOR_WIDTH_M`
 * in `emit.ts` — kept in sync because the short-wall fallback math
 * needs to know it. Re-exporting from emit.ts would create a layering
 * inversion (stages mustn't depend on emit), so we duplicate the
 * constant here and a guardrail test in `rooms-doors.test.ts` asserts
 * they stay equal.
 */
export const DOOR_CLEAR_WIDTH_M = 0.9

/**
 * Minimum partition length for which the corner-offset rule fits.
 * Below this, fall back to midpoint placement.
 *
 *   2 * DOOR_CORNER_OFFSET_M = the room near each endpoint we want to leave clear.
 *   DOOR_CLEAR_WIDTH_M       = the door panel itself.
 *
 * On a wall exactly this long, the door starts at 0.5 m and ends at
 * 1.4 m, leaving 0.5 m of clearance at the far end — symmetric.
 */
export const MIN_PARTITION_LENGTH_FOR_CORNER_OFFSET_M =
  2 * DOOR_CORNER_OFFSET_M + DOOR_CLEAR_WIDTH_M

/** Returns true iff `kind` is the hallway room. Used as a small guard. */
function isHallway(kind: RoomKind): boolean {
  return kind === 'hallway'
}

/** Vertex-average centroid. Exact for axis-aligned rectangles. */
function centroid(polygon: ReadonlyArray<Point2D>): Point2D {
  let sx = 0
  let sy = 0
  for (const p of polygon) {
    sx += p[0]
    sy += p[1]
  }
  const n = polygon.length || 1
  return [sx / n, sy / n]
}

function distSq(a: Point2D, b: Point2D): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

function lerp(a: Point2D, b: Point2D, t: number): Point2D {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

/**
 * Pick the corner of the partition closer to `hallwayCenter`, then place
 * the door `DOOR_CORNER_OFFSET_M` along the partition away from that
 * corner. Falls back to midpoint on short walls.
 *
 * Tie-break (equidistant): pick the east endpoint (larger x; ties on x
 * resolve via larger y). Deterministic.
 *
 * Exported so the test file can lock the math directly.
 */
export function pickDoorPosition(
  a: Point2D,
  b: Point2D,
  hallwayCenter: Point2D,
): Point2D {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < MIN_PARTITION_LENGTH_FOR_CORNER_OFFSET_M) {
    return midpoint(a, b)
  }
  const dA = distSq(a, hallwayCenter)
  const dB = distSq(b, hallwayCenter)
  let corner: Point2D
  let other: Point2D
  if (dA < dB) {
    corner = a
    other = b
  } else if (dB < dA) {
    corner = b
    other = a
  } else {
    // Tie. Prefer the east endpoint; on x-tie prefer the north endpoint.
    const aEast =
      a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1])
    corner = aEast ? a : b
    other = aEast ? b : a
  }
  // Offset from `corner` toward `other` by DOOR_CORNER_OFFSET_M.
  // t = OFFSET / partition length, so lerp(corner, other, t) is the
  // point exactly OFFSET metres along the partition.
  const t = DOOR_CORNER_OFFSET_M / len
  return lerp(corner, other, t)
}

/**
 * Plan room doors in-place: walks every partition wall (count ≥ 2 — the
 * `rooms-walls.ts` interior set), and where exactly one side is the
 * hallway, attaches a `RoomDoor` to the *non-hallway* room's `doors[]`
 * with the corner-offset position. The hallway's `doors[]` stays empty
 * — single-owner deduplication so `emitRoomDoors` can walk
 * `room.doors` and trust the count.
 *
 * Mutates `rooms[*].doors`. Returns the doors as a flat list for
 * inspection by tests.
 *
 * Pre: `rooms[*].walls` is populated (call after `buildRoomWalls`).
 */
export function placeRoomDoors(rooms: RoomPlan[]): RoomDoor[] {
  // Map partition id → list of (room index, room kind) that touch it.
  // Partitions with count !== 2 are non-shared (exterior) and skipped.
  const partitionTouches = new Map<
    string,
    Array<{ index: number; kind: RoomKind; from: Point2D; to: Point2D }>
  >()
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i]!
    for (const w of room.walls) {
      if (w.isExterior) continue
      const arr = partitionTouches.get(w.id) ?? []
      arr.push({
        index: i,
        kind: room.kind,
        from: [w.from[0], w.from[1]],
        to: [w.to[0], w.to[1]],
      })
      partitionTouches.set(w.id, arr)
    }
  }

  const placed: RoomDoor[] = []
  for (const [wallId, touches] of partitionTouches) {
    // Sanity: only proper shared edges (exactly two adjacent rooms).
    // Three-way joins or stray references are ignored here — they'd
    // indicate a packing bug, surfaced by the rooms-walls test suite.
    if (touches.length !== 2) continue
    const [t0, t1] = [touches[0]!, touches[1]!]
    const hallwaySide = isHallway(t0.kind) ? t0 : isHallway(t1.kind) ? t1 : null
    if (!hallwaySide) continue
    const otherSide = hallwaySide === t0 ? t1 : t0
    if (isHallway(otherSide.kind)) continue // both hallway: pathological, skip
    const hallway = rooms[hallwaySide.index]!
    const hallwayCenter = centroid(hallway.polygon)
    const position = pickDoorPosition(t0.from, t0.to, hallwayCenter)
    const door: RoomDoor = {
      from: hallwaySide.kind,
      to: otherSide.kind,
      position: [position[0], position[1]],
      wallId,
    }
    rooms[otherSide.index]!.doors.push(door)
    placed.push(door)
  }
  // Sort `placed` by wallId so the return order is deterministic for
  // tests; the per-room `doors[]` order is whatever Map iteration gave
  // us (insertion order, which is wall-id-keyed and stable across runs).
  placed.sort((a, b) => a.wallId.localeCompare(b.wallId))
  return placed
}
