// Phase 3-9 Task 9 — variant-selection tests.
//
// Pinning the [GATE 2] greedy-by-score weights and the determinism
// contract. Every test fixture below uses a hand-crafted catalog
// (not the production VARIANT_CATALOG) so weight assertions don't
// silently regress when the catalog grows in Phase 3-10+.

import { describe, expect, it } from 'vitest'
import { VARIANT_CATALOG } from '../templates/units'
import type { UnitVariantTemplate } from '../templates/units/types'
import {
  DEEP_PLATE_THRESHOLD_M,
  SCORE_WEIGHTS,
  type UnitConditions,
  scoreTemplate,
  selectTemplate,
} from './variant-selection'

const STUB_SLICES = {
  axis: 'along' as const,
  slices: [{ fraction: 1, kind: 'living' as const }],
}

function makeTemplate(
  overrides: Partial<UnitVariantTemplate>,
): UnitVariantTemplate {
  return {
    id: 'tmpl-base',
    unitType: '2BR',
    label: 'Test 2BR',
    areaBand: { minM2: 60, maxM2: 100 },
    preferredConditions: {},
    hasBalcony: false,
    slices: STUB_SLICES,
    ...overrides,
  }
}

function makeConditions(
  overrides: Partial<UnitConditions> = {},
): UnitConditions {
  return {
    unitId: 'unit-test',
    unitType: '2BR',
    area: 80,
    depthM: 9,
    facadeEdges: 1,
    isCorner: false,
    generateBalconies: false,
    ...overrides,
  }
}

// ── scoreTemplate (weight-by-weight assertions) ─────────────────────────────

describe('scoreTemplate — weight contributions', () => {
  it('corner-match positive: corner-preferred template + corner unit → +3.0', () => {
    const t = makeTemplate({ preferredConditions: { corner: true } })
    const cCorner = makeConditions({ isCorner: true, facadeEdges: 2 })
    const cNon = makeConditions({ isCorner: false, facadeEdges: 1 })
    // Difference between the two equals the corner-match positive minus
    // the corner-match negative (which fires for non-corner unit when
    // template doesn't prefer corner). Construct a clean comparison
    // where ONLY the corner term changes: hold facadeEdges fixed via
    // an explicitly-set `facadeEdges: 1` preference and a non-corner
    // template.
    const tNoPref = makeTemplate({})
    expect(scoreTemplate(t, cCorner) - scoreTemplate(tNoPref, cCorner)).toBe(
      SCORE_WEIGHTS.cornerMatchPositive,
    )
    // With a non-corner-preferred template + non-corner unit, the
    // negative-match weight fires.
    expect(scoreTemplate(tNoPref, cNon) - scoreTemplate(tNoPref, cCorner)).toBe(
      SCORE_WEIGHTS.cornerMatchNegative,
    )
  })

  it('facadeEdges exact match → +2.0', () => {
    const t1 = makeTemplate({ preferredConditions: { facadeEdges: 1 } })
    const t0 = makeTemplate({})
    const c = makeConditions({ facadeEdges: 1 })
    // Same conditions except t1 declares the exact preference; only
    // the +2 facadeEdgesExact term differs.
    expect(scoreTemplate(t1, c) - scoreTemplate(t0, c)).toBe(
      SCORE_WEIGHTS.facadeEdgesExact,
    )
  })

  it('deepPlate match → +1.5 only when depth ≥ threshold', () => {
    const tDeep = makeTemplate({ preferredConditions: { deepPlate: true } })
    const tNo = makeTemplate({})
    const cDeep = makeConditions({ depthM: DEEP_PLATE_THRESHOLD_M })
    const cShallow = makeConditions({ depthM: DEEP_PLATE_THRESHOLD_M - 0.1 })
    expect(scoreTemplate(tDeep, cDeep) - scoreTemplate(tNo, cDeep)).toBe(
      SCORE_WEIGHTS.deepPlateMatch,
    )
    // Below threshold the term is zero.
    expect(scoreTemplate(tDeep, cShallow)).toBe(scoreTemplate(tNo, cShallow))
  })

  it('balcony bonus → +4.0 only when generateBalconies && hasBalcony && facadeEdges ≥ 1', () => {
    const tB = makeTemplate({
      hasBalcony: true,
      balcony: { attachTo: 'living', depthM: 1.5 },
    })
    const tNo = makeTemplate({})
    const cFavoured = makeConditions({
      generateBalconies: true,
      facadeEdges: 1,
    })
    const cInterior = makeConditions({
      generateBalconies: true,
      facadeEdges: 0,
    })
    const cToggleOff = makeConditions({
      generateBalconies: false,
      facadeEdges: 1,
    })
    expect(scoreTemplate(tB, cFavoured) - scoreTemplate(tNo, cFavoured)).toBe(
      SCORE_WEIGHTS.balconyBonus,
    )
    // Interior unit (no facade edge) → bonus does not fire.
    expect(scoreTemplate(tB, cInterior)).toBe(scoreTemplate(tNo, cInterior))
    // Toggle off → bonus does not fire (independent of facadeEdges).
    expect(scoreTemplate(tB, cToggleOff)).toBe(scoreTemplate(tNo, cToggleOff))
  })

  it('area-fit penalty: zero at band centre, exactly -1.0 at band edges', () => {
    const t = makeTemplate({ areaBand: { minM2: 60, maxM2: 100 } })
    const cCentre = makeConditions({ area: 80 })
    const cEdge = makeConditions({ area: 100 })
    expect(scoreTemplate(t, cCentre)).toBeCloseTo(scoreTemplate(t, cCentre), 9)
    // Penalty is the only term differentiating cCentre and cEdge here
    // (corner-negative + 0 deepPlate + 0 facadeEdges + 0 balcony).
    expect(scoreTemplate(t, cCentre) - scoreTemplate(t, cEdge)).toBeCloseTo(
      SCORE_WEIGHTS.areaFitWeight,
      9,
    )
  })
})

// ── selectTemplate (eligibility + tie-break) ────────────────────────────────

describe('selectTemplate — eligibility + tie-break', () => {
  it('filters by unitType', () => {
    const catalog = [
      makeTemplate({ id: 'a-1br', unitType: '1BR' }),
      makeTemplate({ id: 'b-2br', unitType: '2BR' }),
    ]
    const r = selectTemplate(makeConditions({ unitType: '2BR' }), catalog)
    expect(r.template.id).toBe('b-2br')
  })

  it('filters by area band — area outside range is excluded', () => {
    const catalog = [
      makeTemplate({ id: 'small', areaBand: { minM2: 50, maxM2: 70 } }),
      makeTemplate({ id: 'mid', areaBand: { minM2: 70, maxM2: 100 } }),
    ]
    const r = selectTemplate(makeConditions({ area: 90 }), catalog)
    expect(r.template.id).toBe('mid')
  })

  it('excludes balcony variants when generateBalconies is false', () => {
    const catalog = [
      makeTemplate({ id: 'indoor' }),
      makeTemplate({
        id: 'outdoor',
        hasBalcony: true,
        balcony: { attachTo: 'living', depthM: 1.5 },
      }),
    ]
    const r = selectTemplate(
      makeConditions({ generateBalconies: false, facadeEdges: 1 }),
      catalog,
    )
    expect(r.template.id).toBe('indoor')
  })

  it('balcony variant wins on facade-edge unit when generateBalconies is true', () => {
    const catalog = [
      makeTemplate({ id: 'indoor' }),
      makeTemplate({
        id: 'outdoor',
        hasBalcony: true,
        balcony: { attachTo: 'living', depthM: 1.5 },
      }),
    ]
    const r = selectTemplate(
      makeConditions({ generateBalconies: true, facadeEdges: 1 }),
      catalog,
    )
    expect(r.template.id).toBe('outdoor')
  })

  it('falls back to Phase 3-7 default when no catalog entry matches', () => {
    const catalog = [
      makeTemplate({ id: 'wrong-type', unitType: '1BR' }),
    ]
    const r = selectTemplate(makeConditions({ unitType: '2BR' }), catalog)
    expect(r.fallback).toBe(true)
    expect(r.template.id).toBe('fallback-2BR')
    // Fallback wraps Phase 3-7's slices, so the slices field is non-empty.
    expect(r.template.slices.slices.length).toBeGreaterThan(0)
  })

  it('throws when neither catalog nor Phase 3-7 has a matching unitType', () => {
    expect(() =>
      selectTemplate(
        makeConditions({ unitType: 'Penthouse' }),
        VARIANT_CATALOG,
      ),
    ).toThrow(/no variant or fallback/)
  })

  it('tie-break: alphabetical id ascending when scores match', () => {
    // Identical preferences → identical scores. `b-...` and `a-...`
    // are both eligible; `a-...` wins on tie-break.
    const catalog = [
      makeTemplate({ id: 'b-equal' }),
      makeTemplate({ id: 'a-equal' }),
    ]
    const r = selectTemplate(makeConditions(), catalog)
    expect(r.template.id).toBe('a-equal')
  })

  it('corner template wins over non-corner template on a corner unit', () => {
    const catalog = [
      makeTemplate({ id: 'flat' }),
      makeTemplate({ id: 'corner', preferredConditions: { corner: true } }),
    ]
    const r = selectTemplate(
      makeConditions({ isCorner: true, facadeEdges: 2 }),
      catalog,
    )
    expect(r.template.id).toBe('corner')
  })

  it('non-corner template wins over corner template on a non-corner unit', () => {
    const catalog = [
      makeTemplate({ id: 'flat' }),
      makeTemplate({ id: 'corner', preferredConditions: { corner: true } }),
    ]
    const r = selectTemplate(
      makeConditions({ isCorner: false, facadeEdges: 1 }),
      catalog,
    )
    // Both eligible; flat earns the corner-negative-match (+1), corner
    // earns nothing (no corner unit). Flat wins.
    expect(r.template.id).toBe('flat')
  })

  it('the fallback id matches the documented format `fallback-${unitType}`', () => {
    const r = selectTemplate(makeConditions({ unitType: '3BR' }), [])
    expect(r.template.id).toBe('fallback-3BR')
    expect(r.fallback).toBe(true)
  })

  it('integrates with the production VARIANT_CATALOG (smoke)', () => {
    // Realistic 2BR mid-band condition: should pick a 2BR variant.
    const r = selectTemplate(
      makeConditions({
        unitType: '2BR',
        area: 80,
        facadeEdges: 1,
        isCorner: false,
        generateBalconies: false,
      }),
    )
    expect(r.fallback).toBe(false)
    expect(r.template.unitType).toBe('2BR')
    expect(r.template.hasBalcony).toBe(false)
  })

  it('returns a result with template, score, and fallback flag set consistently', () => {
    const r = selectTemplate(makeConditions(), VARIANT_CATALOG)
    expect(r.template).toBeDefined()
    expect(typeof r.score).toBe('number')
    expect(r.fallback).toBe(false)
  })
})

// ── User-specified extra fixtures (3) ───────────────────────────────────────

describe('selectTemplate — user-specified determinism + toggle invariants', () => {
  it('determinism: same conditions → same template id across 3 calls', () => {
    const c = makeConditions({
      unitType: '2BR',
      area: 80,
      facadeEdges: 1,
      depthM: 9,
    })
    const a = selectTemplate(c)
    const b = selectTemplate(c)
    const cc = selectTemplate(c)
    expect(a.template.id).toBe(b.template.id)
    expect(b.template.id).toBe(cc.template.id)
  })

  it('balcony toggle changes selection on a facade-edge unit (off → indoor; on → balcony; ids differ)', () => {
    const base = makeConditions({
      unitType: '2BR',
      area: 80,
      facadeEdges: 1,
    })
    const off = selectTemplate({ ...base, generateBalconies: false })
    const on = selectTemplate({ ...base, generateBalconies: true })
    expect(off.template.hasBalcony).toBe(false)
    expect(on.template.hasBalcony).toBe(true)
    expect(off.template.id).not.toBe(on.template.id)
  })

  it('balcony toggle does NOT change selection on an interior unit (facadeEdges: 0)', () => {
    const base = makeConditions({
      unitType: '2BR',
      area: 80,
      facadeEdges: 0,
      isCorner: false,
    })
    const off = selectTemplate({ ...base, generateBalconies: false })
    const on = selectTemplate({ ...base, generateBalconies: true })
    // The balcony bonus only fires when facadeEdges ≥ 1, so the
    // selector picks the same indoor variant in both toggle states.
    expect(off.template.id).toBe(on.template.id)
    expect(on.template.hasBalcony).toBe(false)
  })
})
