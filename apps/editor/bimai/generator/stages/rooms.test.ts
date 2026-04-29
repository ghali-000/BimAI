import { describe, expect, it } from 'vitest'
import type { UnitPlan } from '../types'
import { UNIT_SHELL_KIND, attachRoomsToUnits, planRooms } from './rooms'

function makeUnit(overrides: Partial<UnitPlan> = {}): UnitPlan {
  return {
    type: '1BR',
    polygon: [
      [0, 0],
      [5, 0],
      [5, 4],
      [0, 4],
    ],
    area: 20,
    facadeEdges: [2],
    corridorEdges: [0],
    // Default to an empty rooms array so every fixture satisfies the
    // post-3-7 required-rooms type. `attachRoomsToUnits` overwrites this
    // with the actual subdivision.
    rooms: [],
    ...overrides,
  }
}

describe('planRooms (unit-shell stub)', () => {
  it('emits exactly one unit-shell room per unit', () => {
    const rooms = planRooms(makeUnit())
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.kind).toBe(UNIT_SHELL_KIND)
  })

  it('matches the unit polygon and area', () => {
    const unit = makeUnit()
    const [room] = planRooms(unit)
    expect(room!.polygon).toEqual(unit.polygon)
    expect(room!.area).toBe(unit.area)
  })

  it('returns a defensive copy of the polygon', () => {
    const unit = makeUnit()
    const [room] = planRooms(unit)
    // Mutating the room must not mutate the unit.
    room!.polygon[0]![0] = 999
    expect(unit.polygon[0]![0]).toBe(0)
  })

  it('returns a fresh array on each call', () => {
    const unit = makeUnit()
    expect(planRooms(unit)).not.toBe(planRooms(unit))
  })

  it('emits no interior walls or doors in the unit-shell case', () => {
    const [room] = planRooms(makeUnit())
    expect(room!.walls).toEqual([])
    expect(room!.doors).toEqual([])
  })

  it('reports windowAccess=true when the unit has facade edges', () => {
    const [room] = planRooms(makeUnit({ facadeEdges: [2] }))
    expect(room!.windowAccess).toBe(true)
  })

  it('reports windowAccess=false when the unit has no facade edges', () => {
    const [room] = planRooms(makeUnit({ facadeEdges: [] }))
    expect(room!.windowAccess).toBe(false)
  })
})

describe('attachRoomsToUnits', () => {
  it('attaches rooms to every unit', () => {
    const units = [
      makeUnit({ type: 'studio' }),
      makeUnit({ type: '2BR', area: 70 }),
    ]
    const out = attachRoomsToUnits(units)
    expect(out).toHaveLength(2)
    for (const u of out) {
      expect(u.rooms).toHaveLength(1)
      expect(u.rooms[0]!.kind).toBe(UNIT_SHELL_KIND)
    }
  })

  it('does not mutate the input units', () => {
    // Build a unit with a sentinel `rooms` reference. After the call,
    // the input must still hold that exact reference — `attachRoomsToUnits`
    // must produce new unit objects, not patch in place.
    const sentinel: UnitPlan['rooms'] = []
    const units = [makeUnit({ rooms: sentinel })]
    attachRoomsToUnits(units)
    expect(units[0]!.rooms).toBe(sentinel)
  })

  it('preserves the unit area on the unit-shell room', () => {
    const units = [makeUnit({ area: 42.5 })]
    const out = attachRoomsToUnits(units)
    expect(out[0]!.rooms[0]!.area).toBe(42.5)
  })

  it('returns an empty array for an empty input', () => {
    expect(attachRoomsToUnits([])).toEqual([])
  })

  it('threads windowAccess through from each unit', () => {
    const units = [
      makeUnit({ type: 'A', facadeEdges: [2] }),
      makeUnit({ type: 'B', facadeEdges: [] }),
    ]
    const out = attachRoomsToUnits(units)
    expect(out[0]!.rooms[0]!.windowAccess).toBe(true)
    expect(out[1]!.rooms[0]!.windowAccess).toBe(false)
  })
})
