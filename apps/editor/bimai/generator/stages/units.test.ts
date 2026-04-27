import { describe, expect, it } from 'vitest'
import type { Program } from '../../schemas'
import { calculatePolygonArea } from '../../lib/geometry'
import type { CorridorPlan } from '../types'
import { placeCorridor } from './corridor'
import { packUnits } from './units'

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
    // Area target honoured exactly.
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
    // Strip 0 fills first with studio,studio (10m of 30m), then 1BR,1BR until
    // strip 0 is full at 30m. Total fits both strips? 4 units × 5m = 20m on
    // strip 0; that leaves 10m unused. Order in `units` is studio,studio,1BR,1BR.
    expect(result.units.map((u) => u.type)).toEqual([
      'studio',
      'studio',
      '1BR',
      '1BR',
    ])
  })

  it('overflows to the second strip when the first fills', () => {
    // Each unit 10m wide ⇒ strip 0 holds 3 (full at 30m), 4th must go to strip 1.
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 4, targetArea: STRIP_DEPTH * 10 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(4)
    expect(result.unplaced).toEqual([])
    // Centroids of first three lie on +y side of corridor; fourth on -y side.
    const cy = (u: { polygon: [number, number][] }) =>
      u.polygon.reduce((s, p) => s + p[1], 0) / u.polygon.length
    expect(cy(result.units[0]!)).toBeGreaterThan(5)
    expect(cy(result.units[1]!)).toBeGreaterThan(5)
    expect(cy(result.units[2]!)).toBeGreaterThan(5)
    expect(cy(result.units[3]!)).toBeLessThan(5)
  })

  it('records unplaced units and warns when the program exceeds capacity', () => {
    // 7 units × 10m = 70m; only 60m available across both strips.
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 7, targetArea: STRIP_DEPTH * 10 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(6)
    expect(result.unplaced).toHaveLength(1)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/could not be placed/)
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
        { type: '2BR', count: 4, targetArea: STRIP_DEPTH * 10 },
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
    const result = packUnits({
      outline: OUTLINE_30x10,
      corridor: corridorFor(OUTLINE_30x10),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 3, targetArea: STRIP_DEPTH * 10 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    // 3 units × 10m fills strip 0 exactly. First (idx 0) gets edge 3; last (idx 2) gets edge 1.
    expect(result.units[0]!.facadeEdges).toContain(3)
    expect(result.units[2]!.facadeEdges).toContain(1)
    // Middle unit has neither end edge.
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
        // Reuse a valid corridor for the rectangle case to satisfy the input;
        // the packer should bail before touching it.
        corridor: corridorFor(OUTLINE_30x10),
        corridorWidth: 1.5,
        unitMix: baseMix([{ type: 'studio', count: 1, targetArea: 20 }]),
      }),
    ).toBeNull()
  })

  it('returns null when the corridor consumes the whole short dimension', () => {
    expect(
      packUnits({
        outline: OUTLINE_30x10,
        corridor: corridorFor(OUTLINE_30x10),
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
        { type: '2BR', count: 3, targetArea: STRIP_DEPTH * 10 },
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
    // 30×10 rotated 45° about origin.
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
        { type: '2BR', count: 3, targetArea: STRIP_DEPTH * 10 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(3)
    for (const u of result.units) {
      expect(u.area).toBeCloseTo(STRIP_DEPTH * 10, 4)
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
})
