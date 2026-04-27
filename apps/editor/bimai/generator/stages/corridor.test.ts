import { describe, expect, it } from 'vitest'
import { calculatePolygonArea } from '../../lib/geometry'
import {
  DEFAULT_CORRIDOR_WIDTH_M,
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
    // 30×10 rotated 30°, centered at origin.
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
    // Long axis direction should align with rotated x-axis.
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

describe('placeCorridor', () => {
  it('places a 1.5m corridor along the long axis of an axis-aligned rectangle', () => {
    const outline: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 10],
      [0, 10],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    // Centerline runs the full length of the long axis through the center.
    expect(c.centerline[0]).toEqual([0, 5])
    expect(c.centerline[1]).toEqual([30, 5])
    // Polygon is a 30 × 1.5 rectangle.
    expect(calculatePolygonArea(c.polygon)).toBeCloseTo(30 * DEFAULT_CORRIDOR_WIDTH_M)
  })

  it('orients the corridor along the long axis when the long axis is Y', () => {
    const outline: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 30],
      [0, 30],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    // Centerline runs vertically through x=5.
    const [start, end] = c.centerline
    expect(start[0]).toBeCloseTo(5)
    expect(end[0]).toBeCloseTo(5)
    expect(Math.abs(end[1] - start[1])).toBeCloseTo(30)
  })

  it('respects a custom width option', () => {
    const c = placeCorridor(
      [
        [0, 0],
        [30, 0],
        [30, 10],
        [0, 10],
      ],
      { width: 2 },
    )
    expect(c).not.toBeNull()
    if (!c) return
    expect(calculatePolygonArea(c.polygon)).toBeCloseTo(30 * 2)
  })

  it('rotates the corridor with the rectangle', () => {
    // 30×10 rotated 90° → outline 10 wide in X, 30 tall in Y.
    const outline: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 30],
      [0, 30],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    // Centerline length = 30 (long axis).
    const [s, e] = c.centerline
    expect(Math.hypot(e[0] - s[0], e[1] - s[1])).toBeCloseTo(30)
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
      [30, 0],
      [30, 10],
      [0, 10],
    ]
    expect(placeCorridor(outline, { width: 0 })).toBeNull()
    expect(placeCorridor(outline, { width: -1 })).toBeNull()
  })

  it('produces a corridor strictly inside the outline (axis-aligned case)', () => {
    const outline: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 10],
      [0, 10],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    for (const [x, y] of c.polygon) {
      expect(x).toBeGreaterThanOrEqual(0 - 1e-9)
      expect(x).toBeLessThanOrEqual(30 + 1e-9)
      expect(y).toBeGreaterThanOrEqual(0 - 1e-9)
      expect(y).toBeLessThanOrEqual(10 + 1e-9)
    }
  })

  it('centerline midpoint equals the rectangle center', () => {
    const outline: [number, number][] = [
      [10, 20],
      [40, 20],
      [40, 30],
      [10, 30],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    const [s, e] = c.centerline
    expect((s[0] + e[0]) / 2).toBeCloseTo(25)
    expect((s[1] + e[1]) / 2).toBeCloseTo(25)
  })

  it('square outline still produces a valid corridor (degenerate long-axis pick)', () => {
    const c = placeCorridor([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
    expect(c).not.toBeNull()
    if (!c) return
    // Length 10, width 1.5.
    expect(calculatePolygonArea(c.polygon)).toBeCloseTo(10 * 1.5)
  })
})
