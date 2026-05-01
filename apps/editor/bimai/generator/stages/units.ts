// Units stage: greedy mix-aware strip-fill packing with width clamping.
//
// Geometry: rectangular floor outline with a centered double-loaded corridor
// along its long axis (from Task 6). That gives us two strips of equal depth
// running parallel to the long axis — one on each side of the corridor.
// Units are placed end-to-end along each strip, in declared order from
// `program.unitMix` (zero-count entries skipped, others expanded one entry per
// unit).
//
// Width derivation. The "ideal" width along the long axis is `targetArea /
// stripDepth` — that honours the area target exactly. Real programs throw
// pathological values at us though (a 200 m² penthouse on a 4.25 m strip
// wants to be 47 m wide; a tiny utility unit wants to be 0.4 m wide), so we
// clamp into a habitable band [MIN_UNIT_WIDTH_M, MAX_UNIT_WIDTH_M] before
// placement and surface a per-unit warning code so the UI can flag it:
//
//   - derived < MIN  →  width = MIN, warn `unit_clipped_min`
//   - derived > MAX  →  width = MAX, warn `unit_clipped_max`
//
// Placement. Greedy left-then-right: fill +perpendicular strip first, then
// −perpendicular. When a unit doesn't fit the current strip's remaining run,
// two further rules apply, in order:
//
//   - rem ≥ MIN  →  place at width = rem, warn `unit_clipped_strip_end`
//                   (cursor lands at strip end; next item goes to next strip)
//   - rem < MIN  →  switch strips without clamping below MIN; if the other
//                   strip can't fit either, the unit is recorded as unplaced
//                   (the orchestrator may escalate to `program_exceeds_capacity`
//                   when no units fit at all).
//
// Cumulative drift. Per unit type we track sum(actualArea) vs sum(targetArea
// × placedCount). When the divergence exceeds 5 % of the type's total target
// area we emit one summary `area_drift` warning per type — once at the end,
// not per unit.
//
// Phase 3-3 explicitly does NOT try to balance strips, swap order, or rotate
// the queue when the right-hand strip is empty. Visually that produces a
// front-heavy building with one full façade and one half-empty one. Tracked
// for the Phase 3-5 optimizer (see PROGRESS.md); not a 3-3 blocker.
//
// Edge labels (downstream emitters read these):
//   - corridorEdges always include the inner edge (corridor side, index 0).
//   - facadeEdges always include the outer edge (building exterior, index 2).
//   - First unit in a strip adds the leading short end-wall (index 3).
//   - Last unit in a strip adds the trailing short end-wall (index 1).

import type { Polygon2D, Point2D } from '../../lib/envelope'
import type {
  PackingStrategy,
  UnitOrderingHeuristic,
} from '../../optimizer/params'
import type { Program } from '../../schemas'
import type { CorridorMode, CorridorPlan, UnitPlan } from '../types'
import { asRectangle } from './corridor'
import {
  AREA_BAND_TOLERANCE_HIGH,
  getUnitTemplate,
} from './rooms-templates'

export interface PackUnitsInput {
  outline: Polygon2D
  corridor: CorridorPlan
  /** Corridor width perpendicular to long axis, metres. */
  corridorWidth: number
  unitMix: Program['unitMix']
  /**
   * Packing strategy. Defaults to `'left-to-right'` (Phase 3-3 behaviour).
   *   - `'left-to-right'`: greedy strip-fill, stay on current strip until
   *     it can't fit the next unit; then move to the other strip.
   *   - `'alternating'`: toggle strip per unit. Produces a balanced
   *     two-façade layout — both façades fill at the same rate. The
   *     trade-off is that strip-end clipping happens earlier on both
   *     strips rather than only once.
   *   - `'grouped-by-type'`: when the unit type changes between
   *     consecutive items, switch strips so types stay clustered. Good
   *     when the program has a few large types (e.g. one penthouse,
   *     three studios) and you want types on the same façade.
   */
  packingStrategy?: PackingStrategy
  /**
   * Order in which to attempt placement.
   *   - `'mix-declared'` (default): the order the user listed in
   *     `program.unitMix`. Stable, predictable.
   *   - `'largest-first'`: descending `targetArea`. Reduces strip-end
   *     clipping because big units that can only fit early are placed
   *     before small ones consume their slots.
   *   - `'smallest-first'`: ascending `targetArea`. Maximises unit count
   *     when total area is the binding constraint.
   */
  unitOrderingHeuristic?: UnitOrderingHeuristic
}

export interface PackUnitsResult {
  units: UnitPlan[]
  /** Entries the packer could not place this floor. */
  unplaced: Array<{ type: string; targetArea: number }>
  warnings: string[]
}

/**
 * Strips per floor by corridor mode:
 *   - `'double-loaded'`: 2 strips flanking a centred corridor.
 *   - `'single-loaded'`: 1 strip on the +perpendicular side (corridor
 *     hugs the −perpendicular outline edge).
 */
const STRIP_SIGNS_BY_MODE: Record<CorridorMode, Array<1 | -1>> = {
  'double-loaded': [1, -1],
  'single-loaded': [1],
}

/**
 * Habitability band for unit width along the long axis.
 *
 * Floor of 4 m is the ABSOLUTE floor — applied to types not registered
 * in `MIN_VIABLE_WIDTH_M` (Studios + any unknown caller-defined type).
 * For typed units (1BR/2BR/3BR/4BR), the per-type `MIN_VIABLE_WIDTH_M`
 * floor is ALWAYS used instead and is strictly higher: it's the
 * smallest width at which the type's template can subdivide into rooms
 * without violating `minRoomDimensionM` (1.5 m). The packer uses this
 * to widen too-narrow units (`unit_widened_for_bisection`) or refuse
 * to place them (`unit_too_narrow_for_template`) instead of silently
 * letting them fall back to unit-shell downstream.
 *
 * Ceiling of 18 m is a sanity cap. A 18 m × 9 m strip is 162 m² —
 * top of the 4BR area band. Anything wider is out of scope for
 * residential mid-rise. Raised from 9 m in Phase 3-7 close-out (Fix A)
 * because 2BR target 125 m² at strip depth 9 derives 13.89 m wide;
 * the old 9 m clamp turned every 2BR into a 9 × 9 square that the
 * template couldn't bisect.
 */
export const MIN_UNIT_WIDTH_M = 4
export const MAX_UNIT_WIDTH_M = 18

/**
 * Per-type minimum width (m) below which the type's template is known
 * to fail `bisectUnit`'s `minRoomDimensionM` floor at the fixed
 * `TARGET_STRIP_DEPTH_M = 9` strip depth.
 *
 * These are STATIC. Drift between templates and these constants is
 * caught by a regression test in `rooms-templates.test.ts` that calls
 * `computeMinViableWidth(template, TARGET_STRIP_DEPTH_M)` and asserts
 * `MIN_VIABLE_WIDTH_M[type] >= computed`. If a template's fractions
 * change so that this invariant breaks, the test fails pointing at the
 * mismatched constant — much safer than silently re-deriving at
 * runtime (a tiny rounding difference would let unbisectable units
 * sneak through).
 *
 * Studio is registered at the absolute floor (4 m). Studios are
 * intentionally exempt from "must be bisectable": the Studio template
 * has a 0.15 root fraction that needs `0.15 × stripDepth = 1.35 m <
 * 1.5 m`, so it can NEVER bisect at our 9 m strip depth and always
 * falls back to unit-shell. The packer sees `MIN_VIABLE_WIDTH_M =
 * MIN_UNIT_WIDTH_M` for Studio and treats it as the legacy "just place
 * something" path; downstream, the unit-shell fallback covers it.
 */
export const MIN_VIABLE_WIDTH_M: Record<string, number> = {
  Studio: 4,
  '1BR': 13,
  '2BR': 11,
  '3BR': 13,
  '4BR': 13,
}

/**
 * Look up the per-type minimum-viable width. Returns `MIN_UNIT_WIDTH_M`
 * for unregistered types so a caller-defined `'penthouse'` (or any
 * future type without a template) still gets the legacy floor instead
 * of a thrown error.
 */
function minViableWidthFor(type: string): number {
  return MIN_VIABLE_WIDTH_M[type] ?? MIN_UNIT_WIDTH_M
}

/** Drift threshold for the per-type `area_drift` summary warning. */
const AREA_DRIFT_THRESHOLD = 0.05

export function packUnits(input: PackUnitsInput): PackUnitsResult | null {
  const { outline, corridor, corridorWidth, unitMix } = input
  if (!Number.isFinite(corridorWidth) || corridorWidth <= 0) return null
  const packingStrategy: PackingStrategy =
    input.packingStrategy ?? 'left-to-right'
  const unitOrdering: UnitOrderingHeuristic =
    input.unitOrderingHeuristic ?? 'mix-declared'

  const rect = asRectangle(outline)
  if (!rect) return null

  // Derive run length + strip depth + basis + mode from the corridor plan.
  // The corridor object is the canonical source: it knows whether the
  // floor was laid out double- or single-loaded (Phase 3-7 close-out
  // refactor), so the packer doesn't re-decide that here.
  //
  // Fall back to the long-axis derivation when the corridor doesn't
  // carry runLength/stripDepth (older fixtures, direct unit tests of
  // packUnits that pass a hand-built CorridorPlan). The fallback assumes
  // double-loaded with the legacy formula — preserved only for those
  // tests; production code always goes through `placeCorridor`.
  let runLength: number
  let stripDepth: number
  let mode: CorridorMode
  let ux: number
  let uy: number
  let cx: number
  let cy: number
  if (
    corridor.runLength !== undefined &&
    corridor.stripDepth !== undefined &&
    corridor.centerline
  ) {
    runLength = corridor.runLength
    stripDepth = corridor.stripDepth
    mode = corridor.mode ?? 'double-loaded'
    const [a, b] = corridor.centerline
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) return null
    ux = dx / len
    uy = dy / len
    cx = (a[0] + b[0]) / 2
    cy = (a[1] + b[1]) / 2
  } else {
    runLength = rect.longLen
    stripDepth = (rect.shortLen - corridorWidth) / 2
    mode = corridor.mode ?? 'double-loaded'
    ux = rect.longDir[0]
    uy = rect.longDir[1]
    cx = rect.center[0]
    cy = rect.center[1]
  }

  // Strip depth must be positive — corridor must fit with room left over
  // for habitable space on each side.
  if (stripDepth <= 0) return null

  const depth = stripDepth // legacy alias used by makeUnit + queue derivation
  const vx = -uy
  const vy = ux
  const halfL = runLength / 2
  const corridorHalf = corridorWidth / 2
  const stripSigns = STRIP_SIGNS_BY_MODE[mode]
  const STRIP_COUNT = stripSigns.length

  // Expand unitMix into a flat queue of placement attempts. Width is the
  // pre-clamped target value — placement may further narrow it via strip-end
  // clamp.
  type QueueItem = {
    type: string
    targetArea: number
    width: number
    minViable: number
    derivedWidth: number
    widened: boolean
    maxClamped: boolean
  }
  const queue: QueueItem[] = []
  const warnings: string[] = []
  // Phase 3-7 Fix A: a type is "feasible" at this strip depth if the
  // minimum-viable rectangle (minViable × stripDepth) fits inside the
  // template's effective area band. If not — e.g. 1BR minViable 13 m ×
  // 9 m = 117 m², 1BR template upper gate 1.5 × 70 = 105 — widening
  // would just push the unit over the bisection gate and trigger a
  // different silent fallback. Better to refuse placement up front
  // with a panel-ready warning that names the constraint.
  const blockedTypes = new Set<string>()
  for (const entry of unitMix) {
    if (entry.count <= 0) continue
    const minViable = minViableWidthFor(entry.type)
    const template = getUnitTemplate(entry.type)
    if (template) {
      const minViableArea = minViable * depth
      const upperGateArea =
        template.areaRangeM2.max * AREA_BAND_TOLERANCE_HIGH
      if (minViableArea > upperGateArea + 1e-6) {
        // Widening this type to its minViable width would overshoot
        // the template's area-band gate. Skip every unit of this type
        // on this floor and emit one summary warning; we don't repeat
        // it per unplaced entry.
        blockedTypes.add(entry.type)
        warnings.push(
          `unit_too_narrow_for_template: cannot place ${entry.type} (target ${entry.targetArea.toFixed(0)} m²): needs ≥${minViable}m width to subdivide into rooms but that yields ${minViableArea.toFixed(0)} m² — over the ${entry.type} template ceiling of ${upperGateArea.toFixed(0)} m². Suggestions: reduce ${entry.type} count, increase footprint depth (currently ${depth.toFixed(1)} m strip), or substitute a larger unit type.`,
        )
        continue
      }
    }
    const derivedWidth = entry.targetArea / depth
    let width = derivedWidth
    let widened = false
    let maxClamped = false
    if (derivedWidth < minViable) {
      width = minViable
      widened = true
    } else if (derivedWidth > MAX_UNIT_WIDTH_M) {
      width = MAX_UNIT_WIDTH_M
      maxClamped = true
    }
    for (let i = 0; i < entry.count; i++) {
      queue.push({
        type: entry.type,
        targetArea: entry.targetArea,
        width,
        minViable,
        derivedWidth,
        widened,
        maxClamped,
      })
      if (widened) {
        warnings.push(
          `unit_widened_for_bisection: ${entry.type} target width ${derivedWidth.toFixed(2)}m → ${minViable}m (template needs ≥${minViable}m at strip depth ${depth.toFixed(1)}m to subdivide into rooms)`,
        )
      } else if (maxClamped) {
        warnings.push(
          `unit_clipped_max: ${entry.type} target width ${derivedWidth.toFixed(2)}m → ${MAX_UNIT_WIDTH_M}m`,
        )
      }
    }
  }
  // Surface blocked-type counts so the panel can show "0 of N placed".
  for (const t of blockedTypes) {
    const requested =
      unitMix.find((e) => e.type === t && e.count > 0)?.count ?? 0
    if (requested > 0) {
      warnings.push(
        `${requested} unit(s) of type ${t} could not be placed — see unit_too_narrow_for_template above.`,
      )
    }
  }

  // Apply ordering heuristic. `mix-declared` (default) leaves the queue
  // alone — the order matches `program.unitMix` after expansion. The two
  // size-based orderings sort by `targetArea` (not the clamped `width`,
  // which lost information for min/max-clamped entries). We use a stable
  // sort: declared order wins for equal-area items so determinism holds.
  if (unitOrdering === 'largest-first') {
    queue.sort((a, b) => b.targetArea - a.targetArea)
  } else if (unitOrdering === 'smallest-first') {
    queue.sort((a, b) => a.targetArea - b.targetArea)
  }

  const units: UnitPlan[] = []
  const unplaced: PackUnitsResult['unplaced'] = []

  // Per-strip cursors (u-coordinate) and per-strip placed-count for end-edge
  // labelling. We need to retroactively flag the *last* unit of each strip
  // as having a facade end-edge — easiest to track its index.
  const stripCursors: number[] = new Array(STRIP_COUNT).fill(-halfL)
  const stripUnitIndices: number[][] = Array.from(
    { length: STRIP_COUNT },
    () => [],
  )

  // Per-type cumulative target/actual area for the drift summary.
  const typeStats = new Map<
    string,
    { targetTotal: number; actualTotal: number; placedCount: number }
  >()
  const bumpStats = (type: string, target: number, actual: number) => {
    const s = typeStats.get(type) ?? {
      targetTotal: 0,
      actualTotal: 0,
      placedCount: 0,
    }
    s.targetTotal += target
    s.actualTotal += actual
    s.placedCount += 1
    typeStats.set(type, s)
  }

  let stripIdx = 0
  let prevType: string | null = null
  for (let qi = 0; qi < queue.length; qi++) {
    const item = queue[qi]!
    // Strategy chooses the strip we *try first*. Fallback to the other
    // strip is the same in every strategy (greedy two-strip search) —
    // strategies only change the starting choice.
    //   - 'left-to-right': continue on the current strip until it can't
    //     fit, then move to the other. This is the previous behaviour:
    //     stripIdx is whatever the last successful placement set it to.
    //   - 'alternating': toggle starting strip per item. Produces a
    //     balanced two-façade layout. The fallback path is unchanged so
    //     when the toggled-into strip is full we still spill into the
    //     other side.
    //   - 'grouped-by-type': stay on the current strip while the type
    //     repeats; switch strips when the type changes. Keeps types
    //     clustered along façades.
    if (packingStrategy === 'alternating') {
      stripIdx = qi % STRIP_COUNT
    } else if (packingStrategy === 'grouped-by-type') {
      if (prevType !== null && prevType !== item.type) {
        stripIdx = (stripIdx + 1) % STRIP_COUNT
      }
    }
    let placed = false
    // Try strips starting from the current one. Within a strip, the only
    // way to fail is if the desired width exceeds remaining length AND the
    // remaining length is below MIN. Otherwise we either fit, or strip-end
    // clamp.
    for (let attempt = 0; attempt < STRIP_COUNT; attempt++) {
      const idx = (stripIdx + attempt) % STRIP_COUNT
      const cursor = stripCursors[idx]!
      const remaining = halfL - cursor
      if (remaining <= 0) continue

      let placedWidth: number
      if (item.width <= remaining + 1e-9) {
        placedWidth = item.width
      } else if (remaining >= item.minViable) {
        // Strip-end clamp respects the per-type minViable floor: a 2BR
        // can be clipped down to its 11 m minViable but not below
        // (11×9 = 99 m² is still inside the 2BR area band; an 8 m clip
        // would be 72 m² in a square-ish shape that the 2BR template
        // can't bisect).
        placedWidth = remaining
        warnings.push(
          `unit_clipped_strip_end: ${item.type} clipped to remaining ${remaining.toFixed(2)}m at strip end`,
        )
      } else {
        // Strip too short — try the next strip without clipping below
        // the type's minViable. If neither strip has room, the unit
        // is recorded as unplaced.
        continue
      }

      const sign = stripSigns[idx]!
      // Outer edge of the strip in corridor-local p-coords. With fixed
      // strip depth this is `corridorHalf + stripDepth`, NOT `shortLen/2`
      // — on plates wider than `2 × TARGET_STRIP_DEPTH_M + corridorWidth`
      // there's an unused buffer between the strip's outer edge and the
      // building outline. Documented trade-off, see PROGRESS.md.
      const outerHalf = corridorHalf + stripDepth
      const unit = makeUnit(
        item.type,
        item.targetArea,
        cursor,
        cursor + placedWidth,
        sign,
        corridorHalf,
        outerHalf,
        { ux, uy, vx, vy, cx, cy },
        stripUnitIndices[idx]!.length === 0,
      )
      units.push(unit)
      stripUnitIndices[idx]!.push(units.length - 1)
      stripCursors[idx] = cursor + placedWidth
      // For 'left-to-right' (default) and 'grouped-by-type', leave
      // stripIdx where it landed so the next item starts on the same
      // strip. For 'alternating', the next iteration will overwrite
      // stripIdx anyway via `qi % STRIP_COUNT`, so leaving it here is
      // harmless.
      stripIdx = idx
      bumpStats(item.type, item.targetArea, unit.area)
      placed = true
      prevType = item.type
      break
    }
    if (!placed) {
      unplaced.push({ type: item.type, targetArea: item.targetArea })
      // Don't update prevType when an item couldn't be placed — the next
      // item's "is this the same type as the previous *placed* one?"
      // check should consult the last successful type, otherwise an
      // unplaced studio in a run of studios would erroneously trigger
      // a strip switch.
    }
  }

  // Add the trailing end-wall as a facade edge on the last unit of each strip.
  for (const indices of stripUnitIndices) {
    if (indices.length === 0) continue
    const lastIdx = indices[indices.length - 1]!
    const unit = units[lastIdx]!
    if (!unit.facadeEdges.includes(LAST_END_EDGE)) {
      unit.facadeEdges = [...unit.facadeEdges, LAST_END_EDGE]
    }
  }

  // Per-type cumulative drift summary. `targetTotal` here is the placed-only
  // target sum (target × placedCount); unplaced units are counted in the
  // separate "could not be placed" warning so we don't double-attribute.
  for (const [type, s] of typeStats) {
    if (s.targetTotal <= 0) continue
    const drift = s.actualTotal - s.targetTotal
    const pct = drift / s.targetTotal
    if (Math.abs(pct) > AREA_DRIFT_THRESHOLD) {
      const sign = pct >= 0 ? '+' : ''
      warnings.push(
        `area_drift: ${type} placed area ${s.actualTotal.toFixed(1)}m² (${sign}${(pct * 100).toFixed(1)}% vs target ${s.targetTotal.toFixed(1)}m²)`,
      )
    }
  }

  if (unplaced.length > 0) {
    warnings.push(
      `${unplaced.length} unit(s) could not be placed on this floor (program exceeds floor capacity).`,
    )
  }

  return { units, unplaced, warnings }
}

// Polygon vertex order is fixed below; these constants name the edge indices
// for downstream emitters that read facadeEdges / corridorEdges.
const CORRIDOR_EDGE = 0
const FIRST_END_EDGE = 3 // u_start short wall
const LAST_END_EDGE = 1 // u_end short wall
const FACADE_EDGE = 2

interface Basis {
  ux: number
  uy: number
  vx: number
  vy: number
  cx: number
  cy: number
}

function toWorld(u: number, v: number, b: Basis): Point2D {
  return [b.cx + u * b.ux + v * b.vx, b.cy + u * b.uy + v * b.vy]
}

function makeUnit(
  type: string,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: kept for future area-deviation tracking
  _targetArea: number,
  uStart: number,
  uEnd: number,
  sign: 1 | -1,
  corridorHalf: number,
  outerHalf: number,
  basis: Basis,
  isFirstInStrip: boolean,
): UnitPlan {
  const vInner = sign * corridorHalf
  const vOuter = sign * outerHalf

  // Vertex order (CCW for sign=+1; sign=-1 flips it but downstream emitters
  // don't depend on winding, only on edge indices). Always:
  //   0: (uStart, vInner)
  //   1: (uEnd,   vInner)
  //   2: (uEnd,   vOuter)
  //   3: (uStart, vOuter)
  // → edge 0: corridor side (uStart→uEnd at vInner)
  // → edge 1: end wall at uEnd
  // → edge 2: facade (uEnd→uStart at vOuter)
  // → edge 3: end wall at uStart
  const polygon: Polygon2D = [
    toWorld(uStart, vInner, basis),
    toWorld(uEnd, vInner, basis),
    toWorld(uEnd, vOuter, basis),
    toWorld(uStart, vOuter, basis),
  ]

  const facadeEdges = [FACADE_EDGE]
  if (isFirstInStrip) facadeEdges.unshift(FIRST_END_EDGE)

  // Area = width × depth. width = uEnd - uStart, depth = |vOuter - vInner|.
  const area = (uEnd - uStart) * Math.abs(vOuter - vInner)

  return {
    type,
    polygon,
    area,
    facadeEdges,
    corridorEdges: [CORRIDOR_EDGE],
  }
}
