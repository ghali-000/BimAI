// Variant-template structural validator tests.
//
// Catalogs call `validateUnitVariantCatalog` at module-load time so
// malformed entries can't reach runtime selection. These specs pin
// the structural failure modes the validator catches: bad ids, bad
// area bands, balcony-flag/spec mismatches, duplicate ids.
//
// Deeper `SubdivideSpec` validation lives in `rooms-templates.ts` and
// is tested in `rooms-templates.test.ts` — not re-exercised here.

import { describe, expect, it } from 'vitest'
import {
  InvalidVariantTemplateError,
  type UnitVariantTemplate,
  validateUnitVariantCatalog,
  validateUnitVariantTemplate,
} from './types'

const STUB_SLICES = {
  axis: 'along' as const,
  slices: [{ fraction: 1, kind: 'living' as const }],
}

function make(overrides: Partial<UnitVariantTemplate> = {}): UnitVariantTemplate {
  return {
    id: 'two-br-base',
    unitType: '2BR',
    label: '2BR base',
    areaBand: { minM2: 60, maxM2: 95 },
    preferredConditions: {},
    hasBalcony: false,
    slices: STUB_SLICES,
    ...overrides,
  }
}

describe('validateUnitVariantTemplate', () => {
  it('accepts a well-formed indoor-only template', () => {
    expect(() => validateUnitVariantTemplate(make())).not.toThrow()
  })

  it('accepts a well-formed balcony-equipped template', () => {
    expect(() =>
      validateUnitVariantTemplate(
        make({
          hasBalcony: true,
          balcony: { attachTo: 'living', depthM: 1.5 },
        }),
      ),
    ).not.toThrow()
  })

  it('rejects empty id', () => {
    expect(() => validateUnitVariantTemplate(make({ id: '' }))).toThrow(
      InvalidVariantTemplateError,
    )
  })

  it('rejects unknown unitType', () => {
    expect(() =>
      validateUnitVariantTemplate(make({ unitType: '5BR' })),
    ).toThrow(/not in/)
  })

  it('rejects empty label', () => {
    expect(() => validateUnitVariantTemplate(make({ label: '' }))).toThrow(
      /label/,
    )
  })

  it('rejects inverted area band', () => {
    expect(() =>
      validateUnitVariantTemplate(
        make({ areaBand: { minM2: 100, maxM2: 50 } }),
      ),
    ).toThrow(/inverted/)
  })

  it('rejects non-positive area band edges', () => {
    expect(() =>
      validateUnitVariantTemplate(
        make({ areaBand: { minM2: 0, maxM2: 50 } }),
      ),
    ).toThrow(/minM2/)
    expect(() =>
      validateUnitVariantTemplate(
        make({ areaBand: { minM2: 50, maxM2: 0 } }),
      ),
    ).toThrow(/maxM2/)
  })

  it('rejects hasBalcony=true without a balcony spec', () => {
    expect(() =>
      validateUnitVariantTemplate(make({ hasBalcony: true })),
    ).toThrow(/no balcony spec/)
  })

  it('rejects a balcony spec with hasBalcony=false', () => {
    expect(() =>
      validateUnitVariantTemplate(
        make({ balcony: { attachTo: 'living', depthM: 1.5 } }),
      ),
    ).toThrow(/hasBalcony=false/)
  })

  it('rejects non-positive balcony depth', () => {
    expect(() =>
      validateUnitVariantTemplate(
        make({
          hasBalcony: true,
          balcony: { attachTo: 'living', depthM: 0 },
        }),
      ),
    ).toThrow(/depthM/)
  })
})

describe('validateUnitVariantCatalog', () => {
  it('accepts a catalog with unique ids', () => {
    expect(() =>
      validateUnitVariantCatalog([
        make({ id: 'a' }),
        make({ id: 'b' }),
        make({ id: 'c' }),
      ]),
    ).not.toThrow()
  })

  it('rejects duplicate ids', () => {
    expect(() =>
      validateUnitVariantCatalog([
        make({ id: 'a' }),
        make({ id: 'b' }),
        make({ id: 'a' }),
      ]),
    ).toThrow(/duplicate id 'a'/)
  })

  it('propagates per-entry validation errors', () => {
    expect(() =>
      validateUnitVariantCatalog([
        make({ id: 'good' }),
        make({ id: 'bad', areaBand: { minM2: 100, maxM2: 50 } }),
      ]),
    ).toThrow(InvalidVariantTemplateError)
  })
})
