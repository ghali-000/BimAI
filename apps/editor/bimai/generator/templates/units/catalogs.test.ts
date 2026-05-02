// Variant-catalog data tests.
//
// The per-file catalogs in this directory are static module-load
// constants: a problem there is a code bug, surfaceable through
// these tests rather than as a runtime crash deep in the bisector.
// Coverage targets the brief's explicit invariants:
//   - every variant's slice fractions sum cleanly (delegated to the
//     Phase 3-7 validator via a synthesized UnitTemplate)
//   - balcony variants have exactly one BalconySpec; non-balcony
//     variants have none
//   - every variant's unitType matches the file it lives in
//   - every variant id is unique across the whole VARIANT_CATALOG

import { describe, expect, it } from 'vitest'
import { validateTemplate } from '../../stages/rooms-templates'
import {
  FOUR_BR_VARIANTS,
  ONE_BR_VARIANTS,
  STUDIO_VARIANTS,
  THREE_BR_VARIANTS,
  TWO_BR_VARIANTS,
  VARIANT_CATALOG,
} from './index'
import type { UnitVariantTemplate } from './types'

const PER_FILE: Array<{ unitType: string; variants: readonly UnitVariantTemplate[] }> = [
  { unitType: 'Studio', variants: STUDIO_VARIANTS },
  { unitType: '1BR', variants: ONE_BR_VARIANTS },
  { unitType: '2BR', variants: TWO_BR_VARIANTS },
  { unitType: '3BR', variants: THREE_BR_VARIANTS },
  { unitType: '4BR', variants: FOUR_BR_VARIANTS },
]

describe('variant catalogs — module-load validation', () => {
  it('every per-file catalog ships at least one variant', () => {
    for (const { unitType, variants } of PER_FILE) {
      expect(variants.length, `${unitType} variants`).toBeGreaterThan(0)
    }
  })

  it("every variant's unitType matches the file it lives in", () => {
    for (const { unitType, variants } of PER_FILE) {
      for (const v of variants) {
        expect(v.unitType, `${v.id}`).toBe(unitType)
      }
    }
  })

  it('every variant id is globally unique across VARIANT_CATALOG', () => {
    const seen = new Set<string>()
    for (const v of VARIANT_CATALOG) {
      expect(seen.has(v.id), `duplicate id: ${v.id}`).toBe(false)
      seen.add(v.id)
    }
    // Sanity: total count = sum of per-file counts.
    expect(seen.size).toBe(
      PER_FILE.reduce((s, p) => s + p.variants.length, 0),
    )
  })

  it("every variant's slice tree passes the Phase 3-7 SubdivideSpec validator", () => {
    // Wrap each variant into a UnitTemplate-shaped object so we can
    // reuse `validateTemplate`. `nominal` is a free-pick within the
    // band — picking the midpoint is fine, validateTemplate only
    // checks min < nominal < max.
    for (const v of VARIANT_CATALOG) {
      const min = v.areaBand.minM2
      const max = v.areaBand.maxM2
      const nominal = (min + max) / 2
      expect(() =>
        validateTemplate({
          unitType: v.unitType,
          areaRangeM2: { min, max, nominal },
          rootSplit: v.slices,
          constraints: {
            bedroomNeedsFacade: true,
            bathroomMaxAreaM2: 8,
            minRoomDimensionM: 1.5,
          },
        }),
      ).not.toThrow()
    }
  })

  it('every variant has a non-empty label and id', () => {
    for (const v of VARIANT_CATALOG) {
      expect(v.id.length).toBeGreaterThan(0)
      expect(v.label.length).toBeGreaterThan(0)
    }
  })

  it('every variant has a positive, well-ordered area band', () => {
    for (const v of VARIANT_CATALOG) {
      expect(v.areaBand.minM2).toBeGreaterThan(0)
      expect(v.areaBand.maxM2).toBeGreaterThan(v.areaBand.minM2)
    }
  })
})

describe('variant catalogs — balcony invariants', () => {
  it('balcony variants have exactly one BalconySpec, non-balcony variants have none', () => {
    for (const v of VARIANT_CATALOG) {
      if (v.hasBalcony) {
        expect(v.balcony, `${v.id}`).toBeDefined()
        expect(v.balcony!.depthM).toBeGreaterThan(0)
      } else {
        expect(v.balcony, `${v.id}`).toBeUndefined()
      }
    }
  })

  it('every catalog ships at least one indoor-only (no-balcony) variant', () => {
    // Critical for `program.generateBalconies = false`: the selector
    // must always have a fallback that excludes balcony variants.
    for (const { unitType, variants } of PER_FILE) {
      const indoor = variants.filter((v) => !v.hasBalcony)
      expect(indoor.length, `${unitType} indoor-only`).toBeGreaterThan(0)
    }
  })

  it("balcony variants' attachTo refers to a living/bedroom/kitchen kind that appears in the slices", () => {
    // Sanity: the emitter (Task 11) projects the balcony off the
    // attached leaf's facade edge — that leaf must exist.
    for (const v of VARIANT_CATALOG) {
      if (!v.hasBalcony) continue
      const target = v.balcony!.attachTo
      const found = collectLeafKinds(v.slices).includes(target)
      expect(found, `${v.id} balcony.attachTo=${target}`).toBe(true)
    }
  })
})

describe('variant catalogs — unit-type coverage', () => {
  it('Studio has at least 1 variant', () => {
    expect(STUDIO_VARIANTS.length).toBeGreaterThanOrEqual(1)
  })

  it('1BR / 2BR / 3BR / 4BR each ship multiple variants', () => {
    expect(ONE_BR_VARIANTS.length).toBeGreaterThanOrEqual(2)
    expect(TWO_BR_VARIANTS.length).toBeGreaterThanOrEqual(2)
    expect(THREE_BR_VARIANTS.length).toBeGreaterThanOrEqual(2)
    expect(FOUR_BR_VARIANTS.length).toBeGreaterThanOrEqual(2)
  })

  it('every unit type from 1BR upward ships at least one balcony variant', () => {
    for (const { unitType, variants } of PER_FILE) {
      if (unitType === 'Studio') continue
      const balcony = variants.filter((v) => v.hasBalcony)
      expect(balcony.length, `${unitType} balcony`).toBeGreaterThanOrEqual(1)
    }
  })
})

// Walk a SubdivideSpec tree and collect every leaf kind. Used for
// the balcony.attachTo cross-check.
function collectLeafKinds(spec: import('../../stages/rooms-templates').SubdivideSpec): string[] {
  const out: string[] = []
  for (const s of spec.slices) {
    if (s.kind) out.push(s.kind)
    if (s.subdivide) out.push(...collectLeafKinds(s.subdivide))
  }
  return out
}
