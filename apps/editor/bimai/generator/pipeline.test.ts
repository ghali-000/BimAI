import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import type { Program, ZoningRules } from '../schemas'
import { applyPlanToScene, buildPlan, runGenerator } from './pipeline'
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

  it('emits a corridor_layout_failed failure when the footprint is too narrow', () => {
    // After the Phase 3-7 close-out (fixed strip depth + mode discriminator),
    // a footprint whose perpendicular usable width falls below MIN_STRIP_DEPTH_M
    // (4 m) fails at the corridor stage rather than at the packer. The test
    // previously asserted `program_exceeds_capacity` for the same fixture —
    // that path is now unreachable from a tiny footprint, because the corridor
    // refuses to place before the packer ever runs.
    //
    // Plot 4×4.5, all setbacks 0.5 ⇒ envelope 3×3.5, footprint inset 0.5 ⇒
    // 2×2.5 (area 5 m², above MIN_FOOTPRINT_AREA_M2=4). usable = 2 − 1.5 =
    // 0.5 < 4 ⇒ placeCorridor returns null.
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
    expect(r.reason).toBe('corridor_layout_failed')
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

  it('sweeps a pre-existing untagged Level 0 so no duplicate appears (Phase 3-6 Task 2)', () => {
    // Reproduction for the duplicate-Level-0 bug. Pascal's `loadScene`
    // creates an untagged `Level 0` under the building before the user
    // ever runs the optimizer; without the level-sweep, applyPlanToScene
    // only deletes tagged nodes, so the default Level 0 survives and the
    // tree shows two `Level 0` entries after a Load into Scene.
    const defaultLevel = makeNode('level_default_0', 'level', BUILDING_ID)
    const writer = createMemoryWriter({
      nodes: {
        [BUILDING_ID]: {
          ...(makeNode(BUILDING_ID, 'building', null) as unknown as Record<string, unknown>),
          children: ['level_default_0'],
        } as unknown as AnyNode,
        level_default_0: defaultLevel,
      },
    })
    const out = runGenerator(baseInput(), writer)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const after = writer.getSnapshot().nodes
    // Pascal's seed level is gone.
    expect(after.level_default_0 as unknown).toBeUndefined()
    // Exactly `out.plan.floorCount` level nodes remain under the building
    // — every one of them is a generated node from this run, none from
    // before.
    let levelCount = 0
    for (const n of Object.values(after)) {
      if (n.type !== 'level') continue
      expect(n.parentId).toBe(BUILDING_ID)
      expect(isGenerated(n, out.plan.generationId)).toBe(true)
      levelCount++
    }
    // Phase 3-8 Task 7: emit adds a synthetic "Roof" LevelNode at
    // `level: floorCount`, so the running count is `floorCount + 1`.
    expect(levelCount).toBe(out.plan.floorCount + 1)
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

// Phase 3-9 Task 5/6 — multi-stair-core for fire egress.
//
// End-plus-central strategy fires when the corridor exceeds the
// `FIRE_EGRESS_THRESHOLD_M` default (30 m). The 50×30 plot's corridor
// runs ~39 m along the long axis, which trips the threshold. A small
// 30×18 plot stays sub-threshold.
describe('runGenerator — multi-stair-core (Phase 3-9)', () => {
  function buildingStub(id: string) {
    return {
      ...(makeNode(id, 'building', null) as unknown as Record<string, unknown>),
      children: [],
    } as unknown as AnyNode
  }

  // Force a multi-floor build by demanding more units than fit on one
  // floor — otherwise demand-based floor count returns 1 and no stair
  // is needed regardless of corridor length.
  const PROGRAM_LARGE: Program = {
    unitMix: [
      { type: 'Studio', count: 4, targetArea: 35 },
      { type: '1BR', count: 6, targetArea: 55 },
      { type: '2BR', count: 4, targetArea: 80 },
    ],
    floorToFloorHeight: 3,
  }

  it('emits 2 stair cores end-to-end on a 50×30 plot (corridor > 30m)', () => {
    const writer = createMemoryWriter({
      nodes: { [BUILDING_ID]: buildingStub(BUILDING_ID) },
    })
    const out = runGenerator(baseInput({ program: PROGRAM_LARGE }), writer)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.plan.stairs).toHaveLength(2)
    expect(out.plan.stairs[0]!.id).toBe('stair_core_0')
    expect(out.plan.stairs[1]!.id).toBe('stair_core_1')
    // Both cores produce stair-shaft walls — cost classifier coverage.
    const stairShaftWalls = Object.values(writer.getSnapshot().nodes).filter(
      (n) => {
        const meta = n.metadata as { bimai?: { wallRole?: string } } | undefined
        return n.type === 'wall' && meta?.bimai?.wallRole === 'stair-shaft'
      },
    )
    // 4 walls per core per floor × 2 cores × N floors.
    expect(stairShaftWalls.length).toBeGreaterThan(0)
    expect(stairShaftWalls.length % 4).toBe(0)
    // Phase 3-8 follow-up edit-UX invariant carries through to both cores.
    const stairs = Object.values(writer.getSnapshot().nodes).filter(
      (n) => n.type === 'stair',
    ) as unknown as Array<{ id: string; parentId: string | null; fromLevelId: string | null }>
    expect(stairs).toHaveLength(2)
    for (const s of stairs) {
      expect(s.parentId).not.toBe(BUILDING_ID)
      expect(s.parentId).toBe(s.fromLevelId)
    }
  })

  it('regen produces byte-identical core ids and wall ids for both cores', () => {
    const writerA = createMemoryWriter({
      nodes: { [BUILDING_ID]: buildingStub(BUILDING_ID) },
    })
    const writerB = createMemoryWriter({
      nodes: { [BUILDING_ID]: buildingStub(BUILDING_ID) },
    })
    const a = runGenerator(baseInput({ program: PROGRAM_LARGE }), writerA)
    const b = runGenerator(baseInput({ program: PROGRAM_LARGE }), writerB)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    // Plan-level: stair core ids and enclosingWallIds match across regen.
    expect(a.plan.stairs.map((s) => s.id)).toEqual(b.plan.stairs.map((s) => s.id))
    for (let i = 0; i < a.plan.stairs.length; i++) {
      expect(a.plan.stairs[i]!.enclosingWallIds).toEqual(
        b.plan.stairs[i]!.enclosingWallIds,
      )
    }
  })

  it('emits 1 stair core on a 30×18 plot (corridor ≤ 30m)', () => {
    const writer = createMemoryWriter({
      nodes: { [BUILDING_ID]: buildingStub(BUILDING_ID) },
    })
    // 30×18 plot with default 5/3/4 setbacks → footprint ~20×11; corridor
    // along long axis runs ~20 m, well below the 30 m threshold.
    const out = runGenerator(
      baseInput({
        plotPolygon: [
          [0, 0],
          [30, 0],
          [30, 18],
          [0, 18],
        ],
        program: {
          unitMix: [
            { type: '1BR', count: 6, targetArea: 55 },
            { type: 'Studio', count: 4, targetArea: 35 },
          ],
          floorToFloorHeight: 3,
        },
      }),
      writer,
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.plan.stairs).toHaveLength(1)
    expect(out.plan.stairs[0]!.id).toBe('stair_core_0')
  })
})

// Phase 3-5 Task 11 — apply-only seam used by the optimizer's "Load
// into scene" button. We re-apply a plan produced by buildPlan
// (mimicking the worker's cached plan) and assert the same
// invariants runGenerator preserves: pause/resume balance, stale-
// generation cleanup, generated tagging, no touching of unrelated
// nodes.

describe('applyPlanToScene (apply-only)', () => {
  function buildingScene() {
    return createMemoryWriter({
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
  }

  it('applies a pre-baked plan and tags every emitted node', () => {
    const planResult = buildPlan(baseInput())
    if (!('plan' in planResult)) throw new Error('plan failed')
    const writer = buildingScene()
    const { opsApplied } = applyPlanToScene(planResult.plan, BUILDING_ID, writer)
    expect(opsApplied).toBeGreaterThan(0)
    let tagged = 0
    for (const n of Object.values(writer.getSnapshot().nodes)) {
      if (isGenerated(n, planResult.plan.generationId)) tagged++
    }
    expect(tagged).toBe(opsApplied)
    expect(writer.stats.pauseCalls).toBe(1)
    expect(writer.stats.resumeCalls).toBe(1)
  })

  it('sweeps stale generated nodes under the same building before re-emit', () => {
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
    const planResult = buildPlan(baseInput())
    if (!('plan' in planResult)) throw new Error('plan failed')
    applyPlanToScene(planResult.plan, BUILDING_ID, writer)
    const after = writer.getSnapshot().nodes
    expect(after.wall_old1 as unknown).toBeUndefined()
    expect(after.wall_user1 as unknown).toBeDefined()
  })

  it('resumes history even when the apply phase throws', () => {
    const writer = buildingScene()
    writer.createNodes = () => {
      throw new Error('boom')
    }
    const planResult = buildPlan(baseInput())
    if (!('plan' in planResult)) throw new Error('plan failed')
    expect(() => applyPlanToScene(planResult.plan, BUILDING_ID, writer)).toThrow(
      'boom',
    )
    expect(writer.stats.pauseCalls).toBe(1)
    expect(writer.stats.resumeCalls).toBe(1)
  })
})
