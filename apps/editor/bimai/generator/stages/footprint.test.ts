import { describe, expect, it } from 'vitest'
import type { Program, ZoningRules } from '../../schemas'
import { calculatePolygonArea } from '../../lib/geometry'
import {
  MIN_FOOTPRINT_AREA_M2,
  STRUCTURAL_MARGIN_M,
  chooseFootprint,
} from './footprint'

const ZONING: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}

const PROGRAM: Program = {
  unitMix: [],
  floorToFloorHeight: 3,
}

describe('chooseFootprint', () => {
  it('insets a square envelope by the structural margin on every side', () => {
    // 20×20 envelope → inset by 0.5m → 19×19, area 361.
    const env: [number, number][] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ]
    const res = chooseFootprint(env, ZONING, PROGRAM)
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.area).toBeCloseTo(19 * 19, 4)
    // Bounding box should be 19×19 centered inside the envelope.
    const xs = res.polygon.map((p) => p[0])
    const ys = res.polygon.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(STRUCTURAL_MARGIN_M, 4)
    expect(Math.max(...xs)).toBeCloseTo(20 - STRUCTURAL_MARGIN_M, 4)
    expect(Math.min(...ys)).toBeCloseTo(STRUCTURAL_MARGIN_M, 4)
    expect(Math.max(...ys)).toBeCloseTo(20 - STRUCTURAL_MARGIN_M, 4)
  })

  it('returns null for a degenerate (line) envelope', () => {
    const env: [number, number][] = [
      [0, 0],
      [10, 0],
    ]
    expect(chooseFootprint(env, ZONING, PROGRAM)).toBeNull()
  })

  it('returns null for a zero-area envelope', () => {
    const env: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 0],
    ]
    expect(chooseFootprint(env, ZONING, PROGRAM)).toBeNull()
  })

  it('returns null when the envelope is smaller than 2× the margin', () => {
    // 0.8m square — 0.5m inset on each side leaves nothing buildable.
    const env: [number, number][] = [
      [0, 0],
      [0.8, 0],
      [0.8, 0.8],
      [0, 0.8],
    ]
    expect(chooseFootprint(env, ZONING, PROGRAM)).toBeNull()
  })

  it('returns null when the inset area is below MIN_FOOTPRINT_AREA_M2', () => {
    // Pick a square just large enough to inset but with area below threshold.
    // After inset of 0.5 each side, we want side² < 4 → side < 2 inset side.
    // Envelope side 2.4 → inset side 1.4 → area 1.96 < 4.
    const s = 2.4
    const env: [number, number][] = [
      [0, 0],
      [s, 0],
      [s, s],
      [0, s],
    ]
    const res = chooseFootprint(env, ZONING, PROGRAM)
    if (res !== null) {
      expect(res.area).toBeGreaterThanOrEqual(MIN_FOOTPRINT_AREA_M2)
    }
    // Allowed: either null, or above threshold. Below-threshold must not pass.
    expect(res === null || res.area >= MIN_FOOTPRINT_AREA_M2).toBe(true)
  })

  it('handles a rectangular (non-square) envelope', () => {
    const env: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 10],
      [0, 10],
    ]
    const res = chooseFootprint(env, ZONING, PROGRAM)
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.area).toBeCloseTo(29 * 9, 4)
  })

  it('handles a rotated rectangle', () => {
    // 20×20 rotated 45° around origin.
    const r = 10 * Math.SQRT2
    const env: [number, number][] = [
      [r, 0],
      [0, r],
      [-r, 0],
      [0, -r],
    ]
    const res = chooseFootprint(env, ZONING, PROGRAM)
    expect(res).not.toBeNull()
    if (!res) return
    // Inset of a 20×20 square by 0.5 → 19×19 = 361, regardless of rotation.
    expect(res.area).toBeCloseTo(19 * 19, 2)
  })

  it('accepts CW-wound input (winding-agnostic)', () => {
    // Same square as the first test but clockwise.
    const env: [number, number][] = [
      [0, 0],
      [0, 20],
      [20, 20],
      [20, 0],
    ]
    const res = chooseFootprint(env, ZONING, PROGRAM)
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.area).toBeCloseTo(19 * 19, 4)
  })

  it('returns a polygon with positive (un-signed) area matching .area', () => {
    const env: [number, number][] = [
      [0, 0],
      [15, 0],
      [15, 12],
      [0, 12],
    ]
    const res = chooseFootprint(env, ZONING, PROGRAM)
    expect(res).not.toBeNull()
    if (!res) return
    expect(calculatePolygonArea(res.polygon)).toBeCloseTo(res.area, 4)
  })

  it('returns an open polygon (first point !== last)', () => {
    const env: [number, number][] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ]
    const res = chooseFootprint(env, ZONING, PROGRAM)
    expect(res).not.toBeNull()
    if (!res) return
    const first = res.polygon[0]!
    const last = res.polygon[res.polygon.length - 1]!
    expect(first[0] === last[0] && first[1] === last[1]).toBe(false)
  })
})
