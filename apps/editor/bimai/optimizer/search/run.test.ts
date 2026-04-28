import type { AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import type { GeneratorInput } from '../../generator/types'
import type { Program, ZoningRules } from '../../schemas'
import { runSearch } from './run'

const SITE_ID = 'site_search_test' as AnyNodeId
const BUILDING_ID = 'building_search_test' as AnyNodeId

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

// Generous plot — the default-space sampler hits compliant configurations
// often enough that small runs find at least a handful of successes.
const PLOT_50x30: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 30],
  [0, 30],
]

function baseInput(): Omit<GeneratorInput, 'params'> {
  return {
    siteId: SITE_ID,
    buildingId: BUILDING_ID,
    plotPolygon: PLOT_50x30,
    zoning: ZONING,
    program: PROGRAM,
  }
}

describe('runSearch — output shape', () => {
  it('produces exactly `count` candidates with unique indices', () => {
    const r = runSearch({ input: baseInput(), count: 25, seed: 42 })
    expect(r.candidates).toHaveLength(25)
    expect(r.stats.sampled).toBe(25)
    const indices = new Set(r.candidates.map((c) => c.candidateIndex))
    expect(indices.size).toBe(25)
    // Indices are 0..count-1.
    for (let i = 0; i < 25; i++) expect(indices.has(i)).toBe(true)
  })

  it('compliant + sum(failures) === sampled', () => {
    const r = runSearch({ input: baseInput(), count: 30, seed: 7 })
    const failureSum = Object.values(r.stats.failures).reduce(
      (s, n) => s + (n ?? 0),
      0,
    )
    expect(r.stats.compliant + failureSum).toBe(r.stats.sampled)
  })

  it('sorts compliant by descending composedScore, failures last', () => {
    const r = runSearch({ input: baseInput(), count: 30, seed: 12 })
    let sawFailure = false
    let lastScore = Infinity
    for (const c of r.candidates) {
      if (!c.compliant) {
        sawFailure = true
        continue
      }
      // Once we see a failure, no compliant candidate should follow.
      expect(sawFailure).toBe(false)
      expect(c.composedScore).toBeLessThanOrEqual(lastScore + 1e-12)
      lastScore = c.composedScore
    }
  })

  it('topK contains up to K compliant candidates and only compliant ones', () => {
    const r = runSearch({ input: baseInput(), count: 30, seed: 1, topK: 4 })
    expect(r.topK.length).toBeLessThanOrEqual(4)
    expect(r.topK.length).toBeLessThanOrEqual(r.stats.compliant)
    for (const c of r.topK) {
      expect(c.compliant).toBe(true)
      expect(c.failure).toBeNull()
    }
  })

  it('heavy fields populated only on topK', () => {
    const r = runSearch({ input: baseInput(), count: 12, seed: 3, topK: 3 })
    for (const c of r.topK) {
      expect(c.plan).toBeDefined()
      expect(c.schedule).toBeDefined()
      expect(c.cost).toBeDefined()
      expect(c.snapshot).toBeDefined()
    }
    // Non-topK candidates must NOT have heavy fields attached.
    const topKIndices = new Set(r.topK.map((c) => c.candidateIndex))
    for (const c of r.candidates) {
      if (topKIndices.has(c.candidateIndex)) continue
      expect(c.plan).toBeUndefined()
      expect(c.schedule).toBeUndefined()
      expect(c.cost).toBeUndefined()
      expect(c.snapshot).toBeUndefined()
    }
  })

  it('bestScore matches the first compliant candidate; 0 when none compliant', () => {
    const r = runSearch({ input: baseInput(), count: 20, seed: 5 })
    if (r.stats.compliant === 0) {
      expect(r.stats.bestScore).toBe(0)
    } else {
      expect(r.stats.bestScore).toBe(r.candidates[0]!.composedScore)
    }
  })
})

describe('runSearch — determinism', () => {
  it('two runs with the same seed produce deeply-equal results (incl. scores)', () => {
    const a = runSearch({ input: baseInput(), count: 50, seed: 42 })
    const b = runSearch({ input: baseInput(), count: 50, seed: 42 })

    // Strip duration AND heavy fields. Heavy fields (plan / snapshot)
    // contain nanoid-minted node + generation IDs which vary per pipeline
    // call by design — so we compare only the deterministic lightweight
    // payload (params, scores, breakdown) plus the failure-bucket stats.
    const stripVolatile = (r: typeof a) => ({
      candidates: r.candidates.map((c) => ({
        candidateIndex: c.candidateIndex,
        params: c.params,
        composedScore: c.composedScore,
        breakdown: c.breakdown,
        compliant: c.compliant,
        failure: c.failure,
      })),
      topKIndices: r.topK.map((c) => c.candidateIndex),
      stats: { ...r.stats, durationMs: 0 },
    })
    expect(stripVolatile(a)).toEqual(stripVolatile(b))

    // Spot-check: every score is identical to the bit (no floating-point
    // drift between runs).
    for (let i = 0; i < a.candidates.length; i++) {
      expect(a.candidates[i]!.composedScore).toBe(b.candidates[i]!.composedScore)
      expect(a.candidates[i]!.candidateIndex).toBe(b.candidates[i]!.candidateIndex)
    }
  })

  it('different seeds produce ≥80% distinct (params) tuples', () => {
    // Catches the seed-not-flowing-to-candidates bug. We compare by index
    // (not by post-sort position) because sorting depends on score and
    // could collide for unrelated reasons.
    const a = runSearch({ input: baseInput(), count: 50, seed: 42 })
    const b = runSearch({ input: baseInput(), count: 50, seed: 43 })
    const byIndex = (r: typeof a) => {
      const m = new Map<number, string>()
      for (const c of r.candidates) {
        m.set(c.candidateIndex, JSON.stringify(c.params))
      }
      return m
    }
    const ma = byIndex(a)
    const mb = byIndex(b)
    let differing = 0
    for (const [idx, paramsA] of ma) {
      if (mb.get(idx) !== paramsA) differing++
    }
    expect(differing / 50).toBeGreaterThanOrEqual(0.8)
  })
})

describe('runSearch — failure bucketing', () => {
  it("buckets failures by reason in stats.failures", () => {
    // Triangle plot with zero area → every candidate fails with
    // envelope_collapsed (the planner can't get past computeEnvelope).
    const collinear: Omit<GeneratorInput, 'params'> = {
      ...baseInput(),
      plotPolygon: [[0, 0], [10, 0], [20, 0]],
    }
    const r = runSearch({ input: collinear, count: 10, seed: 1 })
    expect(r.stats.compliant).toBe(0)
    expect(r.stats.failures.envelope_collapsed).toBe(10)
    expect(r.stats.bestScore).toBe(0)
    expect(r.topK).toEqual([])
  })

  it('every candidate carries a failure object when planning rejected', () => {
    const bad: Omit<GeneratorInput, 'params'> = {
      ...baseInput(),
      plotPolygon: [[0, 0], [1, 0]], // <3 vertices → invalid_input
    }
    const r = runSearch({ input: bad, count: 5, seed: 1 })
    for (const c of r.candidates) {
      expect(c.compliant).toBe(false)
      expect(c.failure).not.toBeNull()
      expect(c.composedScore).toBe(0)
      expect(c.breakdown).toBeNull()
    }
    expect(r.stats.failures.invalid_input).toBe(5)
  })
})

describe('runSearch — weights affect ranking', () => {
  it('muting compliance does not change which candidate ranks first when scores stay distinct', () => {
    // Sanity test: weights are wired through. With default weights and a
    // weight bag muting everything except sellableArea, the highest-NIA
    // compliant candidate should win.
    const r = runSearch({
      input: baseInput(),
      count: 20,
      seed: 99,
      weights: {
        mixAccuracy: 0,
        sellableArea: 1,
        costPerUnit: 0,
        compliance: 0,
      },
    })
    if (r.topK.length === 0) return
    const top = r.topK[0]!
    // Top candidate's sellableArea sub-score must equal its overall score
    // (since other weights are zero).
    expect(top.composedScore).toBeCloseTo(
      top.breakdown!.sellableArea.score,
      6,
    )
  })
})
