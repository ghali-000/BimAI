// Units stage: greedy mix-aware strip-fill packing.
//
// We assume a rectangular floor outline with a centered double-loaded corridor
// (Task 6). That gives us two strips of equal depth running parallel to the
// long axis — one on each side of the corridor. Units are placed end-to-end
// along each strip, in the order they appear in `program.unitMix`, expanded
// to one packing entry per unit (count copies). Each unit's width along the
// long axis is `targetArea / stripDepth`, so the area target is honoured
// exactly at the cost of producing varying widths.
//
// Strategy: fill the +perpendicular strip left-to-right first, then the
// -perpendicular strip. When the next unit doesn't fit in the current strip's
// remaining length we move to the next strip; if neither strip has room, the
// unit is recorded as unplaced and surfaced as a warning. The orchestrator
// can decide whether unplaced units constitute `program_exceeds_capacity`.
//
// Edges on each unit are labelled for downstream emitters:
//   - corridorEdges always include the inner edge (corridor side).
//   - facadeEdges always include the outer edge (building exterior).
//   - First/last unit in a strip also adds the short end-wall on the building
//     exterior side as a facade edge.
//
// Future variants (BLF, mixed-depth, courtyard cores) plug in here without
// changing UnitPlan.

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

  // Expand unitMix into a flat queue of individual placements, in declared
  // order. Zero-count entries are dropped.
  type QueueItem = { type: string; targetArea: number; width: number }
  const queue: QueueItem[] = []
  for (const entry of unitMix) {
    if (entry.count <= 0) continue
    const width = entry.targetArea / depth
    for (let i = 0; i < entry.count; i++) {
      queue.push({ type: entry.type, targetArea: entry.targetArea, width })
    }
  }

  // Each strip has a sign for its perpendicular direction. +1 puts the strip
  // on the +v side (inner edge at +corridorHalf, outer edge at +shortLen/2).
  const stripSigns: Array<1 | -1> = [1, -1]

  const units: UnitPlan[] = []
  const unplaced: PackUnitsResult['unplaced'] = []
  const warnings: string[] = []

  // Per-strip cursors (u-coordinate) and per-strip placed-count for end-edge
  // labelling. We need to retroactively flag the *last* unit of each strip
  // as having a facade end-edge — easiest to track its index.
  const stripCursors: number[] = new Array(STRIP_COUNT).fill(-halfL)
  const stripUnitIndices: number[][] = Array.from(
    { length: STRIP_COUNT },
    () => [],
  )

  let stripIdx = 0
  for (const item of queue) {
    // Advance to a strip that can fit this unit (with a tiny epsilon).
    let placed = false
    for (let attempt = 0; attempt < STRIP_COUNT; attempt++) {
      const idx = (stripIdx + attempt) % STRIP_COUNT
      const cursor = stripCursors[idx]!
      if (cursor + item.width <= halfL + 1e-9) {
        const sign = stripSigns[idx]!
        const unit = makeUnit(
          item.type,
          item.targetArea,
          cursor,
          cursor + item.width,
          sign,
          corridorHalf,
          rect.shortLen / 2,
          { ux, uy, vx, vy, cx, cy },
          stripUnitIndices[idx]!.length === 0,
        )
        units.push(unit)
        stripUnitIndices[idx]!.push(units.length - 1)
        stripCursors[idx] = cursor + item.width
        stripIdx = idx // continue on same strip until it fills
        placed = true
        break
      }
    }
    if (!placed) {
      unplaced.push({ type: item.type, targetArea: item.targetArea })
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
