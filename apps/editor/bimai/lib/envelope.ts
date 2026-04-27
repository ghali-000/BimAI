import polygonClipping from 'polygon-clipping'
import type { ZoningRules } from '../schemas/zoning'
import { calculatePolygonArea } from './geometry'

export type Point2D = [number, number]
export type Polygon2D = Point2D[]

export type EnvelopeResult =
  | { ok: true; polygon: Polygon2D; area: number }
  | { ok: false; reason: 'envelope_collapsed' | 'invalid_plot' }

interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function boundingBox(poly: Polygon2D): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of poly) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

// Signed area: positive when CCW (in standard math axes; here our XZ plane).
function signedArea(poly: Polygon2D): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % poly.length]!
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

function ensureCCW(poly: Polygon2D): Polygon2D {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly
}

// Inward normal for edge a→b in a CCW polygon: rotate edge direction +90°.
// Edge dir = (dx, dy); inward normal = (-dy, dx) normalized.
function offsetEdgeInward(a: Point2D, b: Point2D, d: number): [Point2D, Point2D] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return [a, b]
  const nx = -dy / len
  const ny = dx / len
  return [
    [a[0] + nx * d, a[1] + ny * d],
    [b[0] + nx * d, b[1] + ny * d],
  ]
}

// Intersect two infinite lines defined by (p1,p2) and (p3,p4).
// Returns null if parallel.
function lineIntersect(
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  p4: Point2D,
): Point2D | null {
  const x1 = p1[0]
  const y1 = p1[1]
  const x2 = p2[0]
  const y2 = p2[1]
  const x3 = p3[0]
  const y3 = p3[1]
  const x4 = p4[0]
  const y4 = p4[1]
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(denom) < 1e-9) return null
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]
}

// Compute inward-offset polygon by shifting each edge inward by `distance`,
// then intersecting adjacent shifted edges to recover vertices.
function insetPolygon(poly: Polygon2D, distance: number): Polygon2D {
  const ccw = ensureCCW(poly)
  const n = ccw.length
  const shifted: Array<[Point2D, Point2D]> = []
  for (let i = 0; i < n; i++) {
    shifted.push(offsetEdgeInward(ccw[i]!, ccw[(i + 1) % n]!, distance))
  }
  const result: Polygon2D = []
  for (let i = 0; i < n; i++) {
    const prev = shifted[(i + n - 1) % n]!
    const curr = shifted[i]!
    const v = lineIntersect(prev[0], prev[1], curr[0], curr[1])
    result.push(v ?? curr[0])
  }
  return result
}

// Compute the buildable envelope: plot polygon offset inward by uniform setback
// (mean of front/side/rear). Validates with polygon-clipping intersection
// against the original plot to discard collapsed/inverted geometry.
export function computeEnvelope(
  plotPolygon: Polygon2D,
  zoning: ZoningRules,
): EnvelopeResult {
  if (plotPolygon.length < 3) return { ok: false, reason: 'invalid_plot' }
  const plotArea = calculatePolygonArea(plotPolygon)
  if (plotArea <= 0) return { ok: false, reason: 'invalid_plot' }

  const { front, side, rear } = zoning.setbacks
  const d = (front + side + rear) / 3
  if (d <= 0) {
    return { ok: true, polygon: plotPolygon, area: plotArea }
  }

  const inset = insetPolygon(plotPolygon, d)
  // When setbacks exceed the plot's half-width, the analytic offset produces
  // an inverted/oversized polygon (vertices fall outside the plot). Detect
  // that by checking the inset's bounding box against the plot's: if it's
  // not fully contained, the offset collapsed. signedArea / Math.abs both
  // miss this because the resulting polygon can still be simple and CCW.
  const plotBounds = boundingBox(plotPolygon)
  const insetBounds = boundingBox(inset)
  const eps = 1e-6
  const contained =
    insetBounds.minX >= plotBounds.minX - eps &&
    insetBounds.minY >= plotBounds.minY - eps &&
    insetBounds.maxX <= plotBounds.maxX + eps &&
    insetBounds.maxY <= plotBounds.maxY + eps
  if (!contained) return { ok: false, reason: 'envelope_collapsed' }
  if (signedArea(inset) <= 0) return { ok: false, reason: 'envelope_collapsed' }

  // Clip against the original plot to guarantee containment and discard
  // any self-intersection artifacts produced by the analytic offset.
  const clipped = polygonClipping.intersection(
    [ensureCCW(inset)],
    [ensureCCW(plotPolygon)],
  )
  if (clipped.length === 0) return { ok: false, reason: 'envelope_collapsed' }

  // Pick the largest ring (outer boundary of the largest piece).
  let best: Polygon2D | null = null
  let bestArea = 0
  for (const piece of clipped) {
    const ring = piece[0]
    if (!ring || ring.length < 4) continue
    // polygon-clipping returns closed rings (first === last); drop the last.
    const open: Polygon2D = ring.slice(0, -1).map((p) => [p[0], p[1]])
    const a = calculatePolygonArea(open)
    if (a > bestArea) {
      bestArea = a
      best = open
    }
  }

  if (!best || bestArea <= 0) return { ok: false, reason: 'envelope_collapsed' }
  return { ok: true, polygon: best, area: bestArea }
}
