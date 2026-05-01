import { describe, expect, it } from 'vitest'
import { calculatePolygonArea } from '../../lib/geometry'
import {
  DEFAULT_CORRIDOR_WIDTH_M,
  MIN_STRIP_DEPTH_M,
  TARGET_STRIP_DEPTH_M,
  asRectangle,
  placeCorridor,
} from './corridor'

describe('asRectangle', () => {
  it('accepts an axis-aligned rectangle', () => {
    const r = asRectangle([
      [0, 0],
      [30, 0],
      [30, 10],
      [0, 10],
    ])
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.longLen).toBeCloseTo(30)
    expect(r.shortLen).toBeCloseTo(10)
    expect(r.center[0]).toBeCloseTo(15)
    expect(r.center[1]).toBeCloseTo(5)
    expect(Math.hypot(r.longDir[0], r.longDir[1])).toBeCloseTo(1)
  })

  it('accepts a rotated rectangle and identifies the long axis', () => {
    const a = (30 * Math.PI) / 180
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const rot = (x: number, y: number): [number, number] => [
      x * cos - y * sin,
      x * sin + y * cos,
    ]
    const r = asRectangle([rot(-15, -5), rot(15, -5), rot(15, 5), rot(-15, 5)])
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.longLen).toBeCloseTo(30)
    expect(r.shortLen).toBeCloseTo(10)
    expect(Math.abs(r.longDir[0] * cos + r.longDir[1] * sin)).toBeCloseTo(1)
  })

  it('rejects a triangle', () => {
    expect(
      asRectangle([
        [0, 0],
        [10, 0],
        [5, 10],
      ]),
    ).toBeNull()
  })

  it('rejects a pentagon', () => {
    expect(
      asRectangle([
        [0, 0],
        [10, 0],
        [12, 5],
        [5, 10],
        [0, 5],
      ]),
    ).toBeNull()
  })

  it('rejects a parallelogram (non-right angles)', () => {
    expect(
      asRectangle([
        [0, 0],
        [10, 0],
        [12, 5],
        [2, 5],
      ]),
    ).toBeNull()
  })

  it('rejects a trapezoid', () => {
    expect(
      asRectangle([
        [0, 0],
        [10, 0],
        [8, 5],
        [2, 5],
      ]),
    ).toBeNull()
  })

  it('accepts a square (long == short)', () => {
    const r = asRectangle([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.longLen).toBeCloseTo(10)
    expect(r.shortLen).toBeCloseTo(10)
  })
})

describe('placeCorridor — single-loaded fallback (narrow plates)', () => {
  // 30×10 plate: usable = 8.5 < 2 × TARGET_STRIP_DEPTH_M (18). Falls to
  // single-loaded; strip depth is the residual `usable = 8.5`.
  it('falls back to single-loaded on a 30×10 plate', () => {
    const outline: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 10],
      [0, 10],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.mode).toBe('single-loaded')
    // Centerline runs along long axis; offset toward the −perpendicular
    // outline edge so the corridor hugs y=0. cy = corridorHalf = 0.75.
    expect(c.centerline[0]).toEqual([0, 0.75])
    expect(c.centerline[1]).toEqual([30, 0.75])
    expect(c.stripDepth).toBeCloseTo(10 - DEFAULT_CORRIDOR_WIDTH_M)
    expect(calculatePolygonArea(c.polygon)).toBeCloseTo(30 * DEFAULT_CORRIDOR_WIDTH_M)
  })

  it('orients along the long axis when long axis is Y (10×30 → single-loaded)', () => {
    const outline: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 30],
      [0, 30],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.mode).toBe('single-loaded')
    // Long axis is Y; perpendicular is X. Single-loaded offsets centerline
    // toward the −perpendicular edge (x = 9.25 when corridor hugs x=10).
    const [start, end] = c.centerline
    expect(start[0]).toBeCloseTo(9.25)
    expect(end[0]).toBeCloseTo(9.25)
    expect(Math.abs(end[1] - start[1])).toBeCloseTo(30)
  })

  it('returns null when the plate is too narrow even for a single strip', () => {
    // 30×4: usable = 4 − 1.5 = 2.5 < MIN_STRIP_DEPTH_M (4). No habitable
    // strip can be formed → caller turns this into plot_too_narrow.
    expect(MIN_STRIP_DEPTH_M).toBe(4)
    expect(
      placeCorridor([
        [0, 0],
        [30, 0],
        [30, 4],
        [0, 4],
      ]),
    ).toBeNull()
  })
})

describe('placeCorridor — double-loaded (wide plates)', () => {
  // 50×30 plate: usable = 28.5 ≥ 18 → double-loaded, fixed 9 m strips.
  it('places a centred double-loaded corridor on a 50×30 plate', () => {
    const outline: [number, number][] = [
      [0, 0],
      [50, 0],
      [50, 30],
      [0, 30],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.mode).toBe('double-loaded')
    expect(c.stripDepth).toBe(TARGET_STRIP_DEPTH_M)
    // Centerline runs through the rectangle centre.
    expect(c.centerline[0]).toEqual([0, 15])
    expect(c.centerline[1]).toEqual([50, 15])
    expect(calculatePolygonArea(c.polygon)).toBeCloseTo(50 * DEFAULT_CORRIDOR_WIDTH_M)
  })

  it('respects a custom width option', () => {
    const c = placeCorridor(
      [
        [0, 0],
        [50, 0],
        [50, 30],
        [0, 30],
      ],
      { width: 2 },
    )
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.mode).toBe('double-loaded')
    expect(calculatePolygonArea(c.polygon)).toBeCloseTo(50 * 2)
  })

  it('rotates the corridor with the rectangle', () => {
    // 50×30 rotated 90° → outline 30 wide in X, 50 tall in Y.
    const outline: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 50],
      [0, 50],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    const [s, e] = c.centerline
    expect(Math.hypot(e[0] - s[0], e[1] - s[1])).toBeCloseTo(50)
  })

  it('returns null for a non-rectangle', () => {
    expect(
      placeCorridor([
        [0, 0],
        [10, 0],
        [5, 10],
      ]),
    ).toBeNull()
  })

  it('returns null for non-positive width', () => {
    const outline: [number, number][] = [
      [0, 0],
      [50, 0],
      [50, 30],
      [0, 30],
    ]
    expect(placeCorridor(outline, { width: 0 })).toBeNull()
    expect(placeCorridor(outline, { width: -1 })).toBeNull()
  })

  it('produces a corridor strictly inside the outline', () => {
    const outline: [number, number][] = [
      [0, 0],
      [50, 0],
      [50, 30],
      [0, 30],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    for (const [x, y] of c.polygon) {
      expect(x).toBeGreaterThanOrEqual(0 - 1e-9)
      expect(x).toBeLessThanOrEqual(50 + 1e-9)
      expect(y).toBeGreaterThanOrEqual(0 - 1e-9)
      expect(y).toBeLessThanOrEqual(30 + 1e-9)
    }
  })

  it('centerline midpoint equals the rectangle centre (double-loaded)', () => {
    const outline: [number, number][] = [
      [10, 20],
      [60, 20],
      [60, 50],
      [10, 50],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.mode).toBe('double-loaded')
    const [s, e] = c.centerline
    expect((s[0] + e[0]) / 2).toBeCloseTo(35)
    expect((s[1] + e[1]) / 2).toBeCloseTo(35)
  })

  it('square outline (30×30) still produces a valid double-loaded corridor', () => {
    const c = placeCorridor([
      [0, 0],
      [30, 0],
      [30, 30],
      [0, 30],
    ])
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.mode).toBe('double-loaded')
    expect(c.stripDepth).toBe(TARGET_STRIP_DEPTH_M)
    expect(calculatePolygonArea(c.polygon)).toBeCloseTo(30 * 1.5)
  })
})
