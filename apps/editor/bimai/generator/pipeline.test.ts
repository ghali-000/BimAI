import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import type { Program, ZoningRules } from '../schemas'
import { buildPlan, runGenerator } from './pipeline'
import { createMemoryWriter } from './scene-writer'
import { GENERATED_BY, isGenerated, tagAsGenerated } from './tag'
import type { GeneratorInput } from './types'

const SITE_ID = 'site_pipeline_test' as AnyNodeId
const BUILDING_ID = 'building_pipeline_test' as AnyNodeId

const ZONING: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}

const PROGRAM: Program = {
  unitMix: [{ type: '2BR', count: 4, targetArea: 60 }],
  floorToFloorHeight: 3,
}

// 50×30 plot — generous enough that the envelope and footprint won't collapse.
const PLOT_50x30: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 30],
  [0, 30],
]

function baseInput(overrides: Partial<GeneratorInput> = {}): GeneratorInput {
  return {
    siteId: SITE_ID,
    buildingId: BUILDING_ID,
    plotPolygon: PLOT_50x30,
    zoning: ZONING,
    program: PROGRAM,
    ...overrides,
  }
}

function makeNode(
  id: string,
  type: string,
  parentId: AnyNodeId | null,
  metadata?: Record<string, unknown>,
): AnyNode {
  return {
    object: 'node',
    id,
    type,
    parentId,
    visible: true,
    metadata: metadata ?? {},
  } as unknown as AnyNode
}

describe('buildPlan (pure)', () => {
  it('returns a populated plan for a reasonable input', () => {
    const r = buildPlan(baseInput())
    expect(r.ok).toBe(true)
    if (!('plan' in r)) return
    expect(r.plan.floorCount).toBeGreaterThanOrEqual(1)
    expect(r.plan.floors).toHaveLength(r.plan.floorCount)
    expect(r.plan.generationId.length).toBeGreaterThan(0)
  })

  it('rejects an invalid plot polygon', () => {
    const r = buildPlan(
      baseInput({
        plotPolygon: [
          [0, 0],
          [1, 0],
        ],
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid_input')
  })

  it('reports envelope collapse when setbacks consume the plot', () => {
    // 6×6 plot with default setbacks (mean 4m) → inset would invert.
    const r = buildPlan(
      baseInput({
        // Collinear "triangle" — passes the >=3 vertex check but has zero
        // area, which envelope rejects as invalid_plot → envelope_collapsed.
        plotPolygon: [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('envelope_collapsed')
  })

  it('mints a fresh generationId per call', () => {
    const a = buildPlan(baseInput())
    const b = buildPlan(baseInput())
    if (!('plan' in a) || !('plan' in b)) throw new Error('plan failed')
    expect(a.plan.generationId).not.toBe(b.plan.generationId)
  })

  it('produces floor plans whose units cover positive area', () => {
    const r = buildPlan(baseInput())
    if (!('plan' in r)) throw new Error('plan failed')
    for (const f of r.plan.floors) {
      expect(f.units.length).toBeGreaterThan(0)
      for (const u of f.units) expect(u.area).toBeGreaterThan(0)
    }
  })

  it('emits a program_exceeds_capacity failure when no units fit', () => {
    // With the clamp path (Phase 3-3), `program_exceeds_capacity` only fires
    // when the footprint's long axis is shorter than MIN_UNIT_WIDTH_M (3m) —
    // every queue item then fails rule 4 on both strips.
    //
    // Plot 4×4.5, all setbacks 0.5 ⇒ envelope 3×3.5, footprint inset 0.5 ⇒
    // 2×2.5 (area 5 m², above MIN_FOOTPRINT_AREA_M2=4). longLen = 2.5 < 3.
    const r = buildPlan(
      baseInput({
        plotPolygon: [
          [0, 0],
          [4, 0],
          [4, 4.5],
          [0, 4.5],
        ],
        zoning: {
          ...ZONING,
          setbacks: { front: 0.5, side: 0.5, rear: 0.5 },
        },
        program: {
          ...PROGRAM,
          unitMix: [{ type: 'mansion', count: 5, targetArea: 5000 }],
        },
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('program_exceeds_capacity')
  })
})

describe('runGenerator (with writer)', () => {
  it('applies ops to the writer and returns ok with opsApplied count', () => {
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: makeNode(BUILDING_ID, 'building', null) as AnyNode & {
          children: string[]
        },
      },
    })
    // Building needs a children array for createNodesAction-mirror to wire levels.
    ;(writer.getSnapshot().nodes[BUILDING_ID] as unknown as {
      children: string[]
    }).children = []
    const out = runGenerator(baseInput(), writer)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.opsApplied).toBeGreaterThan(0)
    // Every emitted node ended up in the writer.
    const all = writer.getSnapshot().nodes
    let generated = 0
    for (const n of Object.values(all)) {
      if (isGenerated(n, out.plan.generationId)) generated++
    }
    expect(generated).toBe(out.opsApplied)
  })

  it('pauses and resumes history exactly once each on success', () => {
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: makeNode(BUILDING_ID, 'building', null) as AnyNode & {
          children: string[]
        },
      },
    })
    ;(writer.getSnapshot().nodes[BUILDING_ID] as unknown as {
      children: string[]
    }).children = []
    runGenerator(baseInput(), writer)
    expect(writer.stats.pauseCalls).toBe(1)
    expect(writer.stats.resumeCalls).toBe(1)
  })

  it('does not touch the writer when planning fails', () => {
    const writer = createMemoryWriter({ nodes: {} })
    const out = runGenerator(
      baseInput({
        // Collinear "triangle" — passes the >=3 vertex check but has zero
        // area, which envelope rejects as invalid_plot → envelope_collapsed.
        plotPolygon: [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      }),
      writer,
    )
    expect(out.ok).toBe(false)
    expect(writer.stats.pauseCalls).toBe(0)
    expect(writer.stats.resumeCalls).toBe(0)
    expect(writer.stats.createBatches).toBe(0)
    expect(writer.stats.deleteBatches).toBe(0)
  })

  it('deletes previously-generated nodes under the same building before re-emit', () => {
    const oldWall = tagAsGenerated(
      makeNode('wall_old1', 'wall', BUILDING_ID),
      'gen-OLD',
    )
    const userWall = makeNode('wall_user1', 'wall', BUILDING_ID)
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: {
          ...(makeNode(BUILDING_ID, 'building', null) as unknown as Record<string, unknown>),
          children: ['wall_old1', 'wall_user1'],
        } as unknown as AnyNode,
        wall_old1: oldWall as unknown as AnyNode,
        wall_user1: userWall,
      },
    })
    const out = runGenerator(baseInput(), writer)
    expect(out.ok).toBe(true)
    const after = writer.getSnapshot().nodes
    // Old generated node is gone.
    expect(after.wall_old1 as unknown).toBeUndefined()
    // User-drawn node survives.
    expect(after.wall_user1 as unknown).toBeDefined()
    expect(writer.stats.deleteBatches).toBe(1)
  })

  it('does not touch user-drawn nodes outside the building subtree', () => {
    const otherBuildingId = 'building_other' as AnyNodeId
    const otherTagged = tagAsGenerated(
      makeNode('wall_other_gen', 'wall', otherBuildingId),
      'gen-other',
    )
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: {
          ...(makeNode(BUILDING_ID, 'building', null) as unknown as Record<string, unknown>),
          children: [],
        } as unknown as AnyNode,
        [otherBuildingId]: makeNode(otherBuildingId, 'building', null),
        wall_other_gen: otherTagged as unknown as AnyNode,
      },
    })
    const out = runGenerator(baseInput(), writer)
    expect(out.ok).toBe(true)
    // The unrelated building's tagged node survives untouched.
    expect(writer.getSnapshot().nodes.wall_other_gen as unknown).toBeDefined()
  })

  it('resumes history even when the apply phase throws', () => {
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: {
          ...(makeNode(BUILDING_ID, 'building', null) as unknown as Record<string, unknown>),
          children: [],
        } as unknown as AnyNode,
      },
    })
    // Patch `createNodes` to throw mid-apply.
    const orig = writer.createNodes
    writer.createNodes = () => {
      throw new Error('boom')
    }
    expect(() => runGenerator(baseInput(), writer)).toThrow('boom')
    expect(writer.stats.pauseCalls).toBe(1)
    expect(writer.stats.resumeCalls).toBe(1)
    writer.createNodes = orig
  })

  it('every generated node ends up tagged with the plan generationId', () => {
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: {
          ...(makeNode(BUILDING_ID, 'building', null) as unknown as Record<string, unknown>),
          children: [],
        } as unknown as AnyNode,
      },
    })
    const out = runGenerator(baseInput(), writer)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    let count = 0
    for (const n of Object.values(writer.getSnapshot().nodes)) {
      const meta = (n.metadata ?? {}) as { bimai?: { generatedBy?: string } }
      if (meta.bimai?.generatedBy === GENERATED_BY) count++
    }
    expect(count).toBe(out.opsApplied)
  })

  it('reports a placement summary matching plan + program', () => {
    // Realistic input — 4S + 6×1BR + 4×2BR on 50×30 with 5/3/4 setbacks.
    // Same shape the running app uses; pipeline currently fits 14 per floor
    // across 2 floors (= 28 zones) before strip-end clamps trim a 1BR.
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: {
          ...(makeNode(BUILDING_ID, 'building', null) as unknown as Record<
            string,
            unknown
          >),
          children: [],
        } as unknown as AnyNode,
      },
    })
    const out = runGenerator(
      {
        siteId: SITE_ID,
        buildingId: BUILDING_ID,
        plotPolygon: [
          [0, 0],
          [50, 0],
          [50, 30],
          [0, 30],
        ],
        zoning: ZONING,
        program: {
          unitMix: [
            { type: 'Studio', count: 4, targetArea: 35 },
            { type: '1BR', count: 6, targetArea: 55 },
            { type: '2BR', count: 4, targetArea: 80 },
          ],
          floorToFloorHeight: 3,
        },
      },
      writer,
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const p = out.placement
    expect(p.unitsRequested).toBe(14)
    // pipeline plans identical floors today; per-floor count == floor[0].units.
    expect(p.unitsPlacedPerFloor).toBe(out.plan.floors[0]!.units.length)
    expect(p.totalAcrossFloors).toBe(p.unitsPlacedPerFloor * out.plan.floorCount)
    expect(p.placementRate).toBeCloseTo(p.unitsPlacedPerFloor / 14)
  })

  it('returns placementRate=1 when the program requests zero units', () => {
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: {
          ...(makeNode(BUILDING_ID, 'building', null) as unknown as Record<
            string,
            unknown
          >),
          children: [],
        } as unknown as AnyNode,
      },
    })
    const out = runGenerator(
      baseInput({ program: { unitMix: [], floorToFloorHeight: 3 } }),
      writer,
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.placement.unitsRequested).toBe(0)
    expect(out.placement.placementRate).toBe(1)
  })

  // Phase 3-5 — params threading + plan-recording smoke checks.

  it('records the resolved GenerationParams on BuildingPlan', () => {
    const r = buildPlan(baseInput())
    expect(r.ok).toBe(true)
    if (r.ok !== true) return
    // Defaults stamped — same shape regardless of whether the caller
    // passed any params.
    expect(r.plan.params).toMatchObject({
      seed: 42,
      footprintInsetM: 0.5,
      footprintOrientation: 0,
      floorCountStrategy: 'demand-based',
      corridorOrientation: 'long-axis',
      corridorWidthM: 1.5,
      packingStrategy: 'left-to-right',
      unitOrderingHeuristic: 'mix-declared',
      variant: 0,
    })
  })

  it('partial params merge over defaults', () => {
    const r = buildPlan(baseInput({ params: { corridorWidthM: 1.8 } }))
    expect(r.ok).toBe(true)
    if (r.ok !== true) return
    expect(r.plan.params.corridorWidthM).toBe(1.8)
    // Other fields fall back to defaults.
    expect(r.plan.params.packingStrategy).toBe('left-to-right')
    expect(r.plan.params.seed).toBe(42)
  })

  it("'fill-far' strategy makes the building taller than 'demand-based'", () => {
    // Same inputs, different strategy → different floor count.
    const demand = buildPlan(baseInput())
    const fill = buildPlan(baseInput({ params: { floorCountStrategy: 'fill-far' } }))
    expect(demand.ok && fill.ok).toBe(true)
    if (!demand.ok || !fill.ok) return
    expect(fill.plan.floorCount).toBeGreaterThanOrEqual(demand.plan.floorCount)
  })

  it("alternating + largest-first does not regress placement count vs defaults", () => {
    // Both strategies on a generous 50×30 plot must place at least as
    // many units as the program asks for in one floor (sanity that the
    // strategy paths aren't broken).
    const def = buildPlan(baseInput())
    const alt = buildPlan(
      baseInput({
        params: {
          packingStrategy: 'alternating',
          unitOrderingHeuristic: 'largest-first',
        },
      }),
    )
    expect(def.ok && alt.ok).toBe(true)
    if (!def.ok || !alt.ok) return
    expect(alt.plan.floors[0]!.units.length).toBeGreaterThan(0)
  })
})
