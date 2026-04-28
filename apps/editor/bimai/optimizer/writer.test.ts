// Batch-evaluation tests. Confirms the optimizer writer factory
// produces fully-isolated writers per candidate — running the
// pipeline N times produces N independent buildings with no
// cross-contamination of nodes.

import type { AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import { runGenerator } from '../generator/pipeline'
import { isGenerated } from '../generator/tag'
import type { GeneratorInput } from '../generator/types'
import type { Program, ZoningRules } from '../schemas'
import { DEFAULT_PARAMS } from './params'
import { createOptimizerWriter } from './writer'

const SITE_ID = 'site_opt_test' as AnyNodeId
const BUILDING_ID = 'building_opt_test' as AnyNodeId

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

const PLOT_50x30: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 30],
  [0, 30],
]

function input(overrides: Partial<GeneratorInput> = {}): GeneratorInput {
  return {
    siteId: SITE_ID,
    buildingId: BUILDING_ID,
    plotPolygon: PLOT_50x30,
    zoning: ZONING,
    program: PROGRAM,
    ...overrides,
  }
}

describe('createOptimizerWriter', () => {
  it('seeds one building stub with a children array the pipeline can extend', () => {
    const writer = createOptimizerWriter({
      buildingId: BUILDING_ID,
      siteId: SITE_ID,
    })
    const snap = writer.getSnapshot()
    expect(snap.nodes[BUILDING_ID]).toBeDefined()
    expect((snap.nodes[BUILDING_ID] as unknown as { children: string[] }).children).toEqual([])
    expect(snap.nodes[SITE_ID]).toBeDefined()
  })

  it('omits the site node when no siteId is supplied', () => {
    const writer = createOptimizerWriter({ buildingId: BUILDING_ID })
    const snap = writer.getSnapshot()
    expect(snap.nodes[BUILDING_ID]).toBeDefined()
    expect(Object.keys(snap.nodes)).toHaveLength(1)
  })

  it('fresh writers are independent — mutating one does not affect another', () => {
    const a = createOptimizerWriter({ buildingId: BUILDING_ID })
    const b = createOptimizerWriter({ buildingId: BUILDING_ID })
    a.deleteNodes([BUILDING_ID])
    expect(a.getSnapshot().nodes[BUILDING_ID] as unknown).toBeUndefined()
    expect(b.getSnapshot().nodes[BUILDING_ID]).toBeDefined()
  })
})

describe('batch evaluation — pipeline isolation across candidates', () => {
  it('runs N candidates with different params; each writer holds one building', () => {
    // Three candidates, three different param overrides. Each candidate
    // evaluates inside its own writer; we collect generationIds and
    // node counts and assert no leakage across writers.
    const candidates = [
      { ...DEFAULT_PARAMS },
      { ...DEFAULT_PARAMS, packingStrategy: 'alternating' as const },
      { ...DEFAULT_PARAMS, floorCountStrategy: 'fill-far' as const },
    ]
    const results = candidates.map((params) => {
      const writer = createOptimizerWriter({
        buildingId: BUILDING_ID,
        siteId: SITE_ID,
      })
      const out = runGenerator(input({ params }), writer)
      if (!out.ok) throw new Error(`candidate failed: ${out.reason}`)
      return { writer, out }
    })

    // Distinct generationIds across candidates.
    const gens = new Set(results.map((r) => r.out.plan.generationId))
    expect(gens.size).toBe(3)

    // Each writer holds nodes tagged with its OWN generationId only.
    for (const { writer, out } of results) {
      const all = Object.values(writer.getSnapshot().nodes)
      const tagged = all.filter((n) => isGenerated(n))
      const own = tagged.filter((n) => isGenerated(n, out.plan.generationId))
      expect(own.length).toBe(tagged.length)
      expect(tagged.length).toBeGreaterThan(0)
    }
  })

  it('a fresh writer for the same params produces the same opsApplied count', () => {
    // Determinism check: same input + same writer-construction → same
    // emitted node count. (Generation IDs differ because pipeline mints
    // a new nanoid per call.)
    const a = createOptimizerWriter({ buildingId: BUILDING_ID })
    const b = createOptimizerWriter({ buildingId: BUILDING_ID })
    const ra = runGenerator(input(), a)
    const rb = runGenerator(input(), b)
    if (!ra.ok || !rb.ok) throw new Error('runs failed')
    expect(rb.opsApplied).toBe(ra.opsApplied)
  })

  it('history pause/resume counters confirm the candidate ran exactly once', () => {
    const writer = createOptimizerWriter({ buildingId: BUILDING_ID })
    const out = runGenerator(input(), writer)
    expect(out.ok).toBe(true)
    expect(writer.stats.pauseCalls).toBe(1)
    expect(writer.stats.resumeCalls).toBe(1)
  })

  it('failed candidates do not pollute the writer', () => {
    // Triangle plot with zero area → envelope_collapsed.
    const writer = createOptimizerWriter({ buildingId: BUILDING_ID })
    const out = runGenerator(
      input({ plotPolygon: [[0, 0], [10, 0], [20, 0]] }),
      writer,
    )
    expect(out.ok).toBe(false)
    // Building stub still present, but no generated children attached.
    const snap = writer.getSnapshot()
    expect(snap.nodes[BUILDING_ID]).toBeDefined()
    expect(writer.stats.createBatches).toBe(0)
    expect(writer.stats.deleteBatches).toBe(0)
    // No tagged generation nodes leaked in.
    const tagged = Object.values(snap.nodes).filter((n) => isGenerated(n))
    expect(tagged).toHaveLength(0)
  })
})
