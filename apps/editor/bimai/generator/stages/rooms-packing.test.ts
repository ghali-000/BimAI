import { describe, expect, it } from 'vitest'
import type { UnitPlan } from '../types'
import {
  type BisectResult,
  applyBathroomClamp,
  bisectUnit,
  computeOrientedBoundingBox,
  sliceByFractions,
  transformRectToWorld,
} from './rooms-packing'
import { getUnitTemplate } from './rooms-templates'

function makeUnit(overrides: Partial<UnitPlan> = {}): UnitPlan {
  return {
    type: '2BR',
    polygon: [
      [0, 0],
      [11, 0],
      [11, 7.5],
      [0, 7.5],
    ],
    area: 82.5,
    // Corner-unit fixture: facade on both long edges so 2BR/3BR/4BR
    // private-strip bedrooms (which only touch one long edge each
    // after the across-subdivide) can satisfy bedroomNeedsFacade.
    facadeEdges: [0, 2],
    corridorEdges: [],
    rooms: [],
    ...overrides,
  }
}

function expectOk(r: BisectResult): asserts r is Extract<BisectResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok bisect, got: ${JSON.stringify(r)}`)
}

// ─────────────────────────────────────────────────────────────────────
// Geometry primitives
// ─────────────────────────────────────────────────────────────────────

describe('computeOrientedBoundingBox', () => {
  it('picks the longest CCW edge as +x', () => {
    const obb = computeOrientedBoundingBox([
      [0, 0],
      [11, 0],
      [11, 7.5],
      [0, 7.5],
    ])
    expect(obb.width).toBeCloseTo(11, 6)
    expect(obb.height).toBeCloseTo(7.5, 6)
    expect(obb.xAxis).toEqual([1, 0])
    expect(obb.yAxis).toEqual([0, 1])
    expect(obb.origin).toEqual([0, 0])
  })

  it('lex-min tiebreaker: same rectangle from a shifted starting vertex picks the same origin', () => {
    // Polygon A (origin at (0,0)) and B (CCW order starts at (11, 0))
    // describe the same physical rectangle. Both must produce the
    // same OBB origin (the lex-min of all candidate longest-edge
    // start vertices).
    const a = computeOrientedBoundingBox([
      [0, 0],
      [11, 0],
      [11, 7.5],
      [0, 7.5],
    ])
    const b = computeOrientedBoundingBox([
      [11, 0],
      [11, 7.5],
      [0, 7.5],
      [0, 0],
    ])
    expect(b.origin).toEqual(a.origin)
    expect(b.xAxis[0]).toBeCloseTo(a.xAxis[0], 6)
    expect(b.xAxis[1]).toBeCloseTo(a.xAxis[1], 6)
    expect(b.width).toBeCloseTo(a.width, 6)
    expect(b.height).toBeCloseTo(a.height, 6)
  })

  it('throws on non-quadrilateral polygons', () => {
    expect(() =>
      computeOrientedBoundingBox([
        [0, 0],
        [1, 0],
        [0.5, 1],
      ]),
    ).toThrow(/4-vertex/)
  })
})

describe('sliceByFractions', () => {
  it('along: splits width, preserves y/h', () => {
    const out = sliceByFractions(
      { x: 0, y: 0, w: 10, h: 5 },
      'along',
      [0.3, 0.7],
    )
    expect(out).toEqual([
      { x: 0, y: 0, w: 3, h: 5 },
      { x: 3, y: 0, w: 7, h: 5 },
    ])
  })

  it('across: splits height, preserves x/w', () => {
    const out = sliceByFractions(
      { x: 1, y: 2, w: 8, h: 10 },
      'across',
      [0.4, 0.6],
    )
    expect(out).toEqual([
      { x: 1, y: 2, w: 8, h: 4 },
      { x: 1, y: 6, w: 8, h: 6 },
    ])
  })
})

describe('transformRectToWorld', () => {
  it('round-trips through identity OBB', () => {
    const obb = computeOrientedBoundingBox([
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ])
    const poly = transformRectToWorld({ x: 2, y: 1, w: 3, h: 2 }, obb)
    expect(poly).toEqual([
      [2, 1],
      [5, 1],
      [5, 3],
      [2, 3],
    ])
  })

  it('rotates correctly through a non-axis-aligned OBB', () => {
    // Polygon CCW: (0,0) → (0,10) → (-5,10) → (-5,0). Long edges run
    // vertically; lex-min tiebreaker picks the longest edge whose
    // start vertex is (-5, 10) — i.e. edge 2 going (-5,10)→(-5,0).
    // So OBB origin = (-5, 10), xAxis = (0, -1), yAxis = (1, 0).
    const obb = computeOrientedBoundingBox([
      [0, 0],
      [0, 10],
      [-5, 10],
      [-5, 0],
    ])
    expect(obb.origin).toEqual([-5, 10])
    expect(obb.xAxis[0]).toBeCloseTo(0, 6)
    expect(obb.xAxis[1]).toBeCloseTo(-1, 6)
    expect(obb.yAxis[0]).toBeCloseTo(1, 6)
    expect(obb.yAxis[1]).toBeCloseTo(0, 6)
    // Local rect spanning the full OBB should land on the whole polygon.
    const poly = transformRectToWorld({ x: 0, y: 0, w: 10, h: 5 }, obb)
    expect(poly[0]![0]).toBeCloseTo(-5, 6)
    expect(poly[0]![1]).toBeCloseTo(10, 6)
    expect(poly[2]![0]).toBeCloseTo(0, 6)
    expect(poly[2]![1]).toBeCloseTo(0, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────
// bisectUnit — happy paths
// ─────────────────────────────────────────────────────────────────────

describe('bisectUnit (success cases)', () => {
  it('Studio: 2 rooms (bathroom + living)', () => {
    // 12 × 3.75 = 45 m² — Studio top of band. Bath strip is
    // 0.15 × 12 = 1.8 m wide × 3.75 m tall, clears the 1.5 m floor.
    // (At narrower aspect ratios like 8 × 5 the bath strip would be
    // 1.2 m, below the floor.)
    const r = bisectUnit(
      makeUnit({
        type: 'Studio',
        polygon: [
          [0, 0],
          [12, 0],
          [12, 3.75],
          [0, 3.75],
        ],
        area: 45,
        facadeEdges: [2],
      }),
      getUnitTemplate('Studio')!,
    )
    expectOk(r)
    expect(r.rooms.map((rm) => rm.kind).sort()).toEqual(['bathroom', 'living'])
  })

  it('reference 2BR (82.5 m², 11×7.5) produces 6 rooms with expected kinds and area sum', () => {
    const r = bisectUnit(makeUnit(), getUnitTemplate('2BR')!)
    expectOk(r)
    expect(r.rooms).toHaveLength(6)
    expect(r.rooms.map((rm) => rm.kind).sort()).toEqual([
      'bathroom',
      'bedroom',
      'bedroom',
      'hallway',
      'kitchen',
      'living',
    ])
    const sum = r.rooms.reduce((s, rm) => s + rm.area, 0)
    expect(sum).toBeCloseTo(82.5, 4)
  })

  it('windowAccess: every bedroom touches a facade-mapped OBB edge', () => {
    // Positive contract: a successful bisection must place every
    // bedroom against a facade (otherwise bedroomNeedsFacade would
    // have failed). For a 2BR corner unit (facade on both long edges)
    // both bedrooms in the across-subdivided private strip touch a
    // long edge.
    const r = bisectUnit(makeUnit(), getUnitTemplate('2BR')!)
    expectOk(r)
    for (const bed of r.rooms.filter((rm) => rm.kind === 'bedroom')) {
      expect(bed.windowAccess).toBe(true)
    }
  })

  it('windowAccess: returns false for a leaf that misses every facade edge', () => {
    // 12 × 3.75 Studio with facade on polygon edge 1 (the right short
    // edge of the rectangle = OBB right at x=12). Bath strip is
    // x∈[0, 1.8], touches OBB left (x=0) but not right. Living strip
    // x∈[1.8, 12] touches OBB right.
    const r = bisectUnit(
      makeUnit({
        type: 'Studio',
        polygon: [
          [0, 0],
          [12, 0],
          [12, 3.75],
          [0, 3.75],
        ],
        area: 45,
        facadeEdges: [1], // only the right short edge
      }),
      getUnitTemplate('Studio')!,
    )
    expectOk(r)
    const bath = r.rooms.find((rm) => rm.kind === 'bathroom')!
    const living = r.rooms.find((rm) => rm.kind === 'living')!
    expect(bath.windowAccess).toBe(false)
    expect(living.windowAccess).toBe(true)
  })

  it('populates walls (Task 5) and doors (Task 8) for every room', () => {
    const r = bisectUnit(makeUnit(), getUnitTemplate('2BR')!)
    expectOk(r)
    for (const rm of r.rooms) {
      // Every rectangular room contributes 4 boundary segments.
      expect(rm.walls).toHaveLength(4)
      // At least one boundary touches the unit envelope (isExterior=true)
      // and at least one is a shared interior partition (isExterior=false).
      // For a 6-room 2BR every leaf has at least one of each.
      expect(rm.walls.some((w) => w.isExterior)).toBe(true)
      expect(rm.walls.some((w) => !w.isExterior)).toBe(true)
    }
    // Single-owner door dedup (Task 8): doors live on the non-hallway
    // side only, so the hallway's `doors[]` is empty. At least one
    // non-hallway room shares a hallway-adjacent partition (the
    // bathroom, by the 2BR template) and owns its door. Rooms that
    // only share *partial* edges with the hallway (kitchen / living /
    // bedrooms in this template) get no door under the current
    // canonical-edge equality model — direct-graph circulation beyond
    // exact-edge adjacency is out of scope for Phase 3-7.
    const hallway = r.rooms.find((rm) => rm.kind === 'hallway')
    expect(hallway).toBeDefined()
    expect(hallway!.doors).toEqual([])
    const totalDoors = r.rooms.reduce((n, rm) => n + rm.doors.length, 0)
    expect(totalDoors).toBeGreaterThanOrEqual(1)
    for (const rm of r.rooms) {
      for (const d of rm.doors) {
        expect(d.from).toBe('hallway')
        expect(d.to).toBe(rm.kind)
        // Door wallId references one of this room's partition walls.
        expect(rm.walls.some((w) => w.id === d.wallId && !w.isExterior)).toBe(
          true,
        )
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// bisectUnit — failures
// ─────────────────────────────────────────────────────────────────────

describe('bisectUnit (failure cases)', () => {
  it('fails with rooms_too_small when a 1BR is packed into 4×12 (in band, but the hallway-strip bathroom is 1.44 m long)', () => {
    // 48 m² is inside the 1BR band [45, 70] so the area-band gate
    // does not fire; the hallway-strip width is 0.12 × 12 = 1.44 m,
    // below the 1.5 m floor — that's the failure we're documenting.
    const r = bisectUnit(
      makeUnit({
        type: '1BR',
        polygon: [
          [0, 0],
          [12, 0],
          [12, 4],
          [0, 4],
        ],
        area: 48,
        facadeEdges: [2],
      }),
      getUnitTemplate('1BR')!,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('rooms_too_small')
      expect(r.detail).toMatch(/minimum 1.5 m/)
    }
  })

  it('fails on non-rectangular polygons before walking the tree', () => {
    const r = bisectUnit(
      makeUnit({
        polygon: [
          [0, 0],
          [10, 0],
          [10, 5],
          [5, 7],
          [0, 5],
        ] as [number, number][],
      }),
      getUnitTemplate('2BR')!,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unit_not_rectangular')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Area-band gate (Phase 3-7 follow-up to Task 8)
// ─────────────────────────────────────────────────────────────────────

describe('bisectUnit area-band gate', () => {
  // The gate uses asymmetric tolerances: 0.85 × min on the small side,
  // 1.5 × max on the large side. Tests pin both sides of every band
  // and the boundary behaviour at the upper edge (1BR: 1.5 × 70 = 105).

  it('Studio at the nominal 40 m² passes the gate', () => {
    const r = bisectUnit(
      makeUnit({
        type: 'Studio',
        polygon: [
          [0, 0],
          [8, 0],
          [8, 5],
          [0, 5],
        ],
        area: 40,
        facadeEdges: [2],
      }),
      getUnitTemplate('Studio')!,
    )
    // Either ok (success) or a downstream failure; what we're asserting
    // is that the area-band gate did NOT fire.
    if (!r.ok) {
      expect(r.reason).not.toBe('unit_too_small_for_template')
      expect(r.reason).not.toBe('unit_too_large_for_template')
    }
  })

  it('Studio at 25 m² (below 0.85 × 30 = 25.5) fails with unit_too_small_for_template', () => {
    const r = bisectUnit(
      makeUnit({
        type: 'Studio',
        polygon: [
          [0, 0],
          [5, 0],
          [5, 5],
          [0, 5],
        ],
        area: 25,
        facadeEdges: [2],
      }),
      getUnitTemplate('Studio')!,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unit_too_small_for_template')
      expect(r.areaBand).toEqual({
        actualAreaM2: 25,
        bandMin: 30,
        bandMax: 50,
        nominalM2: 40,
      })
    }
  })

  it('1BR at 200 m² (above 1.5 × 70 = 105) fails with unit_too_large_for_template', () => {
    const r = bisectUnit(
      makeUnit({
        type: '1BR',
        polygon: [
          [0, 0],
          [20, 0],
          [20, 10],
          [0, 10],
        ],
        area: 200,
        facadeEdges: [2],
      }),
      getUnitTemplate('1BR')!,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unit_too_large_for_template')
      expect(r.areaBand?.actualAreaM2).toBe(200)
      expect(r.areaBand?.bandMax).toBe(70)
      expect(r.areaBand?.nominalM2).toBe(55)
    }
  })

  it('boundary: 1BR at exactly 105 m² passes the gate; at 105.1 fails', () => {
    // 1.5 × 70 = 105 exactly.
    const at = bisectUnit(
      makeUnit({
        type: '1BR',
        polygon: [
          [0, 0],
          [15, 0],
          [15, 7],
          [0, 7],
        ],
        area: 105,
        facadeEdges: [2],
      }),
      getUnitTemplate('1BR')!,
    )
    if (!at.ok) {
      expect(at.reason).not.toBe('unit_too_large_for_template')
    }

    const over = bisectUnit(
      makeUnit({
        type: '1BR',
        polygon: [
          [0, 0],
          [15, 0],
          [15, 7],
          [0, 7],
        ],
        area: 105.1,
        facadeEdges: [2],
      }),
      getUnitTemplate('1BR')!,
    )
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.reason).toBe('unit_too_large_for_template')
  })

  it('the gate fires before the dimension-floor walk (caller can fall back without seeing opaque "bathroom 0.96 m" failures)', () => {
    // 1BR at 32 m² in a 4×8 strip — same shape as the legacy
    // rooms_too_small fixture. With the gate in place this now reports
    // unit_too_small_for_template (32 < 0.85 × 45 = 38.25), giving the
    // panel a clean "wrong template for this area" message instead of
    // a deep dimension-floor detail.
    const r = bisectUnit(
      makeUnit({
        type: '1BR',
        polygon: [
          [0, 0],
          [8, 0],
          [8, 4],
          [0, 4],
        ],
        area: 32,
        facadeEdges: [2],
      }),
      getUnitTemplate('1BR')!,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unit_too_small_for_template')
      expect(r.areaBand?.actualAreaM2).toBe(32)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bathroom clamp
// ─────────────────────────────────────────────────────────────────────

describe('bathroom clamp (unit tests on applyBathroomClamp)', () => {
  // We unit-test the clamp logic directly because the integrated
  // 4BR-at-160 path documented in the brief produces an en-suite that
  // — once clamped to 8 m² — collapses to a strip narrower than the
  // 1.5 m floor, so full-bisection rejects it. The clamp logic itself
  // is correct; the dimension floor + clamp + en-suite-fraction
  // combo is mutually constraining at 4BR's upper band. See the
  // documented degenerate-case test below.

  const constraints = {
    bedroomNeedsFacade: true,
    bathroomMaxAreaM2: 8,
    minRoomDimensionM: 1.5,
  }

  it('caps an over-cap bathroom and pushes surplus to the next sibling', () => {
    // Strip area 73.6 m² (4BR private at 160 m²). Bathroom raw = 12% =
    // 8.832 m² → caps at 8.0, surplus 0.832 m² flows to index 2.
    const before = [
      { fraction: 0.24, kind: 'bedroom' as const },
      { fraction: 0.12, kind: 'bathroom' as const },
      { fraction: 0.22, kind: 'bedroom' as const },
      { fraction: 0.21, kind: 'bedroom' as const },
      { fraction: 0.21, kind: 'bedroom' as const },
    ]
    const after = applyBathroomClamp(before, 73.6, constraints)
    expect(after[1]!.fraction * 73.6).toBeCloseTo(8.0, 6)
    // Surplus = original 8.832 - 8.0 = 0.832 → 0.832/73.6 = 0.011304…
    expect(after[2]!.fraction).toBeCloseTo(0.22 + (0.832 / 73.6), 6)
    // Other siblings untouched.
    expect(after[0]!.fraction).toBe(0.24)
    expect(after[3]!.fraction).toBe(0.21)
    expect(after[4]!.fraction).toBe(0.21)
    // Sum still ≈ 1.0.
    const sum = after.reduce((s, x) => s + x.fraction, 0)
    expect(sum).toBeCloseTo(1.0, 6)
  })

  it('does not mutate the input slice array', () => {
    const before = [
      { fraction: 0.5, kind: 'bathroom' as const },
      { fraction: 0.5, kind: 'living' as const },
    ]
    const snapshot = JSON.parse(JSON.stringify(before))
    applyBathroomClamp(before, 30, constraints) // 0.5 * 30 = 15 → clamps
    expect(before).toEqual(snapshot)
  })

  it('does not clamp when bathroom area is already under the cap', () => {
    const before = [
      { fraction: 0.15, kind: 'bathroom' as const },
      { fraction: 0.85, kind: 'living' as const },
    ]
    const after = applyBathroomClamp(before, 40, constraints) // 0.15 * 40 = 6.0
    expect(after[0]!.fraction).toBe(0.15)
    expect(after[1]!.fraction).toBe(0.85)
  })

  it('no-ops when bathroom is the last sibling (template-authoring concern)', () => {
    // The brief's contract: a bathroom-as-last-sibling is an authoring
    // error; the runtime falls through unclamped rather than crashing.
    const before = [
      { fraction: 0.5, kind: 'living' as const },
      { fraction: 0.5, kind: 'bathroom' as const }, // last
    ]
    const after = applyBathroomClamp(before, 30, constraints) // bath would be 15 m²
    expect(after[0]!.fraction).toBe(0.5)
    expect(after[1]!.fraction).toBe(0.5)
  })
})

describe('bathroom clamp + dimension floor (integrated)', () => {
  it('full-bisection 4BR at 160 m² fails dimension floor (documented degenerate case)', () => {
    // Captures a real design tension between the brief's 4BR template
    // (en-suite at 12% of the private strip), the 8 m² bathroom cap,
    // and the 1.5 m dimension floor. After clamp, the en-suite rect
    // is `stripWidth × (8 / stripWidth)`. For min ≥ 1.5 we need
    // stripWidth ∈ [1.5, 5.33], i.e. unitLong ≤ 11.6 (since
    // stripWidth = 0.46·unitLong). But unitArea ≥ 145 m² for the
    // clamp to actually fire (private strip area > 8/0.12), and
    // unitLong ≥ √unitArea ≈ 12.04 m. The two ranges don't overlap —
    // so the clamp succeeds, the dimension floor rejects, and the
    // unit falls back to unit-shell. Logged here so a future template
    // re-balance can intentionally close the gap.
    const r = bisectUnit(
      makeUnit({
        type: '4BR',
        polygon: [
          [0, 0],
          [16, 0],
          [16, 10],
          [0, 10],
        ],
        area: 160,
        facadeEdges: [0, 1, 2, 3],
      }),
      getUnitTemplate('4BR')!,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('rooms_too_small')
  })
})

// ─────────────────────────────────────────────────────────────────────
// OBB rotation invariance
// ─────────────────────────────────────────────────────────────────────

describe('OBB rotation invariance', () => {
  it('same physical rectangle defined with shifted vertex order yields the same room set', () => {
    // Same 2BR rectangle, two CCW vertex orderings.
    // Note: facadeEdges is given as polygon-edge indices, so it must
    // shift along with the rotation.
    const A = bisectUnit(
      makeUnit({
        type: '2BR',
        polygon: [
          [0, 0],
          [11, 0],
          [11, 7.5],
          [0, 7.5],
        ],
        area: 82.5,
        facadeEdges: [0, 2], // both long edges (corner unit)
      }),
      getUnitTemplate('2BR')!,
    )
    const B = bisectUnit(
      makeUnit({
        type: '2BR',
        polygon: [
          [11, 0],
          [11, 7.5],
          [0, 7.5],
          [0, 0],
        ],
        area: 82.5,
        // Vertices rotated by one position. A's edge 0 (bottom) is
        // B's edge 3; A's edge 2 (top) is B's edge 1. So A's [0, 2]
        // is equivalent to B's [1, 3].
        facadeEdges: [1, 3],
      }),
      getUnitTemplate('2BR')!,
    )
    expectOk(A)
    expectOk(B)
    expect(A.rooms.length).toBe(B.rooms.length)
    // Same kinds, same area distribution.
    const sortedA = A.rooms.map((r) => `${r.kind}:${r.area.toFixed(3)}`).sort()
    const sortedB = B.rooms.map((r) => `${r.kind}:${r.area.toFixed(3)}`).sort()
    expect(sortedA).toEqual(sortedB)
  })
})
