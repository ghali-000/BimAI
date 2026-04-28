import { describe, expect, it } from 'vitest'
import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { tagAsGenerated } from '../generator/tag'
import { computeSchedule } from './compute'

// ── Test fixtures ───────────────────────────────────────────────────────────
//
// Same pattern as cleanup.test.ts / bim-defaults.test.ts: build minimal node
// shapes via cast rather than running them through Pascal's Zod schemas.
// computeSchedule reads .id / .type / .parentId / .polygon / .metadata only.

function makeNode(
  id: string,
  type: string,
  parentId: AnyNodeId | null,
  extra?: Record<string, unknown>,
): AnyNode {
  return {
    object: 'node',
    id,
    type,
    parentId,
    visible: true,
    metadata: {},
    ...extra,
  } as unknown as AnyNode
}

function makeLevel(id: string, level: number, parentId: AnyNodeId): AnyNode {
  return tagAsGenerated(makeNode(id, 'level', parentId, { level }), 'gen-A')
}

function makeSlab(
  id: string,
  parentId: AnyNodeId,
  polygon: [number, number][],
): AnyNode {
  return tagAsGenerated(makeNode(id, 'slab', parentId, { polygon }), 'gen-A')
}

function makeZone(
  id: string,
  parentId: AnyNodeId,
  polygon: [number, number][],
  unitType: string | null,
): AnyNode {
  const meta = unitType !== null ? { bimai: { unitType } } : {}
  // tagAsGenerated will deep-merge generatedBy/generationId under metadata.bimai.
  return tagAsGenerated(
    makeNode(id, 'zone', parentId, { polygon, metadata: meta }),
    'gen-A',
  )
}

function buildScene(nodes: AnyNode[]) {
  const dict: Record<AnyNodeId, AnyNode> = {}
  for (const n of nodes) dict[n.id] = n
  return { nodes: dict }
}

// 10×10 = 100 m² square
const SQUARE_10: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
]
// 5×4 = 20 m² rectangle
const RECT_5x4: [number, number][] = [
  [0, 0],
  [5, 0],
  [5, 4],
  [0, 4],
]
// 5×3 = 15 m²
const RECT_5x3: [number, number][] = [
  [0, 0],
  [5, 0],
  [5, 3],
  [0, 3],
]

describe('computeSchedule', () => {
  it('returns zeroed result for an empty scene', () => {
    const r = computeSchedule({ nodes: {} })
    expect(r.floorCount).toBe(0)
    expect(r.totals).toEqual({ gea: 0, nia: 0, efficiency: 0 })
    expect(r.byFloor).toEqual([])
    expect(r.residential.totalUnits).toBe(0)
    expect(r.residential.avgUnitArea).toBe(0)
    expect(r.residential.byUnitType).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('does not divide by zero on empty scenes', () => {
    const r = computeSchedule({ nodes: {} })
    expect(Number.isFinite(r.totals.efficiency)).toBe(true)
    expect(Number.isFinite(r.residential.avgUnitArea)).toBe(true)
  })

  it('counts a single floor: GEA from slab, NIA from zones, efficiency = NIA/GEA', () => {
    const scene = buildScene([
      makeLevel('level_1', 0, 'building_1' as AnyNodeId),
      makeSlab('slab_1', 'level_1' as AnyNodeId, SQUARE_10), // 100
      makeZone('zone_1', 'level_1' as AnyNodeId, RECT_5x4, '1BR'), // 20
      makeZone('zone_2', 'level_1' as AnyNodeId, RECT_5x3, 'Studio'), // 15
    ])
    const r = computeSchedule(scene)
    expect(r.floorCount).toBe(1)
    expect(r.totals.gea).toBe(100)
    expect(r.totals.nia).toBe(35)
    expect(r.totals.efficiency).toBeCloseTo(0.35, 5)
    expect(r.byFloor).toHaveLength(1)
    expect(r.byFloor[0]).toEqual({ level: 0, gea: 100, nia: 35, unitCount: 2 })
  })

  it('aggregates across multiple floors (totals = sum of byFloor)', () => {
    const scene = buildScene([
      makeLevel('level_0', 0, 'building_1' as AnyNodeId),
      makeLevel('level_1', 1, 'building_1' as AnyNodeId),
      makeSlab('slab_0', 'level_0' as AnyNodeId, SQUARE_10), // 100
      makeSlab('slab_1', 'level_1' as AnyNodeId, SQUARE_10), // 100
      makeZone('z_0a', 'level_0' as AnyNodeId, RECT_5x4, '1BR'), // 20
      makeZone('z_1a', 'level_1' as AnyNodeId, RECT_5x4, '1BR'), // 20
      makeZone('z_1b', 'level_1' as AnyNodeId, RECT_5x3, '1BR'), // 15
    ])
    const r = computeSchedule(scene)
    expect(r.floorCount).toBe(2)
    expect(r.totals.gea).toBe(200)
    expect(r.totals.nia).toBe(55)
    expect(r.byFloor.map((f) => f.level)).toEqual([0, 1])
    expect(r.byFloor[0]!.unitCount).toBe(1)
    expect(r.byFloor[1]!.unitCount).toBe(2)
  })

  it('groups zones by unitType and sorts byUnitType by count desc', () => {
    const scene = buildScene([
      makeLevel('level_0', 0, 'building_1' as AnyNodeId),
      makeSlab('slab_0', 'level_0' as AnyNodeId, SQUARE_10),
      makeZone('z_a', 'level_0' as AnyNodeId, RECT_5x4, 'Studio'), // 20
      makeZone('z_b', 'level_0' as AnyNodeId, RECT_5x4, 'Studio'), // 20
      makeZone('z_c', 'level_0' as AnyNodeId, RECT_5x4, 'Studio'), // 20
      makeZone('z_d', 'level_0' as AnyNodeId, RECT_5x3, '1BR'), // 15
    ])
    const r = computeSchedule(scene)
    expect(r.residential.totalUnits).toBe(4)
    expect(r.residential.byUnitType).toHaveLength(2)
    // Studio (3) before 1BR (1) — sorted by count desc.
    expect(r.residential.byUnitType[0]).toEqual({
      type: 'Studio',
      count: 3,
      totalArea: 60,
      avgArea: 20,
    })
    expect(r.residential.byUnitType[1]).toEqual({
      type: '1BR',
      count: 1,
      totalArea: 15,
      avgArea: 15,
    })
    expect(r.residential.avgUnitArea).toBe(75 / 4)
  })

  it('buckets zones with missing unitType as "(unknown)" and warns', () => {
    const scene = buildScene([
      makeLevel('level_0', 0, 'building_1' as AnyNodeId),
      makeSlab('slab_0', 'level_0' as AnyNodeId, SQUARE_10),
      makeZone('z_known', 'level_0' as AnyNodeId, RECT_5x4, '1BR'),
      makeZone('z_unknown', 'level_0' as AnyNodeId, RECT_5x3, null),
    ])
    const r = computeSchedule(scene)
    const types = r.residential.byUnitType.map((b) => b.type)
    expect(types).toContain('(unknown)')
    expect(r.warnings.some((w) => w.includes('z_unknown'))).toBe(true)
  })

  it('ignores untagged (user-drawn) nodes', () => {
    const scene = buildScene([
      // Untagged level + slab + zone — must be skipped.
      makeNode('level_user', 'level', 'building_1' as AnyNodeId, { level: 0 }),
      makeNode('slab_user', 'slab', 'level_user' as AnyNodeId, { polygon: SQUARE_10 }),
      makeNode('zone_user', 'zone', 'level_user' as AnyNodeId, {
        polygon: RECT_5x4,
        metadata: { bimai: { unitType: '1BR' } },
      }),
    ])
    const r = computeSchedule(scene)
    expect(r.floorCount).toBe(0)
    expect(r.totals.gea).toBe(0)
    expect(r.totals.nia).toBe(0)
    expect(r.residential.totalUnits).toBe(0)
  })

  it('restricts to descendants of buildingId when provided', () => {
    // Two buildings, each with one floor — buildingId should pick exactly one.
    const scene = buildScene([
      makeLevel('level_A', 0, 'building_A' as AnyNodeId),
      makeLevel('level_B', 0, 'building_B' as AnyNodeId),
      makeSlab('slab_A', 'level_A' as AnyNodeId, SQUARE_10),
      makeSlab('slab_B', 'level_B' as AnyNodeId, RECT_5x4),
      makeZone('z_A', 'level_A' as AnyNodeId, RECT_5x4, '1BR'),
      makeZone('z_B', 'level_B' as AnyNodeId, RECT_5x3, 'Studio'),
    ])
    const r = computeSchedule(scene, { buildingId: 'building_A' as AnyNodeId })
    expect(r.floorCount).toBe(1)
    expect(r.totals.gea).toBe(100)
    expect(r.totals.nia).toBe(20)
    expect(r.residential.byUnitType).toHaveLength(1)
    expect(r.residential.byUnitType[0]!.type).toBe('1BR')
  })

  it('warns when a level has no slab and reports its GEA as 0', () => {
    const scene = buildScene([
      makeLevel('level_naked', 0, 'building_1' as AnyNodeId),
      makeZone('z_x', 'level_naked' as AnyNodeId, RECT_5x4, '1BR'),
    ])
    const r = computeSchedule(scene)
    expect(r.byFloor).toHaveLength(1)
    expect(r.byFloor[0]!.gea).toBe(0)
    expect(r.warnings.some((w) => w.includes('no slab'))).toBe(true)
    // Efficiency falls back to 0 when GEA is 0 — must not be Infinity / NaN.
    expect(r.totals.efficiency).toBe(0)
  })

  it('drops orphan slabs / zones (parent level missing) with a warning', () => {
    const scene = buildScene([
      makeSlab('slab_orphan', 'level_missing' as AnyNodeId, SQUARE_10),
      makeZone('zone_orphan', 'level_missing' as AnyNodeId, RECT_5x4, '1BR'),
    ])
    const r = computeSchedule(scene)
    expect(r.totals.gea).toBe(0)
    expect(r.totals.nia).toBe(0)
    expect(r.warnings.some((w) => w.includes('slab_orphan'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('zone_orphan'))).toBe(true)
  })

  it('byFloor is sorted by level ascending regardless of insertion order', () => {
    const scene = buildScene([
      makeLevel('level_2', 2, 'building_1' as AnyNodeId),
      makeLevel('level_0', 0, 'building_1' as AnyNodeId),
      makeLevel('level_1', 1, 'building_1' as AnyNodeId),
      makeSlab('s0', 'level_0' as AnyNodeId, SQUARE_10),
      makeSlab('s1', 'level_1' as AnyNodeId, SQUARE_10),
      makeSlab('s2', 'level_2' as AnyNodeId, SQUARE_10),
    ])
    const r = computeSchedule(scene)
    expect(r.byFloor.map((f) => f.level)).toEqual([0, 1, 2])
  })

  it('efficiency in (0, 1) for realistic mid-rise input', () => {
    // 100 m² floor with 70 m² of zones — 0.7 efficiency, healthy mid-rise.
    const ZONE_70: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 7],
      [0, 7],
    ]
    const scene = buildScene([
      makeLevel('level_0', 0, 'building_1' as AnyNodeId),
      makeSlab('s0', 'level_0' as AnyNodeId, SQUARE_10),
      makeZone('z0', 'level_0' as AnyNodeId, ZONE_70, '1BR'),
    ])
    const r = computeSchedule(scene)
    expect(r.totals.efficiency).toBeCloseTo(0.7, 5)
  })
})
