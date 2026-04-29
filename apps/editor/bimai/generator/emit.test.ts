import type { AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import { calculatePolygonArea } from '../lib/geometry'
import { placeCorridor } from './stages/corridor'
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
