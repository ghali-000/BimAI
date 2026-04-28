// Tests for the multi-select summarizer. Drives the panel's
// shared / mixed / absent rendering decisions, so these specs lock
// the behaviour the panel relies on.

import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import { BimAIMaterialId, type ComponentBIM } from '../bim/schemas/component-bim'
import { summarizeMultiSelection } from './multi-select'

const mat = (s: string) => BimAIMaterialId.parse(s)

function node(
  type: string,
  bim?: Partial<ComponentBIM>,
  id = `${type}_${Math.random().toString(36).slice(2, 8)}`,
): AnyNode {
  return {
    object: 'node',
    id: id as AnyNodeId,
    type,
    parentId: null,
    visible: true,
    metadata: bim ? { bimai: { bim } } : {},
    name: type,
  } as unknown as AnyNode
}

describe('summarizeMultiSelection — filtering and counts', () => {
  it('keeps only wall/slab/door/window in supportedNodes', () => {
    const s = summarizeMultiSelection([
      node('wall'),
      node('slab'),
      node('door'),
      node('window'),
      node('zone'),
      node('level'),
    ])
    expect(s.supportedNodes.map((e) => e.type)).toEqual([
      'wall',
      'slab',
      'door',
      'window',
    ])
    expect(s.unsupportedCount).toBe(2)
    expect(s.countsByType).toMatchObject({
      wall: 1,
      slab: 1,
      door: 1,
      window: 1,
      zone: 1,
      level: 1,
    })
  })

  it('treats null / undefined entries as unsupported', () => {
    const s = summarizeMultiSelection([null, undefined, node('wall')])
    expect(s.supportedNodes).toHaveLength(1)
    expect(s.unsupportedCount).toBe(2)
  })
})

describe('summarizeMultiSelection — typesAreMixed flag', () => {
  it('false when every supported node is the same type', () => {
    const s = summarizeMultiSelection([node('wall'), node('wall'), node('wall')])
    expect(s.typesAreMixed).toBe(false)
  })

  it('true when supported nodes mix wall + slab', () => {
    const s = summarizeMultiSelection([node('wall'), node('slab')])
    expect(s.typesAreMixed).toBe(true)
  })
})

describe('summarizeMultiSelection — Tristate per field', () => {
  it('shared when every node carries the same fire rating', () => {
    const s = summarizeMultiSelection([
      node('wall', { fireRating: 'A1', material: mat('concrete-cast'), loadBearing: true }),
      node('wall', { fireRating: 'A1', material: mat('concrete-cast'), loadBearing: true }),
    ])
    expect(s.fireRating).toEqual({ kind: 'shared', value: 'A1' })
    expect(s.material).toEqual({ kind: 'shared', value: 'concrete-cast' })
    expect(s.loadBearing).toEqual({ kind: 'shared', value: true })
  })

  it('mixed when nodes disagree on a field', () => {
    const s = summarizeMultiSelection([
      node('wall', { fireRating: 'A1', material: mat('concrete-cast') }),
      node('wall', { fireRating: 'A2', material: mat('concrete-cast') }),
    ])
    expect(s.fireRating).toEqual({ kind: 'mixed' })
    expect(s.material).toEqual({ kind: 'shared', value: 'concrete-cast' })
  })

  it("nodes without BIM data treat fireRating as 'unrated' default for sharing", () => {
    const s = summarizeMultiSelection([node('wall'), node('wall')])
    expect(s.fireRating).toEqual({ kind: 'shared', value: 'unrated' })
    expect(s.material).toEqual({ kind: 'shared', value: undefined })
  })

  it('absent across the board when no supported nodes', () => {
    const s = summarizeMultiSelection([node('zone'), node('level')])
    expect(s.fireRating).toEqual({ kind: 'absent' })
    expect(s.material).toEqual({ kind: 'absent' })
    expect(s.loadBearing).toEqual({ kind: 'absent' })
    expect(s.costOverrideSlot).toBeNull()
  })
})

describe('summarizeMultiSelection — costOverride slot', () => {
  it("returns 'perM2' when only walls/slabs are selected", () => {
    const s = summarizeMultiSelection([node('wall'), node('slab')])
    expect(s.costOverrideSlot).toBe('perM2')
  })

  it("returns 'flat' when only doors/windows are selected", () => {
    const s = summarizeMultiSelection([node('door'), node('window')])
    expect(s.costOverrideSlot).toBe('flat')
  })

  it("returns 'mixed' when slot types straddle (wall + door)", () => {
    const s = summarizeMultiSelection([node('wall'), node('door')])
    expect(s.costOverrideSlot).toBe('mixed')
  })

  it('costOverridePerM2 is shared when every wall/slab agrees', () => {
    const s = summarizeMultiSelection([
      node('wall', { costOverride: { perM2: 200 } }),
      node('slab', { costOverride: { perM2: 200 } }),
    ])
    expect(s.costOverrideSlot).toBe('perM2')
    expect(s.costOverridePerM2).toEqual({ kind: 'shared', value: 200 })
  })

  it('costOverridePerM2 is mixed when values disagree', () => {
    const s = summarizeMultiSelection([
      node('wall', { costOverride: { perM2: 200 } }),
      node('wall', { costOverride: { perM2: 250 } }),
    ])
    expect(s.costOverridePerM2).toEqual({ kind: 'mixed' })
  })
})
