import { describe, expect, it } from 'vitest'
import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { BIMAI_MATERIALS } from '../bim/materials'
import type { ComponentBIM } from '../bim/schemas/component-bim'
import { tagAsGenerated } from '../generator/tag'
import { computeCost } from './compute'
import { DEFAULT_TYPOLOGY } from './typology'

// ── Test-only node builders ─────────────────────────────────────────────────
//
// Same convention as schedule/compute.test.ts: cast minimal shapes; never
// run through Pascal's Zod schemas under vitest.

function makeNode(
  id: string,
  type: string,
  parentId: AnyNodeId | null,
  extra: Record<string, unknown> = {},
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

function withBIM(node: AnyNode, bim: Partial<ComponentBIM>): AnyNode {
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const bimai = (meta.bimai ?? {}) as Record<string, unknown>
  return {
    ...node,
    metadata: { ...meta, bimai: { ...bimai, bim } },
  } as unknown as AnyNode
}

function tagGen(node: AnyNode): AnyNode {
  return tagAsGenerated(node, 'gen-A')
}

function buildScene(nodes: AnyNode[]) {
  const dict: Record<AnyNodeId, AnyNode> = {}
  for (const n of nodes) dict[n.id] = n
  return { nodes: dict }
}

// ── Catalog shorthands ──────────────────────────────────────────────────────
const BRICK = BIMAI_MATERIALS['brick-exterior']
const DRYWALL = BIMAI_MATERIALS['drywall-residential']
const SLAB_RES = BIMAI_MATERIALS['concrete-slab-residential']
const DOOR = BIMAI_MATERIALS['door-residential']
const WINDOW = BIMAI_MATERIALS['window-double-glazed']

// ── Geometry shorthands ─────────────────────────────────────────────────────
const SQUARE_10: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
]

// One-floor synthetic scene: 100 m² slab, two walls (one exterior 10×3,
// one interior 10×3), one door, one window, one zone with unitType.
function oneFloorScene() {
  const lvl = tagGen(
    makeNode('level_0', 'level', 'building_1' as AnyNodeId, { level: 0 }),
  )
  const slab = tagGen(
    withBIM(
      makeNode('slab_0', 'slab', 'level_0' as AnyNodeId, { polygon: SQUARE_10 }),
      { material: SLAB_RES.id, fireRating: 'A1', loadBearing: true },
    ),
  )
  const wallExt = tagGen(
    withBIM(
      makeNode('wall_ext', 'wall', 'level_0' as AnyNodeId, {
        start: [0, 0],
        end: [10, 0],
        height: 3,
      }),
      { material: BRICK.id, fireRating: 'A1', loadBearing: true },
    ),
  )
  const wallInt = tagGen(
    withBIM(
      makeNode('wall_int', 'wall', 'level_0' as AnyNodeId, {
        start: [0, 5],
        end: [10, 5],
        height: 3,
      }),
      { material: DRYWALL.id, fireRating: 'A2', loadBearing: false },
    ),
  )
  const door = tagGen(
    withBIM(
      makeNode('door_0', 'door', 'wall_int' as AnyNodeId),
      { material: DOOR.id, fireRating: 'unrated', loadBearing: false },
    ),
  )
  const win = tagGen(
    withBIM(
      makeNode('win_0', 'window', 'wall_ext' as AnyNodeId),
      { material: WINDOW.id, fireRating: 'unrated', loadBearing: false },
    ),
  )
  const zone = tagAsGenerated(
    makeNode('zone_0', 'zone', 'level_0' as AnyNodeId, {
      polygon: SQUARE_10,
      metadata: { bimai: { unitType: '1BR' } },
    }),
    'gen-A',
  )
  return buildScene([lvl, slab, wallExt, wallInt, door, win, zone])
}

// ── Hand-arithmetic expectations (matches oneFloorScene) ────────────────────
const EXP_WALL_EXT = 10 * 3 * BRICK.costPerM2! // 30 m² × €220 = €6,600
const EXP_WALL_INT = 10 * 3 * DRYWALL.costPerM2! // 30 m² × €65 = €1,950
const EXP_SLAB = 100 * SLAB_RES.costPerM2! // 100 m² × €215 = €21,500
const EXP_DOOR = DOOR.costPerUnit! // €380
const EXP_WINDOW = WINDOW.costPerUnit! // €520
const EXP_PER_COMPONENT_TOTAL =
  EXP_WALL_EXT + EXP_WALL_INT + EXP_SLAB + EXP_DOOR + EXP_WINDOW
const EXP_GEA = 100 // m²

describe('computeCost — per-component sum matches hand arithmetic', () => {
  it('sums each bucket exactly', () => {
    const r = computeCost(oneFloorScene())
    expect(r.perComponent.walls.exterior).toBeCloseTo(EXP_WALL_EXT, 5)
    // Interior drywall wall is non-loadBearing → interior bucket.
    expect(r.perComponent.walls.interior).toBeCloseTo(EXP_WALL_INT, 5)
    expect(r.perComponent.walls.loadBearing).toBe(0)
    expect(r.perComponent.slabs).toBeCloseTo(EXP_SLAB, 5)
    expect(r.perComponent.openings.doors).toBeCloseTo(EXP_DOOR, 5)
    expect(r.perComponent.openings.windows).toBeCloseTo(EXP_WINDOW, 5)
    expect(r.perComponentTotal).toBeCloseTo(EXP_PER_COMPONENT_TOTAL, 5)
  })

  it('classifies a non-exterior load-bearing wall into the loadBearing bucket', () => {
    // Replace the interior drywall wall with concrete-cast (load-bearing,
    // not in EXTERIOR_WALL_MATERIALS) and verify the bucketing flips.
    const lvl = tagGen(
      makeNode('level_0', 'level', 'building_1' as AnyNodeId, { level: 0 }),
    )
    const wall = tagGen(
      withBIM(
        makeNode('wall_lb', 'wall', 'level_0' as AnyNodeId, {
          start: [0, 0],
          end: [10, 0],
          height: 3,
        }),
        {
          material: BIMAI_MATERIALS['concrete-cast'].id,
          fireRating: 'A1',
          loadBearing: true,
        },
      ),
    )
    const r = computeCost(buildScene([lvl, wall]))
    expect(r.perComponent.walls.loadBearing).toBeGreaterThan(0)
    expect(r.perComponent.walls.exterior).toBe(0)
    expect(r.perComponent.walls.interior).toBe(0)
  })
})

describe('computeCost — typology categories', () => {
  it('applies catalog defaults: mep / finishes / generalConditions / contingency', () => {
    const r = computeCost(oneFloorScene())
    expect(r.typology.mep).toBeCloseTo(DEFAULT_TYPOLOGY.mep * EXP_GEA, 5)
    expect(r.typology.finishes).toBeCloseTo(DEFAULT_TYPOLOGY.finishes * EXP_GEA, 5)
    expect(r.typology.generalConditions).toBeCloseTo(
      DEFAULT_TYPOLOGY.generalConditions * EXP_GEA,
      5,
    )
    const subtotal =
      EXP_PER_COMPONENT_TOTAL +
      DEFAULT_TYPOLOGY.mep * EXP_GEA +
      DEFAULT_TYPOLOGY.finishes * EXP_GEA +
      DEFAULT_TYPOLOGY.generalConditions * EXP_GEA
    expect(r.typology.contingency).toBeCloseTo(
      DEFAULT_TYPOLOGY.contingencyPct * subtotal,
      5,
    )
  })

  it('soft costs = softCostsPct × hardCost', () => {
    const r = computeCost(oneFloorScene())
    expect(r.softCosts).toBeCloseTo(DEFAULT_TYPOLOGY.softCostsPct * r.hardCost, 5)
    expect(r.totalProjectCost).toBeCloseTo(r.hardCost + r.softCosts, 5)
  })

  it('overriding only typology.mep moves only the MEP line', () => {
    const baseline = computeCost(oneFloorScene())
    const bumped = computeCost(oneFloorScene(), {
      typologyOverride: { mep: 300 }, // up from default 210
    })
    expect(bumped.typology.mep).toBeCloseTo(300 * EXP_GEA, 5)
    // Other typology lines unchanged.
    expect(bumped.typology.finishes).toBeCloseTo(baseline.typology.finishes, 5)
    expect(bumped.typology.generalConditions).toBeCloseTo(
      baseline.typology.generalConditions,
      5,
    )
    // Contingency depends on the (perComp + mep + finishes + GC) subtotal,
    // so it does shift — that's the model. Sanity: it shifts by exactly
    // contingencyPct × (delta in MEP).
    const expectedContingencyDelta =
      DEFAULT_TYPOLOGY.contingencyPct * (300 - DEFAULT_TYPOLOGY.mep) * EXP_GEA
    expect(bumped.typology.contingency - baseline.typology.contingency).toBeCloseTo(
      expectedContingencyDelta,
      5,
    )
  })

  it('overriding contingencyPct affects contingency only (not MEP / finishes / GC)', () => {
    const baseline = computeCost(oneFloorScene())
    const bumped = computeCost(oneFloorScene(), {
      typologyOverride: { contingencyPct: 0.15 },
    })
    expect(bumped.typology.mep).toBeCloseTo(baseline.typology.mep, 5)
    expect(bumped.typology.finishes).toBeCloseTo(baseline.typology.finishes, 5)
    expect(bumped.typology.contingency).toBeGreaterThan(baseline.typology.contingency)
  })
})

describe('computeCost — costOverride on individual components', () => {
  it('overriding one wall.perM2 moves total by exactly area × delta', () => {
    const base = computeCost(oneFloorScene())

    // Build a scene identical except wall_ext gets perM2 = 500 (was 220).
    const lvl = tagGen(
      makeNode('level_0', 'level', 'building_1' as AnyNodeId, { level: 0 }),
    )
    const slab = tagGen(
      withBIM(
        makeNode('slab_0', 'slab', 'level_0' as AnyNodeId, { polygon: SQUARE_10 }),
        { material: SLAB_RES.id, fireRating: 'A1', loadBearing: true },
      ),
    )
    const wallExt = tagGen(
      withBIM(
        makeNode('wall_ext', 'wall', 'level_0' as AnyNodeId, {
          start: [0, 0],
          end: [10, 0],
          height: 3,
        }),
        {
          material: BRICK.id,
          fireRating: 'A1',
          loadBearing: true,
          costOverride: { perM2: 500 },
        },
      ),
    )
    const wallInt = tagGen(
      withBIM(
        makeNode('wall_int', 'wall', 'level_0' as AnyNodeId, {
          start: [0, 5],
          end: [10, 5],
          height: 3,
        }),
        { material: DRYWALL.id, fireRating: 'A2', loadBearing: false },
      ),
    )
    const door = tagGen(
      withBIM(makeNode('door_0', 'door', 'wall_int' as AnyNodeId), {
        material: DOOR.id,
      }),
    )
    const win = tagGen(
      withBIM(makeNode('win_0', 'window', 'wall_ext' as AnyNodeId), {
        material: WINDOW.id,
      }),
    )
    const zone = tagAsGenerated(
      makeNode('zone_0', 'zone', 'level_0' as AnyNodeId, {
        polygon: SQUARE_10,
        metadata: { bimai: { unitType: '1BR' } },
      }),
      'gen-A',
    )

    const overridden = computeCost(
      buildScene([lvl, slab, wallExt, wallInt, door, win, zone]),
    )
    const wallArea = 10 * 3
    const expectedDelta = wallArea * (500 - BRICK.costPerM2!)
    expect(
      overridden.perComponent.walls.exterior - base.perComponent.walls.exterior,
    ).toBeCloseTo(expectedDelta, 5)
    expect(overridden.perComponentTotal - base.perComponentTotal).toBeCloseTo(
      expectedDelta,
      5,
    )
  })

  it('explicit-zero override means free, not "fall back to catalog"', () => {
    // Pin the schema-level distinction at the cost layer too.
    const lvl = tagGen(
      makeNode('level_0', 'level', 'building_1' as AnyNodeId, { level: 0 }),
    )
    const wall = tagGen(
      withBIM(
        makeNode('wall_free', 'wall', 'level_0' as AnyNodeId, {
          start: [0, 0],
          end: [10, 0],
          height: 3,
        }),
        {
          material: BRICK.id,
          loadBearing: true,
          costOverride: { perM2: 0 },
        },
      ),
    )
    const r = computeCost(buildScene([lvl, wall]))
    expect(r.perComponent.walls.exterior).toBe(0)
    expect(r.perComponentTotal).toBe(0)
  })

  it('flat override on a door overrides catalog costPerUnit', () => {
    const wall = tagGen(
      makeNode('wall_anchor', 'wall', null, {
        start: [0, 0],
        end: [10, 0],
        height: 3,
      }),
    )
    const door = tagGen(
      withBIM(makeNode('door_lux', 'door', 'wall_anchor' as AnyNodeId), {
        material: DOOR.id,
        costOverride: { flat: 1000 },
      }),
    )
    const r = computeCost(buildScene([wall, door]))
    expect(r.perComponent.openings.doors).toBe(1000)
  })
})

describe('computeCost — empty / degenerate inputs', () => {
  it('empty scene: every number is 0, no NaN, no Infinity', () => {
    const r = computeCost({ nodes: {} })
    expect(r.perComponentTotal).toBe(0)
    expect(r.typology.mep).toBe(0)
    expect(r.typology.contingency).toBe(0)
    expect(r.typologyTotal).toBe(0)
    expect(r.hardCost).toBe(0)
    expect(r.softCosts).toBe(0)
    expect(r.totalProjectCost).toBe(0)
    expect(r.perM2OfGEA).toBe(0)
    expect(r.perUnit).toBe(0)
    for (const v of [
      r.perComponentTotal,
      r.typology.mep,
      r.typologyTotal,
      r.hardCost,
      r.softCosts,
      r.totalProjectCost,
      r.perM2OfGEA,
      r.perUnit,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('zero-length wall is skipped with a warning, not priced as €0×nothing', () => {
    const lvl = tagGen(
      makeNode('level_0', 'level', 'building_1' as AnyNodeId, { level: 0 }),
    )
    const degenerate = tagGen(
      withBIM(
        makeNode('wall_zero', 'wall', 'level_0' as AnyNodeId, {
          start: [3, 4],
          end: [3, 4],
          height: 3,
        }),
        { material: BRICK.id, loadBearing: true },
      ),
    )
    const r = computeCost(buildScene([lvl, degenerate]))
    expect(r.perComponent.walls.exterior).toBe(0)
    expect(r.warnings.some((w) => w.includes('wall_zero'))).toBe(true)
  })

  it('wall without material falls back to €0 and warns', () => {
    const lvl = tagGen(
      makeNode('level_0', 'level', 'building_1' as AnyNodeId, { level: 0 }),
    )
    const wall = tagGen(
      makeNode('wall_no_mat', 'wall', 'level_0' as AnyNodeId, {
        start: [0, 0],
        end: [10, 0],
        height: 3,
      }),
    )
    const r = computeCost(buildScene([lvl, wall]))
    expect(r.perComponentTotal).toBe(0)
    expect(r.warnings.some((w) => w.includes('wall_no_mat'))).toBe(true)
  })
})

describe('computeCost — building scoping', () => {
  it('restricts to descendants of buildingId', () => {
    const a = oneFloorScene().nodes
    // Add a second level with a slab under a different building. Different
    // ids to avoid collision.
    const lvlB = tagGen(
      makeNode('level_B', 'level', 'building_B' as AnyNodeId, { level: 0 }),
    )
    const slabB = tagGen(
      withBIM(
        makeNode('slab_B', 'slab', 'level_B' as AnyNodeId, { polygon: SQUARE_10 }),
        { material: SLAB_RES.id, fireRating: 'A1', loadBearing: true },
      ),
    )
    const merged: Record<AnyNodeId, AnyNode> = {
      ...a,
      [lvlB.id]: lvlB,
      [slabB.id]: slabB,
    }
    const r = computeCost(
      { nodes: merged },
      { buildingId: 'building_1' as AnyNodeId },
    )
    // building_1 has just one slab (the original one), not two.
    expect(r.perComponent.slabs).toBeCloseTo(EXP_SLAB, 5)
  })
})

describe('computeCost — ratios', () => {
  it('perM2OfGEA = totalProjectCost / GEA, perUnit = totalProjectCost / unitCount', () => {
    const r = computeCost(oneFloorScene())
    expect(r.perM2OfGEA).toBeCloseTo(r.totalProjectCost / EXP_GEA, 5)
    expect(r.perUnit).toBeCloseTo(r.totalProjectCost / 1, 5)
  })
})
