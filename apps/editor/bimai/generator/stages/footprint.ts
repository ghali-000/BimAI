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
import { insetPolygon, type Polygon2D } from '../../lib/envelope'
import { calculatePolygonArea } from '../../lib/geometry'
import type { Program, ZoningRules } from '../../schemas'

/** Structural margin applied inside the legal envelope, in metres. */
export const STRUCTURAL_MARGIN_M = 0.5

/** Below this area (m²) we consider the footprint unbuildable. */
export const MIN_FOOTPRINT_AREA_M2 = 4

export interface FootprintResult {
  polygon: Polygon2D
  area: number
}

/**
 * Choose the building footprint inside an already-validated envelope.
 *
 * Currently `zoning` and `program` are unused by this stage — they're in the
 * signature so future variants (e.g. coverage-aware shrink, FAR-aware
 * resizing) can plug in without churning callers. Keep them in the signature.
 */
export function chooseFootprint(
  envelope: Polygon2D,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: reserved for future variants
  _zoning: ZoningRules,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: reserved for future variants
  _program: Program,
): FootprintResult | null {
  if (envelope.length < 3) return null
  const envelopeArea = calculatePolygonArea(envelope)
  if (envelopeArea <= 0) return null

  const inset = insetPolygon(envelope, STRUCTURAL_MARGIN_M)
  if (inset.length < 3) return null

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
