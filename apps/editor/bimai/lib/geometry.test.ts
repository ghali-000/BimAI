import { describe, expect, it } from 'vitest'
import { calculatePerimeter, calculatePolygonArea } from './geometry'

describe('calculatePolygonArea', () => {
  it('returns 0 for degenerate polygons', () => {
    expect(calculatePolygonArea([])).toBe(0)
    expect(calculatePolygonArea([[0, 0]])).toBe(0)
    expect(
      calculatePolygonArea([
        [0, 0],
        [1, 0],
      ]),
    ).toBe(0)
  })

  it('computes area for a unit square', () => {
    const square: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    expect(calculatePolygonArea(square)).toBeCloseTo(1, 6)
  })

  it('is orientation-invariant (CCW vs CW)', () => {
    const ccw: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const cw: [number, number][] = [...ccw].reverse()
    expect(calculatePolygonArea(ccw)).toBeCloseTo(100, 6)
    expect(calculatePolygonArea(cw)).toBeCloseTo(100, 6)
  })

  it('computes area for a triangle', () => {
    expect(
      calculatePolygonArea([
        [0, 0],
        [4, 0],
        [0, 3],
      ]),
    ).toBeCloseTo(6, 6)
  })
})

describe('calculatePerimeter', () => {
  it('returns 0 for fewer than 2 points', () => {
    expect(calculatePerimeter([])).toBe(0)
    expect(calculatePerimeter([[1, 2]])).toBe(0)
  })

  it('computes perimeter for a unit square', () => {
    expect(
      calculatePerimeter([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    ).toBeCloseTo(4, 6)
  })
})
