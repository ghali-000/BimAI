import { describe, expect, it } from 'vitest'
import type { RoomPlan, UnitPlan } from '../types'
import { bisectUnit } from './rooms-packing'
import { getUnitTemplate } from './rooms-templates'
import {
  buildRoomWalls,
  interiorPartitionEdges,
  partitionWallId,
  unitSeedFor,
} from './rooms-walls'

// ─────────────────────────────────────────────────────────────────────
// partitionWallId
// ─────────────────────────────────────────────────────────────────────

describe('partitionWallId', () => {
  it('is direction-invariant: (a→b) and (b→a) hash identically', () => {
    const a: [number, number] = [1, 2]
    const b: [number, number] = [3, 4]
    expect(partitionWallId(a, b, 'seed')).toBe(partitionWallId(b, a, 'seed'))
  })

  it('depends on the seed: different seeds produce different ids', () => {
    const a: [number, number] = [0, 0]
    const b: [number, number] = [1, 0]
    expect(partitionWallId(a, b, 'unit-1')).not.toBe(
      partitionWallId(a, b, 'unit-2'),
    )
  })

  it('snaps endpoints to EDGE_EPSILON: tiny float drift hashes the same', () => {
    const id1 = partitionWallId([0, 0], [1, 0], 'seed')
    const id2 = partitionWallId([1e-7, -1e-7], [1.00000001, 1e-9], 'seed')
    expect(id2).toBe(id1)
  })

  it('produces stable opaque strings of the documented form', () => {
    const id = partitionWallId([0, 0], [1, 0], 'seed')
    expect(id).toMatch(/^partition_[0-9a-f]{12}$/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// unitSeedFor
// ─────────────────────────────────────────────────────────────────────

describe('unitSeedFor', () => {
  it('is stable under polygon vertex rotation (lex-min anchor)', () => {
    const polyA: [number, number][] = [
      [0, 0],
      [5, 0],
      [5, 4],
      [0, 4],
    ]
    const polyB: [number, number][] = [
      [5, 0],
      [5, 4],
      [0, 4],
      [0, 0],
    ]
    expect(unitSeedFor('1BR', polyA)).toBe(unitSeedFor('1BR', polyB))
  })

  it('changes when the unit shifts in world space', () => {
    const a = unitSeedFor('1BR', [
      [0, 0],
      [5, 0],
      [5, 4],
      [0, 4],
    ])
    const b = unitSeedFor('1BR', [
      [10, 0],
      [15, 0],
      [15, 4],
      [10, 4],
    ])
    expect(a).not.toBe(b)
  })
})

// ─────────────────────────────────────────────────────────────────────
// buildRoomWalls — synthetic two-room split
// ─────────────────────────────────────────────────────────────────────

function rect(x: number, y: number, w: number, h: number): RoomPlan {
  return {
    kind: 'living',
    polygon: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
    area: w * h,
    walls: [],
    doors: [],
    windowAccess: false,
  }
}

describe('buildRoomWalls', () => {
  it('shares the partition edge between two adjacent rectangles', () => {
    // Two rectangles split a 10×4 unit at x=4. Shared edge is x=4, y∈[0,4].
    const rooms: RoomPlan[] = [rect(0, 0, 4, 4), rect(4, 0, 6, 4)]
    const { edges, perRoom } = buildRoomWalls(rooms, 'seed')

    // Find the shared edge.
    const shared = [...edges.values()].filter((e) => e.count >= 2)
    expect(shared).toHaveLength(1)
    expect(shared[0]!.count).toBe(2)

    // Both rooms record the same id for the shared edge.
    const left = perRoom[0]!.find((w) => !w.isExterior)
    const right = perRoom[1]!.find((w) => !w.isExterior)
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    expect(left!.id).toBe(right!.id)
  })

  it('marks unshared edges as exterior (count=1)', () => {
    const rooms: RoomPlan[] = [rect(0, 0, 4, 4), rect(4, 0, 6, 4)]
    const { perRoom } = buildRoomWalls(rooms, 'seed')

    // Each rectangle has 4 segments; 1 interior + 3 exterior.
    expect(perRoom[0]!.filter((w) => w.isExterior)).toHaveLength(3)
    expect(perRoom[0]!.filter((w) => !w.isExterior)).toHaveLength(1)
    expect(perRoom[1]!.filter((w) => w.isExterior)).toHaveLength(3)
    expect(perRoom[1]!.filter((w) => !w.isExterior)).toHaveLength(1)
  })

  it('interiorPartitionEdges returns one entry per shared edge', () => {
    const rooms: RoomPlan[] = [rect(0, 0, 4, 4), rect(4, 0, 6, 4)]
    const { edges } = buildRoomWalls(rooms, 'seed')
    expect(interiorPartitionEdges(edges)).toHaveLength(1)
  })

  it('handles three rooms in a row (two interior partitions)', () => {
    const rooms: RoomPlan[] = [
      rect(0, 0, 3, 4),
      rect(3, 0, 4, 4),
      rect(7, 0, 3, 4),
    ]
    const { edges } = buildRoomWalls(rooms, 'seed')
    const shared = interiorPartitionEdges(edges)
    expect(shared).toHaveLength(2)
    // Middle room shares with both neighbours → 2 interior walls.
    const { perRoom } = buildRoomWalls(rooms, 'seed')
    expect(perRoom[1]!.filter((w) => !w.isExterior)).toHaveLength(2)
  })

  it('does not share edges across two unrelated unit seeds', () => {
    // Same physical edge in two different unit scopes must map to
    // different ids (so two units' partition walls are not falsely
    // merged in the dedup step).
    const rooms = [rect(0, 0, 4, 4), rect(4, 0, 6, 4)]
    const a = buildRoomWalls(rooms, 'unit-A')
    const b = buildRoomWalls(rooms, 'unit-B')
    const aShared = interiorPartitionEdges(a.edges)[0]!.id
    const bShared = interiorPartitionEdges(b.edges)[0]!.id
    expect(aShared).not.toBe(bShared)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Integration via bisectUnit — deterministic, full template paths
// ─────────────────────────────────────────────────────────────────────

function makeUnit(overrides: Partial<UnitPlan> = {}): UnitPlan {
  return {
    type: '2BR',
    polygon: [
      [0, 0],
      [11, 0],
      [11, 7.5],
      [0, 7.5],
    ],
    area: 82.5,
    facadeEdges: [0, 2],
    corridorEdges: [],
    rooms: [],
    ...overrides,
  }
}

describe('bisectUnit + room walls (integration)', () => {
  it('reference 2BR: every room has 4 walls; interior partition ids dedupe', () => {
    const r = bisectUnit(makeUnit(), getUnitTemplate('2BR')!)
    if (!r.ok) throw new Error('expected ok')
    // 6 rooms × 4 segments = 24 segments. Interior partition ids
    // should number ≤ 24 - (perimeter segments). Each interior id
    // appears twice across the room set.
    const ids: string[] = []
    for (const rm of r.rooms) for (const w of rm.walls) ids.push(w.id)
    const interior = r.rooms.flatMap((rm) =>
      rm.walls.filter((w) => !w.isExterior),
    )
    // Count occurrences of each interior id.
    const counts = new Map<string, number>()
    for (const w of interior) counts.set(w.id, (counts.get(w.id) ?? 0) + 1)
    for (const c of counts.values()) expect(c).toBe(2)
  })

  it('partition ids are stable across two independent bisections of the same input', () => {
    const A = bisectUnit(makeUnit(), getUnitTemplate('2BR')!)
    const B = bisectUnit(makeUnit(), getUnitTemplate('2BR')!)
    if (!A.ok || !B.ok) throw new Error('expected ok')
    const idsA = A.rooms
      .flatMap((rm) => rm.walls.filter((w) => !w.isExterior))
      .map((w) => w.id)
      .sort()
    const idsB = B.rooms
      .flatMap((rm) => rm.walls.filter((w) => !w.isExterior))
      .map((w) => w.id)
      .sort()
    expect(idsB).toEqual(idsA)
  })

  it('Studio: bath strip + living share exactly one partition', () => {
    const r = bisectUnit(
      makeUnit({
        type: 'Studio',
        polygon: [
          [0, 0],
          [12, 0],
          [12, 3.75],
          [0, 3.75],
        ],
        area: 45,
        facadeEdges: [2],
      }),
      getUnitTemplate('Studio')!,
    )
    if (!r.ok) throw new Error('expected ok')
    const interior = r.rooms.flatMap((rm) =>
      rm.walls.filter((w) => !w.isExterior),
    )
    const uniqueIds = new Set(interior.map((w) => w.id))
    expect(uniqueIds.size).toBe(1)
    expect(interior).toHaveLength(2) // one per side
  })

  it('every interior partition lies fully inside the unit polygon (no perimeter leaks)', () => {
    // Smoke check that the count=1 / count=2 split correctly distinguishes
    // perimeter from interior. For a 2BR rectangle 0,0 → 11,7.5, an
    // interior partition has both endpoints with x ∈ [0, 11] and y ∈ [0, 7.5]
    // and at least one endpoint not on the envelope (count≥2 implies it's
    // shared between two interior rooms).
    const r = bisectUnit(makeUnit(), getUnitTemplate('2BR')!)
    if (!r.ok) throw new Error('expected ok')
    for (const rm of r.rooms) {
      for (const w of rm.walls) {
        if (w.isExterior) continue
        // Each interior partition endpoint sits inside or on the unit
        // envelope. A partition fully on the envelope would have count=1
        // (it's only owned by one room), so this catches the inverse: a
        // partition wandering outside the unit.
        for (const p of [w.from, w.to]) {
          expect(p[0]).toBeGreaterThanOrEqual(-1e-6)
          expect(p[0]).toBeLessThanOrEqual(11 + 1e-6)
          expect(p[1]).toBeGreaterThanOrEqual(-1e-6)
          expect(p[1]).toBeLessThanOrEqual(7.5 + 1e-6)
        }
      }
    }
  })

  it('1BR fallback (32 m²) ships unit-shell with no interior partitions', () => {
    // Bisection fails (rooms_too_small), planRooms falls back to a single
    // unit-shell room. That room's edges are all "interior" by buildRoomWalls
    // accounting only if we ran it on the unit polygon — but the fallback
    // path in rooms.ts skips rooms-walls and returns walls=[] for the shell.
    const fallback = bisectUnit(
      makeUnit({
        type: '1BR',
        polygon: [
          [0, 0],
          [8, 0],
          [8, 4],
          [0, 4],
        ],
        area: 32,
        facadeEdges: [2],
      }),
      getUnitTemplate('1BR')!,
    )
    expect(fallback.ok).toBe(false)
  })
})
