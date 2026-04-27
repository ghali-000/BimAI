import { describe, expect, it } from 'vitest'
import {
  BimAIMaterialId,
  ComponentBIM,
  FireRating,
} from './component-bim'

describe('FireRating', () => {
  it('accepts every EN 13501-1 grade plus unrated', () => {
    for (const v of ['A1', 'A2', 'B', 'C', 'D', 'E', 'F', 'unrated']) {
      expect(FireRating.safeParse(v).success).toBe(true)
    }
  })

  it('rejects unknown grades', () => {
    expect(FireRating.safeParse('Z').success).toBe(false)
    expect(FireRating.safeParse('a1').success).toBe(false) // case-sensitive
  })
})

describe('BimAIMaterialId', () => {
  it('parses any string and returns a branded value', () => {
    const id = BimAIMaterialId.parse('concrete-cast')
    // The runtime is just a string; the brand only matters at type level.
    expect(typeof id).toBe('string')
    expect(id).toBe('concrete-cast')
  })

  it('rejects non-string inputs', () => {
    expect(BimAIMaterialId.safeParse(42).success).toBe(false)
    expect(BimAIMaterialId.safeParse(null).success).toBe(false)
  })
})

describe('ComponentBIM', () => {
  it('fills fireRating + loadBearing defaults when absent', () => {
    const r = ComponentBIM.parse({})
    expect(r.fireRating).toBe('unrated')
    expect(r.loadBearing).toBe(false)
    expect(r.material).toBeUndefined()
    expect(r.costOverride).toBeUndefined()
  })

  it('round-trips a fully-populated blob', () => {
    const input = {
      material: 'brick-exterior',
      fireRating: 'A1',
      loadBearing: true,
      costOverride: { perM2: 250 },
    }
    const r = ComponentBIM.parse(input)
    expect(r.material).toBe('brick-exterior')
    expect(r.fireRating).toBe('A1')
    expect(r.loadBearing).toBe(true)
    expect(r.costOverride?.perM2).toBe(250)
    expect(r.costOverride?.perM3).toBeUndefined()
  })

  it('accepts a costOverride with multiple slots set', () => {
    // Cost compute picks the slot that matches the component dimension —
    // having multiple set isn't an error, it's "be ready for any caller".
    const r = ComponentBIM.parse({
      costOverride: { perM2: 200, perM3: 350, flat: 500 },
    })
    expect(r.costOverride).toEqual({ perM2: 200, perM3: 350, flat: 500 })
  })

  it('rejects an invalid fireRating', () => {
    expect(
      ComponentBIM.safeParse({ fireRating: 'a1' }).success,
    ).toBe(false)
  })

  it('treats explicit zero overrides as set, not absent', () => {
    const r = ComponentBIM.parse({ costOverride: { perM2: 0 } })
    // Explicit-zero means "this component is free"; cost compute should
    // honour that rather than fall back to the catalog. Test pins the
    // distinction at the schema layer so future refactors don't drop it.
    expect(r.costOverride?.perM2).toBe(0)
  })
})
