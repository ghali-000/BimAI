import { describe, expect, it } from 'vitest'
import { RESIDENTIAL_STAIR, buildFlightPlan } from './stairs-templates'

describe('RESIDENTIAL_STAIR template', () => {
  it('has typical residential dimensions (2.5 m × 4.0 m)', () => {
    expect(RESIDENTIAL_STAIR.width).toBe(2.5)
    expect(RESIDENTIAL_STAIR.depth).toBe(4.0)
  })

  it('flight step count tracks floor-to-floor height (2.7m → 15, 3.0m → 17, 3.3m → 19)', () => {
    // ceil(h / 0.18): 2.7 → 15, 3.0 → 17 (16.66…), 3.3 → 19 (18.33…).
    expect(RESIDENTIAL_STAIR.flightStepCount(2.7)).toBe(15)
    expect(RESIDENTIAL_STAIR.flightStepCount(3.0)).toBe(17)
    expect(RESIDENTIAL_STAIR.flightStepCount(3.3)).toBe(19)
  })

  it('step height stays in 0.15–0.20 m range across typical floor heights', () => {
    for (const h of [2.4, 2.7, 3.0, 3.3, 3.6]) {
      const stepCount = RESIDENTIAL_STAIR.flightStepCount(h)
      const riser = h / stepCount
      expect(riser).toBeGreaterThanOrEqual(RESIDENTIAL_STAIR.stepHeightRangeM.min)
      expect(riser).toBeLessThanOrEqual(RESIDENTIAL_STAIR.stepHeightRangeM.max)
    }
  })

  it('flight rise = floor-to-floor height (no drift)', () => {
    const flight = buildFlightPlan(RESIDENTIAL_STAIR, 0, 0, 3.0)
    expect(flight.endElevation - flight.startElevation).toBeCloseTo(3.0, 9)
    expect(flight.stepHeight * flight.stepCount).toBeCloseTo(3.0, 9)
  })

  it('buildFlightPlan wires fromLevel → toLevel as consecutive integers', () => {
    const flight = buildFlightPlan(RESIDENTIAL_STAIR, 2, 6.0, 3.0)
    expect(flight.fromLevel).toBe(2)
    expect(flight.toLevel).toBe(3)
    expect(flight.startElevation).toBe(6.0)
    expect(flight.endElevation).toBe(9.0)
    expect(flight.stepDepth).toBeCloseTo(0.275, 9) // midpoint of 0.25–0.30
  })
})
