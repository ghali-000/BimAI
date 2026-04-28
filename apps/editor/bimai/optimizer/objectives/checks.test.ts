// Compliance check tests. Each test isolates one check by tweaking the
// fixture so that *only* the targeted check fails — the score then
// drops from 5/5 = 1.0 to 4/5 = 0.8 and the note vocabulary names the
// failing check.

import { describe, expect, it } from 'vitest'
import type { BuildingPlan } from '../../generator/types'
import type { CostResult } from '../../cost/types'
import type { ScheduleResult } from '../../schedule/types'
import type { Program, ZoningRules } from '../../schemas'
import { DEFAULT_PARAMS } from '../params'
import { runComplianceChecks } from './checks'
import { compliance } from './compliance'
import type { CandidateEvaluation } from './types'

const ZONING: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}

const PROGRAM: Program = {
  unitMix: [{ type: 'Studio', count: 1, targetArea: 35 }],
  floorToFloorHeight: 3,
}

const PLOT_50x30: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 30],
  [0, 30],
]

const PLOT_AREA = 1500

const SCHEDULE: ScheduleResult = {
  floorCount: 1,
  totals: { gea: 100, nia: 80, efficiency: 0.8 },
  byFloor: [],
  residential: { totalUnits: 1, avgUnitArea: 80, byUnitType: [] },
  warnings: [],
}

const COST: CostResult = {
  perComponent: {
    walls: { exterior: 0, interior: 0, loadBearing: 0 },
    slabs: 0,
    openings: { doors: 0, windows: 0 },
  },
  perComponentTotal: 0,
  typology: { mep: 0, finishes: 0, generalConditions: 0, contingency: 0 },
  typologyTotal: 0,
  hardCost: 0,
  softCosts: 0,
  totalProjectCost: 0,
  perM2OfGEA: 0,
  perUnit: 0,
  warnings: [],
}

// 10×10 footprint sitting inside the inset envelope of the 50×30 plot.
const PLAN: BuildingPlan = {
  generationId: 'gen-test',
  footprint: [[10, 10], [20, 10], [20, 20], [10, 20]],
  floorCount: 1,
  floorHeight: 3,
  floors: [],
  warnings: [],
  params: DEFAULT_PARAMS,
}

function ctx(overrides: Partial<CandidateEvaluation> = {}): CandidateEvaluation {
  return {
    program: PROGRAM,
    zoning: ZONING,
    plotPolygon: PLOT_50x30,
    plotArea: PLOT_AREA,
    plan: PLAN,
    schedule: SCHEDULE,
    cost: COST,
    ...overrides,
  }
}

describe('runComplianceChecks — happy path', () => {
  it('all five checks pass for an in-spec candidate', () => {
    const checks = runComplianceChecks(ctx())
    expect(checks).toHaveLength(5)
    expect(checks.every((c) => c.pass)).toBe(true)
    // Stable order — UI relies on this for tooltips.
    expect(checks.map((c) => c.name)).toEqual([
      'envelopeContainment',
      'far',
      'coverage',
      'height',
      'openSpace',
    ])
  })
})

describe('envelopeContainment', () => {
  it('fails when footprint pokes outside the setback envelope', () => {
    // Push the footprint into the front-setback band (y < 5).
    const checks = runComplianceChecks(
      ctx({
        plan: { ...PLAN, footprint: [[10, 1], [20, 1], [20, 6], [10, 6]] },
      }),
    )
    const env = checks.find((c) => c.name === 'envelopeContainment')!
    expect(env.pass).toBe(false)
    expect(env.measured).toBeGreaterThan(0)
    expect(env.detail).toMatch(/overflows/)
  })

  it('passes for a footprint that exactly touches but does not cross the envelope', () => {
    // Front setback 5, side 3 → envelope inner edges at y=5, x=3, etc.
    // Footprint flush at y=5 should still pass (vertex on the boundary).
    const checks = runComplianceChecks(
      ctx({
        plan: { ...PLAN, footprint: [[5, 5], [15, 5], [15, 15], [5, 15]] },
      }),
    )
    const env = checks.find((c) => c.name === 'envelopeContainment')!
    expect(env.pass).toBe(true)
  })
})

describe('far', () => {
  it('fails when GFA / plotArea exceeds maxFAR', () => {
    // GFA 4000 / 1500 = 2.67 > 2.0
    const checks = runComplianceChecks(
      ctx({
        schedule: { ...SCHEDULE, totals: { gea: 4000, nia: 3200, efficiency: 0.8 } },
      }),
    )
    const r = checks.find((c) => c.name === 'far')!
    expect(r.pass).toBe(false)
    expect(r.measured).toBeCloseTo(4000 / 1500, 6)
    expect(r.limit).toBe(2)
  })

  it('passes when GFA exactly equals the FAR cap', () => {
    const checks = runComplianceChecks(
      ctx({
        schedule: { ...SCHEDULE, totals: { gea: 3000, nia: 2400, efficiency: 0.8 } },
      }),
    )
    expect(checks.find((c) => c.name === 'far')!.pass).toBe(true)
  })
})

describe('coverage', () => {
  it('fails when footprint / plot exceeds maxCoverage', () => {
    // 1000 m² footprint on 1500 m² plot = 0.667 > 0.6
    const big: [number, number][] = [
      [10, 10],
      [60, 10],
      [60, 30],
      [10, 30],
    ]
    const checks = runComplianceChecks(
      ctx({ plan: { ...PLAN, footprint: big } }),
    )
    const r = checks.find((c) => c.name === 'coverage')!
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/exceeds/)
  })
})

describe('height', () => {
  it('fails when floorCount × floorHeight exceeds maxHeight', () => {
    // 9 × 3 = 27m > 24m
    const checks = runComplianceChecks(
      ctx({ plan: { ...PLAN, floorCount: 9, floorHeight: 3 } }),
    )
    const r = checks.find((c) => c.name === 'height')!
    expect(r.pass).toBe(false)
    expect(r.measured).toBe(27)
    expect(r.limit).toBe(24)
  })

  it('passes at exactly the limit', () => {
    const checks = runComplianceChecks(
      ctx({ plan: { ...PLAN, floorCount: 8, floorHeight: 3 } }),
    )
    expect(checks.find((c) => c.name === 'height')!.pass).toBe(true)
  })
})

describe('openSpace', () => {
  it('fails when open area falls below minOpenSpace', () => {
    // 1100 m² footprint on 1500 m² plot → open 26.7% < 30%
    const big: [number, number][] = [
      [5, 5],
      [60, 5],
      [60, 25],
      [5, 25],
    ]
    const checks = runComplianceChecks(
      ctx({ plan: { ...PLAN, footprint: big } }),
    )
    const r = checks.find((c) => c.name === 'openSpace')!
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/below minimum/)
  })
})

describe('compliance objective integration', () => {
  it('scores 0.8 (4/5) when exactly one check fails', () => {
    const r = compliance(
      ctx({ plan: { ...PLAN, floorCount: 9, floorHeight: 3 } }),
    )
    expect(r.score).toBeCloseTo(0.8, 6)
    expect(r.notes?.length).toBe(1)
    expect(r.notes?.[0]).toMatch(/^height:/)
  })

  it('scores 0.6 (3/5) when two checks fail', () => {
    const r = compliance(
      ctx({
        plan: { ...PLAN, floorCount: 9, floorHeight: 3 },
        schedule: { ...SCHEDULE, totals: { gea: 4000, nia: 3200, efficiency: 0.8 } },
      }),
    )
    expect(r.score).toBeCloseTo(0.6, 6)
    expect(r.notes?.length).toBe(2)
  })

  it('scores 1.0 with no notes when every check passes', () => {
    const r = compliance(ctx())
    expect(r.score).toBe(1)
    expect(r.notes).toBeUndefined()
  })
})
