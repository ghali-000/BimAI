// Phase 3-8 Task 6 — roof typology + parapet defaults.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAPET_HEIGHT_M,
  DEFAULT_PARAPET_THICKNESS_M,
  chooseRoofTypology,
  planRoof,
} from './roof'

const FOOTPRINT_30x18: [number, number][] = [
  [0, 0],
  [30, 0],
  [30, 18],
  [0, 18],
]

describe('chooseRoofTypology — GATE 2 lock', () => {
  it('returns flat-with-parapet for residential mid-rise (multi-floor)', () => {
    expect(chooseRoofTypology({ floorCount: 4 })).toBe('flat-with-parapet')
    expect(chooseRoofTypology({ floorCount: 6 })).toBe('flat-with-parapet')
  })
  it('returns flat-with-parapet even for a single-floor building', () => {
    // 3-8 lock: residential program ⇒ parapet, regardless of storey count.
    // Phase 3-9 may relax this when explicit accessory-building intent
    // is part of the input model.
    expect(chooseRoofTypology({ floorCount: 1 })).toBe('flat-with-parapet')
  })
})

describe('planRoof — flat-with-parapet construction', () => {
  it('echoes the footprint as the slab polygon', () => {
    const r = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 3,
      floorHeight: 3,
    })
    expect(r.slabPolygon).toEqual(FOOTPRINT_30x18)
  })

  it('elevation equals floorCount × floorHeight', () => {
    const r = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 5,
      floorHeight: 3,
    })
    expect(r.elevation).toBeCloseTo(15, 9)
  })

  it('emits a parapet with default height + thickness, polygon = footprint', () => {
    const r = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 3,
      floorHeight: 3,
    })
    expect(r.typology).toBe('flat-with-parapet')
    expect(r.parapet).toBeDefined()
    expect(r.parapet!.height).toBeCloseTo(DEFAULT_PARAPET_HEIGHT_M, 9)
    expect(r.parapet!.thickness).toBeCloseTo(DEFAULT_PARAPET_THICKNESS_M, 9)
    expect(r.parapet!.polygon).toEqual(FOOTPRINT_30x18)
  })

  it('mints one canonical parapet wall id per polygon edge', () => {
    const r = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 3,
      floorHeight: 3,
    })
    expect(r.parapet!.wallIds).toHaveLength(FOOTPRINT_30x18.length)
    for (const id of r.parapet!.wallIds) {
      expect(id).toMatch(/^parapet_[0-9a-f]{12}$/)
    }
    // All edge ids are distinct (rectangle's four edges hash to four values).
    expect(new Set(r.parapet!.wallIds).size).toBe(r.parapet!.wallIds.length)
  })

  it('regen with the same footprint yields the same parapet wall ids', () => {
    const a = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 3,
      floorHeight: 3,
    })
    const b = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 3,
      floorHeight: 3,
    })
    expect(a.parapet!.wallIds).toEqual(b.parapet!.wallIds)
  })

  it('different footprints produce different parapet wall ids', () => {
    const a = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 3,
      floorHeight: 3,
    })
    const shifted: [number, number][] = FOOTPRINT_30x18.map(
      (p) => [p[0] + 100, p[1]],
    )
    const b = planRoof({
      footprint: shifted,
      floorCount: 3,
      floorHeight: 3,
    })
    // Same shape, different world position ⇒ different canonical seeds
    // ⇒ different ids. Otherwise two adjacent buildings on the same plot
    // would clash on parapet wall ids.
    expect(a.parapet!.wallIds).not.toEqual(b.parapet!.wallIds)
  })

  it('floorCount changes elevation but does not change parapet wall ids', () => {
    // The parapet hash seeds on footprint geometry only — height is
    // irrelevant. This is the property we want: re-planning a 3-floor
    // building as 5-floor must not invalidate stable wall ids tied to
    // perimeter edges.
    const a = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 3,
      floorHeight: 3,
    })
    const b = planRoof({
      footprint: FOOTPRINT_30x18,
      floorCount: 5,
      floorHeight: 3,
    })
    expect(a.parapet!.wallIds).toEqual(b.parapet!.wallIds)
  })
})
