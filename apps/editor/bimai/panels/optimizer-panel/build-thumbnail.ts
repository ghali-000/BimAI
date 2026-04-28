// Pure SVG-data builder for a candidate's plan thumbnail.
//
// Inputs: a BuildingPlan (we render only floors[0] — ground floor is
// canonical for the gallery) and a unit-type → fill resolver. Output:
// a flat list of layers in paint order plus a viewBox string. The
// React thumbnail component (./candidate-thumbnail.tsx) is a thin
// wrapper that maps each layer to one SVG element. Keeping the
// geometry math here means we can test it under vitest's `node`
// environment without spinning up jsdom — same pattern the rest of
// the bimai workspace follows.
//
// Paint order (back to front):
//   1. footprint  — building bounding outline, light gray fill
//   2. corridor   — distinct lighter fill so it reads as circulation
//   3. unit zone  — coloured by unit type
//   4. wall edge  — thin dark outline on the footprint perimeter
// We deliberately skip plot polygon, envelope, doors, windows, and
// labels at this scale — too much context shrinks the building to
// noise per the gate-3 spec.
//
// viewBox: tight building bbox + 10% margin. Buildings of any aspect
// ratio render with `preserveAspectRatio="xMidYMid meet"` in the
// component, so a 4:3 card always letterboxes correctly without
// stretching the plan.

import type { BuildingPlan, FloorPlan } from '../../generator/types'

export type ThumbnailLayerKind = 'footprint' | 'corridor' | 'unit' | 'wall'

export interface ThumbnailLayer {
  kind: ThumbnailLayerKind
  /** SVG path-data string (M ... L ... Z). Closed for fills, also
   *  closed for the wall stroke (footprint perimeter). */
  d: string
  /** Fill colour. Omitted for the wall layer (stroke-only). */
  fill?: string
  /** Stroke colour. Omitted for fill-only layers. */
  stroke?: string
  /** Stroke width in *user units* (i.e. metres). The component scales
   *  it down via `vector-effect: non-scaling-stroke` so the line stays
   *  thin regardless of card size. */
  strokeWidth?: number
  /** For unit layers: the unit type name. Useful for tests + future
   *  hover tooltips; ignored by the renderer otherwise. */
  unitType?: string
}

export interface ThumbnailData {
  viewBox: string
  layers: ThumbnailLayer[]
}

export interface BuildThumbnailOpts {
  /** Resolver — pass the centralized `unitColor` so the gallery and
   *  the 3D viewer paint the same Studio/1BR/2BR shades. Injected
   *  rather than imported so tests can verify references without
   *  hardcoding palette knowledge here. */
  unitColor: (type: string) => string
  /** Margin around the building bbox, fraction of bbox size.
   *  Default 0.10 (10% on every side). */
  marginFrac?: number
  /** Fill colour for the footprint layer. */
  footprintFill?: string
  /** Fill colour for the corridor layer. */
  corridorFill?: string
  /** Stroke colour for the wall outline. */
  wallStroke?: string
  /** Wall stroke width in metres. The component renders it as a
   *  non-scaling stroke. */
  wallStrokeWidth?: number
}

const DEFAULT_OPTS: Required<Omit<BuildThumbnailOpts, 'unitColor'>> = {
  marginFrac: 0.1,
  footprintFill: 'rgba(255, 255, 255, 0.08)',
  corridorFill: 'rgba(255, 255, 255, 0.18)',
  wallStroke: 'rgba(0, 0, 0, 0.7)',
  wallStrokeWidth: 0.15,
}

/**
 * Build the SVG data for one candidate's ground-floor thumbnail.
 *
 * Layers come back in paint order. Throws if the plan has no floors —
 * that's a bug upstream (every successful pipeline run produces at
 * least one floor) and surfaces it loudly rather than silently
 * rendering an empty card.
 */
export function buildThumbnail(
  plan: BuildingPlan,
  opts: BuildThumbnailOpts,
): ThumbnailData {
  const o = { ...DEFAULT_OPTS, ...opts }
  if (plan.floors.length === 0) {
    throw new Error('buildThumbnail: plan has no floors')
  }
  const floor: FloorPlan = plan.floors[0]!

  // bbox over the footprint only — we don't include corridor/units
  // because they're (by construction) inside the footprint, so any
  // bbox calc that hits all four would give the same result for less
  // information.
  const bbox = polygonBbox(plan.footprint)
  const viewBox = bboxToViewBox(bbox, o.marginFrac)

  const layers: ThumbnailLayer[] = []

  // 1. Footprint fill.
  layers.push({
    kind: 'footprint',
    d: polygonPath(plan.footprint),
    fill: o.footprintFill,
  })

  // 2. Corridor fill.
  if (floor.corridor.polygon.length >= 3) {
    layers.push({
      kind: 'corridor',
      d: polygonPath(floor.corridor.polygon),
      fill: o.corridorFill,
    })
  }

  // 3. Unit zones, in plan order. The optimizer's unit packer emits
  //    them in a stable order and we don't shuffle here, so two thumbs
  //    of the "same-ish" plan look spatially comparable.
  for (const unit of floor.units) {
    if (unit.polygon.length < 3) continue
    layers.push({
      kind: 'unit',
      d: polygonPath(unit.polygon),
      fill: opts.unitColor(unit.type),
      unitType: unit.type,
    })
  }

  // 4. Wall edge — stroke-only path along the footprint perimeter.
  layers.push({
    kind: 'wall',
    d: polygonPath(plan.footprint),
    stroke: o.wallStroke,
    strokeWidth: o.wallStrokeWidth,
  })

  return { viewBox, layers }
}

// ── geometry helpers ────────────────────────────────────────────────────────

interface Bbox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function polygonBbox(poly: [number, number][]): Bbox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of poly) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

function bboxToViewBox(bbox: Bbox, marginFrac: number): string {
  const w = Math.max(bbox.maxX - bbox.minX, 1e-6)
  const h = Math.max(bbox.maxY - bbox.minY, 1e-6)
  const mx = w * marginFrac
  const my = h * marginFrac
  // SVG y is conventionally down; the floor plan's y is up. We don't
  // negate here — we let the renderer flip with a transform so the
  // viewBox stays in math-space. Keeps the bbox math intuitive.
  const x = bbox.minX - mx
  const y = bbox.minY - my
  const vw = w + mx * 2
  const vh = h + my * 2
  return `${fmt(x)} ${fmt(y)} ${fmt(vw)} ${fmt(vh)}`
}

function polygonPath(poly: [number, number][]): string {
  if (poly.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < poly.length; i++) {
    const [x, y] = poly[i]!
    parts.push(`${i === 0 ? 'M' : 'L'} ${fmt(x)} ${fmt(y)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

/** Trim trailing zeros for compact viewBox + path strings; ~3 decimal
 *  places is plenty at thumbnail scale. */
function fmt(n: number): string {
  return Number(n.toFixed(3)).toString()
}
