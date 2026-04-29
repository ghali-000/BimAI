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
  getUnitTemplate,
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

// validateTemplate guards against malformed templates landing in the
// repo. We construct deliberately-bad templates here to confirm the
// thrown errors point at the right path.
describe('validateTemplate', () => {
  function tpl(rootSplit: SubdivideSpec): UnitTemplate {
    return {
      unitType: 'TEST',
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
