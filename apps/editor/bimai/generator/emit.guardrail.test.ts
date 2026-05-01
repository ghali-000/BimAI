// Drift guardrail.
//
// Runs a realistic input through the full pipeline against the in-memory
// writer, then re-parses every emitted node with its Pascal schema. The
// boundary parse in `pascal-writer.ts` already does this in the browser —
// this spec is the test-time signal that catches drift between our emitter
// (`emit.ts`, raw `{...} as unknown as Foo` casts) and the canonical
// schemas before someone hits Generate and watches their camera freeze.
//
// Imports go through `@pascal-app/core/schema` (subpath) rather than the
// barrel — see `bimai/generator/emit.guardrail.md` and the upstream PR
// (BIMAI: upstreamed PR #NNN) for why this matters: the bare entry pulls
// renderer code that crashes vitest via three-mesh-bvh.

import {
  DoorNode,
  LevelNode,
  SlabNode,
  StairNode,
  StairSegmentNode,
  WallNode,
  WindowNode,
  ZoneNode,
} from '@pascal-app/core/schema'
import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import type { Program, ZoningRules } from '../schemas'
import { runGenerator } from './pipeline'
import { createMemoryWriter } from './scene-writer'
import type { GeneratorInput } from './types'

const SITE_ID = 'site_guardrail' as AnyNodeId
const BUILDING_ID = 'building_guardrail' as AnyNodeId

const SCHEMAS: Record<
  string,
  { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } } | undefined
> = {
  door: DoorNode,
  window: WindowNode,
  wall: WallNode,
  slab: SlabNode,
  zone: ZoneNode,
  level: LevelNode,
  stair: StairNode,
  'stair-segment': StairSegmentNode,
}

// Same shape the running app uses (4 Studio + 6 1BR + 4 2BR on 50×30,
// 5/3/4 setbacks, FtF 3). Hits doors, windows, walls, slabs, zones, and
// levels in one pass — every node type our emitter produces.
const ZONING: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}

const PROGRAM: Program = {
  unitMix: [
    { type: 'Studio', count: 4, targetArea: 35 },
    { type: '1BR', count: 6, targetArea: 55 },
    { type: '2BR', count: 4, targetArea: 80 },
  ],
  floorToFloorHeight: 3,
}

const PLOT_50x30: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 30],
  [0, 30],
]

function realisticInput(): GeneratorInput {
  return {
    siteId: SITE_ID,
    buildingId: BUILDING_ID,
    plotPolygon: PLOT_50x30,
    zoning: ZONING,
    program: PROGRAM,
  }
}

function buildingStub(): AnyNode {
  return {
    object: 'node',
    id: BUILDING_ID,
    type: 'building',
    parentId: null,
    visible: true,
    metadata: {},
    children: [] as string[],
  } as unknown as AnyNode
}

describe('emit drift guardrail', () => {
  it('every emitted node passes Pascal schema validation', () => {
    const writer = createMemoryWriter({
      nodes: { [BUILDING_ID]: buildingStub() },
    })
    const out = runGenerator(realisticInput(), writer)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    // Sanity-check: the input is non-trivial. If the pipeline ever stops
    // emitting one of these types we'd silently lose drift coverage for it.
    const types = new Set<string>()
    for (const n of Object.values(writer.getSnapshot().nodes)) {
      if (n.id !== BUILDING_ID) types.add(n.type)
    }
    expect(types).toEqual(
      new Set([
        'level',
        'slab',
        'wall',
        'zone',
        'door',
        'window',
        // Phase 3-8: realistic input is multi-floor → stair core + segments.
        'stair',
        'stair-segment',
      ]),
    )

    const failures: string[] = []
    for (const n of Object.values(writer.getSnapshot().nodes)) {
      if (n.id === BUILDING_ID) continue // seeded stub, not generator output
      const schema = SCHEMAS[n.type]
      if (!schema) continue
      const r = schema.safeParse(n)
      if (!r.success) {
        failures.push(
          `${n.type} ${String(n.id)}: ${JSON.stringify(r.error?.issues)}`,
        )
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
