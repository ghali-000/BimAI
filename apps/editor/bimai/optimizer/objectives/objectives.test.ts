// Objective + composer tests. Fixtures are minimal — we only need the
// fields each objective actually reads, not full BuildingPlan/CostResult
// shapes. Casts isolate that fact at the construction site.

import { describe, expect, it } from 'vitest'
import type { CostResult } from '../../cost/types'
import { emptyRoomBreakdown } from '../../schedule/compute'
import type { ScheduleResult } from '../../schedule/types'
import type { BuildingPlan } from '../../generator/types'
import { DEFAULT_PARAMS } from '../params'
import type { Program, ZoningRules } from '../../schemas'
import { mixAccuracy } from './mix-accuracy'
import { sellableArea } from './sellable-area'
import { costPerUnit, DEFAULT_TARGET_COST_PER_UNIT, makeCostPerUnit } from './cost-per-unit'
import { compliance } from './compliance'
import { composeObjectives, DEFAULT_WEIGHTS } from './index'
import type { CandidateEvaluation } from './types'

const ZONING: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}

const PROGRAM: Program = {
  unitMix: [
    { type: 'Studio', count: 4, targetArea: 35 },
    { type: '1BR', count: 6, targetArea: 55 },
    { type: '2BR', count: 4, targetArea: 80 },
  ],
  floorToFloorHeight: 3,
}

function makeSchedule(byUnitType: Array<[string, number, number]>): ScheduleResult {
  const totalNia = byUnitType.reduce((s, [, , a]) => s + a, 0)
  const totalUnits = byUnitType.reduce((s, [, c]) => s + c, 0)
  return {
    floorCount: 1,
    totals: { gea: totalNia / 0.8, nia: totalNia, efficiency: 0.8 },
    byFloor: [],
    residential: {
      totalUnits,
      avgUnitArea: totalUnits > 0 ? totalNia / totalUnits : 0,
      byUnitType: byUnitType.map(([type, count, totalArea]) => ({
        type,
        count,
        totalArea,
        avgArea: count > 0 ? totalArea / count : 0,
      })),
    },
    roomBreakdown: emptyRoomBreakdown(),
    warnings: [],
  }
}

function makeCost(perUnit: number, totalUnits: number): CostResult {
  const total = perUnit * totalUnits
  return {
    perComponent: { walls: { exterior: 0, interior: 0, loadBearing: 0 }, slabs: 0, openings: { doors: 0, windows: 0 } },
    perComponentTotal: total * 0.6,
    typology: { mep: 0, finishes: 0, generalConditions: 0, contingency: 0 },
    typologyTotal: total * 0.4,
    hardCost: total * 0.85,
    softCosts: total * 0.15,
    totalProjectCost: total,
    perM2OfGEA: 0,
    perUnit,
    warnings: [],
  }
}

// Footprint sits inside the 50×30 plot's setback envelope (front:5, side:3,
// rear:4 → envelope ≈ [3,5]–[47,26]) so the envelopeContainment check
// passes by default.
const PLAN: BuildingPlan = {
  generationId: 'gen-test',
  footprint: [[10, 10], [20, 10], [20, 20], [10, 20]],
  floorCount: 1,
  floorHeight: 3,
  floors: [],
  stairs: [],
  roof: {
    typology: 'flat-with-parapet',
    slabPolygon: [[10, 10], [20, 10], [20, 20], [10, 20]],
    elevation: 3,
  },
  warnings: [],
  params: DEFAULT_PARAMS,
}

// 50×30 plot — generous so default compliance checks pass against a
// 10×10 footprint at one floor.
const PLOT_50x30: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 30],
  [0, 30],
]

function ctx(overrides: Partial<CandidateEvaluation> = {}): CandidateEvaluation {
  return {
    program: PROGRAM,
    zoning: ZONING,
    plotPolygon: PLOT_50x30,
    plotArea: 1500,
    plan: PLAN,
    schedule: makeSchedule([['Studio', 4, 140], ['1BR', 6, 330], ['2BR', 4, 320]]),
    cost: makeCost(150_000, 14),
    ...overrides,
  }
}

// ── mix-accuracy ────────────────────────────────────────────────────────────

describe('mixAccuracy', () => {
  it('returns 1.0 when every requested unit is placed', () => {
    const r = mixAccuracy(ctx())
    expect(r.score).toBe(1)
  })

  it('returns 0.5 when half the requested units are placed', () => {
    const r = mixAccuracy(
      ctx({ schedule: makeSchedule([['Studio', 2, 70], ['1BR', 3, 165], ['2BR', 2, 160]]) }),
    )
    expect(r.score).toBeCloseTo(7 / 14, 6)
  })

  it('caps over-placement at the requested count (no bonus for extras)', () => {
    const r = mixAccuracy(
      ctx({ schedule: makeSchedule([['Studio', 8, 280], ['1BR', 6, 330], ['2BR', 4, 320]]) }),
    )
    // requested 14, covered = min(8,4)+6+4 = 14 → 1.0
    expect(r.score).toBe(1)
    expect(r.notes?.some((n) => n.includes('Studio: 8 placed'))).toBe(true)
  })

  it('returns 1.0 when the program requested zero units', () => {
    const r = mixAccuracy(
      ctx({
        program: { unitMix: [], floorToFloorHeight: 3 },
        schedule: makeSchedule([]),
      }),
    )
    expect(r.score).toBe(1)
  })

  it('ignores placed units of types that were not requested', () => {
    const r = mixAccuracy(
      ctx({
        program: { unitMix: [{ type: 'Studio', count: 4, targetArea: 35 }], floorToFloorHeight: 3 },
        schedule: makeSchedule([['Studio', 4, 140], ['ghost', 99, 99]]),
      }),
    )
    expect(r.score).toBe(1)
  })
})

// ── sellable-area ───────────────────────────────────────────────────────────

describe('sellableArea', () => {
  it('scores NIA against the FAR cap (NIA / (maxFAR × plotArea))', () => {
    // NIA 790 / (2 × 1500 = 3000) = 0.2633
    const r = sellableArea(ctx())
    expect(r.score).toBeCloseTo(790 / 3000, 6)
    expect(r.raw).toBe(790)
  })

  it('caps at 1.0 when NIA exceeds the FAR cap', () => {
    const r = sellableArea(
      ctx({ schedule: makeSchedule([['Studio', 50, 5000]]), plotArea: 1000 }),
    )
    // cap = 2 × 1000 = 2000; NIA 5000 → over.
    expect(r.score).toBe(1)
    expect(r.notes?.[0]).toMatch(/exceeds FAR cap/)
  })

  it('returns 0 when plotArea or maxFAR is zero', () => {
    expect(sellableArea(ctx({ plotArea: 0 })).score).toBe(0)
    expect(
      sellableArea(ctx({ zoning: { ...ZONING, maxFAR: 0 } })).score,
    ).toBe(0)
  })
})

// ── cost-per-unit ───────────────────────────────────────────────────────────

describe('costPerUnit', () => {
  it('hits 1.0 at the target budget', () => {
    const r = costPerUnit(ctx({ cost: makeCost(DEFAULT_TARGET_COST_PER_UNIT, 14) }))
    expect(r.score).toBe(1)
  })

  it('halves at 2× the target', () => {
    const r = costPerUnit(
      ctx({ cost: makeCost(DEFAULT_TARGET_COST_PER_UNIT * 2, 14) }),
    )
    expect(r.score).toBeCloseTo(0.5, 6)
  })

  it('caps at 1.0 below the target (no bonus for cheap)', () => {
    const r = costPerUnit(
      ctx({ cost: makeCost(DEFAULT_TARGET_COST_PER_UNIT / 4, 14) }),
    )
    expect(r.score).toBe(1)
  })

  it('returns 0 when no units are placed', () => {
    const r = costPerUnit(
      ctx({ schedule: makeSchedule([]), cost: makeCost(0, 0) }),
    )
    expect(r.score).toBe(0)
  })

  it('makeCostPerUnit honours a custom target', () => {
    const obj = makeCostPerUnit({ targetCostPerUnit: 100_000 })
    const r = obj(ctx({ cost: makeCost(100_000, 14) }))
    expect(r.score).toBe(1)
  })
})

// ── compliance (stub) ───────────────────────────────────────────────────────

describe('compliance', () => {
  it('returns 1.0 when every check passes on the default fixture', () => {
    const r = compliance(ctx())
    expect(r.score).toBe(1)
    expect(r.notes).toBeUndefined()
  })
})

// ── composer ────────────────────────────────────────────────────────────────

describe('composeObjectives', () => {
  it('weighted-averages the four objectives under default weights', () => {
    // Perfect candidate: mix=1, area=0.263, cost=1, compliance=1
    // Weights: 1 + 0.5 + 0.5 + 1 = 3
    // Sum: 1·1 + 0.263·0.5 + 1·0.5 + 1·1 = 2.6315
    // Composite: 2.6315 / 3 ≈ 0.877
    const out = composeObjectives(ctx())
    const expected = (1 * 1 + (790 / 3000) * 0.5 + 1 * 0.5 + 1 * 1) / 3
    expect(out.score).toBeCloseTo(expected, 6)
    // Breakdown is fully populated.
    expect(out.breakdown.mixAccuracy.score).toBe(1)
    expect(out.breakdown.sellableArea.raw).toBe(790)
    expect(out.breakdown.costPerUnit.score).toBe(1)
    expect(out.breakdown.compliance.score).toBe(1)
  })

  it('honours custom weights', () => {
    // Mute everything except mixAccuracy. Composite = breakdown.mixAccuracy.score.
    const out = composeObjectives(ctx(), {
      mixAccuracy: 1,
      sellableArea: 0,
      costPerUnit: 0,
      compliance: 0,
    })
    expect(out.score).toBe(out.breakdown.mixAccuracy.score)
  })

  it('treats negative weights as zero', () => {
    const out = composeObjectives(ctx(), {
      mixAccuracy: 1,
      sellableArea: -5, // ignored
      costPerUnit: 0,
      compliance: 0,
    })
    expect(out.score).toBe(out.breakdown.mixAccuracy.score)
  })

  it('returns 0 when every weight is zero', () => {
    const out = composeObjectives(ctx(), {
      mixAccuracy: 0,
      sellableArea: 0,
      costPerUnit: 0,
      compliance: 0,
    })
    expect(out.score).toBe(0)
    // Breakdown still computed.
    expect(out.breakdown.mixAccuracy.score).toBe(1)
  })

  it('a half-mixed candidate scores below a fully-mixed one', () => {
    const fullMix = composeObjectives(ctx())
    const halfMix = composeObjectives(
      ctx({ schedule: makeSchedule([['Studio', 2, 70], ['1BR', 3, 165], ['2BR', 2, 160]]) }),
    )
    expect(halfMix.score).toBeLessThan(fullMix.score)
  })

  it('DEFAULT_WEIGHTS sums to 3 (1 + 0.5 + 0.5 + 1)', () => {
    const total =
      DEFAULT_WEIGHTS.mixAccuracy +
      DEFAULT_WEIGHTS.sellableArea +
      DEFAULT_WEIGHTS.costPerUnit +
      DEFAULT_WEIGHTS.compliance
    expect(total).toBe(3)
  })
})
