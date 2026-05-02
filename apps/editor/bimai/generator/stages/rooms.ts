// Rooms stage.
//
// Phase 3-7 entry point for unit subdivision. The actual algorithm
// (recursive bisection of the unit's OBB) lives in `rooms-packing.ts`;
// the substrate templates live in `rooms-templates.ts` and the
// Phase 3-9 variant catalog lives in `templates/units/`. This file
// is the integration seam: `attachRoomsToUnits` is what the pipeline
// calls after the units packer runs.
//
// Behaviour per unit (Phase 3-9):
//   1. Compute `UnitConditions` from the packed unit (area, depth,
//      facadeEdges, isCorner) plus `Program.generateBalconies`.
//   2. Run `selectTemplate` against the variant catalog (greedy by
//      score, [GATE 2]). The result is either a catalog hit or a
//      `fallback-${unitType}` synthesized from Phase 3-7 defaults.
//   3. Run `bisectUnit` against the chosen variant's slices. Success →
//      use those rooms; record the variant id (and balcony spec) on
//      the UnitPlan. Failure (rooms too small, bedroom misses facade,
//      etc.) → fall back to `unit-shell` and accumulate a warning.
//
// The unit-shell fallback is the degenerate "one open room" case
// used for Studios in simple emission paths and any unit whose
// subdivision fails a constraint.

import type { RoomKind, RoomPlan, UnitPlan } from '../types'
import { bisectUnit } from './rooms-packing'
import {
  type UnitTemplate as Phase37Template,
  getUnitTemplate,
} from './rooms-templates'
import {
  type UnitConditions,
  selectTemplatesForUnits,
} from './variant-selection'
import type { UnitVariantTemplate } from '../templates/units/types'

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

export interface AttachRoomsOptions {
  /**
   * Phase 3-9: enables balcony-equipped variants in the selector.
   * When `false` (the default), balcony variants are filtered out and
   * the selector picks the highest-scoring indoor-only template.
   */
  generateBalconies?: boolean
}

/**
 * Compute `UnitConditions` for a single packed unit. Depth is taken
 * as the smaller of the unit's bounding-box dimensions — packers lay
 * units out perpendicular to the corridor, so the smaller axis is
 * always the depth (perpendicular extent). Pure helper, exported for
 * tests that want to assert the conditions a unit produces.
 */
export function computeUnitConditions(
  unit: UnitPlan,
  generateBalconies: boolean,
  unitId?: string,
): UnitConditions {
  const xs = unit.polygon.map((p) => p[0])
  const ys = unit.polygon.map((p) => p[1])
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  const depthM = Math.min(w, h)
  const facadeEdges = unit.facadeEdges.length
  return {
    unitId: unitId ?? `${unit.type}-${unit.area.toFixed(0)}`,
    unitType: unit.type,
    area: unit.area,
    depthM,
    facadeEdges,
    isCorner: facadeEdges >= 2,
    generateBalconies,
  }
}

/**
 * Wrap a Phase 3-9 `UnitVariantTemplate` into the Phase 3-7
 * `UnitTemplate` shape `bisectUnit` consumes. Reuses Phase 3-7's
 * default constraints (`bedroomNeedsFacade`, `bathroomMaxAreaM2`,
 * `minRoomDimensionM`) — variants don't yet override these because
 * they share the same EU residential mid-rise constraint set. If a
 * future variant needs a different floor (e.g. a Japanese-style
 * compact 1BR with `minRoomDimensionM = 1.2`), extend
 * `UnitVariantTemplate` with an optional `constraints` field.
 */
function variantToPhase37Template(
  variant: UnitVariantTemplate,
): Phase37Template {
  const min = variant.areaBand.minM2
  const max = variant.areaBand.maxM2
  return {
    unitType: variant.unitType,
    areaRangeM2: { min, max, nominal: (min + max) / 2 },
    rootSplit: variant.slices,
    constraints: {
      bedroomNeedsFacade: true,
      bathroomMaxAreaM2: 8,
      minRoomDimensionM: 1.5,
    },
  }
}

/**
 * Apply room subdivision to every unit on a list. Returns new units
 * (input is never mutated) plus an array of warnings — one per unit
 * that fell back to unit-shell or to a Phase 3-7 fallback variant.
 *
 * Phase 3-9 wiring: each unit's conditions are computed, the variant
 * selector picks one of the catalog templates (or synthesizes a
 * `fallback-${unitType}`), and the chosen variant's slices are passed
 * to `bisectUnit`. The variant id and any balcony spec are recorded
 * on the returned UnitPlan for downstream consumers (Task 11 balcony
 * emitter, schedule, IFC).
 */
export function attachRoomsToUnits(
  units: UnitPlan[],
  options: AttachRoomsOptions = {},
): AttachRoomsResult {
  const generateBalconies = options.generateBalconies ?? false
  const warnings: string[] = []

  // Pre-pass: split units into "selector-eligible" (recognised
  // unitType) vs "unknown type → unit-shell." The selector would
  // throw on unknown types because there's no Phase 3-7 fallback to
  // synthesize from; the existing Phase 3-7 contract for unknown
  // types is silent unit-shell, and we preserve that.
  const eligibleIdx: number[] = []
  for (let i = 0; i < units.length; i++) {
    if (getUnitTemplate(units[i]!.type)) eligibleIdx.push(i)
  }
  const eligibleConditions = eligibleIdx.map((i) =>
    computeUnitConditions(units[i]!, generateBalconies, `${units[i]!.type}-${i}`),
  )
  const eligibleSelections = selectTemplatesForUnits(eligibleConditions)
  const selectionByIndex = new Map<number, (typeof eligibleSelections)[number]>()
  eligibleIdx.forEach((origIdx, j) =>
    selectionByIndex.set(origIdx, eligibleSelections[j]!),
  )

  const out = units.map((u, i) => {
    const sel = selectionByIndex.get(i)
    if (!sel) {
      // Unknown unitType — silent unit-shell (Phase 3-7 contract).
      return { ...u, rooms: unitShellLayout(u) }
    }
    if (sel.fallback) {
      // Track that the fallback path fired — pipeline collects this
      // into the build's warnings. Not a hard error; the fallback is
      // a working Phase 3-7 layout.
      warnings.push(
        `template_fallback_used: unit ${i} (${u.type}, ${u.area.toFixed(0)} m²) fell back to '${sel.template.id}' (no catalog entry matched).`,
      )
    }
    const phase37 = variantToPhase37Template(sel.template)
    const result = bisectUnit(u, phase37)
    if (!result.ok) {
      warnings.push(formatBisectFailureWarning(i, u, result))
      return {
        ...u,
        rooms: unitShellLayout(u),
        selectedVariantId: sel.template.id,
      }
    }
    return {
      ...u,
      rooms: result.rooms,
      selectedVariantId: sel.template.id,
      // Carry the balcony spec when the variant declares one AND the
      // user opted in. Defensive double-check (the selector already
      // filters), so a misconfigured catalog can't leak balconies into
      // an opt-out build.
      balcony:
        generateBalconies && sel.template.balcony
          ? { ...sel.template.balcony }
          : undefined,
    }
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
