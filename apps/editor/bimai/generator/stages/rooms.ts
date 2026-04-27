// Rooms stage — STUB.
//
// Phase 3-3 doesn't subdivide units into bedrooms/baths/kitchen/living.
// We emit a single "open" room per unit, matching the unit polygon. This
// pins the contract (RoomPlan shape, edge indexing, area accounting) so the
// emitter and downstream renderers can integrate now and a real layout
// algorithm — likely informed by unit type ("2BR" → 2 bed + bath + LDK) —
// can swap in later without churning anything above this seam.
//
// Intentionally pure and dependency-free. No furniture, no door swings, no
// fixtures — those are out of scope for this phase.

import type { RoomPlan, UnitPlan } from '../types'

export const OPEN_ROOM_NAME = 'open'

/**
 * Returns the rooms inside a single unit. Stub: one open room covering the
 * full unit polygon. Returns a fresh array so callers can mutate freely.
 */
export function planRooms(unit: UnitPlan): RoomPlan[] {
  return [
    {
      name: OPEN_ROOM_NAME,
      // Defensive copy so downstream mutations of the room polygon don't
      // leak into the source unit.
      polygon: unit.polygon.map((p) => [p[0], p[1]] as [number, number]),
      area: unit.area,
    },
  ]
}

/** Apply `planRooms` to every unit on a list, returning new units. Pure. */
export function attachRoomsToUnits(units: UnitPlan[]): UnitPlan[] {
  return units.map((u) => ({ ...u, rooms: planRooms(u) }))
}
