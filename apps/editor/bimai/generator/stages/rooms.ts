// Rooms stage.
//
// Phase 3-7 introduces real interior subdivision (bedrooms, bathrooms,
// kitchens, living rooms, hallways). The full subdivision algorithm lives
// in `rooms-packing.ts` (Task 4) and is driven by templates from
// `rooms-templates.ts` (Tasks 2-3). This file is the integration seam:
// `attachRoomsToUnits` is the entry point the pipeline calls after the
// units packer runs.
//
// Until the templates + packer land (Tasks 2-5), `planRooms` returns a
// degenerate single-room layout — one `unit-shell` room covering the
// entire unit polygon, no interior walls, no interior doors. This matches
// the Phase 3-3 stub semantics under the new (Phase 3-7) RoomPlan shape:
// the data model evolves first, the algorithm fills in next. Existing
// fixtures and the integration pipeline keep passing because a
// `unit-shell` room is a valid (if uninteresting) RoomPlan.
//
// Intentionally pure and dependency-free.

import type { RoomKind, RoomPlan, UnitPlan } from '../types'

/**
 * Room kind used for the degenerate "no subdivision" case. Exported so
 * tests and downstream consumers (schedule, IFC writer) can recognise
 * an un-subdivided unit without re-deriving the convention from kind
 * strings scattered across the codebase.
 */
export const UNIT_SHELL_KIND: RoomKind = 'unit-shell'

/**
 * Returns the rooms inside a single unit. Phase 3-7 stub: emits one
 * `unit-shell` room covering the full unit polygon with no interior
 * walls or doors. The real subdivision lands in Task 4 once Gates 1-2
 * resolve the template format and packing algorithm; this stub keeps
 * the pipeline alive in the meantime.
 *
 * Returns a fresh array so callers can mutate freely.
 */
export function planRooms(unit: UnitPlan): RoomPlan[] {
  return [
    {
      kind: UNIT_SHELL_KIND,
      // Defensive copy so downstream mutations of the room polygon don't
      // leak into the source unit.
      polygon: unit.polygon.map((p) => [p[0], p[1]] as [number, number]),
      area: unit.area,
      // No interior walls / doors in the unit-shell case. Exterior walls
      // are the unit's perimeter, but the unit-shell stub does not enumerate
      // them — Phase 3-7's real subdivision will populate `walls` for
      // subdivided units. Downstream emitters (cost, IFC) currently read
      // walls only for partition counting; an empty list is correct.
      walls: [],
      doors: [],
      // A unit-shell "room" has access to whatever facade the unit has.
      windowAccess: unit.facadeEdges.length > 0,
    },
  ]
}

/** Apply `planRooms` to every unit on a list, returning new units. Pure. */
export function attachRoomsToUnits(units: UnitPlan[]): UnitPlan[] {
  return units.map((u) => ({ ...u, rooms: planRooms(u) }))
}
