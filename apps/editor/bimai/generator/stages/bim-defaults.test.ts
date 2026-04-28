import { describe, expect, it } from 'vitest'
import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { BIMAI_MATERIALS } from '../../bim/materials'
import type { NodeOp } from '../types'
import { applyBIMDefaults } from './bim-defaults'

// ── Tiny synthetic-node builders ────────────────────────────────────────────
//
// We bypass the real Pascal node schemas here on purpose. bim-defaults only
// reads `node.type` + `node.metadata.bimai.wallRole`; building real WallNode /
// SlabNode shapes would couple this test to upstream schema churn for no gain.

function wallOp(
  id: string,
  role: 'perimeter' | 'corridor' | 'party' | undefined,
): NodeOp {
  const node = {
    object: 'node',
    id: id as AnyNodeId,
    type: 'wall',
    parentId: null,
    visible: true,
    metadata: role ? { bimai: { wallRole: role } } : {},
  } as unknown as AnyNode
  return { node }
}

function nodeOp(id: string, type: string, extraMeta?: Record<string, unknown>): NodeOp {
  const node = {
    object: 'node',
    id: id as AnyNodeId,
    type,
    parentId: null,
    visible: true,
    metadata: extraMeta ?? {},
  } as unknown as AnyNode
  return { node }
}

function bimOf(op: NodeOp) {
  const meta = op.node.metadata as { bimai?: { bim?: unknown } } | undefined
  return meta?.bimai?.bim as
    | { material?: string; fireRating?: string; loadBearing?: boolean }
    | undefined
}

describe('applyBIMDefaults', () => {
  it('stamps brick + A1 + loadBearing on perimeter walls', () => {
    const [out] = applyBIMDefaults([wallOp('w1', 'perimeter')])
    const bim = bimOf(out!)
    expect(bim?.material).toBe(BIMAI_MATERIALS['brick-exterior'].id)
    expect(bim?.fireRating).toBe('A1')
    expect(bim?.loadBearing).toBe(true)
  })

  it('stamps drywall + A2 + non-loadBearing on corridor walls', () => {
    const [out] = applyBIMDefaults([wallOp('w2', 'corridor')])
    const bim = bimOf(out!)
    expect(bim?.material).toBe(BIMAI_MATERIALS['drywall-residential'].id)
    expect(bim?.fireRating).toBe('A2')
    expect(bim?.loadBearing).toBe(false)
  })

  it('stamps drywall on party walls (interior, non-load-bearing today)', () => {
    const [out] = applyBIMDefaults([wallOp('w3', 'party')])
    const bim = bimOf(out!)
    expect(bim?.material).toBe(BIMAI_MATERIALS['drywall-residential'].id)
    expect(bim?.loadBearing).toBe(false)
  })

  it('treats walls with missing wallRole as interior non-load-bearing', () => {
    // Defensive default — if a future emitter forgets to tag a wall, we
    // pick the safer (cheaper, less structural) interior material instead
    // of silently inheriting brick.
    const [out] = applyBIMDefaults([wallOp('w4', undefined)])
    const bim = bimOf(out!)
    expect(bim?.material).toBe(BIMAI_MATERIALS['drywall-residential'].id)
    expect(bim?.loadBearing).toBe(false)
  })

  it('stamps slab → concrete-slab-residential, A1, loadBearing', () => {
    const [out] = applyBIMDefaults([nodeOp('s1', 'slab')])
    const bim = bimOf(out!)
    expect(bim?.material).toBe(BIMAI_MATERIALS['concrete-slab-residential'].id)
    expect(bim?.fireRating).toBe('A1')
    expect(bim?.loadBearing).toBe(true)
  })

  it('stamps door → door-residential, unrated, non-loadBearing', () => {
    const [out] = applyBIMDefaults([nodeOp('d1', 'door')])
    const bim = bimOf(out!)
    expect(bim?.material).toBe(BIMAI_MATERIALS['door-residential'].id)
    expect(bim?.fireRating).toBe('unrated')
    expect(bim?.loadBearing).toBe(false)
  })

  it('stamps window → window-double-glazed, unrated, non-loadBearing', () => {
    const [out] = applyBIMDefaults([nodeOp('win1', 'window')])
    const bim = bimOf(out!)
    expect(bim?.material).toBe(BIMAI_MATERIALS['window-double-glazed'].id)
    expect(bim?.fireRating).toBe('unrated')
    expect(bim?.loadBearing).toBe(false)
  })

  it('passes through level + zone nodes unchanged (no bim stamp)', () => {
    const ops = applyBIMDefaults([
      nodeOp('l1', 'level'),
      nodeOp('z1', 'zone', { bimai: { unitType: '1BR', targetArea: 50 } }),
    ])
    for (const op of ops) {
      expect(bimOf(op)).toBeUndefined()
    }
    // The zone's pre-existing bimai metadata is preserved.
    const zoneMeta = ops[1]!.node.metadata as { bimai?: Record<string, unknown> }
    expect(zoneMeta.bimai?.unitType).toBe('1BR')
    expect(zoneMeta.bimai?.targetArea).toBe(50)
  })

  it('preserves existing metadata.bimai fields (e.g. wallRole, generatedBy)', () => {
    // Walls go through tagAsGenerated before bim-defaults in the real
    // pipeline, so generatedBy/generationId are already present. Pinning
    // here so a future refactor that overwrites bimai wholesale fails loud.
    const [out] = applyBIMDefaults([
      {
        node: {
          object: 'node',
          id: 'w5' as AnyNodeId,
          type: 'wall',
          parentId: null,
          visible: true,
          metadata: {
            bimai: {
              wallRole: 'perimeter',
              generatedBy: 'procedural-v1',
              generationId: 'gen-xyz',
            },
          },
        } as unknown as AnyNode,
      },
    ])
    const bimai = (out!.node.metadata as { bimai: Record<string, unknown> }).bimai
    expect(bimai.wallRole).toBe('perimeter')
    expect(bimai.generatedBy).toBe('procedural-v1')
    expect(bimai.generationId).toBe('gen-xyz')
    expect(bimai.bim).toBeDefined()
  })

  it('does not mutate the input ops array or its nodes', () => {
    const input: NodeOp[] = [wallOp('w6', 'perimeter'), nodeOp('s2', 'slab')]
    const inputBefore = JSON.parse(JSON.stringify(input))
    const out = applyBIMDefaults(input)
    expect(input).toEqual(inputBefore)
    expect(out).not.toBe(input)
    expect(out[0]).not.toBe(input[0])
    expect(out[0]!.node).not.toBe(input[0]!.node)
  })

  it('handles a mixed full-floor ops list (one of each emitted type)', () => {
    // Smoke test mirroring the real emit shape — exercise the dispatch in
    // one go to catch any type-switch typos.
    const ops = applyBIMDefaults([
      nodeOp('l1', 'level'),
      nodeOp('s1', 'slab'),
      wallOp('w-perim', 'perimeter'),
      wallOp('w-corr', 'corridor'),
      wallOp('w-party', 'party'),
      nodeOp('z1', 'zone'),
      nodeOp('d1', 'door'),
      nodeOp('win1', 'window'),
    ])
    expect(bimOf(ops[0]!)).toBeUndefined() // level
    expect(bimOf(ops[1]!)?.material).toBe(BIMAI_MATERIALS['concrete-slab-residential'].id)
    expect(bimOf(ops[2]!)?.material).toBe(BIMAI_MATERIALS['brick-exterior'].id)
    expect(bimOf(ops[3]!)?.material).toBe(BIMAI_MATERIALS['drywall-residential'].id)
    expect(bimOf(ops[4]!)?.material).toBe(BIMAI_MATERIALS['drywall-residential'].id)
    expect(bimOf(ops[5]!)).toBeUndefined() // zone
    expect(bimOf(ops[6]!)?.material).toBe(BIMAI_MATERIALS['door-residential'].id)
    expect(bimOf(ops[7]!)?.material).toBe(BIMAI_MATERIALS['window-double-glazed'].id)
  })
})
