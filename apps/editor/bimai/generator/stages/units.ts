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
import type { Program } from '../../schemas'
import type { CorridorPlan, UnitPlan } from '../types'
import { asRectangle } from './corridor'

export interface PackUnitsInput {
  outline: Polygon2D
  corridor: CorridorPlan
  /** Corridor width perpendicular to long axis, metres. */
  corridorWidth: number
  unitMix: Program['unitMix']
}

export interface PackUnitsResult {
  units: UnitPlan[]
  /** Entries the packer could not place this floor. */
  unplaced: Array<{ type: string; targetArea: number }>
  warnings: string[]
}

/** Two strips per floor: +perpendicular (left) and −perpendicular (right). */
const STRIP_COUNT = 2

/** Habitability band for unit width along the long axis. */
export const MIN_UNIT_WIDTH_M = 3
export const MAX_UNIT_WIDTH_M = 9

/** Drift threshold for the per-type `area_drift` summary warning. */
const AREA_DRIFT_THRESHOLD = 0.05

export function packUnits(input: PackUnitsInput): PackUnitsResult | null {
  // `corridor` is part of the input contract for forward compatibility (we'll
  // need its centerline for door placement at the emit stage); the packer
  // itself only needs the corridor width to compute strip depth.
  const { outline, corridorWidth, unitMix } = input
  if (!Number.isFinite(corridorWidth) || corridorWidth <= 0) return null

  const rect = asRectangle(outline)
  if (!rect) return null

  const depth = (rect.shortLen - corridorWidth) / 2
  // Strip depth must be positive — i.e. the corridor must fit within the
  // building's short dimension with room left over for habitable space.
  if (depth <= 0) return null

  // Local-axis basis. u along the long axis, v perpendicular (rotated +90°).
  const ux = rect.longDir[0]
  const uy = rect.longDir[1]
  const vx = -uy
  const vy = ux
  const cx = rect.center[0]
  const cy = rect.center[1]
  const halfL = rect.longLen / 2
  const corridorHalf = corridorWidth / 2

  // Expand unitMix into a flat queue of placement attempts. Width is the
  // pre-clamped target value — placement may further narrow it via strip-end
  // clamp.
  type QueueItem = {
    type: string
    targetArea: number
    width: number
    derivedWidth: number
    minClamped: boolean
    maxClamped: boolean
  }
  const queue: QueueItem[] = []
  const warnings: string[] = []
  for (const entry of unitMix) {
    if (entry.count <= 0) continue
    const derivedWidth = entry.targetArea / depth
    let width = derivedWidth
    let minClamped = false
    let maxClamped = false
    if (derivedWidth < MIN_UNIT_WIDTH_M) {
      width = MIN_UNIT_WIDTH_M
      minClamped = true
    } else if (derivedWidth > MAX_UNIT_WIDTH_M) {
      width = MAX_UNIT_WIDTH_M
      maxClamped = true
    }
    for (let i = 0; i < entry.count; i++) {
      queue.push({
        type: entry.type,
        targetArea: entry.targetArea,
        width,
        derivedWidth,
        minClamped,
        maxClamped,
      })
      if (minClamped) {
        warnings.push(
          `unit_clipped_min: ${entry.type} target width ${derivedWidth.toFixed(2)}m → ${MIN_UNIT_WIDTH_M}m`,
        )
      } else if (maxClamped) {
        warnings.push(
          `unit_clipped_max: ${entry.type} target width ${derivedWidth.toFixed(2)}m → ${MAX_UNIT_WIDTH_M}m`,
        )
      }
    }
  }

  // Each strip has a sign for its perpendicular direction. +1 puts the strip
  // on the +v side (inner edge at +corridorHalf, outer edge at +shortLen/2).
  const stripSigns: Array<1 | -1> = [1, -1]

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
  outer: for (const item of queue) {
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
      } else if (remaining >= MIN_UNIT_WIDTH_M) {
        placedWidth = remaining
        warnings.push(
          `unit_clipped_strip_end: ${item.type} clipped to remaining ${remaining.toFixed(2)}m at strip end`,
        )
      } else {
        // Strip too short — try the next strip without clipping below MIN.
        continue
      }

      const sign = stripSigns[idx]!
      const unit = makeUnit(
        item.type,
        item.targetArea,
        cursor,
        cursor + placedWidth,
        sign,
        corridorHalf,
        rect.shortLen / 2,
        { ux, uy, vx, vy, cx, cy },
        stripUnitIndices[idx]!.length === 0,
      )
      units.push(unit)
      stripUnitIndices[idx]!.push(units.length - 1)
      stripCursors[idx] = cursor + placedWidth
      stripIdx = idx // continue on same strip until it fills
      bumpStats(item.type, item.targetArea, unit.area)
      continue outer
    }
    unplaced.push({ type: item.type, targetArea: item.targetArea })
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
