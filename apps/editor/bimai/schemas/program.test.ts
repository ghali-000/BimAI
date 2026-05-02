// Program schema tests. Phase 3-9 added the `generateBalconies` opt-in;
// these specs pin its default + backwards-compat parse path so persisted
// pre-3-9 scenes (which never wrote the field) keep loading cleanly with
// `generateBalconies: false`. schemaVersion stays at 1 because the
// default is backwards-compatible — no migration code involved.

import { describe, expect, it } from 'vitest'
import { Program } from './program'

describe('Program (Phase 3-9 generateBalconies)', () => {
  it('parses a pre-3-9-shape Program (no generateBalconies field) with the field defaulted to false', () => {
    // Pre-3-9 persisted scenes wrote unitMix + floorToFloorHeight only.
    const persisted = {
      unitMix: [{ type: '2BR', count: 4, targetArea: 80 }],
      floorToFloorHeight: 3,
    }
    const parsed = Program.parse(persisted)
    expect(parsed.generateBalconies).toBe(false)
    // Other fields unchanged.
    expect(parsed.unitMix).toHaveLength(1)
    expect(parsed.unitMix[0]!.type).toBe('2BR')
    expect(parsed.floorToFloorHeight).toBe(3)
  })

  it('parses a 3-9 Program with generateBalconies: true', () => {
    const parsed = Program.parse({
      unitMix: [],
      floorToFloorHeight: 3,
      generateBalconies: true,
    })
    expect(parsed.generateBalconies).toBe(true)
  })

  it('round-trips defaults — empty input yields generateBalconies: false', () => {
    const parsed = Program.parse({})
    expect(parsed.generateBalconies).toBe(false)
    expect(parsed.unitMix).toEqual([])
    expect(parsed.floorToFloorHeight).toBe(3)
  })

  it('rejects non-boolean values for generateBalconies (no silent coercion)', () => {
    expect(() =>
      Program.parse({ unitMix: [], floorToFloorHeight: 3, generateBalconies: 'yes' }),
    ).toThrow()
  })
})
