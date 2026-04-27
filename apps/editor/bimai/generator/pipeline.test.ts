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
    // Tiny plot + huge unit targetArea so packer rejects everything on every floor.
    const r = buildPlan(
      baseInput({
        plotPolygon: [
          [0, 0],
          [20, 0],
          [20, 18],
          [0, 18],
        ],
        zoning: {
          ...ZONING,
          setbacks: { front: 0.1, side: 0.1, rear: 0.1 },
        },
        program: {
          ...PROGRAM,
          unitMix: [{ type: 'mansion', count: 5, targetArea: 50000 }],
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
})
