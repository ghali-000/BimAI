import { describe, expect, it } from 'vitest'
import type { BimAIMaterialId } from './schemas/component-bim'
import {
  BIMAI_MATERIALS,
  defaultMaterialFor,
  getMaterial,
  materialsApplicableTo,
  tryGetMaterial,
} from './materials'

describe('BIMAI_MATERIALS catalog', () => {
  it('has each entry self-consistent (key === id)', () => {
    for (const [key, mat] of Object.entries(BIMAI_MATERIALS)) {
      expect(mat.id).toBe(key)
    }
  })

  it('covers every component type the generator emits today', () => {
    // wall / slab / door / window — roof is forward-compat only.
    const covered = new Set<string>()
    for (const m of Object.values(BIMAI_MATERIALS)) {
      for (const t of m.applicableTo) covered.add(t)
    }
    expect(covered.has('wall')).toBe(true)
    expect(covered.has('slab')).toBe(true)
    expect(covered.has('door')).toBe(true)
    expect(covered.has('window')).toBe(true)
  })

  it('uses A1 fire rating for every concrete-based material', () => {
    // Sanity check: concrete is non-combustible. Catches typos.
    const concretes = Object.values(BIMAI_MATERIALS).filter((m) =>
      m.id.toString().startsWith('concrete-'),
    )
    expect(concretes.length).toBeGreaterThan(0)
    for (const m of concretes) expect(m.fireRating).toBe('A1')
  })

  it('prices windows + doors per-unit, not per-m²', () => {
    // The cost compute layer dispatches on which slot is set; lock the
    // catalog convention so a future edit doesn't quietly break it.
    expect(BIMAI_MATERIALS['door-residential'].costPerUnit).toBeDefined()
    expect(BIMAI_MATERIALS['door-residential'].costPerM2).toBeUndefined()
    expect(BIMAI_MATERIALS['window-double-glazed'].costPerUnit).toBeDefined()
    expect(BIMAI_MATERIALS['window-double-glazed'].costPerM2).toBeUndefined()
  })

  it('prices walls + slabs per-m², not per-unit', () => {
    for (const id of [
      'concrete-cast',
      'concrete-slab-residential',
      'concrete-precast-facade',
      'drywall-residential',
      'partition-acoustic',
      'brick-exterior',
    ] as const) {
      expect(BIMAI_MATERIALS[id].costPerM2).toBeDefined()
      expect(BIMAI_MATERIALS[id].costPerUnit).toBeUndefined()
    }
  })
})

describe('getMaterial', () => {
  it('returns the material for a known id', () => {
    const m = getMaterial(BIMAI_MATERIALS['brick-exterior'].id)
    expect(m.name).toBe('Brick veneer on stud')
  })

  it('throws for an unknown id', () => {
    expect(() => getMaterial('not-a-material' as BimAIMaterialId)).toThrow(
      /unknown BimAI material/,
    )
  })
})

describe('tryGetMaterial', () => {
  it('returns undefined for unknown ids and undefined inputs', () => {
    expect(tryGetMaterial(undefined)).toBeUndefined()
    expect(tryGetMaterial('not-a-material' as BimAIMaterialId)).toBeUndefined()
  })

  it('returns the material for a known id', () => {
    const m = tryGetMaterial(BIMAI_MATERIALS['concrete-cast'].id)
    expect(m?.name).toBe('Cast-in-place concrete')
  })
})

describe('defaultMaterialFor', () => {
  it('exterior wall → brick-exterior', () => {
    expect(defaultMaterialFor('wall', { isExterior: true })).toBe(
      BIMAI_MATERIALS['brick-exterior'].id,
    )
  })

  it('interior load-bearing wall → concrete-cast', () => {
    expect(
      defaultMaterialFor('wall', { isExterior: false, isLoadBearing: true }),
    ).toBe(BIMAI_MATERIALS['concrete-cast'].id)
  })

  it('interior non-load-bearing wall → drywall-residential', () => {
    expect(defaultMaterialFor('wall', {})).toBe(
      BIMAI_MATERIALS['drywall-residential'].id,
    )
    expect(
      defaultMaterialFor('wall', { isExterior: false, isLoadBearing: false }),
    ).toBe(BIMAI_MATERIALS['drywall-residential'].id)
  })

  it('exterior wins over loadBearing — exterior+loadBearing still picks brick', () => {
    // This is a deliberate priority. An exterior load-bearing wall is
    // an exterior wall first; cost computation reads loadBearing
    // separately for structural reporting.
    expect(
      defaultMaterialFor('wall', { isExterior: true, isLoadBearing: true }),
    ).toBe(BIMAI_MATERIALS['brick-exterior'].id)
  })

  it('slab → concrete-slab-residential', () => {
    expect(defaultMaterialFor('slab')).toBe(
      BIMAI_MATERIALS['concrete-slab-residential'].id,
    )
  })

  it('door → door-residential', () => {
    expect(defaultMaterialFor('door')).toBe(
      BIMAI_MATERIALS['door-residential'].id,
    )
  })

  it('window → window-double-glazed', () => {
    expect(defaultMaterialFor('window')).toBe(
      BIMAI_MATERIALS['window-double-glazed'].id,
    )
  })
})

describe('materialsApplicableTo', () => {
  it('returns only materials whose applicableTo includes the type', () => {
    const wallMats = materialsApplicableTo('wall')
    for (const m of wallMats) expect(m.applicableTo).toContain('wall')
    // Walls have a richer choice (≥ 5) than doors / windows.
    expect(wallMats.length).toBeGreaterThanOrEqual(5)
    expect(materialsApplicableTo('door')).toHaveLength(1)
    expect(materialsApplicableTo('window')).toHaveLength(1)
  })

  it('returns an empty array for component types with no entries', () => {
    expect(materialsApplicableTo('roof')).toEqual([])
  })
})
