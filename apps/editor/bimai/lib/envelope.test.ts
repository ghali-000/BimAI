import { describe, expect, it } from 'vitest'
import { ZoningRules } from '../schemas/zoning'
import { computeEnvelope } from './envelope'

const baseZoning = ZoningRules.parse({})

describe('computeEnvelope', () => {
  it('returns invalid_plot for degenerate polygons', () => {
    const result = computeEnvelope([], baseZoning)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_plot')
  })

  it('returns the original polygon when all setbacks are zero', () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const zoning = ZoningRules.parse({
      setbacks: { front: 0, side: 0, rear: 0 },
    })
    const result = computeEnvelope(square, zoning)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.area).toBeCloseTo(100, 4)
  })

  it('shrinks a 30x30 plot to 22x22 with default 4m mean setback', () => {
    const plot: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 30],
      [0, 30],
    ]
    // Defaults: front 5, side 3, rear 4 → mean = 4m → 22×22 = 484 m²
    const result = computeEnvelope(plot, baseZoning)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.area).toBeCloseTo(484, 1)
  })

  it('reports envelope_collapsed when setbacks exceed plot half-width', () => {
    const plot: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]
    const zoning = ZoningRules.parse({
      setbacks: { front: 5, side: 5, rear: 5 },
    })
    const result = computeEnvelope(plot, zoning)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('envelope_collapsed')
  })

  it('handles CW-oriented input by treating it as the same plot', () => {
    const ccw: [number, number][] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ]
    const cw: [number, number][] = [...ccw].reverse()
    const zoning = ZoningRules.parse({
      setbacks: { front: 2, side: 2, rear: 2 },
    })
    const r1 = computeEnvelope(ccw, zoning)
    const r2 = computeEnvelope(cw, zoning)
    expect(r1.ok && r2.ok).toBe(true)
    if (r1.ok && r2.ok) expect(r1.area).toBeCloseTo(r2.area, 3)
  })
})
