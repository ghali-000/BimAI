import { describe, expect, it } from 'vitest'
import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { BIMAI_MATERIALS } from '../bim/materials'
import { BimAIMaterialId } from '../bim/schemas/component-bim'
import {
  hasNodeBIM,
  mergeBIMPatch,
  metadataWithBIM,
  readNodeBIM,
} from './component-bim'

// Minimal-cast node builders, same convention as the rest of the bimai tests.
function makeNode(extra: Record<string, unknown> = {}): AnyNode {
  return {
    object: 'node',
    id: 'wall_1' as AnyNodeId,
    type: 'wall',
    parentId: null,
    visible: true,
    metadata: {},
    ...extra,
  } as unknown as AnyNode
}

const BRICK = BimAIMaterialId.parse(BIMAI_MATERIALS['brick-exterior'].id)
const DRYWALL = BimAIMaterialId.parse(BIMAI_MATERIALS['drywall-residential'].id)

describe('readNodeBIM', () => {
  it('returns null for null / undefined inputs', () => {
    expect(readNodeBIM(null)).toBeNull()
    expect(readNodeBIM(undefined)).toBeNull()
  })

  it('returns null when metadata.bimai.bim is absent', () => {
    expect(readNodeBIM(makeNode())).toBeNull()
    expect(readNodeBIM(makeNode({ metadata: { bimai: {} } }))).toBeNull()
    expect(
      readNodeBIM(makeNode({ metadata: { bimai: { wallRole: 'perimeter' } } })),
    ).toBeNull()
  })

  it('returns the parsed shape when bim is valid', () => {
    const node = makeNode({
      metadata: {
        bimai: {
          bim: {
            material: BRICK,
            fireRating: 'A1',
            loadBearing: true,
          },
        },
      },
    })
    const r = readNodeBIM(node)
    expect(r).not.toBeNull()
    expect(r?.material).toBe(BRICK)
    expect(r?.fireRating).toBe('A1')
    expect(r?.loadBearing).toBe(true)
  })

  it('returns null when bim is present but invalid (corrupt blob)', () => {
    // Corrupt blob — fireRating must be a valid grade or 'unrated'.
    const node = makeNode({
      metadata: { bimai: { bim: { fireRating: 'Z' } } },
    })
    expect(readNodeBIM(node)).toBeNull()
  })

  it('honours Zod defaults (fireRating, loadBearing) when bim is the empty object', () => {
    const node = makeNode({ metadata: { bimai: { bim: {} } } })
    const r = readNodeBIM(node)
    expect(r?.fireRating).toBe('unrated')
    expect(r?.loadBearing).toBe(false)
    expect(r?.material).toBeUndefined()
  })
})

describe('hasNodeBIM', () => {
  it('returns false when bim is missing', () => {
    expect(hasNodeBIM(makeNode())).toBe(false)
    expect(hasNodeBIM(makeNode({ metadata: { bimai: {} } }))).toBe(false)
  })

  it('returns true when bim is present, even if invalid', () => {
    expect(hasNodeBIM(makeNode({ metadata: { bimai: { bim: {} } } }))).toBe(true)
    // Pin: present-but-invalid must still report "has", so the panel knows
    // not to show the "apply defaults" button (the user has *something*
    // there, even if corrupt — the right action is to show the form).
    expect(
      hasNodeBIM(makeNode({ metadata: { bimai: { bim: { fireRating: 'Z' } } } })),
    ).toBe(true)
  })
})

describe('mergeBIMPatch', () => {
  it('starts from defaults when existing is null', () => {
    const r = mergeBIMPatch(null, { material: BRICK })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.material).toBe(BRICK)
    expect(r.value.fireRating).toBe('unrated') // default
    expect(r.value.loadBearing).toBe(false) // default
  })

  it('preserves existing fields when patching one slot', () => {
    const existing = mergeBIMPatch(null, {
      material: BRICK,
      fireRating: 'A1',
      loadBearing: true,
    })
    if (!existing.ok) throw new Error('setup')
    const r = mergeBIMPatch(existing.value, { material: DRYWALL })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.material).toBe(DRYWALL)
    expect(r.value.fireRating).toBe('A1') // preserved
    expect(r.value.loadBearing).toBe(true) // preserved
  })

  it('drops `undefined` patch fields rather than clobbering existing values', () => {
    const seed = mergeBIMPatch(null, { material: BRICK, fireRating: 'A1' })
    if (!seed.ok) throw new Error('setup')
    const r = mergeBIMPatch(seed.value, {
      material: undefined,
      fireRating: 'A2',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.material).toBe(BRICK) // not cleared
    expect(r.value.fireRating).toBe('A2') // updated
  })

  it('clearKeys removes optional fields explicitly', () => {
    const seed = mergeBIMPatch(null, { material: BRICK, fireRating: 'A1' })
    if (!seed.ok) throw new Error('setup')
    const r = mergeBIMPatch(seed.value, {}, { clearKeys: ['material'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.material).toBeUndefined()
    expect(r.value.fireRating).toBe('A1') // untouched
  })

  it('replaces costOverride wholesale rather than deep-merging', () => {
    const seed = mergeBIMPatch(null, { costOverride: { perM2: 100, flat: 50 } })
    if (!seed.ok) throw new Error('setup')
    const r = mergeBIMPatch(seed.value, { costOverride: { perM2: 200 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.costOverride?.perM2).toBe(200)
    // Pinned semantics: flat is gone, not preserved. Panel always sends
    // the full intended override.
    expect(r.value.costOverride?.flat).toBeUndefined()
  })

  it('honours explicit-zero in costOverride (means "free", not "fall back")', () => {
    const r = mergeBIMPatch(null, { costOverride: { perM2: 0 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.costOverride?.perM2).toBe(0)
  })

  it('rejects an invalid FireRating', () => {
    // @ts-expect-error — runtime test for what happens when the panel
    // accidentally writes a bogus grade. Zod must catch it at the seam.
    const r = mergeBIMPatch(null, { fireRating: 'Z' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.length).toBeGreaterThan(0)
  })

  it('rejects negative costOverride.perM2', () => {
    // perM2 is a number (no min), so this actually passes — pin the
    // current behaviour so a future tightening notices.
    const r = mergeBIMPatch(null, { costOverride: { perM2: -10 } })
    expect(r.ok).toBe(true)
  })
})

describe('metadataWithBIM', () => {
  it('merges into existing bimai without dropping sibling keys', () => {
    const node = makeNode({
      metadata: {
        bimai: {
          generatedBy: 'procedural-v1',
          generationId: 'gen-xyz',
          wallRole: 'perimeter',
        },
        otherTool: { foo: 1 },
      },
    })
    const seed = mergeBIMPatch(null, { material: BRICK, loadBearing: true })
    if (!seed.ok) throw new Error('setup')
    const out = metadataWithBIM(node, seed.value)
    expect(out.otherTool).toEqual({ foo: 1 })
    const bimai = out.bimai as Record<string, unknown>
    expect(bimai.generatedBy).toBe('procedural-v1')
    expect(bimai.generationId).toBe('gen-xyz')
    expect(bimai.wallRole).toBe('perimeter')
    expect((bimai.bim as { material: string }).material).toBe(BRICK)
  })

  it('handles a node with no metadata at all', () => {
    const node = makeNode({ metadata: undefined })
    const seed = mergeBIMPatch(null, { material: BRICK })
    if (!seed.ok) throw new Error('setup')
    const out = metadataWithBIM(node, seed.value)
    expect((out.bimai as { bim: { material: string } }).bim.material).toBe(BRICK)
  })
})
