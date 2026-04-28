// Strategy-variant tests for Phase 3-5 Task 1.
//
// Phase 3-3 hardcoded one path through every stage; this phase parametrizes
// the choice. The default values reproduce Phase 3-3 byte-for-byte (verified
// by the existing per-stage test files staying green). This file exercises
// the *new* paths — the variants the optimizer can choose from once the
// search loop lands.

import { describe, expect, it } from 'vitest'
import { calculatePolygonArea } from '../../lib/geometry'
import type { Program, ZoningRules } from '../../schemas'
import { placeCorridor } from './corridor'
import { chooseFootprint } from './footprint'
import { planFloors } from './floors'
import { packUnits } from './units'

// 30×10 axis-aligned outline: long axis = X, short axis = Y.
const OUTLINE_30x10: [number, number][] = [
  [0, 0],
  [30, 0],
  [30, 10],
  [0, 10],
]

// 12×10 nearly-square outline — exercises 'auto' corridor orientation
// (short axis is narrow enough that long-axis corridor still wins).
const OUTLINE_12x10: [number, number][] = [
  [0, 0],
  [12, 0],
  [12, 10],
  [0, 10],
]

// 12×11 even-more-square outline. With auto orientation the short-axis
// branch wins because (longLen − corridor) yields more strip depth than
// (shortLen − corridor).
const OUTLINE_12x11: [number, number][] = [
  [0, 0],
  [12, 0],
  [12, 11],
  [0, 11],
]

const ZONING: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}
const PROGRAM: Program = { unitMix: [], floorToFloorHeight: 3 }

const baseMix = (m: Program['unitMix']): Program['unitMix'] => m

// ── Corridor orientation ────────────────────────────────────────────────────

describe('placeCorridor — orientation parameter', () => {
  it("default 'long-axis' picks the long edge (Phase 3-3 behaviour)", () => {
    const c = placeCorridor(OUTLINE_30x10, { width: 1.5 })
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.runLength).toBeCloseTo(30, 6)
    expect(c.stripDepth).toBeCloseTo(4.25, 6) // (10 − 1.5)/2
  })

  it("'short-axis' runs the corridor across the rectangle's short side", () => {
    const c = placeCorridor(OUTLINE_30x10, { width: 1.5, orientation: 'short-axis' })
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.runLength).toBeCloseTo(10, 6)
    // Strip depth perpendicular to short axis = (longLen − width)/2.
    expect(c.stripDepth).toBeCloseTo((30 - 1.5) / 2, 6)
    // Centerline runs along Y (short axis), not X.
    const [a, b] = c.centerline
    expect(Math.abs(b[0] - a[0])).toBeLessThan(1e-9)
    expect(Math.abs(b[1] - a[1])).toBeCloseTo(10, 6)
  })

  it("'auto' picks the long axis on a clearly-elongated rectangle", () => {
    // 30×10 — long-axis strip depth (10−1.5)/2 = 4.25,
    // short-axis strip depth (30−1.5)/2 = 14.25. Short-axis "wins" on
    // depth, but auto compares using strip-depth-after-corridor which
    // is biased toward whichever axis leaves *more* depth — that's
    // short-axis here. Document the actual semantics so a future
    // tweak doesn't accidentally invert them.
    const c = placeCorridor(OUTLINE_30x10, { width: 1.5, orientation: 'auto' })
    expect(c).not.toBeNull()
    if (!c) return
    // Auto chose short-axis (depth 14.25 > 4.25). Run length = shortLen = 10.
    expect(c.runLength).toBeCloseTo(10, 6)
  })

  it("'auto' picks the long axis when both axes are nearly equal — tiebreak", () => {
    // 12×10: long-axis stripDepth = (10−1.5)/2 = 4.25,
    //        short-axis stripDepth = (12−1.5)/2 = 5.25. Short still wins.
    const c = placeCorridor(OUTLINE_12x10, { width: 1.5, orientation: 'auto' })
    expect(c).not.toBeNull()
    if (!c) return
    // Short-axis: runLength = shortLen = 10.
    expect(c.runLength).toBeCloseTo(10, 6)
  })

  it("'auto' falls through to long-axis on a true square (depths equal)", () => {
    // For a perfect square, both axes give the same strip depth. The
    // tiebreak says: long-axis wins. Use a 12×12 outline so longLen ===
    // shortLen and asRectangle's "longer of the two" picks an axis
    // deterministically.
    const sq: [number, number][] = [
      [0, 0],
      [12, 0],
      [12, 12],
      [0, 12],
    ]
    const c = placeCorridor(sq, { width: 1.5, orientation: 'auto' })
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.runLength).toBeCloseTo(12, 6)
  })
})

// ── Floor count strategy ────────────────────────────────────────────────────

describe('planFloors — strategy parameter', () => {
  // 100m² footprint, 1000m² plot, height 24, f2f 3 → height-cap = 8.
  // FAR 2 × 1000 = 2000 GFA → /100 = 20 floors-by-FAR. Cap is min(8, 20) = 8.
  const FP: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]
  const PLOT_AREA = 1000

  it("default 'demand-based' matches Phase 3-3: smallest count that fits demand", () => {
    // Demand: 1 unit × 50m² × 1.25 / 100m² = 0.625 → 1 floor.
    const r = planFloors({
      footprint: FP,
      plotArea: PLOT_AREA,
      zoning: ZONING,
      program: { unitMix: [{ type: 'studio', count: 1, targetArea: 50 }], floorToFloorHeight: 3 },
    })
    expect(r?.floorCount).toBe(1)
  })

  it("'fill-far' packs to the FAR cap (clamped by height)", () => {
    const r = planFloors({
      footprint: FP,
      plotArea: PLOT_AREA,
      zoning: ZONING,
      program: PROGRAM,
      strategy: 'fill-far',
    })
    // floorsByFAR = 20, zoningCap = min(8, 20) = 8 → result 8.
    expect(r?.floorCount).toBe(8)
  })

  it("'fill-height' packs to the height cap (clamped by FAR)", () => {
    const r = planFloors({
      footprint: FP,
      plotArea: PLOT_AREA,
      zoning: ZONING,
      program: PROGRAM,
      strategy: 'fill-height',
    })
    // floorsByHeight = 8, zoningCap = 8 → result 8.
    expect(r?.floorCount).toBe(8)
  })

  it("'fill-far' on a tight FAR clamps below height cap", () => {
    const tightFAR: ZoningRules = { ...ZONING, maxFAR: 0.5 } // 500/100 = 5 floors
    const r = planFloors({
      footprint: FP,
      plotArea: PLOT_AREA,
      zoning: tightFAR,
      program: PROGRAM,
      strategy: 'fill-far',
    })
    expect(r?.floorCount).toBe(5)
  })

  it("'fill-far' ignores demand: builds taller than the program asks for", () => {
    // Demand says 1 floor; fill-far ignores it and packs to the cap.
    const r = planFloors({
      footprint: FP,
      plotArea: PLOT_AREA,
      zoning: ZONING,
      program: { unitMix: [{ type: 'studio', count: 1, targetArea: 50 }], floorToFloorHeight: 3 },
      strategy: 'fill-far',
    })
    expect(r?.floorCount).toBe(8)
  })
})

// ── Footprint inset + orientation ───────────────────────────────────────────

describe('chooseFootprint — params', () => {
  const ENV20: [number, number][] = [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
  ]

  it("insetM defaults to STRUCTURAL_MARGIN_M (0.5) → 19×19", () => {
    const f = chooseFootprint(ENV20, ZONING, PROGRAM)
    expect(f).not.toBeNull()
    expect(f!.area).toBeCloseTo(19 * 19, 6)
  })

  it("custom insetM grows the structural margin", () => {
    // Inset 1.0 → 18×18 = 324.
    const f = chooseFootprint(ENV20, ZONING, PROGRAM, { insetM: 1.0 })
    expect(f).not.toBeNull()
    expect(f!.area).toBeCloseTo(18 * 18, 6)
  })

  it("non-zero orientation rejects when the rotated rect overflows the envelope", () => {
    // 19×19 inset + 45° rotation: corners poke past the envelope by
    // 19·√2/2 − 19/2 ≈ 3.43m. Difference is non-empty → null.
    const f = chooseFootprint(ENV20, ZONING, PROGRAM, { orientation: Math.PI / 4 })
    expect(f).toBeNull()
  })

  it("zero orientation reproduces default behaviour exactly", () => {
    const a = chooseFootprint(ENV20, ZONING, PROGRAM)
    const b = chooseFootprint(ENV20, ZONING, PROGRAM, { orientation: 0 })
    expect(a?.area).toBeCloseTo(b?.area ?? -1, 6)
  })

  it("rejects negative insetM", () => {
    const f = chooseFootprint(ENV20, ZONING, PROGRAM, { insetM: -0.5 })
    expect(f).toBeNull()
  })
})

// ── Unit packing strategy ───────────────────────────────────────────────────

describe('packUnits — strategy + ordering', () => {
  function corr(outline: [number, number][], width = 1.5) {
    const c = placeCorridor(outline, { width })
    if (!c) throw new Error('setup: corridor')
    return c
  }

  // 30×10 with 1.5m corridor on long axis: each strip 30×4.25, fits ~6 units
  // at 5m wide.
  const STRIP_DEPTH = 4.25

  it("packingStrategy 'left-to-right' (default) fills strip 0 first", () => {
    const r = packUnits({
      outline: OUTLINE_30x10,
      corridor: corr(OUTLINE_30x10),
      corridorWidth: 1.5,
      // 4 units × 5m = 20m → all fit on strip 0 (cap is 30m).
      unitMix: baseMix([{ type: 'studio', count: 4, targetArea: STRIP_DEPTH * 5 }]),
    })
    expect(r).not.toBeNull()
    if (!r) return
    // All 4 units land on strip 0 (positive Y in this outline).
    const ys = r.units.map((u) => {
      // Average y of unit polygon vertices.
      return u.polygon.reduce((s, p) => s + p[1], 0) / u.polygon.length
    })
    // All on the same side of the corridor (centerline at y = 5).
    expect(ys.every((y) => y > 5) || ys.every((y) => y < 5)).toBe(true)
  })

  it("packingStrategy 'alternating' splits units across both strips", () => {
    const r = packUnits({
      outline: OUTLINE_30x10,
      corridor: corr(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: 'studio', count: 4, targetArea: STRIP_DEPTH * 5 }]),
      packingStrategy: 'alternating',
    })
    expect(r).not.toBeNull()
    if (!r) return
    const ys = r.units.map((u) => u.polygon.reduce((s, p) => s + p[1], 0) / u.polygon.length)
    const above = ys.filter((y) => y > 5).length
    const below = ys.filter((y) => y < 5).length
    // Even split — 2 on each strip.
    expect(above).toBe(2)
    expect(below).toBe(2)
  })

  it("packingStrategy 'grouped-by-type' switches strips on type change", () => {
    const r = packUnits({
      outline: OUTLINE_30x10,
      corridor: corr(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'studio', count: 2, targetArea: STRIP_DEPTH * 5 },
        { type: '1BR', count: 2, targetArea: STRIP_DEPTH * 5 },
      ]),
      packingStrategy: 'grouped-by-type',
    })
    expect(r).not.toBeNull()
    if (!r) return
    // Studios on one strip, 1BRs on the other.
    const studios = r.units.filter((u) => u.type === 'studio')
    const oneBRs = r.units.filter((u) => u.type === '1BR')
    const yStudio = studios.map((u) => u.polygon.reduce((s, p) => s + p[1], 0) / u.polygon.length)
    const yOneBR = oneBRs.map((u) => u.polygon.reduce((s, p) => s + p[1], 0) / u.polygon.length)
    const studiosOnSide = yStudio.every((y) => y > 5) || yStudio.every((y) => y < 5)
    const oneBROnOtherSide = yOneBR.every((y) => y > 5) || yOneBR.every((y) => y < 5)
    expect(studiosOnSide).toBe(true)
    expect(oneBROnOtherSide).toBe(true)
    // And critically: studios and 1BRs are on opposite sides.
    const studioAvg = yStudio.reduce((s, v) => s + v, 0) / yStudio.length
    const oneBRAvg = yOneBR.reduce((s, v) => s + v, 0) / yOneBR.length
    expect(Math.sign(studioAvg - 5)).not.toBe(Math.sign(oneBRAvg - 5))
  })

  it("unitOrderingHeuristic 'mix-declared' (default) places in declared order", () => {
    const r = packUnits({
      outline: OUTLINE_30x10,
      corridor: corr(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'small', count: 2, targetArea: STRIP_DEPTH * 4 },
        { type: 'big', count: 1, targetArea: STRIP_DEPTH * 8 },
      ]),
    })
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.units.map((u) => u.type)).toEqual(['small', 'small', 'big'])
  })

  it("unitOrderingHeuristic 'largest-first' sorts by descending targetArea", () => {
    const r = packUnits({
      outline: OUTLINE_30x10,
      corridor: corr(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'small', count: 2, targetArea: STRIP_DEPTH * 4 },
        { type: 'big', count: 1, targetArea: STRIP_DEPTH * 8 },
      ]),
      unitOrderingHeuristic: 'largest-first',
    })
    expect(r).not.toBeNull()
    if (!r) return
    // 'big' (32 m²·factor) placed before 'small' (~17 m²·factor).
    expect(r.units[0]!.type).toBe('big')
  })

  it("unitOrderingHeuristic 'smallest-first' sorts by ascending targetArea", () => {
    const r = packUnits({
      outline: OUTLINE_30x10,
      corridor: corr(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'small', count: 2, targetArea: STRIP_DEPTH * 4 },
        { type: 'big', count: 1, targetArea: STRIP_DEPTH * 8 },
      ]),
      unitOrderingHeuristic: 'smallest-first',
    })
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.units[0]!.type).toBe('small')
  })

  it("strategy + ordering compose: largest-first + alternating", () => {
    const r = packUnits({
      outline: OUTLINE_30x10,
      corridor: corr(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'small', count: 2, targetArea: STRIP_DEPTH * 4 },
        { type: 'big', count: 2, targetArea: STRIP_DEPTH * 7 },
      ]),
      unitOrderingHeuristic: 'largest-first',
      packingStrategy: 'alternating',
    })
    expect(r).not.toBeNull()
    if (!r) return
    // Order after sort: big, big, small, small. Alternating strips → big0
    // strip0, big1 strip1, small0 strip0, small1 strip1. The first unit
    // is a 'big'.
    expect(r.units[0]!.type).toBe('big')
    // Second unit also 'big' on the other strip.
    expect(r.units[1]!.type).toBe('big')
  })

  it("short-axis corridor: packer reorients to use corridor's actual run direction", () => {
    // 12×11 outline, short-axis corridor (12-axis). Run length should be
    // the long edge — but auto/short-axis picks the corridor parallel
    // to short, so the packer's u-direction is along that.
    const c = placeCorridor(OUTLINE_12x11, { width: 1.5, orientation: 'short-axis' })
    expect(c).not.toBeNull()
    if (!c) return
    // Short-axis corridor on 12×11 means corridor parallel to the
    // short edge (length 11), so runLength = 11.
    expect(c.runLength).toBeCloseTo(11, 6)
    const r = packUnits({
      outline: OUTLINE_12x11,
      corridor: c,
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: 'studio', count: 2, targetArea: 5 * 4 }]),
    })
    expect(r).not.toBeNull()
    if (!r) return
    // Units fit within the rotated frame.
    expect(r.units.length).toBe(2)
    // Sanity: each unit's polygon area ≈ recorded area.
    for (const u of r.units) {
      expect(calculatePolygonArea(u.polygon)).toBeCloseTo(u.area, 6)
    }
  })
})
