import { describe, expect, it } from 'vitest'
import type { UnitPlan } from '../types'
import { OPEN_ROOM_NAME, attachRoomsToUnits, planRooms } from './rooms'

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
    ...overrides,
  }
}

describe('planRooms (stub)', () => {
  it('emits exactly one open room per unit', () => {
    const rooms = planRooms(makeUnit())
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.name).toBe(OPEN_ROOM_NAME)
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
      expect(u.rooms).toBeDefined()
      expect(u.rooms!).toHaveLength(1)
      expect(u.rooms![0]!.name).toBe(OPEN_ROOM_NAME)
    }
  })

  it('does not mutate the input units', () => {
    const units = [makeUnit()]
    attachRoomsToUnits(units)
    expect(units[0]!.rooms).toBeUndefined()
  })

  it('preserves the unit area on the open room', () => {
    const units = [makeUnit({ area: 42.5 })]
    const out = attachRoomsToUnits(units)
    expect(out[0]!.rooms![0]!.area).toBe(42.5)
  })

  it('returns an empty array for an empty input', () => {
    expect(attachRoomsToUnits([])).toEqual([])
  })
})
