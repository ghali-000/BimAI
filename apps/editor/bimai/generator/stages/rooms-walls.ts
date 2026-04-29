// Room-partition wall derivation (Phase 3-7, Task 5).
//
// The packer in `rooms-packing.ts` produces a list of leaf rectangles
// (one per RoomPlan) in world coords. Adjacent rooms share an edge —
// physically the same drywall partition. This module:
//
//   1. Walks every room's 4 boundary segments.
//   2. Snaps each endpoint to a grid (EDGE_EPSILON) and canonicalises
//      the segment by sorting its two endpoints lex-min so a→b and
//      b→a hash to the same key.
//   3. Hashes the canonical key (with a unit-scoped seed) into a
//      stable string id via cyrb128Hex — same input string ⇒ same id,
//      across runs and across the two RoomPlans that share the edge.
//   4. Counts how many rooms claim each canonical edge:
//        count = 1 → unit-perimeter edge (already emitted as a
//                    `perimeter`/`corridor`/`party` wall by the unit
//                    packer; we surface it on the room with
//                    `isExterior: true` for downstream readers but
//                    don't re-emit a WallNode for it).
//        count ≥ 2 → interior partition between two rooms inside the
//                    same unit. Emit one WallNode (Phase 3-7) tagged
//                    `metadata.bimai.wallRole: 'room-partition'`.
//
// Why a separate file rather than inlining in rooms-packing:
//   - Packing is "where do rooms go"; wall derivation is "given rooms,
//     who owns which segment". Different concerns, separately testable.
//   - The dedup logic is generic enough that Phase 3-10 (non-rectangular
//     unit subdivision) can reuse it unchanged once it produces RoomPlans.
//
// Determinism + collision behaviour:
//   - cyrb128Hex of a stable input string is deterministic across runs.
//   - 12 hex chars = 48 bits of entropy. For a few hundred partition
//     walls in one project, collision probability is ~birthday(2^48, 300)
//     ≈ 5e-10. Good enough for an in-export dedup key. The `unitSeed`
//     scoper exists so two unrelated projects can't collide just because
//     their partition walls happen to land on identical coordinates.

import type { RoomPlan, RoomWall } from '../types'
import { cyrb128Hex } from '../../lib/hash'

type Point2D = [number, number]

/** Endpoint snap tolerance for "two segments coincide". 0.1 mm. */
export const EDGE_EPSILON = 1e-4

/** Round a coordinate to the snap grid; renders to a stable string. */
function snap(n: number): string {
  // Round to EDGE_EPSILON; format with 4 decimal places so 0 and -0
  // both print as "0.0000". Math.round + toFixed handles -0 cleanly.
  const r = Math.round(n / EDGE_EPSILON) * EDGE_EPSILON
  return (Math.abs(r) < EDGE_EPSILON / 2 ? 0 : r).toFixed(4)
}

/**
 * Canonicalise a segment by sorting its two endpoints lex-min. Returned
 * key is the same regardless of which direction the caller walked the
 * room boundary.
 */
function canonicalEdgeKey(a: Point2D, b: Point2D): string {
  const ax = snap(a[0]),
    ay = snap(a[1]),
    bx = snap(b[0]),
    by = snap(b[1])
  // Lex compare on the snapped strings; ties on x compare on y.
  const aFirst = ax < bx || (ax === bx && ay <= by)
  const [p, q] = aFirst ? [[ax, ay], [bx, by]] : [[bx, by], [ax, ay]]
  return `${p[0]},${p[1]}→${q[0]},${q[1]}`
}

/**
 * Stable id for a partition wall. Same canonical edge + same `unitSeed`
 * ⇒ same id, across runs. The id is opaque to consumers; emit.ts uses
 * it only for set-based dedup before assigning a Pascal nanoid to the
 * WallNode.
 */
export function partitionWallId(
  a: Point2D,
  b: Point2D,
  unitSeed: string,
): string {
  const key = `${unitSeed}|${canonicalEdgeKey(a, b)}`
  return `partition_${cyrb128Hex(key).slice(0, 12)}`
}

/**
 * Compute a stable, project-scoped seed for a unit. We use the unit's
 * type plus the snapped coords of its lex-min vertex — together those
 * are unique across one floor's units (two units of the same type can't
 * sit at the same lex-min vertex; their polygons would overlap) and
 * stable across runs (same plan ⇒ same lex-min vertex).
 *
 * Including a project-level component (e.g. `BuildingPlan.generationId`)
 * is unnecessary for in-export dedup — the cyrb128Hex of the canonical
 * edge string is already collision-resistant at our scale — but we
 * accept it as an optional extra prefix so callers that want
 * project-level uniqueness can opt in.
 */
export function unitSeedFor(
  unitType: string,
  unitPolygon: ReadonlyArray<Point2D>,
  projectSeed = '',
): string {
  let lex: Point2D = unitPolygon[0]!
  for (const p of unitPolygon) {
    if (p[0] < lex[0] || (p[0] === lex[0] && p[1] < lex[1])) lex = p
  }
  return `${projectSeed}|${unitType}|${snap(lex[0])},${snap(lex[1])}`
}

interface CanonicalEdge {
  /** Stable id (shared across rooms that touch this edge). */
  id: string
  /** Canonical (lex-min sorted) endpoints. */
  from: Point2D
  to: Point2D
  /** How many rooms claim this edge. */
  count: number
}

/**
 * Walk the room polygons, bucket boundary segments by canonical id, and
 * return both:
 *   - the edge map (id → CanonicalEdge with count and canonical points),
 *   - the per-room walls list (every boundary segment, tagged
 *     `isExterior` based on whether the edge is shared with ≥1 sibling).
 *
 * Rooms are read-only here; this is a pure function of the input list.
 */
export function buildRoomWalls(
  rooms: RoomPlan[],
  unitSeed: string,
): {
  edges: Map<string, CanonicalEdge>
  perRoom: RoomWall[][]
} {
  const edges = new Map<string, CanonicalEdge>()
  const perRoomKeys: string[][] = rooms.map(() => [])

  for (let r = 0; r < rooms.length; r++) {
    const poly = rooms[r]!.polygon
    if (poly.length < 3) continue
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!
      const b = poly[(i + 1) % poly.length]!
      const id = partitionWallId(a, b, unitSeed)
      let entry = edges.get(id)
      if (!entry) {
        // Store canonical (sorted) endpoints so the consumer's `from→to`
        // is the same regardless of which room registered the edge first.
        const aFirst =
          a[0] < b[0] - EDGE_EPSILON ||
          (Math.abs(a[0] - b[0]) <= EDGE_EPSILON && a[1] <= b[1])
        const [p, q] = aFirst ? [a, b] : [b, a]
        entry = {
          id,
          from: [p[0], p[1]],
          to: [q[0], q[1]],
          count: 0,
        }
        edges.set(id, entry)
      }
      entry.count++
      perRoomKeys[r]!.push(id)
    }
  }

  // Build the per-room RoomWall[] now that all counts are final.
  const perRoom: RoomWall[][] = perRoomKeys.map((keys) =>
    keys.map((k) => {
      const e = edges.get(k)!
      return {
        id: e.id,
        from: [e.from[0], e.from[1]],
        to: [e.to[0], e.to[1]],
        // Shared (count ≥ 2) ⇒ interior partition. Solo edges are on the
        // unit's outer envelope, already materialised by the unit packer.
        isExterior: e.count < 2,
      }
    }),
  )

  return { edges, perRoom }
}

/** Just the interior partition edges (count ≥ 2), one entry per shared id. */
export function interiorPartitionEdges(
  edges: Map<string, CanonicalEdge>,
): CanonicalEdge[] {
  const out: CanonicalEdge[] = []
  for (const e of edges.values()) {
    if (e.count >= 2) out.push(e)
  }
  return out
}

export type { CanonicalEdge }
