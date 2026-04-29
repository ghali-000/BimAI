import { describe, expect, it } from 'vitest'
import type { RoomKind } from '../types'
import {
  BATHROOM_MAX_AREA_M2,
  FRACTION_EPSILON,
  InvalidTemplateError,
  MIN_ROOM_DIMENSION_M,
  type ProportionalSlice,
  type SubdivideSpec,
  type UnitTemplate,
  computeLeafAllocations,
  getUnitTemplate,
  isAreaInBand,
  leafKinds,
  listUnitTemplates,
  validateTemplate,
} from './rooms-templates'

// Note on scope: these tests cover the *template format* — structural
// correctness, fraction sums, leaf/non-leaf invariants, and the
// expected room-kind set per unit type. The "instantiate against a
// reference unit" tests (areas in expected bands, all bedrooms touch
// a facade, dimension floor) belong to the Task 4 packer where the
// instantiator actually exists.

function sumFractions(spec: SubdivideSpec): number {
  let s = 0
  for (const slice of spec.slices) s += slice.fraction
  return s
}

function visitSlices(
  spec: SubdivideSpec,
  fn: (slice: ProportionalSlice, path: string) => void,
  path = 'rootSplit',
): void {
  spec.slices.forEach((slice, i) => {
    const p = `${path}.slices[${i}]`
    fn(slice, p)
    if (slice.subdivide) visitSlices(slice.subdivide, fn, `${p}.subdivide`)
  })
}

function depth(spec: SubdivideSpec): number {
  let d = 1
  for (const s of spec.slices) {
    if (s.subdivide) d = Math.max(d, 1 + depth(s.subdivide))
  }
  return d
}

describe('UnitTemplate registry', () => {
  it('exposes the five expected unit types', () => {
    const types = listUnitTemplates().map((t) => t.unitType).sort()
    expect(types).toEqual(['1BR', '2BR', '3BR', '4BR', 'Studio'])
  })

  it('looks up templates by unit type', () => {
    expect(getUnitTemplate('Studio')?.unitType).toBe('Studio')
    expect(getUnitTemplate('2BR')?.unitType).toBe('2BR')
    expect(getUnitTemplate('unknown')).toBeUndefined()
  })

  it('uses the default constraints on every template', () => {
    for (const t of listUnitTemplates()) {
      expect(t.constraints.bedroomNeedsFacade).toBe(true)
      expect(t.constraints.bathroomMaxAreaM2).toBe(BATHROOM_MAX_AREA_M2)
      expect(t.constraints.minRoomDimensionM).toBe(MIN_ROOM_DIMENSION_M)
    }
  })
})

describe('template structural invariants', () => {
  it('every subdivide spec has fractions summing to 1.0', () => {
    for (const t of listUnitTemplates()) {
      expect(sumFractions(t.rootSplit)).toBeCloseTo(1.0, 6)
      visitSlices(t.rootSplit, (slice) => {
        if (slice.subdivide) {
          expect(sumFractions(slice.subdivide)).toBeCloseTo(1.0, 6)
        }
      })
    }
  })

  it('every slice is either a leaf (kind set) or a node (subdivide set), never both', () => {
    for (const t of listUnitTemplates()) {
      visitSlices(t.rootSplit, (slice) => {
        const hasKind = slice.kind !== undefined
        const hasSub = slice.subdivide !== undefined
        expect(hasKind !== hasSub).toBe(true) // exactly one
      })
    }
  })

  it('caps recursion at two levels (root + one child subdivide)', () => {
    for (const t of listUnitTemplates()) {
      expect(depth(t.rootSplit)).toBeLessThanOrEqual(2)
    }
  })

  it('child subdivides flip axis relative to root', () => {
    for (const t of listUnitTemplates()) {
      const rootAxis = t.rootSplit.axis
      for (const s of t.rootSplit.slices) {
        if (s.subdivide) expect(s.subdivide.axis).not.toBe(rootAxis)
      }
    }
  })
})

describe('expected leaf-kind sets per unit type', () => {
  function expectKinds(unitType: string, expected: Record<RoomKind, number>) {
    const t = getUnitTemplate(unitType)!
    const counts: Record<string, number> = {}
    for (const k of leafKinds(t)) counts[k] = (counts[k] ?? 0) + 1
    for (const [k, n] of Object.entries(expected)) {
      expect(counts[k] ?? 0).toBe(n)
    }
  }

  it('Studio = bathroom + living', () => {
    expectKinds('Studio', {
      bathroom: 1,
      living: 1,
      bedroom: 0,
      kitchen: 0,
      hallway: 0,
      'unit-shell': 0,
    })
  })

  it('1BR = hallway + bathroom + kitchen + living + bedroom', () => {
    expectKinds('1BR', {
      bathroom: 1,
      bedroom: 1,
      kitchen: 1,
      living: 1,
      hallway: 1,
      'unit-shell': 0,
    })
  })

  it('2BR = hallway + bathroom + kitchen + living + 2 bedrooms', () => {
    expectKinds('2BR', {
      bathroom: 1,
      bedroom: 2,
      kitchen: 1,
      living: 1,
      hallway: 1,
      'unit-shell': 0,
    })
  })

  it('3BR = hallway + bathroom + kitchen + living + 3 bedrooms', () => {
    expectKinds('3BR', {
      bathroom: 1,
      bedroom: 3,
      kitchen: 1,
      living: 1,
      hallway: 1,
      'unit-shell': 0,
    })
  })

  it('4BR = hallway + 2 bathrooms + kitchen + living + 4 bedrooms', () => {
    expectKinds('4BR', {
      bathroom: 2,
      bedroom: 4,
      kitchen: 1,
      living: 1,
      hallway: 1,
      'unit-shell': 0,
    })
  })
})

describe('area bands', () => {
  it('every template declares a positive, ordered band', () => {
    for (const t of listUnitTemplates()) {
      expect(t.areaRangeM2.minM2).toBeGreaterThan(0)
      expect(t.areaRangeM2.maxM2).toBeGreaterThan(t.areaRangeM2.minM2)
    }
  })

  it('bands match the brief (Studio 35-45 ... 4BR 130-160)', () => {
    expect(getUnitTemplate('Studio')!.areaRangeM2).toEqual({ minM2: 35, maxM2: 45 })
    expect(getUnitTemplate('1BR')!.areaRangeM2).toEqual({ minM2: 50, maxM2: 65 })
    expect(getUnitTemplate('2BR')!.areaRangeM2).toEqual({ minM2: 75, maxM2: 90 })
    expect(getUnitTemplate('3BR')!.areaRangeM2).toEqual({ minM2: 100, maxM2: 120 })
    expect(getUnitTemplate('4BR')!.areaRangeM2).toEqual({ minM2: 130, maxM2: 160 })
  })

  it('isAreaInBand: midpoint inside, endpoints inside, outside outside', () => {
    const t = getUnitTemplate('2BR')!
    expect(isAreaInBand(t, 82.5)).toBe(true)
    expect(isAreaInBand(t, 75)).toBe(true)
    expect(isAreaInBand(t, 90)).toBe(true)
    expect(isAreaInBand(t, 74.9)).toBe(false)
    expect(isAreaInBand(t, 90.1)).toBe(false)
  })
})

describe('computeLeafAllocations', () => {
  it('sums to the total area', () => {
    for (const t of listUnitTemplates()) {
      const mid = (t.areaRangeM2.minM2 + t.areaRangeM2.maxM2) / 2
      const sum = computeLeafAllocations(t, mid).reduce(
        (acc, l) => acc + l.areaM2,
        0,
      )
      expect(sum).toBeCloseTo(mid, 6)
    }
  })

  it('produces one entry per leaf in template order', () => {
    const t = getUnitTemplate('2BR')!
    const allocs = computeLeafAllocations(t, 82.5)
    expect(allocs.map((a) => a.kind)).toEqual(leafKinds(t))
  })

  it('respects nested fractions (2BR mid-band sanity check)', () => {
    // 2BR @ 82.5: hallway-strip 14% = 11.55 (hallway 60% = 6.93, bath 40% = 4.62);
    // public 48% = 39.6 (kitchen 40% = 15.84, living 60% = 23.76);
    // private 38% = 31.35 (bed-1 55% = 17.24, bed-2 45% = 14.11).
    const allocs = computeLeafAllocations(getUnitTemplate('2BR')!, 82.5)
    const byKind: Record<string, number[]> = {}
    for (const a of allocs) (byKind[a.kind] ??= []).push(a.areaM2)
    expect(byKind.hallway![0]).toBeCloseTo(82.5 * 0.14 * 0.6, 4)
    expect(byKind.bathroom![0]).toBeCloseTo(82.5 * 0.14 * 0.4, 4)
    expect(byKind.kitchen![0]).toBeCloseTo(82.5 * 0.48 * 0.4, 4)
    expect(byKind.living![0]).toBeCloseTo(82.5 * 0.48 * 0.6, 4)
    expect(byKind.bedroom!.sort((a, b) => b - a)).toEqual([
      82.5 * 0.38 * 0.55,
      82.5 * 0.38 * 0.45,
    ])
  })

  it('hallway-embedded bathroom stays under the cap at mid-band for every template', () => {
    // The hallway strip's bathroom (the smaller of the two, in 4BR)
    // is the common case; it should never need clamping at mid-band.
    for (const t of listUnitTemplates()) {
      const mid = (t.areaRangeM2.minM2 + t.areaRangeM2.maxM2) / 2
      const allocs = computeLeafAllocations(t, mid)
      const baths = allocs.filter((a) => a.kind === 'bathroom')
      if (baths.length === 0) continue // (no template currently has zero baths, but be defensive)
      const smallestBath = baths.reduce((m, a) => (a.areaM2 < m.areaM2 ? a : m))
      expect(smallestBath.areaM2).toBeLessThanOrEqual(BATHROOM_MAX_AREA_M2)
    }
  })

  it('flags 4BR en-suite as the documented clamp case at upper mid-band', () => {
    // Brief calls this out explicitly: "4BR template at the top of
    // its band — bathroom slices clamp at bathroomMaxAreaM2 and
    // surplus reallocates." At 145 m² mid-band the en-suite is
    // 145 * 0.46 * 0.12 ≈ 8.004 m² — just over the 8 m² cap. This
    // is the trigger the Task 4 packer's clamp-and-redistribute
    // path needs to fire on; capturing it as a test guards against
    // accidentally re-balancing the template into a no-clamp shape.
    const allocs = computeLeafAllocations(getUnitTemplate('4BR')!, 145)
    const overCap = allocs.filter(
      (a) => a.kind === 'bathroom' && a.areaM2 > BATHROOM_MAX_AREA_M2,
    )
    expect(overCap.length).toBeGreaterThanOrEqual(1)
  })
})

// validateTemplate guards against malformed templates landing in the
// repo. We construct deliberately-bad templates here to confirm the
// thrown errors point at the right path.
describe('validateTemplate', () => {
  function tpl(rootSplit: SubdivideSpec): UnitTemplate {
    return {
      unitType: 'TEST',
      areaRangeM2: { minM2: 30, maxM2: 60 },
      rootSplit,
      constraints: {
        bedroomNeedsFacade: true,
        bathroomMaxAreaM2: BATHROOM_MAX_AREA_M2,
        minRoomDimensionM: MIN_ROOM_DIMENSION_M,
      },
    }
  }

  it('accepts a valid two-level template', () => {
    expect(() =>
      validateTemplate(
        tpl({
          axis: 'along',
          slices: [
            { fraction: 0.5, kind: 'living' },
            {
              fraction: 0.5,
              subdivide: {
                axis: 'across',
                slices: [
                  { fraction: 0.5, kind: 'bedroom' },
                  { fraction: 0.5, kind: 'bathroom' },
                ],
              },
            },
          ],
        }),
      ),
    ).not.toThrow()
  })

  it('throws when fractions do not sum to 1', () => {
    expect(() =>
      validateTemplate(
        tpl({
          axis: 'along',
          slices: [
            { fraction: 0.3, kind: 'living' },
            { fraction: 0.3, kind: 'bedroom' },
          ],
        }),
      ),
    ).toThrow(InvalidTemplateError)
  })

  it('throws when a slice has both kind and subdivide', () => {
    expect(() =>
      validateTemplate(
        tpl({
          axis: 'along',
          slices: [
            {
              fraction: 1.0,
              kind: 'living',
              subdivide: {
                axis: 'across',
                slices: [{ fraction: 1.0, kind: 'bedroom' }],
              },
            },
          ],
        }),
      ),
    ).toThrow(/both kind and subdivide/)
  })

  it('throws when a slice has neither kind nor subdivide', () => {
    expect(() =>
      validateTemplate(
        tpl({
          axis: 'along',
          slices: [{ fraction: 1.0 }],
        }),
      ),
    ).toThrow(/neither kind nor subdivide/)
  })

  it('throws when recursion exceeds two levels', () => {
    expect(() =>
      validateTemplate(
        tpl({
          axis: 'along',
          slices: [
            {
              fraction: 1.0,
              subdivide: {
                axis: 'across',
                slices: [
                  {
                    fraction: 1.0,
                    subdivide: {
                      axis: 'along',
                      slices: [{ fraction: 1.0, kind: 'bedroom' }],
                    },
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toThrow(/two-level depth cap/)
  })

  it('throws on inverted or zero areaRangeM2', () => {
    const bad: UnitTemplate = {
      unitType: 'TEST',
      areaRangeM2: { minM2: 60, maxM2: 30 }, // inverted
      rootSplit: { axis: 'along', slices: [{ fraction: 1.0, kind: 'living' }] },
      constraints: {
        bedroomNeedsFacade: true,
        bathroomMaxAreaM2: BATHROOM_MAX_AREA_M2,
        minRoomDimensionM: MIN_ROOM_DIMENSION_M,
      },
    }
    expect(() => validateTemplate(bad)).toThrow(/areaRangeM2/)
  })

  it('throws on empty slices array', () => {
    expect(() =>
      validateTemplate(tpl({ axis: 'along', slices: [] })),
    ).toThrow(/no slices/)
  })

  it('tolerates floating-point error within FRACTION_EPSILON', () => {
    // 0.1 + 0.2 + 0.7 round-trips through binary float at ~3e-17.
    const sum = 0.1 + 0.2 + 0.7
    expect(Math.abs(sum - 1.0)).toBeLessThan(FRACTION_EPSILON)
    expect(() =>
      validateTemplate(
        tpl({
          axis: 'along',
          slices: [
            { fraction: 0.1, kind: 'bathroom' },
            { fraction: 0.2, kind: 'kitchen' },
            { fraction: 0.7, kind: 'living' },
          ],
        }),
      ),
    ).not.toThrow()
  })
})
