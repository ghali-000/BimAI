import { describe, expect, it } from 'vitest'
import { mulberry32, nextU32 } from './search/rng'
import {
  buildParamSpace,
  DEFAULT_SPACE,
  type ParamSpace,
  plotBoundingBox,
  sampleFromSpace,
} from './space'

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

// ── Phase 3-6 Task 1: plot-adaptive bounds ─────────────────────────────────

describe('buildParamSpace — plot-adaptive bounds', () => {
  it('preserves DEFAULT_SPACE for spacious square plots', () => {
    // 30×30 plot: minSide 30, 0.4 × 30 = 12 → caps at the published 1.5
    // ceiling, so insetMax stays at DEFAULT_SPACE's value. Aspect 1.0 is
    // square-ish so orientation tightens to ±π/36.
    const sp = buildParamSpace({ plotWidth: 30, plotDepth: 30 })
    expect(sp.footprintInsetM).toEqual({ kind: 'range', min: 0.3, max: 1.5 })
    expect(sp.footprintOrientation).toEqual({
      kind: 'range',
      min: -Math.PI / 36,
      max: Math.PI / 36,
    })
    // Other domains are untouched — only the two footprint knobs are
    // plot-sensitive.
    expect(sp.corridorWidthM).toEqual(DEFAULT_SPACE.corridorWidthM)
    expect(sp.packingStrategy).toEqual(DEFAULT_SPACE.packingStrategy)
    expect(sp.seed).toEqual(DEFAULT_SPACE.seed)
  })

  it('widens orientation domain for elongated plots', () => {
    // 50×20: aspect 2.5 > 1.5 ⇒ orientation widens to ±π/24 (still
    // tight — the post-setback envelope, not the raw plot, governs
    // how much rotation the footprint stage will accept).
    const sp = buildParamSpace({ plotWidth: 50, plotDepth: 20 })
    expect(sp.footprintOrientation).toEqual({
      kind: 'range',
      min: -Math.PI / 24,
      max: Math.PI / 24,
    })
  })

  it('shrinks the inset cap for very small plots', () => {
    // 4×4: 0.4 × 4 = 1.6 → still over the 1.5 ceiling, so inset stays
    // at 1.5. 3×3: 0.4 × 3 = 1.2 ⇒ insetMax = 1.2.
    const tight = buildParamSpace({ plotWidth: 3, plotDepth: 3 })
    if (tight.footprintInsetM.kind !== 'range') throw new Error('want range')
    expect(tight.footprintInsetM.min).toBeCloseTo(0.3, 12)
    expect(tight.footprintInsetM.max).toBeCloseTo(1.2, 12)
    // 1×1: 0.4 × 1 = 0.4 — above the 0.3 floor.
    const tiny = buildParamSpace({ plotWidth: 1, plotDepth: 1 })
    if (tiny.footprintInsetM.kind !== 'range') throw new Error('want range')
    expect(tiny.footprintInsetM.min).toBeCloseTo(0.3, 12)
    expect(tiny.footprintInsetM.max).toBeCloseTo(0.4, 12)
  })

  it('floors the inset cap at 0.3 to avoid degenerate point-samples', () => {
    // 0.5 m × 0.5 m: 0.4 × 0.5 = 0.2 ⇒ floored to 0.3 (min == max == 0.3,
    // a constant draw, but never below the structural margin).
    const sp = buildParamSpace({ plotWidth: 0.5, plotDepth: 0.5 })
    expect(sp.footprintInsetM).toEqual({ kind: 'range', min: 0.3, max: 0.3 })
  })

  it('uses DEFAULT_SPACE as a hard fallback for invalid plot dims', () => {
    expect(buildParamSpace({ plotWidth: 0, plotDepth: 10 })).toBe(DEFAULT_SPACE)
    expect(buildParamSpace({ plotWidth: -5, plotDepth: 5 })).toBe(DEFAULT_SPACE)
    expect(buildParamSpace({ plotWidth: NaN, plotDepth: 5 })).toBe(DEFAULT_SPACE)
  })

  it('flips on the aspect-ratio threshold at 1.5 exactly', () => {
    // 15×10: aspect 1.5 — at the threshold, brief-pseudo-code uses ">"
    // which means equal lands on the square branch. Pin this so a
    // future ">=" tweak surfaces in the diff.
    const atThreshold = buildParamSpace({ plotWidth: 15, plotDepth: 10 })
    expect(atThreshold.footprintOrientation).toEqual({
      kind: 'range',
      min: -Math.PI / 36,
      max: Math.PI / 36,
    })
    // Aspect 1.51 — barely elongated.
    const beyondThreshold = buildParamSpace({ plotWidth: 15.1, plotDepth: 10 })
    expect(beyondThreshold.footprintOrientation).toEqual({
      kind: 'range',
      min: -Math.PI / 24,
      max: Math.PI / 24,
    })
  })

  it('orientation symmetric about zero so the median sample is the pre-3-6 default', () => {
    // We sampled [0, π/2] before — uniform mean ≈ π/4 ≈ 45°. Now we
    // sample symmetric ranges so the mean is 0 — the unrotated
    // footprint is the *expected* sample, not an extreme. Pin the
    // sign symmetry so a future widening can't quietly drop it.
    const sp = buildParamSpace({ plotWidth: 50, plotDepth: 20 })
    if (sp.footprintOrientation.kind !== 'range') throw new Error('want range')
    expect(sp.footprintOrientation.min).toBeCloseTo(-sp.footprintOrientation.max, 12)
  })
})

describe('plotBoundingBox', () => {
  it('returns spans for a square polygon', () => {
    expect(
      plotBoundingBox([
        [0, 0],
        [30, 0],
        [30, 30],
        [0, 30],
      ]),
    ).toEqual({ plotWidth: 30, plotDepth: 30 })
  })

  it('returns spans for an elongated polygon', () => {
    expect(
      plotBoundingBox([
        [0, 0],
        [50, 0],
        [50, 20],
        [0, 20],
      ]),
    ).toEqual({ plotWidth: 50, plotDepth: 20 })
  })

  it('returns null for fewer than 3 vertices', () => {
    expect(plotBoundingBox([])).toBeNull()
    expect(plotBoundingBox([[0, 0]])).toBeNull()
    expect(
      plotBoundingBox([
        [0, 0],
        [1, 1],
      ]),
    ).toBeNull()
  })

  it('returns null for collinear vertices (zero-area bbox)', () => {
    expect(
      plotBoundingBox([
        [0, 0],
        [10, 0],
        [20, 0],
      ]),
    ).toBeNull()
  })
})
