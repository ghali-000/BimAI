// Footprint stage: pick the building's outer-wall outline.
//
// The input `envelope` is the buildable polygon produced upstream by
// `bimai/lib/envelope.ts` — already inset from the plot by zoning setbacks.
// Here we shrink it once more by a small structural margin (0.5 m) so the
// generated walls don't sit flush with the legal envelope boundary; this
// leaves room for facade thickness, eaves, and minor offsets without
// violating setback. Per Phase 3-3, footprints are rectangular-friendly but
// we don't enforce rectangularity here — we just inset and validate. The
// rectangle assumption shows up later in corridor and unit packing.
//
// Returns null on degenerate results (collapsed polygon, area below
// threshold, or analytic offset overflowing the envelope). The orchestrator
// converts null into the typed failure `{ ok: false, reason: 'no_valid_footprint' }`.

import polygonClipping from 'polygon-clipping'
import { insetPolygon, type Point2D, type Polygon2D } from '../../lib/envelope'
import { calculatePolygonArea } from '../../lib/geometry'
import type { GenerationParams } from '../../optimizer/params'
import type { Program, ZoningRules } from '../../schemas'

/**
 * Default structural margin applied inside the legal envelope, in metres.
 * Phase 3-5 turns this into a parameter — `params.footprintInsetM` —
 * defaulting to this value so prior callers reproduce.
 */
export const STRUCTURAL_MARGIN_M = 0.5

/** Below this area (m²) we consider the footprint unbuildable. */
export const MIN_FOOTPRINT_AREA_M2 = 4

export interface FootprintResult {
  polygon: Polygon2D
  area: number
}

export interface FootprintParams {
  /** Inset beyond envelope, metres. Defaults to STRUCTURAL_MARGIN_M. */
  insetM?: number
  /**
   * Rotation about the inset polygon's centroid, radians. Defaults to 0
   * (no rotation, current behaviour). Non-zero rotates the rectangle and
   * re-validates against the envelope; if the rotated shape overflows the
   * envelope we return null.
   */
  orientation?: number
}

/**
 * Choose the building footprint inside an already-validated envelope.
 *
 * Currently `zoning` and `program` are unused by this stage — they're in the
 * signature so future variants (e.g. coverage-aware shrink, FAR-aware
 * resizing) can plug in without churning callers. Keep them in the signature.
 *
 * `params` (optional) lets the optimizer vary structural margin and footprint
 * orientation. Omitting it reproduces the Phase 3-3 behaviour exactly.
 */
export function chooseFootprint(
  envelope: Polygon2D,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: reserved for future variants
  _zoning: ZoningRules,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: reserved for future variants
  _program: Program,
  params: FootprintParams = {},
): FootprintResult | null {
  if (envelope.length < 3) return null
  const envelopeArea = calculatePolygonArea(envelope)
  if (envelopeArea <= 0) return null

  const insetM = params.insetM ?? STRUCTURAL_MARGIN_M
  if (!Number.isFinite(insetM) || insetM < 0) return null

  let inset = insetPolygon(envelope, insetM)
  if (inset.length < 3) return null

  const orientation = params.orientation ?? 0
  if (!Number.isFinite(orientation)) return null
  if (orientation !== 0) {
    inset = rotateAboutCentroid(inset, orientation)
    if (inset.length < 3) return null
  }

  // Authoritative containment: the analytic inset can self-intersect or
  // overflow on rotated/concave envelopes (same failure mode envelope.ts
  // guards against). Reject if any part lies outside the envelope.
  const overflow = polygonClipping.difference([inset], [envelope])
  if (overflow.length > 0) return null

  // Materialise via intersection so degenerate touches collapse cleanly.
  const clipped = polygonClipping.intersection([inset], [envelope])
  if (clipped.length === 0) return null

  let best: Polygon2D | null = null
  let bestArea = 0
  for (const piece of clipped) {
    const ring = piece[0]
    if (!ring || ring.length < 4) continue
    // polygon-clipping returns closed rings; drop the duplicated last point.
    const open: Polygon2D = ring.slice(0, -1).map((p) => [p[0], p[1]])
    const a = calculatePolygonArea(open)
    if (a > bestArea) {
      bestArea = a
      best = open
    }
  }

  if (!best || bestArea < MIN_FOOTPRINT_AREA_M2) return null
  return { polygon: best, area: bestArea }
}

/**
 * Rotate a polygon about its centroid by `theta` radians. Used for the
 * `footprintOrientation` parameter — the rotated polygon is then re-clipped
 * against the envelope so any overflow is rejected by the standard guard.
 */
function rotateAboutCentroid(poly: Polygon2D, theta: number): Polygon2D {
  if (poly.length === 0) return poly
  let cx = 0
  let cy = 0
  for (const [x, y] of poly) {
    cx += x
    cy += y
  }
  cx /= poly.length
  cy /= poly.length
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return poly.map(([x, y]): Point2D => {
    const dx = x - cx
    const dy = y - cy
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
  })
}

/**
 * Slice of `GenerationParams` consumed by this stage. Re-exported for
 * pipeline-level threading — the orchestrator extracts these fields and
 * passes them as `FootprintParams`.
 */
export function footprintParamsFrom(p: GenerationParams): FootprintParams {
  return { insetM: p.footprintInsetM, orientation: p.footprintOrientation }
}
