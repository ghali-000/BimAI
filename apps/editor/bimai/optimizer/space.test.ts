import { describe, expect, it } from 'vitest'
import { mulberry32, nextU32 } from './search/rng'
import { DEFAULT_SPACE, type ParamSpace, sampleFromSpace } from './space'

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 8; i++) expect(a()).toBe(b())
  })

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    // First draws must differ — it would be a bad PRNG if they didn't.
    expect(a()).not.toBe(b())
  })

  it('stays in [0, 1)', () => {
    const r = mulberry32(123)
    for (let i = 0; i < 1000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('nextU32 returns integers in uint32 range', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 100; i++) {
      const v = nextU32(r)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffff_ffff)
    }
  })
})

describe('sampleFromSpace — bounds', () => {
  it('every sampled GenerationParams stays inside DEFAULT_SPACE bounds', () => {
    const rng = mulberry32(1)
    for (let i = 0; i < 200; i++) {
      const p = sampleFromSpace(DEFAULT_SPACE, rng)
      // Numeric ranges (range)
      expect(p.footprintInsetM).toBeGreaterThanOrEqual(0.3)
      expect(p.footprintInsetM).toBeLessThan(1.5 + 1e-9)
      expect(p.footprintOrientation).toBeGreaterThanOrEqual(0)
      expect(p.footprintOrientation).toBeLessThan(Math.PI / 2 + 1e-9)
      expect(p.corridorWidthM).toBeGreaterThanOrEqual(1.2)
      expect(p.corridorWidthM).toBeLessThan(2.4 + 1e-9)
      // Ints
      expect(Number.isInteger(p.seed)).toBe(true)
      expect(p.seed).toBeGreaterThanOrEqual(0)
      expect(p.seed).toBeLessThanOrEqual(0x7fff_ffff)
      expect(Number.isInteger(p.variant)).toBe(true)
      expect(p.variant).toBeGreaterThanOrEqual(0)
      expect(p.variant).toBeLessThanOrEqual(7)
      // Enums
      expect([
        'demand-based',
        'fill-far',
        'fill-height',
      ]).toContain(p.floorCountStrategy)
      expect(['long-axis', 'short-axis', 'auto']).toContain(p.corridorOrientation)
      expect([
        'left-to-right',
        'alternating',
        'grouped-by-type',
      ]).toContain(p.packingStrategy)
      expect([
        'mix-declared',
        'largest-first',
        'smallest-first',
      ]).toContain(p.unitOrderingHeuristic)
    }
  })

  it('exercises every enum value across many samples', () => {
    // Sanity: with 1500 draws and 3-value enums, every value should appear.
    // Probability of missing one is (2/3)^1500 ≈ 10^-264.
    const rng = mulberry32(99)
    const seen = {
      floor: new Set<string>(),
      corridor: new Set<string>(),
      packing: new Set<string>(),
      ordering: new Set<string>(),
    }
    for (let i = 0; i < 1500; i++) {
      const p = sampleFromSpace(DEFAULT_SPACE, rng)
      seen.floor.add(p.floorCountStrategy)
      seen.corridor.add(p.corridorOrientation)
      seen.packing.add(p.packingStrategy)
      seen.ordering.add(p.unitOrderingHeuristic)
    }
    expect(seen.floor.size).toBe(3)
    expect(seen.corridor.size).toBe(3)
    expect(seen.packing.size).toBe(3)
    expect(seen.ordering.size).toBe(3)
  })
})

describe('sampleFromSpace — determinism', () => {
  it('same seed produces the same N-candidate sequence', () => {
    const a = mulberry32(2026)
    const b = mulberry32(2026)
    for (let i = 0; i < 10; i++) {
      const pa = sampleFromSpace(DEFAULT_SPACE, a)
      const pb = sampleFromSpace(DEFAULT_SPACE, b)
      expect(pa).toEqual(pb)
    }
  })

  it('different seeds diverge by the first sample', () => {
    const a = sampleFromSpace(DEFAULT_SPACE, mulberry32(1))
    const b = sampleFromSpace(DEFAULT_SPACE, mulberry32(2))
    // At least one numeric field must differ; the seed field draws first
    // and is the most reliable bellwether.
    expect(a.seed).not.toBe(b.seed)
  })
})

describe('sampleFromSpace — two-level seeding', () => {
  it('sampled candidates carry distinct seeds', () => {
    // Two-level model: master rng drives the *sequence* of params; each
    // candidate carries its own `seed` for stage-level randomness. Two
    // consecutive samples should almost certainly carry different seeds.
    const rng = mulberry32(7)
    const a = sampleFromSpace(DEFAULT_SPACE, rng)
    const b = sampleFromSpace(DEFAULT_SPACE, rng)
    expect(a.seed).not.toBe(b.seed)
  })

  it('master sequence reproducibility is independent of per-candidate seed use', () => {
    // Run 1: sample 5 candidates, then draw a child rng from candidate
    // 0's seed and pull 3 numbers.
    const m1 = mulberry32(99)
    const cands1 = Array.from({ length: 5 }, () =>
      sampleFromSpace(DEFAULT_SPACE, m1),
    )
    const child1 = mulberry32(cands1[0]!.seed)
    const childDraws1 = [child1(), child1(), child1()]

    // Run 2: same master seed, sample 5 candidates. The candidate seeds
    // and the resulting child sequence must match Run 1 exactly.
    const m2 = mulberry32(99)
    const cands2 = Array.from({ length: 5 }, () =>
      sampleFromSpace(DEFAULT_SPACE, m2),
    )
    const child2 = mulberry32(cands2[0]!.seed)
    const childDraws2 = [child2(), child2(), child2()]

    expect(cands2.map((c) => c.seed)).toEqual(cands1.map((c) => c.seed))
    expect(childDraws2).toEqual(childDraws1)
  })
})

describe('sampleFromSpace — custom space overrides', () => {
  it('respects a tightened range domain', () => {
    const space: ParamSpace = {
      ...DEFAULT_SPACE,
      corridorWidthM: { kind: 'range', min: 1.5, max: 1.5 + 1e-9 },
    }
    const rng = mulberry32(0)
    for (let i = 0; i < 50; i++) {
      const p = sampleFromSpace(space, rng)
      expect(p.corridorWidthM).toBeCloseTo(1.5, 6)
    }
  })

  it('respects a single-value enum domain', () => {
    const space: ParamSpace = {
      ...DEFAULT_SPACE,
      packingStrategy: { kind: 'enum', values: ['alternating'] },
    }
    const rng = mulberry32(0)
    for (let i = 0; i < 20; i++) {
      const p = sampleFromSpace(space, rng)
      expect(p.packingStrategy).toBe('alternating')
    }
  })

  it('int domain reaches both endpoints across many draws', () => {
    const space: ParamSpace = {
      ...DEFAULT_SPACE,
      variant: { kind: 'int', min: 0, max: 1 },
    }
    const rng = mulberry32(42)
    const seen = new Set<number>()
    for (let i = 0; i < 50; i++) {
      seen.add(sampleFromSpace(space, rng).variant)
    }
    expect(seen.has(0)).toBe(true)
    expect(seen.has(1)).toBe(true)
    expect(seen.size).toBe(2) // never out of bounds
  })
})
