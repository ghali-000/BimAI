import { describe, expect, it } from 'vitest'
import type { Program } from '../../schemas'
import { calculatePolygonArea } from '../../lib/geometry'
import type { CorridorPlan } from '../types'
import { placeCorridor } from './corridor'
import { MAX_UNIT_WIDTH_M, MIN_UNIT_WIDTH_M, packUnits } from './units'

// 30 (long) × 10 (short) axis-aligned floor plate. Corridor 1.5m wide along
// the long axis ⇒ each strip is (10 − 1.5) / 2 = 4.25m deep.
const OUTLINE_30x10: [number, number][] = [
  [0, 0],
  [30, 0],
  [30, 10],
  [0, 10],
]
const STRIP_DEPTH = 4.25

function corridorFor(outline: [number, number][]): CorridorPlan {
  const c = placeCorridor(outline)
  if (!c) throw new Error('test setup: corridor placement failed')
  return c
}

const baseMix = (mix: Program['unitMix']): Program['unitMix'] => mix

describe('packUnits', () => {
  it('places a single unit on the first strip', () => {
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: 'studio', count: 1, targetArea: 4.25 * 5 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(1)
    expect(result.units[0]!.type).toBe('studio')
    // Area target honoured exactly (derived width 5m sits inside [MIN, MAX]).
    expect(result.units[0]!.area).toBeCloseTo(4.25 * 5, 6)
    expect(result.unplaced).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('honours declaration order across the queue', () => {
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'studio', count: 2, targetArea: STRIP_DEPTH * 5 },
        { type: '1BR', count: 2, targetArea: STRIP_DEPTH * 5 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    // 4 units × 5m = 20m on strip 0; declared order preserved.
    expect(result.units.map((u) => u.type)).toEqual([
      'studio',
      'studio',
      '1BR',
      '1BR',
    ])
  })

  it('overflows to the second strip when the first fills', () => {
    // width 7m (target 4.25 × 7 = 29.75 m², no clamp). Strip 0 fits 4 (28m),
    // remainder 2m < MIN_UNIT_WIDTH_M ⇒ rule 4 (switch strips) sends the 5th
    // unit to strip 1.
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 5, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(5)
    expect(result.unplaced).toEqual([])
    // Centroids of first four lie on +y side of corridor; fifth on -y side.
    const cy = (u: { polygon: [number, number][] }) =>
      u.polygon.reduce((s, p) => s + p[1], 0) / u.polygon.length
    expect(cy(result.units[0]!)).toBeGreaterThan(5)
    expect(cy(result.units[1]!)).toBeGreaterThan(5)
    expect(cy(result.units[2]!)).toBeGreaterThan(5)
    expect(cy(result.units[3]!)).toBeGreaterThan(5)
    expect(cy(result.units[4]!)).toBeLessThan(5)
  })

  it('records unplaced units and warns when the program exceeds capacity', () => {
    // 11 units × 6m wide (target 4.25 × 6 = 25.5 m², no clamp). Each strip
    // tiles exactly at 5×6=30m ⇒ 10 placed, 1 unplaced. No strip-end clipping.
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 11, targetArea: STRIP_DEPTH * 6 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(10)
    expect(result.unplaced).toHaveLength(1)
    expect(result.warnings.some((w) => /could not be placed/.test(w))).toBe(true)
  })

  it('skips zero-count entries entirely', () => {
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'studio', count: 0, targetArea: 35 },
        { type: '1BR', count: 1, targetArea: STRIP_DEPTH * 5 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(1)
    expect(result.units[0]!.type).toBe('1BR')
  })

  it('labels facade and corridor edges on every unit', () => {
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 4, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      expect(u.corridorEdges).toEqual([0])
      expect(u.facadeEdges).toContain(2)
    }
  })

  it('flags first/last units in a strip with end-wall facade edges', () => {
    // 3 units × 7m wide ⇒ strip 0 holds all three (21m of 30m).
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 3, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units[0]!.facadeEdges).toContain(3)
    expect(result.units[2]!.facadeEdges).toContain(1)
    expect(result.units[1]!.facadeEdges).not.toContain(1)
    expect(result.units[1]!.facadeEdges).not.toContain(3)
  })

  it('returns null for non-rectangular outlines', () => {
    const triangle: [number, number][] = [
      [0, 0],
      [10, 0],
      [5, 10],
    ]
    expect(
      packUnits({
        outline: triangle,
        corridor: corridorFor(OUTLINE_30x10),
        corridorWidth: 1.5,
        unitMix: baseMix([{ type: 'studio', count: 1, targetArea: 20 }]),
      }),
    ).toBeNull()
  })

  it('returns null when the corridor consumes the whole short dimension', () => {
    // Pass a corridor whose own metadata reflects the consumed dimension.
    // Phase 3-5 made the corridor object the canonical source for run
    // length + strip depth, so the test's `corridorWidth` field on its
    // own no longer drives strip-depth derivation.
    const consumed = placeCorridor(OUTLINE_30x10, { width: 10 })
    if (!consumed) throw new Error('test setup: corridor at full width')
    expect(
      packUnits({
        outline: OUTLINE_30x10,
        corridor: consumed,
        corridorWidth: 10,
        unitMix: baseMix([{ type: 'studio', count: 1, targetArea: 20 }]),
      }),
    ).toBeNull()
  })

  it('returns null for non-positive corridor width', () => {
    expect(
      packUnits({
        outline: OUTLINE_30x10,
        corridor: corridorFor(OUTLINE_30x10),
        corridorWidth: 0,
        unitMix: baseMix([{ type: 'studio', count: 1, targetArea: 20 }]),
      }),
    ).toBeNull()
  })

  it('produces unit polygons whose computed area matches the recorded area', () => {
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 3, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      expect(calculatePolygonArea(u.polygon)).toBeCloseTo(u.area, 4)
    }
  })

  it('keeps unit polygons inside the floor outline (axis-aligned case)', () => {
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'studio', count: 6, targetArea: STRIP_DEPTH * 5 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      for (const [x, y] of u.polygon) {
        expect(x).toBeGreaterThanOrEqual(-1e-9)
        expect(x).toBeLessThanOrEqual(30 + 1e-9)
        expect(y).toBeGreaterThanOrEqual(-1e-9)
        expect(y).toBeLessThanOrEqual(10 + 1e-9)
      }
    }
  })

  it('places units on a rotated rectangle along its long axis', () => {
    // 30×10 rotated 45° about origin. width 7m (target 4.25 × 7 = 29.75) keeps
    // the test inside the unclamped band so we're testing rotation, not clamp.
    const a = Math.PI / 4
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const rot = (x: number, y: number): [number, number] => [
      x * cos - y * sin,
      x * sin + y * cos,
    ]
    const outline = [rot(0, 0), rot(30, 0), rot(30, 10), rot(0, 10)] as [
      number,
      number,
    ][]
    const corridor = placeCorridor(outline)
    expect(corridor).not.toBeNull()
    if (!corridor) return
    const result = packUnits({
      outline,
      corridor,
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 3, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(3)
    for (const u of result.units) {
      expect(u.area).toBeCloseTo(STRIP_DEPTH * 7, 4)
    }
  })

  it('returns an empty result for an empty unit mix', () => {
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toEqual([])
    expect(result.unplaced).toEqual([])
    expect(result.warnings).toEqual([])
  })

  // ── Gate 1 regression tests ────────────────────────────────────────────────
  // Pinned arithmetic from the Phase 3-3 Gate 1 spec. Each test names the
  // exact derivation so future refactors can spot a behaviour change rather
  // than a fixture drift.

  it('Gate 1 — 30×10 + 4 Studios @ 35 m² fits inside [MIN,MAX] band', () => {
    // depth = (10 − 1.5) / 2 = 4.25m
    // derived width = 35 / 4.25 ≈ 8.235m  (within [3, 9] ⇒ no width clamp)
    // Strip 0: 3 × 8.235 = 24.706m, remaining 5.294m ≥ MIN ⇒ rule 3 fires
    //   for the 4th unit (strip-end clamp to 5.294m × 4.25 ≈ 22.5 m²).
    // Net: 4 placed, 0 unplaced; one `unit_clipped_strip_end` warning;
    //   `area_drift` for studio (≈ -8.9% < -5%).
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: 'studio', count: 4, targetArea: 35 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(4)
    expect(result.unplaced).toEqual([])
    // First three units pinned at the unclamped derived width 35/4.25.
    const expectedWidth = 35 / 4.25
    for (let i = 0; i < 3; i++) {
      expect(result.units[i]!.area).toBeCloseTo(expectedWidth * 4.25, 4)
    }
    // Fourth unit was strip-end clipped — narrower than the first three.
    expect(result.units[3]!.area).toBeLessThan(result.units[0]!.area)
    expect(
      result.warnings.some((w) => w.startsWith('unit_clipped_strip_end:')),
    ).toBe(true)
    expect(result.warnings.some((w) => w.startsWith('unit_clipped_max:'))).toBe(
      false,
    )
    expect(result.warnings.some((w) => w.startsWith('unit_clipped_min:'))).toBe(
      false,
    )
    expect(result.warnings.some((w) => w.startsWith('area_drift:'))).toBe(true)
  })

  it('Gate 1 — 30×10 + 1 oversize 4BR @ 200 m² is max-clamped', () => {
    // derived width = 200 / 4.25 ≈ 47.06m  ⇒  clamp to MAX = 9m
    // Placed area = 9 × 4.25 = 38.25 m² (vs target 200). One placed, no
    //   unplaced; `unit_clipped_max` and `area_drift` warnings.
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: '4BR', count: 1, targetArea: 200 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(1)
    expect(result.unplaced).toEqual([])
    expect(result.units[0]!.area).toBeCloseTo(MAX_UNIT_WIDTH_M * STRIP_DEPTH, 4)
    expect(result.warnings.some((w) => w.startsWith('unit_clipped_max:'))).toBe(
      true,
    )
    expect(result.warnings.some((w) => w.startsWith('area_drift:'))).toBe(true)
  })

  it('Gate 1 — 30×10 + 20 Studios @ 35 m² overflows capacity', () => {
    // derived width 8.235m, no clamp. Each strip fits 3 normal units + 1
    //   strip-end clamped tail (rem 5.294m ≥ MIN). So 4 per strip = 8 placed,
    //   12 unplaced. Note: greedy left-then-right sees rem ≥ MIN and trips
    //   strip-end clamping before exhausting the queue, so we end up with
    //   8 placed rather than the 6 a strict floor(30/8.235) would suggest.
    //   That's the conversation: rule 3 (strip-end clamp) bites here.
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: 'studio', count: 20, targetArea: 35 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(8)
    expect(result.unplaced).toHaveLength(12)
    expect(result.warnings.some((w) => /could not be placed/.test(w))).toBe(
      true,
    )
    expect(
      result.warnings.filter((w) => w.startsWith('unit_clipped_strip_end:'))
        .length,
    ).toBe(2) // one tail per strip
  })

  it('Gate 1 — 50×12 mixed (4 Studio + 6 1BR + 4 2BR) clamps and drifts', () => {
    // depth = (12 − 1.5) / 2 = 5.25m
    // Studio 35 / 5.25 = 6.667m (no clamp)
    // 1BR    55 / 5.25 = 10.476m → clamp to MAX = 9m
    // 2BR    80 / 5.25 = 15.238m → clamp to MAX = 9m
    //
    // Greedy left-then-right (halfL = 25, longLen = 50):
    //   Strip 0: 4 Studios (26.67m used) + 2 × 1BR @ 9 (44.67m) + strip-end
    //            clamped 1BR @ 5.33m. cursor = 25 (full). 7 units.
    //   Strip 1: 3 × 1BR @ 9 (27m) + 1 × 1BR @ 9 (no — only 6 1BRs total;
    //            we used 3 on strip 0, so 3 left). Continue with 2BRs:
    //            2 × 2BR @ 9 (45m) + strip-end clamped 2BR @ 5m. cursor = 25.
    //            6 units.
    //   Strip 0 → cursor=25 (full); 4th 2BR cannot fit anywhere → unplaced.
    //
    // Total: 13 placed, 1 unplaced.
    const outline: [number, number][] = [
      [0, 0],
      [50, 0],
      [50, 12],
      [0, 12],
    ]
    const result = packUnits({
      outline,
      corridor: corridorFor(outline),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'studio', count: 4, targetArea: 35 },
        { type: '1BR', count: 6, targetArea: 55 },
        { type: '2BR', count: 4, targetArea: 80 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(13)
    expect(result.unplaced).toHaveLength(1)
    expect(result.unplaced[0]!.type).toBe('2BR')

    const maxClamps = result.warnings.filter((w) =>
      w.startsWith('unit_clipped_max:'),
    )
    // 6 × 1BR + 4 × 2BR = 10 max-clamp warnings (one per item, emitted once
    // per queue entry at width-derivation time).
    expect(maxClamps).toHaveLength(10)

    const stripEndClamps = result.warnings.filter((w) =>
      w.startsWith('unit_clipped_strip_end:'),
    )
    expect(stripEndClamps).toHaveLength(2)

    const drifts = result.warnings.filter((w) => w.startsWith('area_drift:'))
    // Studios placed exactly on target ⇒ no drift entry. 1BR & 2BR clamped ⇒
    // both exceed the 5% threshold.
    expect(drifts.some((w) => w.includes('1BR'))).toBe(true)
    expect(drifts.some((w) => w.includes('2BR'))).toBe(true)
    expect(drifts.some((w) => w.includes('studio'))).toBe(false)

    expect(result.warnings.some((w) => /could not be placed/.test(w))).toBe(
      true,
    )

    // Sanity check on the band constants — if MIN/MAX move, the fixture
    // arithmetic above stops holding.
    expect(MIN_UNIT_WIDTH_M).toBe(4)
    expect(MAX_UNIT_WIDTH_M).toBe(9)
  })
})
