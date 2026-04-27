// Corridor stage: place a double-loaded corridor down the long axis of the
// floor outline.
//
// "Double-loaded" means units flank the corridor on both sides — the canonical
// efficient layout for residential. We pick the long edge of the (assumed
// rectangular) footprint as the corridor direction; later stages will pack
// units in the two strips on either side.
//
// Phase 3-3 explicitly limits us to rectangular footprints. If the outline
// isn't a rectangle (within tolerance) we return null and the orchestrator
// converts that into a typed `corridor_layout_failed` failure. Generalising
// to L/T/U-shaped footprints is future work — likely a different placement
// algorithm entirely (medial axis, or hand-authored splines).

import type { Polygon2D, Point2D } from '../../lib/envelope'
import type { CorridorPlan } from '../types'

/** Default double-loaded corridor width, metres. */
export const DEFAULT_CORRIDOR_WIDTH_M = 1.5

/** Tolerance for "right angle" and "equal length" checks on rectangle detection. */
const RECTANGLE_TOLERANCE = 1e-3

export interface PlaceCorridorOptions {
  /** Width across the corridor, metres. Default 1.5. */
  width?: number
}

export function placeCorridor(
  outline: Polygon2D,
  options: PlaceCorridorOptions = {},
): CorridorPlan | null {
  const width = options.width ?? DEFAULT_CORRIDOR_WIDTH_M
  if (!Number.isFinite(width) || width <= 0) return null

  const rect = asRectangle(outline)
  if (!rect) return null

  const half = width / 2
  // Outward perpendicular to the long-axis direction: rotate +90°.
  const px = -rect.longDir[1]
  const py = rect.longDir[0]

  const halfL = rect.longLen / 2
  const cx = rect.center[0]
  const cy = rect.center[1]
  const ux = rect.longDir[0]
  const uy = rect.longDir[1]

  const start: Point2D = [cx - ux * halfL, cy - uy * halfL]
  const end: Point2D = [cx + ux * halfL, cy + uy * halfL]

  const polygon: Polygon2D = [
    [start[0] + px * half, start[1] + py * half],
    [end[0] + px * half, end[1] + py * half],
    [end[0] - px * half, end[1] - py * half],
    [start[0] - px * half, start[1] - py * half],
  ]

  return {
    polygon,
    centerline: [start, end],
  }
}

interface RectangleAnalysis {
  center: Point2D
  longDir: Point2D // unit vector
  longLen: number
  shortLen: number
}

/**
 * Returns rectangle metadata if `poly` is a rectangle within tolerance, else
 * null. Winding-agnostic. Tolerates the small numeric noise produced by
 * polygon-clipping after envelope/footprint insets.
 */
export function asRectangle(poly: Polygon2D): RectangleAnalysis | null {
  if (poly.length !== 4) return null

  const edges: Array<{ dx: number; dy: number; len: number }> = []
  for (let i = 0; i < 4; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % 4]!
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    if (len < RECTANGLE_TOLERANCE) return null
    edges.push({ dx, dy, len })
  }

  // Right-angle check: each edge perpendicular to its neighbour.
  for (let i = 0; i < 4; i++) {
    const a = edges[i]!
    const b = edges[(i + 1) % 4]!
    const dot = (a.dx * b.dx + a.dy * b.dy) / (a.len * b.len)
    if (Math.abs(dot) > RECTANGLE_TOLERANCE) return null
  }

  // Opposite-side equality.
  if (Math.abs(edges[0]!.len - edges[2]!.len) > RECTANGLE_TOLERANCE * Math.max(edges[0]!.len, edges[2]!.len)) {
    return null
  }
  if (Math.abs(edges[1]!.len - edges[3]!.len) > RECTANGLE_TOLERANCE * Math.max(edges[1]!.len, edges[3]!.len)) {
    return null
  }

  // Pick the longer of the two distinct edge lengths as the long axis.
  // Edges 0 and 2 share a length; same for 1 and 3.
  const len01 = edges[0]!.len
  const len12 = edges[1]!.len
  const longEdgeIndex = len01 >= len12 ? 0 : 1
  const longEdge = edges[longEdgeIndex]!
  const longLen = longEdge.len
  const shortLen = longEdgeIndex === 0 ? len12 : len01
  const longDir: Point2D = [longEdge.dx / longLen, longEdge.dy / longLen]

  const center: Point2D = [
    (poly[0]![0] + poly[1]![0] + poly[2]![0] + poly[3]![0]) / 4,
    (poly[0]![1] + poly[1]![1] + poly[2]![1] + poly[3]![1]) / 4,
  ]

  return { center, longDir, longLen, shortLen }
}
