import type { AnyNode } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import { GENERATED_BY, isGenerated, tagAsGenerated } from './tag'

// Build a minimal ZoneNode-shaped object without parsing through Pascal's
// Zod schema. The barrel `@pascal-app/core` pulls three-mesh-bvh which can't
// load under vitest's node environment; the tag helpers only inspect
// `metadata` so a structural cast is safe.
function makeZone(metadata?: Record<string, unknown>): AnyNode {
  return {
    object: 'node',
    id: 'zone_test0000000001',
    type: 'zone',
    name: 'unit',
    parentId: null,
    visible: true,
    color: '#3b82f6',
    polygon: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    metadata: metadata ?? {},
  } as unknown as AnyNode
}

describe('tagAsGenerated', () => {
  it('stamps generatedBy + generationId onto metadata.bimai', () => {
    const zone = makeZone()
    const tagged = tagAsGenerated(zone, 'gen-123')
    const bimai = (tagged.metadata as { bimai: Record<string, unknown> }).bimai
    expect(bimai.generatedBy).toBe(GENERATED_BY)
    expect(bimai.generationId).toBe('gen-123')
  })

  it('preserves existing metadata.bimai fields (deep merge)', () => {
    const zone = makeZone({
      bimai: { unitType: '2BR', targetArea: 80 },
    })
    const tagged = tagAsGenerated(zone, 'gen-xyz')
    const bimai = (tagged.metadata as { bimai: Record<string, unknown> }).bimai
    expect(bimai.unitType).toBe('2BR')
    expect(bimai.targetArea).toBe(80)
    expect(bimai.generatedBy).toBe(GENERATED_BY)
    expect(bimai.generationId).toBe('gen-xyz')
  })

  it('preserves sibling top-level metadata keys', () => {
    const zone = makeZone({
      bimai: { unitType: 'studio' },
      extension: { custom: true },
    })
    const tagged = tagAsGenerated(zone, 'gen-1')
    const meta = tagged.metadata as Record<string, unknown>
    expect(meta.extension).toEqual({ custom: true })
  })

  it('does not mutate the input node', () => {
    const zone = makeZone({ bimai: { unitType: '1BR' } })
    const before = JSON.stringify(zone.metadata)
    tagAsGenerated(zone, 'gen-1')
    expect(JSON.stringify(zone.metadata)).toBe(before)
  })
})

describe('isGenerated', () => {
  it('returns false for an untagged node', () => {
    expect(isGenerated(makeZone())).toBe(false)
  })

  it('returns false when metadata.bimai exists but lacks the tag', () => {
    const zone = makeZone({ bimai: { unitType: '2BR' } })
    expect(isGenerated(zone)).toBe(false)
  })

  it('returns true after tagAsGenerated, regardless of generationId', () => {
    const zone = tagAsGenerated(makeZone(), 'gen-A')
    expect(isGenerated(zone)).toBe(true)
  })

  it('matches a specific generationId when provided', () => {
    const zone = tagAsGenerated(makeZone(), 'gen-A')
    expect(isGenerated(zone, 'gen-A')).toBe(true)
    expect(isGenerated(zone, 'gen-B')).toBe(false)
  })

  it('round-trips: tag then read back', () => {
    const zone = tagAsGenerated(
      makeZone({ bimai: { unitType: 'studio', targetArea: 35 } }),
      'gen-roundtrip',
    )
    expect(isGenerated(zone, 'gen-roundtrip')).toBe(true)
    const bimai = (zone.metadata as { bimai: Record<string, unknown> }).bimai
    expect(bimai.unitType).toBe('studio')
    expect(bimai.targetArea).toBe(35)
  })
})
