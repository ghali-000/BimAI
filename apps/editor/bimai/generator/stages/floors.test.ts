import { describe, expect, it } from 'vitest'
import type { Program, ZoningRules } from '../../schemas'
import { GROSS_TO_NET_FACTOR, planFloors } from './floors'

const baseZoning: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}

const baseProgram: Program = {
  unitMix: [],
  floorToFloorHeight: 3,
}

// 20×20 footprint = 400 m².
const SQUARE_20: [number, number][] = [
  [0, 0],
  [20, 0],
  [20, 20],
  [0, 20],
]

describe('planFloors', () => {
  it('returns at least 1 floor for an empty program', () => {
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 1000,
      zoning: baseZoning,
      program: baseProgram,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.floorCount).toBe(1)
    expect(res.floorHeight).toBe(3)
    expect(res.footprintArea).toBeCloseTo(400)
    expect(res.grossFloorArea).toBeCloseTo(400)
    expect(res.warnings).toEqual([])
  })

  it('scales floor count with program demand', () => {
    // 10 units × 80m² = 800 net → 1000 gross / 400 footprint = 2.5 → 3 floors.
    const program: Program = {
      ...baseProgram,
      unitMix: [{ type: '2BR', count: 10, targetArea: 80 }],
    }
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 5000,
      zoning: baseZoning,
      program,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.floorCount).toBe(3)
    expect(res.warnings).toEqual([])
  })

  it('caps by maxHeight / floorToFloorHeight', () => {
    // Demand: 100 units × 80 = 8000 net → 10000 gross / 400 = 25 floors needed.
    // Height cap: 24 / 3 = 8 floors.
    // FAR cap: 2 × 100000 / 400 = 500 floors (effectively unlimited).
    const program: Program = {
      ...baseProgram,
      unitMix: [{ type: '2BR', count: 100, targetArea: 80 }],
    }
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 100000,
      zoning: baseZoning,
      program,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.floorCount).toBe(8)
    expect(res.warnings.some((w) => w.includes('height cap'))).toBe(true)
  })

  it('caps by maxFAR × plotArea', () => {
    // Big maxHeight so FAR is the binding constraint.
    const zoning: ZoningRules = { ...baseZoning, maxHeight: 1000 }
    // plotArea 1000, maxFAR 2 → max GFA 2000. Footprint 400 → 5 floors.
    // Demand 100 units × 80 = 10000 gross / 400 = 25 floors needed.
    const program: Program = {
      ...baseProgram,
      unitMix: [{ type: '2BR', count: 100, targetArea: 80 }],
    }
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 1000,
      zoning,
      program,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.floorCount).toBe(5)
    expect(res.warnings.some((w) => w.includes('FAR cap'))).toBe(true)
  })

  it('uses the tighter of the two zoning caps', () => {
    // Height cap: 24/3 = 8. FAR cap: 2×800/400 = 4. FAR wins.
    const program: Program = {
      ...baseProgram,
      unitMix: [{ type: '2BR', count: 100, targetArea: 80 }],
    }
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 800,
      zoning: baseZoning,
      program,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.floorCount).toBe(4)
  })

  it('respects floorToFloorHeight when computing height cap', () => {
    // 24/4 = 6 floors max by height.
    const program: Program = {
      ...baseProgram,
      floorToFloorHeight: 4,
      unitMix: [{ type: '2BR', count: 100, targetArea: 80 }],
    }
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 100000,
      zoning: baseZoning,
      program,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.floorCount).toBe(6)
    expect(res.floorHeight).toBe(4)
  })

  it('applies the gross-to-net factor', () => {
    // With factor 1.25: 5 units × 64 = 320 net → 400 gross / 400 = 1 floor.
    // Without it, this would also be 1 floor — pick numbers that differ.
    // 5 × 100 = 500 net → 625 gross / 400 = 1.5625 → 2 floors.
    // Without factor it would be 500/400 = 1.25 → 2 floors too. Try
    // 4 × 100 = 400 net → 500 gross / 400 = 1.25 → 2 floors.
    // Without factor: 400/400 = 1 → 1 floor. So factor changes outcome.
    const program: Program = {
      ...baseProgram,
      unitMix: [{ type: '2BR', count: 4, targetArea: 100 }],
    }
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 100000,
      zoning: baseZoning,
      program,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.floorCount).toBe(2)
    // Sanity: confirm factor still has the documented value.
    expect(GROSS_TO_NET_FACTOR).toBeCloseTo(1.25)
  })

  it('returns null for a degenerate footprint', () => {
    expect(
      planFloors({
        footprint: [[0, 0]],
        plotArea: 1000,
        zoning: baseZoning,
        program: baseProgram,
      }),
    ).toBeNull()
  })

  it('returns null for non-positive plotArea', () => {
    expect(
      planFloors({
        footprint: SQUARE_20,
        plotArea: 0,
        zoning: baseZoning,
        program: baseProgram,
      }),
    ).toBeNull()
  })

  it('returns null for non-positive floorToFloorHeight', () => {
    const program: Program = { ...baseProgram, floorToFloorHeight: 0 }
    expect(
      planFloors({
        footprint: SQUARE_20,
        plotArea: 1000,
        zoning: baseZoning,
        program,
      }),
    ).toBeNull()
  })

  it('emits no warning when demand fits within both caps', () => {
    const program: Program = {
      ...baseProgram,
      unitMix: [{ type: '2BR', count: 5, targetArea: 60 }],
    }
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 5000,
      zoning: baseZoning,
      program,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.warnings).toEqual([])
  })

  it('records grossFloorArea = floorCount × footprintArea', () => {
    const program: Program = {
      ...baseProgram,
      unitMix: [{ type: '2BR', count: 10, targetArea: 80 }],
    }
    const res = planFloors({
      footprint: SQUARE_20,
      plotArea: 5000,
      zoning: baseZoning,
      program,
    })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.grossFloorArea).toBeCloseTo(res.floorCount * res.footprintArea)
  })
})
