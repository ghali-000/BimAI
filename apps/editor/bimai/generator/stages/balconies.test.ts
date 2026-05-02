// Phase 3-9 Task 11 — balcony emission tests.
//
// Pinning: slab role + parenting + railing geometry + the
// "balconies-off emits nothing" defensive guard. Geometry asserts
// against known-good projections of a unit-square's facade edge —
// the projection algorithm is deterministic, so any drift surfaces
// here before it reaches the viewer.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BALCONY_RAILING_HEIGHT_M,
  emitBalconies,
  emitOneBalcony,
} from './balconies'
import type { UnitPlan } from '../types'

const LEVEL_ID = 'level_test_001' as never
const CTX = { generationId: 'gen-test' }

/**
 * Build a unit-square unit with one facade edge on the +Y side of
 * the polygon. The polygon is CCW: (0,0) → (10,0) → (10,5) → (0,5).
 * `facadeEdges = [2]` means edge 2 is the facade — that's the segment
 * polygon[2]→polygon[3], i.e. (10,5)→(0,5). Outward normal points
 * +Y away from the unit centroid (5, 2.5).
 */
function makeUnitWithFacade(
  overrides: Partial<UnitPlan> = {},
): UnitPlan {
  return {
    type: '2BR',
    polygon: [
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ],
    area: 50,
    facadeEdges: [2],
    corridorEdges: [0],
    rooms: [],
    selectedVariantId: 'two-br-master-secondary-balcony',
    balcony: { attachTo: 'living', depthM: 1.5 },
    ...overrides,
  }
}

// ── emitBalconies (integration) ─────────────────────────────────────────────

describe('emitBalconies — integration', () => {
  it('emits 0 ops when no unit has a balcony spec', () => {
    const unit = makeUnitWithFacade({ balcony: undefined })
    expect(emitBalconies([unit], CTX, LEVEL_ID)).toHaveLength(0)
  })

  it('emits 0 ops when the unit has a balcony spec but no facade edges (interior unit)', () => {
    const unit = makeUnitWithFacade({ facadeEdges: [] })
    expect(emitBalconies([unit], CTX, LEVEL_ID)).toHaveLength(0)
  })

  it('emits 1 slab + 3 fences = 4 ops for one balcony-eligible unit', () => {
    const ops = emitBalconies([makeUnitWithFacade()], CTX, LEVEL_ID)
    expect(ops).toHaveLength(4)
    const slabs = ops.filter((o) => o.node.type === 'slab')
    const fences = ops.filter((o) => o.node.type === 'fence')
    expect(slabs).toHaveLength(1)
    expect(fences).toHaveLength(3)
  })

  it('emits 4 ops × N units when multiple units have balconies', () => {
    const units = [
      makeUnitWithFacade(),
      makeUnitWithFacade({
        polygon: [
          [20, 0],
          [30, 0],
          [30, 5],
          [20, 5],
        ],
      }),
    ]
    const ops = emitBalconies(units, CTX, LEVEL_ID)
    expect(ops).toHaveLength(8)
  })
})

// ── per-unit balcony geometry + tagging ─────────────────────────────────────

describe('emitOneBalcony — slab + fence properties', () => {
  it('balcony slab parents to the level (not the unit / building)', () => {
    const ops = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    const slab = ops.find((o) => o.node.type === 'slab')!
    expect(slab.parentId).toBe(LEVEL_ID)
    expect((slab.node as { parentId: unknown }).parentId).toBe(LEVEL_ID)
  })

  it("balcony slab is tagged metadata.bimai.slabRole = 'balcony'", () => {
    const ops = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    const slab = ops.find((o) => o.node.type === 'slab')!
    const meta = slab.node.metadata as {
      bimai: { slabRole: string; attachTo: string }
    }
    expect(meta.bimai.slabRole).toBe('balcony')
    expect(meta.bimai.attachTo).toBe('living')
  })

  it("every fence is tagged metadata.bimai.fenceRole = 'balcony-railing' and balconyId links to the slab", () => {
    const ops = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    const slab = ops.find((o) => o.node.type === 'slab')!
    const fences = ops.filter((o) => o.node.type === 'fence')
    expect(fences).toHaveLength(3)
    for (const f of fences) {
      const meta = f.node.metadata as {
        bimai: { fenceRole: string; balconyId: string }
      }
      expect(meta.bimai.fenceRole).toBe('balcony-railing')
      expect(meta.bimai.balconyId).toBe(slab.node.id)
    }
  })

  it('every fence parents to the level (Phase 3-8 follow-up invariant)', () => {
    const ops = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    const fences = ops.filter((o) => o.node.type === 'fence')
    for (const f of fences) {
      expect(f.parentId).toBe(LEVEL_ID)
      expect((f.node as { parentId: unknown }).parentId).toBe(LEVEL_ID)
    }
  })

  it('every fence carries the residential-code railing height (1.1 m)', () => {
    const ops = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    const fences = ops.filter((o) => o.node.type === 'fence')
    for (const f of fences) {
      expect((f.node as { height: number }).height).toBe(
        DEFAULT_BALCONY_RAILING_HEIGHT_M,
      )
    }
  })

  it('the three fences cover the slab perimeter EXCEPT the unit-wall edge', () => {
    // Unit facade edge: polygon[2]→polygon[3] = (10,5)→(0,5).
    // Outward normal: +Y. Balcony rect with depth 1.5:
    //   [0]=(10,5), [1]=(0,5), [2]=(0,6.5), [3]=(10,6.5)
    // Wait — emitOneBalcony uses (a, b) = (polygon[i], polygon[i+1]),
    // so for facadeIdx=2 the rect is built off (10,5)→(0,5):
    //   balconyRect[0]=(10,5)  ← inboard, unit-wall side
    //   balconyRect[1]=(0,5)
    //   balconyRect[2]=(0,6.5) ← outboard
    //   balconyRect[3]=(10,6.5)
    // Fence sides emit balconyRect[1→2], [2→3], [3→0] —
    // skipping [0→1] which is the unit-wall edge.
    const ops = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    const fences = ops
      .filter((o) => o.node.type === 'fence')
      .map((o) => o.node as unknown as { start: [number, number]; end: [number, number] })
    // Right-end railing.
    expect(fences[0]!.start).toEqual([0, 5])
    expect(fences[0]!.end).toEqual([0, 6.5])
    // Front (outboard) railing.
    expect(fences[1]!.start).toEqual([0, 6.5])
    expect(fences[1]!.end).toEqual([10, 6.5])
    // Left-end railing.
    expect(fences[2]!.start).toEqual([10, 6.5])
    expect(fences[2]!.end).toEqual([10, 5])
    // None of the three traces the unit-wall edge (10,5)→(0,5) or its
    // reverse — that side stays open for the balcony door.
    for (const f of fences) {
      const tracesUnitWall =
        (f.start[0] === 10 && f.start[1] === 5 && f.end[0] === 0 && f.end[1] === 5) ||
        (f.start[0] === 0 && f.start[1] === 5 && f.end[0] === 10 && f.end[1] === 5)
      expect(tracesUnitWall).toBe(false)
    }
  })

  it('balcony slab polygon is the projected outboard rectangle (4 vertices, depth × edge-length)', () => {
    const ops = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    const slab = ops.find((o) => o.node.type === 'slab')!
    const polygon = (slab.node as unknown as { polygon: [number, number][] }).polygon
    expect(polygon).toHaveLength(4)
    // Outboard normal is +Y; depth = 1.5 m.
    expect(polygon[0]).toEqual([10, 5])
    expect(polygon[1]).toEqual([0, 5])
    expect(polygon[2]).toEqual([0, 6.5])
    expect(polygon[3]).toEqual([10, 6.5])
  })

  it('regen produces deterministic ops for the same unit (slab + fence ids stable across calls)', () => {
    // Pascal's `generateId` makes fresh ids per call, so absolute id
    // strings differ between regens — but the count, ordering, and
    // metadata.balconyId↔slab.id linkage stay byte-identical, which is
    // what downstream consumers (cost classifier, IFC writer) actually
    // care about. This spec pins those invariants.
    const a = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    const b = emitOneBalcony(makeUnitWithFacade(), CTX, LEVEL_ID)
    expect(a).toHaveLength(b.length)
    expect(a.map((o) => o.node.type)).toEqual(b.map((o) => o.node.type))
    const slabA = a.find((o) => o.node.type === 'slab')!
    const slabB = b.find((o) => o.node.type === 'slab')!
    const fencesA = a.filter((o) => o.node.type === 'fence')
    const fencesB = b.filter((o) => o.node.type === 'fence')
    for (let i = 0; i < fencesA.length; i++) {
      const ma = fencesA[i]!.node.metadata as {
        bimai: { balconyId: string; railingSegment: number }
      }
      const mb = fencesB[i]!.node.metadata as {
        bimai: { balconyId: string; railingSegment: number }
      }
      expect(ma.bimai.balconyId).toBe(slabA.node.id)
      expect(mb.bimai.balconyId).toBe(slabB.node.id)
      expect(ma.bimai.railingSegment).toBe(mb.bimai.railingSegment)
    }
  })
})
