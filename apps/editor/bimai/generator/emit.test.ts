import type { AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import { calculatePolygonArea } from '../lib/geometry'
import { roomColor } from '../lib/unit-colors'
import { placeCorridor } from './stages/corridor'
import { attachRoomsToUnits } from './stages/rooms'
import { packUnits } from './stages/units'
import {
  DEFAULT_DOOR_HEIGHT_M,
  DEFAULT_DOOR_WIDTH_M,
  DEFAULT_SLAB_ELEVATION_M,
  DEFAULT_WALL_THICKNESS_M,
  DEFAULT_WINDOW_HEIGHT_M,
  DEFAULT_WINDOW_SILL_M,
  emitBuildingPlan,
} from './emit'
import { GENERATED_BY, isGenerated } from './tag'
import type { BuildingPlan, FloorPlan } from './types'
import { DEFAULT_PARAMS } from '../optimizer/params'

const BUILDING_ID = 'building_test001' as AnyNodeId
const GEN_ID = 'gen-emit-1'
const STRIP_DEPTH = 4.25

const OUTLINE_30x10: [number, number][] = [
  [0, 0],
  [30, 0],
  [30, 10],
  [0, 10],
]

function buildSingleFloorPlan(): BuildingPlan {
  const corridor = placeCorridor(OUTLINE_30x10)
  if (!corridor) throw new Error('test setup: corridor placement failed')
  const packed = packUnits({
    outline: OUTLINE_30x10,
    corridor,
    corridorWidth: 1.5,
    unitMix: [{ type: '2BR', count: 4, targetArea: STRIP_DEPTH * 10 }],
  })
  if (!packed) throw new Error('test setup: pack failed')
  const floor: FloorPlan = {
    level: 0,
    outline: OUTLINE_30x10,
    corridor,
    units: packed.units,
  }
  return {
    generationId: GEN_ID,
    footprint: OUTLINE_30x10,
    floorCount: 1,
    floorHeight: 3,
    floors: [floor],
    warnings: [],
    params: DEFAULT_PARAMS,
  }
}

describe('emitBuildingPlan', () => {
  it('emits one level node per floor parented to the building', () => {
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const levels = ops.filter((o) => o.node.type === 'level')
    expect(levels).toHaveLength(1)
    expect(levels[0]!.parentId).toBe(BUILDING_ID)
  })

  it('tags every emitted node with the generation marker', () => {
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    expect(ops.length).toBeGreaterThan(0)
    for (const op of ops) {
      expect(isGenerated(op.node, GEN_ID)).toBe(true)
    }
  })

  it('emits the level before any of its children', () => {
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const levelOp = ops.find((o) => o.node.type === 'level')!
    const levelIdx = ops.indexOf(levelOp)
    const childIdx = ops
      .map((o, i) => (o.parentId === levelOp.node.id ? i : -1))
      .filter((i) => i >= 0)
    for (const i of childIdx) expect(i).toBeGreaterThan(levelIdx)
  })

  it('emits walls before the door/window children that reference them', () => {
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    for (const op of ops) {
      if (op.node.type !== 'door' && op.node.type !== 'window') continue
      const wallIdx = ops.findIndex((x) => x.node.id === op.parentId)
      const opIdx = ops.indexOf(op)
      expect(wallIdx).toBeGreaterThan(-1)
      expect(wallIdx).toBeLessThan(opIdx)
    }
  })

  it('produces exactly one slab per floor with the floor outline', () => {
    const plan = buildSingleFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const slabs = ops.filter((o) => o.node.type === 'slab')
    expect(slabs).toHaveLength(1)
    const slab = slabs[0]!.node as unknown as {
      polygon: [number, number][]
      elevation: number
    }
    expect(calculatePolygonArea(slab.polygon)).toBeCloseTo(
      calculatePolygonArea(plan.floors[0]!.outline),
    )
    expect(slab.elevation).toBe(DEFAULT_SLAB_ELEVATION_M)
  })

  it('produces one zone per unit with name = unit type and bimai metadata', () => {
    const plan = buildSingleFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const zones = ops.filter((o) => o.node.type === 'zone')
    expect(zones).toHaveLength(plan.floors[0]!.units.length)
    for (const op of zones) {
      const node = op.node as unknown as {
        name: string
        metadata: { bimai: { unitType: string; generatedBy: string; targetArea: number } }
      }
      expect(node.name).toBe('2BR')
      expect(node.metadata.bimai.unitType).toBe('2BR')
      expect(node.metadata.bimai.generatedBy).toBe(GENERATED_BY)
      expect(node.metadata.bimai.targetArea).toBeGreaterThan(0)
    }
  })

  it('emits perimeter + corridor walls for a floor', () => {
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const walls = ops.filter((o) => o.node.type === 'wall')
    // 4 perimeter + 2 corridor + party walls (≥0). Always ≥6.
    expect(walls.length).toBeGreaterThanOrEqual(6)
    for (const op of walls) {
      const node = op.node as unknown as { thickness: number; height: number }
      expect(node.thickness).toBe(DEFAULT_WALL_THICKNESS_M)
      expect(node.height).toBe(3)
    }
  })

  it('emits party walls between adjacent units in the same strip', () => {
    // 3 units per strip, 2 strips → 2 internal cuts × 2 strips = 4 party walls
    // (or fewer if cuts coincide across strips, which they do for equal-width).
    const corridor = placeCorridor(OUTLINE_30x10)!
    const packed = packUnits({
      outline: OUTLINE_30x10,
      corridor,
      corridorWidth: 1.5,
      unitMix: [{ type: '2BR', count: 6, targetArea: STRIP_DEPTH * 10 }],
    })!
    const plan: BuildingPlan = {
      generationId: GEN_ID,
      footprint: OUTLINE_30x10,
      floorCount: 1,
      floorHeight: 3,
      floors: [
        {
          level: 0,
          outline: OUTLINE_30x10,
          corridor,
          units: packed.units,
        },
      ],
      warnings: [],
      params: DEFAULT_PARAMS,
    }
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const walls = ops.filter((o) => o.node.type === 'wall')
    // 4 perimeter + 2 corridor + at least 2 party (one per internal cut).
    expect(walls.length).toBeGreaterThanOrEqual(8)
  })

  it('emits one door per unit on the corridor side', () => {
    const plan = buildSingleFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const doors = ops.filter((o) => o.node.type === 'door')
    expect(doors).toHaveLength(plan.floors[0]!.units.length)
    for (const op of doors) {
      const node = op.node as unknown as {
        width: number
        height: number
        position: [number, number, number]
      }
      expect(node.width).toBe(DEFAULT_DOOR_WIDTH_M)
      expect(node.height).toBe(DEFAULT_DOOR_HEIGHT_M)
      expect(node.position[1]).toBeCloseTo(DEFAULT_DOOR_HEIGHT_M / 2)
    }
  })

  it('emits one window per unit on the facade side', () => {
    const plan = buildSingleFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const windows = ops.filter((o) => o.node.type === 'window')
    expect(windows).toHaveLength(plan.floors[0]!.units.length)
    for (const op of windows) {
      const node = op.node as unknown as {
        height: number
        position: [number, number, number]
      }
      expect(node.height).toBe(DEFAULT_WINDOW_HEIGHT_M)
      expect(node.position[1]).toBeCloseTo(
        DEFAULT_WINDOW_SILL_M + DEFAULT_WINDOW_HEIGHT_M / 2,
      )
    }
  })

  it('parents each opening to a wall that exists in the op list', () => {
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const wallIds = new Set<string>(
      ops.filter((o) => o.node.type === 'wall').map((o) => o.node.id as string),
    )
    for (const op of ops) {
      if (op.node.type !== 'door' && op.node.type !== 'window') continue
      expect(wallIds.has(op.parentId as unknown as string)).toBe(true)
    }
  })

  it('multiplies output by floorCount', () => {
    const single = buildSingleFloorPlan()
    const f0 = single.floors[0]!
    const multi: BuildingPlan = {
      ...single,
      floorCount: 3,
      floors: [
        { ...f0, level: 0 },
        { ...f0, level: 1 },
        { ...f0, level: 2 },
      ],
    }
    const ops = emitBuildingPlan(multi, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    expect(ops.filter((o) => o.node.type === 'level')).toHaveLength(3)
    expect(ops.filter((o) => o.node.type === 'slab')).toHaveLength(3)
  })

  it('returns a unique ID for every emitted node', () => {
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const ids = ops.map((o) => o.node.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('emits zero ops for a plan with no floors', () => {
    const plan: BuildingPlan = {
      generationId: GEN_ID,
      footprint: OUTLINE_30x10,
      floorCount: 0,
      floorHeight: 3,
      floors: [],
      warnings: [],
      params: DEFAULT_PARAMS,
    }
    expect(
      emitBuildingPlan(plan, { buildingId: BUILDING_ID, generationId: GEN_ID }),
    ).toEqual([])
  })

  // Regression: the IFC writer keys host-wall resolution off the
  // `wallId` field on door / window nodes (Pascal schema:
  // `door.ts:29`, `window.ts:16`). Earlier emit passes only set
  // `parentId`, leaving `wallId` undefined — which made the writer
  // fall back to the storey placement, producing a "diagonal
  // staircase" pattern in BIMcollab (doors and windows offset by the
  // wall's world position, embedded in the storey rather than the
  // wall, no opening cut). Assert the actual invariant: every emitted
  // door / window has `wallId` set, and that id points at a real
  // `wall`-typed op. We do *not* assert `wallId === parentId` —
  // they're allowed to legitimately decouple in the future, the
  // semantic property is "the wallId points at the host wall".
  it('emits doors and windows with a wallId that points at a real wall op', () => {
    const allOps = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    let openingCount = 0
    for (const op of allOps) {
      if (op.node.type !== 'door' && op.node.type !== 'window') continue
      openingCount++
      const wallId = (op.node as unknown as { wallId?: string }).wallId
      expect(wallId, `${op.node.type} ${op.node.id} has no wallId`).toBeDefined()
      const host = allOps.find((o) => o.node.id === wallId)
      expect(
        host?.node.type,
        `${op.node.type} ${op.node.id} wallId ${wallId} points at non-wall (${host?.node.type ?? 'missing'})`,
      ).toBe('wall')
    }
    // Sanity: the fixture must actually emit some openings; otherwise
    // the invariant above is vacuously satisfied.
    expect(openingCount).toBeGreaterThan(0)
  })

  it('clamps openings into wall bounds when the midpoint would put them past the end', () => {
    // Use a very long unit so the door midpoint sits well inside the corridor wall.
    const plan = buildSingleFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    for (const op of ops) {
      if (op.node.type !== 'door') continue
      const wall = ops.find((x) => x.node.id === op.parentId)!.node as unknown as {
        start: [number, number]
        end: [number, number]
      }
      const len = Math.hypot(
        wall.end[0] - wall.start[0],
        wall.end[1] - wall.start[1],
      )
      const x = (op.node as unknown as { position: [number, number, number] })
        .position[0]
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(len)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Phase 3-7 Task 6 — Room zone emission
// ─────────────────────────────────────────────────────────────────────

interface ZoneShape {
  id: string
  type: 'zone'
  name: string
  parentId: string | null
  polygon: [number, number][]
  color: string
  metadata?: { bimai?: Record<string, unknown> }
}

function buildRoomyFloorPlan(): BuildingPlan {
  // Same fixture as buildSingleFloorPlan, but the units are run through
  // attachRoomsToUnits so each one carries a populated `rooms` array.
  // packUnits's default 4×2BR-on-30×10 produces 4 corner-eligible 2BR
  // candidates; without the corner-tower facade fixture they fall back to
  // unit-shell, so rooms.length === 1 per unit. That's enough to exercise
  // the emitter in this test — for richer (multi-room) coverage we use
  // the synthetic fixture below.
  const corridor = placeCorridor(OUTLINE_30x10)
  if (!corridor) throw new Error('test setup: corridor placement failed')
  const packed = packUnits({
    outline: OUTLINE_30x10,
    corridor,
    corridorWidth: 1.5,
    unitMix: [{ type: '2BR', count: 4, targetArea: STRIP_DEPTH * 10 }],
  })
  if (!packed) throw new Error('test setup: pack failed')
  const { units } = attachRoomsToUnits(packed.units)
  const floor: FloorPlan = {
    level: 0,
    outline: OUTLINE_30x10,
    corridor,
    units,
  }
  return {
    generationId: GEN_ID,
    footprint: OUTLINE_30x10,
    floorCount: 1,
    floorHeight: 3,
    floors: [floor],
    warnings: [],
    params: DEFAULT_PARAMS,
  }
}

/** Synthetic single-floor plan with one fully-subdivided 2BR unit
 *  (corner-tower facade), guaranteeing 6 rooms for emitter coverage. */
function buildMultiRoomFloorPlan(): BuildingPlan {
  const polygon: [number, number][] = [
    [0, 0],
    [11, 0],
    [11, 7.5],
    [0, 7.5],
  ]
  const { units } = attachRoomsToUnits([
    {
      type: '2BR',
      polygon,
      area: 82.5,
      facadeEdges: [0, 2],
      corridorEdges: [],
      rooms: [],
    },
  ])
  const corridor = placeCorridor(OUTLINE_30x10)
  if (!corridor) throw new Error('test setup: corridor placement failed')
  const floor: FloorPlan = {
    level: 0,
    outline: OUTLINE_30x10,
    corridor,
    units,
  }
  return {
    generationId: GEN_ID,
    footprint: OUTLINE_30x10,
    floorCount: 1,
    floorHeight: 3,
    floors: [floor],
    warnings: [],
    params: DEFAULT_PARAMS,
  }
}

describe('emitBuildingPlan — room zones (Phase 3-7 Task 6)', () => {
  it('emits one ZoneNode per RoomPlan plus the unit zone (multi-room 2BR)', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const zones = ops
      .map((o) => o.node as unknown as ZoneShape)
      .filter((n) => n.type === 'zone')
    // 1 unit zone + 6 room zones (bedroom×2, bathroom, kitchen, living, hallway).
    expect(zones).toHaveLength(7)
  })

  it('marks every room zone with the correct roomKind / unitId / unitType', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const zones = ops
      .map((o) => o.node as unknown as ZoneShape)
      .filter((n) => n.type === 'zone')
    const unitZone = zones.find(
      (z) => (z.metadata?.bimai as { unitType?: string })?.unitType === '2BR' &&
        (z.metadata?.bimai as { roomKind?: string })?.roomKind === undefined,
    )!
    expect(unitZone).toBeDefined()
    const roomZones = zones.filter(
      (z) => (z.metadata?.bimai as { roomKind?: string })?.roomKind !== undefined,
    )
    expect(roomZones).toHaveLength(6)
    for (const z of roomZones) {
      const bimai = z.metadata!.bimai as {
        roomKind: string
        unitId: string
        unitType: string
        roomArea: number
        windowAccess: boolean
      }
      expect(bimai.unitId).toBe(unitZone.id)
      expect(bimai.unitType).toBe('2BR')
      expect(['bedroom', 'bathroom', 'kitchen', 'living', 'hallway']).toContain(
        bimai.roomKind,
      )
      expect(bimai.roomArea).toBeGreaterThan(0)
      expect(typeof bimai.windowAccess).toBe('boolean')
    }
  })

  it('paints every room zone with the documented roomColor for its kind', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const roomZones = ops
      .map((o) => o.node as unknown as ZoneShape)
      .filter(
        (n) =>
          n.type === 'zone' &&
          (n.metadata?.bimai as { roomKind?: string })?.roomKind !== undefined,
      )
    for (const z of roomZones) {
      const kind = (z.metadata!.bimai as { roomKind: string }).roomKind
      expect(z.color).toBe(roomColor(kind))
    }
  })

  it('parents every room zone to the level (sibling of the unit zone)', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const levelOp = ops.find((o) => o.node.type === 'level')!
    const roomZoneOps = ops.filter((o) => {
      const meta = o.node.metadata as { bimai?: { roomKind?: string } }
      return o.node.type === 'zone' && meta?.bimai?.roomKind !== undefined
    })
    expect(roomZoneOps.length).toBeGreaterThan(0)
    for (const op of roomZoneOps) {
      expect(op.parentId).toBe(levelOp.node.id)
    }
  })

  it('emits the unit zone before its room zones (parent-before-child order)', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const unitZoneIdx = ops.findIndex(
      (o) =>
        o.node.type === 'zone' &&
        (o.node.metadata as { bimai?: { roomKind?: string; unitType?: string } })
          ?.bimai?.roomKind === undefined,
    )
    const roomZoneIdxs = ops
      .map((o, i) => {
        const meta = o.node.metadata as { bimai?: { roomKind?: string } }
        return o.node.type === 'zone' && meta?.bimai?.roomKind !== undefined
          ? i
          : -1
      })
      .filter((i) => i >= 0)
    for (const i of roomZoneIdxs) expect(i).toBeGreaterThan(unitZoneIdx)
  })

  it('suppresses unit-shell room zones (unit zone alone covers the shell)', () => {
    // Unknown unit type → no template → unit-shell. The unit-shell room's
    // polygon equals the unit zone's polygon, so emitting a separate room
    // zone would double-count area in the schedule. The convention: unit
    // zone alone represents the shell; no room zone is emitted.
    const corridor = placeCorridor(OUTLINE_30x10)!
    const polygon: [number, number][] = [
      [0, 0],
      [5, 0],
      [5, 4],
      [0, 4],
    ]
    const { units } = attachRoomsToUnits([
      {
        type: 'made-up-type',
        polygon,
        area: 20,
        facadeEdges: [2],
        corridorEdges: [0],
        rooms: [],
      },
    ])
    const plan: BuildingPlan = {
      generationId: GEN_ID,
      footprint: OUTLINE_30x10,
      floorCount: 1,
      floorHeight: 3,
      floors: [
        { level: 0, outline: OUTLINE_30x10, corridor, units },
      ],
      warnings: [],
      params: DEFAULT_PARAMS,
    }
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const zones = ops.filter((o) => o.node.type === 'zone')
    const roomZones = zones.filter((o) => {
      const meta = o.node.metadata as { bimai?: { roomKind?: string } }
      return meta?.bimai?.roomKind !== undefined
    })
    // No room zones for unit-shell units.
    expect(roomZones).toHaveLength(0)
    // Unit zone alone is emitted for the shell.
    const unitZones = zones.filter((o) => {
      const meta = o.node.metadata as { bimai?: { unitType?: string; roomKind?: string } }
      return meta?.bimai?.unitType === 'made-up-type' && meta?.bimai?.roomKind === undefined
    })
    expect(unitZones).toHaveLength(1)
  })

  it('emits no extra zones for the pre-3-7 fixture (units without rooms)', () => {
    // Backward-compat smoke test: the original fixture has units with
    // rooms === [] (default UnitPlan shape). emitRoomZones should produce
    // 0 ops for those units; total zone count = unit zone count.
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const zones = ops.filter((o) => o.node.type === 'zone')
    const roomZones = zones.filter((o) => {
      const meta = o.node.metadata as { bimai?: { roomKind?: string } }
      return meta?.bimai?.roomKind !== undefined
    })
    expect(roomZones).toHaveLength(0)
  })

  it('uses the room polygon (not the unit polygon) for each room zone', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const unit = plan.floors[0]!.units[0]!
    const roomZones = ops
      .map((o) => o.node as unknown as ZoneShape)
      .filter(
        (n) =>
          n.type === 'zone' &&
          (n.metadata?.bimai as { roomKind?: string })?.roomKind !== undefined,
      )
    const totalZoneArea = roomZones.reduce(
      (s, z) => s + calculatePolygonArea(z.polygon),
      0,
    )
    // Room zones tile the unit; their polygon areas should sum to the unit area.
    expect(totalZoneArea).toBeCloseTo(unit.area, 3)
    // And every individual zone's polygon has 4 vertices (rectangular leaves).
    for (const z of roomZones) expect(z.polygon).toHaveLength(4)
  })

  it('attaches generationId / generatedBy via tagAsGenerated on every room zone', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const roomZoneOps = ops.filter((o) => {
      const meta = o.node.metadata as { bimai?: { roomKind?: string } }
      return o.node.type === 'zone' && meta?.bimai?.roomKind !== undefined
    })
    expect(roomZoneOps.length).toBeGreaterThan(0)
    for (const op of roomZoneOps) {
      expect(isGenerated(op.node, GEN_ID)).toBe(true)
    }
  })

  // Touch the helper so its signature stays stable when we extend it for
  // other tests (e.g. multi-floor plans in Task 10).
  void buildRoomyFloorPlan
})

// ─────────────────────────────────────────────────────────────────────
// Phase 3-7 Task 8 — room doors on partition walls
// ─────────────────────────────────────────────────────────────────────

interface DoorShape {
  type: 'door'
  id: string
  parentId: string | null
  wallId?: string
  position: [number, number, number]
  width: number
  metadata?: { bimai?: Record<string, unknown> }
}

interface WallShape {
  type: 'wall'
  id: string
  start: [number, number]
  end: [number, number]
  metadata?: { bimai?: { wallRole?: string } }
}

const EMIT_EPS = 1e-6

describe('emitBuildingPlan — room doors (Phase 3-7 Task 8)', () => {
  it('owners-only dedup: every internal door has from=hallway and lives on a partition wall', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const partitionWallIds = new Set(
      ops
        .map((o) => o.node as unknown as WallShape)
        .filter(
          (n) => n.type === 'wall' && n.metadata?.bimai?.wallRole === 'room-partition',
        )
        .map((n) => n.id),
    )
    const internalDoors = ops
      .map((o) => o.node as unknown as DoorShape)
      .filter(
        (n) =>
          n.type === 'door' &&
          (n.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind !==
            undefined,
      )
    expect(internalDoors.length).toBeGreaterThanOrEqual(1)
    for (const d of internalDoors) {
      const meta = d.metadata!.bimai as {
        fromRoomKind: string
        toRoomKind: string
      }
      expect(meta.fromRoomKind).toBe('hallway')
      expect(meta.toRoomKind).not.toBe('hallway')
      // Door is parented to a partition wall (not a perimeter / corridor wall).
      expect(partitionWallIds.has(d.parentId!)).toBe(true)
      expect(d.wallId).toBe(d.parentId)
    }
  })

  it('unit-shell unit emits zero internal doors but still emits the front door', () => {
    // The pre-3-7 single-floor fixture's units fall back to unit-shell —
    // no partitions, so no room doors. The front door at the corridor
    // edge midpoint is still emitted.
    const ops = emitBuildingPlan(buildSingleFloorPlan(), {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const doors = ops.map((o) => o.node as unknown as DoorShape).filter(
      (n) => n.type === 'door',
    )
    const internal = doors.filter(
      (d) =>
        (d.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind !==
        undefined,
    )
    const frontDoors = doors.filter(
      (d) =>
        (d.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind ===
        undefined,
    )
    expect(internal).toHaveLength(0)
    // 4 units in OUTLINE_30x10 / 2BR mix ⇒ 4 front doors.
    expect(frontDoors.length).toBeGreaterThanOrEqual(1)
  })

  it('door positions land on the host partition wall (within EPSILON)', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const wallById = new Map<string, WallShape>()
    for (const o of ops) {
      const n = o.node as unknown as WallShape
      if (n.type === 'wall') wallById.set(n.id, n)
    }
    const internalDoors = ops
      .map((o) => o.node as unknown as DoorShape)
      .filter(
        (n) =>
          n.type === 'door' &&
          (n.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind !==
            undefined,
      )
    expect(internalDoors.length).toBeGreaterThanOrEqual(1)
    for (const d of internalDoors) {
      const wall = wallById.get(d.parentId!)
      expect(wall).toBeDefined()
      const len = Math.hypot(
        wall!.end[0] - wall!.start[0],
        wall!.end[1] - wall!.start[1],
      )
      // Wall-local x is the door's first position component; must lie
      // strictly within [0, len] (the emitter's clamp guarantees this).
      const x = d.position[0]
      expect(x).toBeGreaterThanOrEqual(-EMIT_EPS)
      expect(x).toBeLessThanOrEqual(len + EMIT_EPS)
    }
  })

  it('door parentId equals the wall id and door wallId mirrors it', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const internalDoors = ops
      .map((o) => o.node as unknown as DoorShape)
      .filter(
        (n) =>
          n.type === 'door' &&
          (n.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind !==
            undefined,
      )
    expect(internalDoors.length).toBeGreaterThanOrEqual(1)
    for (const d of internalDoors) {
      // parentId and wallId both point at the host partition. The IFC
      // writer reads `wallId`; `parentId` is the scene-tree relationship.
      // They must agree — emit.ts sets both off the same WallNode.
      expect(d.wallId).toBe(d.parentId)
    }
  })

  it('regen with the same plan produces identical door ids (deterministic)', () => {
    const plan = buildMultiRoomFloorPlan()
    const a = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const b = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const doorIdsA = a
      .map((o) => o.node as unknown as DoorShape)
      .filter(
        (n) =>
          n.type === 'door' &&
          (n.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind !==
            undefined,
      )
      .map((d) => d.id)
      .sort()
    const doorIdsB = b
      .map((o) => o.node as unknown as DoorShape)
      .filter(
        (n) =>
          n.type === 'door' &&
          (n.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind !==
            undefined,
      )
      .map((d) => d.id)
      .sort()
    expect(doorIdsA.length).toBeGreaterThanOrEqual(1)
    expect(doorIdsA).toEqual(doorIdsB)
    // The deterministic id format is `door_<12hex>` — derived from the
    // partition wall hash slice, no `generateId('door')` randomness.
    for (const id of doorIdsA) {
      expect(id).toMatch(/^door_[0-9a-f]{12}$/)
    }
  })

  it('front door + internal doors coexist for a multi-room unit', () => {
    const plan = buildMultiRoomFloorPlan()
    const ops = emitBuildingPlan(plan, {
      buildingId: BUILDING_ID,
      generationId: GEN_ID,
    })
    const doors = ops.map((o) => o.node as unknown as DoorShape).filter(
      (n) => n.type === 'door',
    )
    const internal = doors.filter(
      (d) =>
        (d.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind !==
        undefined,
    )
    const frontDoors = doors.filter(
      (d) =>
        (d.metadata?.bimai as { fromRoomKind?: string })?.fromRoomKind ===
        undefined,
    )
    // The single 2BR unit gets exactly one front door (corridor edge).
    expect(frontDoors).toHaveLength(1)
    // …and at least one internal door (the bathroom; further hallway-
    // adjacent rooms depend on canonical-edge equality, see rooms-doors).
    expect(internal.length).toBeGreaterThanOrEqual(1)
    // All door widths use the default; emitter never resizes for doors.
    for (const d of doors) expect(d.width).toBeCloseTo(DEFAULT_DOOR_WIDTH_M, 9)
  })
})
