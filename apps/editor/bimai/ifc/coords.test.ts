// Pure tests for the Pascal ↔ IFC coordinate-system bridge.
//
// Locks the canonical Y-up→Z-up swap (`(1, 2, 3) → (1, 3, 2)`) — every other
// emitter in the IFC writer derives from this convention, so a regression
// here cascades into axis-misaligned exports.

import { describe, expect, it } from 'vitest'
import {
  elevationForLevel,
  pascal2DToIfc,
  pascalPolygonToIfc,
  pascalToIfc,
  type Pascal3D,
} from './coords'

describe('pascalToIfc', () => {
  it('swaps Y-up to Z-up: (1, 2, 3) → (1, 3, 2)', () => {
    expect(pascalToIfc([1, 2, 3])).toEqual([1, 3, 2])
  })

  it('is its own inverse for 3-tuples', () => {
    const p: Pascal3D = [4.5, -1.25, 7]
    const back = pascalToIfc(pascalToIfc(p) as unknown as Pascal3D)
    expect(back).toEqual([p[0], p[1], p[2]])
  })
})

describe('pascal2DToIfc', () => {
  it('passes the planar pair through and lifts elevation onto Z', () => {
    expect(pascal2DToIfc([5, 7], 2)).toEqual([5, 7, 2])
  })

  it('accepts negative coords and negative elevation', () => {
    expect(pascal2DToIfc([-2.5, -1.5], -3)).toEqual([-2.5, -1.5, -3])
  })
})

describe('pascalPolygonToIfc', () => {
  it('lifts every vertex and preserves order', () => {
    const polygon = [
      [0, 0],
      [4, 0],
      [4, 3],
    ] as const
    expect(pascalPolygonToIfc(polygon, 1.5)).toEqual([
      [0, 0, 1.5],
      [4, 0, 1.5],
      [4, 3, 1.5],
    ])
  })
})

describe('elevationForLevel', () => {
  it('respects zero and stacks levels multiplicatively', () => {
    expect(elevationForLevel(0, 3)).toBe(0)
    expect(elevationForLevel(3, 3)).toBe(9)
  })
})
