// Rooms stage.
//
// Phase 3-7 entry point for unit subdivision. The actual algorithm
// (recursive bisection of the unit's OBB) lives in `rooms-packing.ts`;
// templates live in `rooms-templates.ts`. This file is the integration
// seam: `attachRoomsToUnits` is what the pipeline calls after the
// units packer runs.
//
// Behaviour per unit:
//   1. Look up the template for `unit.type`. No template → fall back
//      to a single `unit-shell` room.
//   2. Run `bisectUnit`. Success → use those rooms. Failure (rooms
//      too small, bedroom misses facade, etc.) → fall back to
//      `unit-shell` and accumulate a warning string for the panel
//      summary.
//
// The unit-shell fallback is also used as the Phase 3-3 stub
// interpretation under the new RoomPlan shape — a single room
// covering the unit polygon, no interior walls or doors. Tests still
// exercise it directly via `unitShellLayout`.

import type { RoomKind, RoomPlan, UnitPlan } from '../types'
import { bisectUnit } from './rooms-packing'
import { getUnitTemplate } from './rooms-templates'

/**
 * Room kind used for the degenerate "no subdivision" case. Exported so
 * tests and downstream consumers (schedule, IFC writer) can recognise
 * an un-subdivided unit without re-deriving the convention from kind
 * strings scattered across the codebase.
 */
export const UNIT_SHELL_KIND: RoomKind = 'unit-shell'

/**
 * Build the degenerate single-room layout for a unit: one `unit-shell`
 * room covering the full polygon, no interior walls or doors. Used as
 * the fallback when no template matches the unit type or when bisection
 * fails a constraint. Pure; returns a fresh array and defensively-copied
 * polygon.
 */
export function unitShellLayout(unit: UnitPlan): RoomPlan[] {
  return [
    {
      kind: UNIT_SHELL_KIND,
      polygon: unit.polygon.map((p) => [p[0], p[1]] as [number, number]),
      area: unit.area,
      walls: [],
      doors: [],
      windowAccess: unit.facadeEdges.length > 0,
    },
  ]
}

/**
 * Returns the rooms inside a single unit. Tries the template-driven
 * bisector first; falls back to `unitShellLayout` on any failure.
 *
 * The fallback path is silent here — `attachRoomsToUnits` is the
 * level that reports warnings to the pipeline so the panel can show
 * "N units could not be subdivided".
 */
export function planRooms(unit: UnitPlan): RoomPlan[] {
  const template = getUnitTemplate(unit.type)
  if (!template) return unitShellLayout(unit)
  const result = bisectUnit(unit, template)
  if (!result.ok) return unitShellLayout(unit)
  return result.rooms
}

export interface AttachRoomsResult {
  units: UnitPlan[]
  warnings: string[]
}

/**
 * Apply room subdivision to every unit on a list. Returns new units
 * (input is never mutated) plus an array of warnings — one per unit
 * that fell back to unit-shell because of a packer failure or because
 * its type has no template.
 *
 * The warning strings are panel-ready: they include the unit type,
 * the failing room kind (when applicable), and the failing dimension
 * so a reviewer can decide whether to widen the unit, shrink the
 * template, or accept the fallback.
 */
export function attachRoomsToUnits(units: UnitPlan[]): AttachRoomsResult {
  const warnings: string[] = []
  const out = units.map((u, i) => {
    const template = getUnitTemplate(u.type)
    if (!template) {
      // No-template is silent: it's the expected path for unit types
      // outside the registry (e.g. a future custom type the optimizer
      // hasn't added a template for yet). The unit ships as a shell.
      return { ...u, rooms: unitShellLayout(u) }
    }
    const result = bisectUnit(u, template)
    if (!result.ok) {
      warnings.push(formatBisectFailureWarning(i, u, result))
      return { ...u, rooms: unitShellLayout(u) }
    }
    return { ...u, rooms: result.rooms }
  })
  return { units: out, warnings }
}

/**
 * Format a panel-ready warning for a `bisectUnit` failure. The
 * area-band cases get explicit "Likely cause" hints so a reviewer can
 * tell at a glance whether the failure is downstream (template too
 * tight) or upstream (unit packer producing the wrong size). The other
 * failure reasons fall through to the legacy detail string.
 */
function formatBisectFailureWarning(
  index: number,
  unit: UnitPlan,
  result: import('./rooms-packing').BisectFailure,
): string {
  const prefix = `Unit ${index} (${unit.type}, ${unit.area.toFixed(0)} m²)`
  if (
    (result.reason === 'unit_too_small_for_template' ||
      result.reason === 'unit_too_large_for_template') &&
    result.areaBand
  ) {
    const { bandMin, bandMax, nominalM2 } = result.areaBand
    const direction =
      result.reason === 'unit_too_small_for_template' ? 'too small' : 'too large'
    const cause =
      result.reason === 'unit_too_small_for_template'
        ? 'unit packer producing undersized strips'
        : 'unit packer producing oversized strips'
    return `${prefix} ${direction} for ${unit.type} template (range ${bandMin}-${bandMax} m², expected ~${nominalM2} m²). Falling back to unit-shell. Likely cause: ${cause}.`
  }
  return `${prefix}: could not be subdivided — ${result.detail}. Falling back to unit-shell.`
}
