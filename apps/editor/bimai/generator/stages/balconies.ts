// Phase 3-9 Task 11: balcony emission.
//
// Each unit whose chosen variant declared a `BalconySpec` and whose
// program opted into balconies (`UnitPlan.balcony` populated by the
// Task 10 wiring) gets:
//   - one outdoor SlabNode projecting `balcony.depthM` off the unit's
//     facade edge (`metadata.bimai.slabRole = 'balcony'`)
//   - three FenceNodes wrapping the slab's three exposed sides
//     (`metadata.bimai.fenceRole = 'balcony-railing'`); the fourth
//     side is the unit wall and stays open
//
// Both the balcony slab and its fences parent to the floor's level
// node — same Phase 3-8 follow-up invariant as every other emitted
// node ("everything parents to a level"). The fences carry
// `balconyId` metadata that links each railing back to its slab so
// downstream consumers (cost, schedule, IFC) can group them.
//
// Geometry caveat. The balcony slab projects beyond the building
// footprint. The optimizer's envelope-containment check would
// reject this geometry if it ran post-emit; in 3-9 the optimizer
// runs pre-emit (against the unit packer's outline), so the
// out-of-envelope balcony is invisible to compliance. Phase 3-10
// adds explicit "encroachment up to 1.5 m past the buildable
// envelope" — the typical zoning allowance for balconies.
//
// Emission policy:
//   - `unit.balcony` undefined ⇒ unit gets no balcony (the indoor
//     variant path or `generateBalconies: false`).
//   - `unit.facadeEdges.length === 0` ⇒ skip silently. Interior
//     units never have a facade to attach to; the selector should
//     have filtered the balcony variant out, but a defensive guard
//     here keeps the emitter pure.
//   - First-facade-edge attachment. Phase 3-9 picks `facadeEdges[0]`
//     deterministically. The variant's `balcony.attachTo` (which
//     room kind) is honoured insofar as the variant chooses
//     `'living'` (the default for every shipped balcony variant);
//     once Phase 3-10 adds room-to-edge mapping the emitter can
//     route the balcony off the specific room's facade.

import type { AnyNodeId, FenceNode, SlabNode } from '@pascal-app/core'
import { generateId } from '../ids'
import { tagAsGenerated } from '../tag'
import type { NodeOp, UnitPlan } from '../types'

/**
 * Slim subset of `EmitContext` from `emit.ts` — we only need the
 * generationId for the `tagAsGenerated` call. Declared locally so
 * stages don't import from emit.ts (which would invert the
 * dependency direction).
 */
export interface BalconyEmitContext {
  generationId: string
}

/** Residential code minimum railing height in metres. */
export const DEFAULT_BALCONY_RAILING_HEIGHT_M = 1.1
/** Slab thickness for the projecting balcony deck. Thinner than
 *  interior slabs because the balcony is a cantilevered tray, not a
 *  load-floor. */
export const DEFAULT_BALCONY_SLAB_THICKNESS_M = 0.18
/** Vertical offset of the balcony slab below the unit's floor level —
 *  matches the indoor slab elevation so the balcony lines up with the
 *  unit's interior floor. */
export const DEFAULT_BALCONY_SLAB_ELEVATION_M = 0.05

/**
 * Emit balcony slabs + fences for every unit on a floor whose chosen
 * variant declared a balcony AND opted in. Pure: no scene reads, no
 * mutations of the input plan; returns a flat list of NodeOps to be
 * concatenated with the floor's other ops.
 *
 * The balcony rectangle's polygon is winding-correct CCW so the
 * SlabNode's body extrusion (Pascal-side, +Y up) doesn't flip.
 */
export function emitBalconies(
  units: ReadonlyArray<UnitPlan>,
  ctx: BalconyEmitContext,
  parentId: AnyNodeId,
): NodeOp[] {
  const ops: NodeOp[] = []
  for (const unit of units) {
    if (!unit.balcony) continue
    if (unit.facadeEdges.length === 0) continue
    const balconyOps = emitOneBalcony(unit, ctx, parentId)
    ops.push(...balconyOps)
  }
  return ops
}

/**
 * Emit one balcony slab + 3 fences for a single unit. Exported for
 * direct testing of the geometry — `emitBalconies` is the integration
 * seam the floor emitter calls.
 */
export function emitOneBalcony(
  unit: UnitPlan,
  ctx: BalconyEmitContext,
  parentId: AnyNodeId,
): NodeOp[] {
  const ops: NodeOp[] = []
  if (!unit.balcony) return ops
  const facadeIdx = unit.facadeEdges[0]!
  const n = unit.polygon.length
  const a = unit.polygon[facadeIdx]!
  const b = unit.polygon[(facadeIdx + 1) % n]!

  const balconyRect = projectBalconyRect(unit.polygon, a, b, unit.balcony.depthM)
  if (!balconyRect) return ops

  const slabId = generateId('slab')
  const slab: SlabNode = {
    object: 'node',
    id: slabId,
    type: 'slab',
    parentId,
    visible: true,
    polygon: balconyRect.map((p) => [p[0], p[1]] as [number, number]),
    holes: [],
    holeMetadata: [],
    elevation: DEFAULT_BALCONY_SLAB_ELEVATION_M,
    autoFromWalls: false,
    metadata: {
      bimai: {
        slabRole: 'balcony',
        unitId: unit.type,
        attachTo: unit.balcony.attachTo,
      },
    },
  } as unknown as SlabNode
  ops.push({ node: tagAsGenerated(slab, ctx.generationId), parentId })

  // Three fence segments wrapping the outboard sides. Vertex layout:
  //   balconyRect[0] = a            (inboard, unit-wall side, unfenced)
  //   balconyRect[1] = b            (inboard end)
  //   balconyRect[2] = b + n×depth  (outboard end)
  //   balconyRect[3] = a + n×depth  (outboard start)
  // Fences:
  //   side 1: balconyRect[1] → balconyRect[2]   (right-end railing)
  //   side 2: balconyRect[2] → balconyRect[3]   (front railing — outboard)
  //   side 3: balconyRect[3] → balconyRect[0]   (left-end railing)
  const fenceSides: Array<[number, number]> = [
    [1, 2],
    [2, 3],
    [3, 0],
  ]
  for (let i = 0; i < fenceSides.length; i++) {
    const [si, ei] = fenceSides[i]!
    const start = balconyRect[si]!
    const end = balconyRect[ei]!
    const fenceId = generateId('fence')
    const fence: FenceNode = {
      object: 'node',
      id: fenceId,
      type: 'fence',
      parentId,
      visible: true,
      start: [start[0], start[1]],
      end: [end[0], end[1]],
      height: DEFAULT_BALCONY_RAILING_HEIGHT_M,
      thickness: 0.04,
      baseHeight: 0.04,
      postSpacing: 1.2,
      postSize: 0.05,
      topRailHeight: 0.04,
      groundClearance: 0,
      edgeInset: 0.015,
      baseStyle: 'grounded',
      style: 'rail',
      color: '#cccccc',
      metadata: {
        bimai: {
          fenceRole: 'balcony-railing',
          balconyId: slabId,
          railingSegment: i,
        },
      },
    } as unknown as FenceNode
    ops.push({ node: tagAsGenerated(fence, ctx.generationId), parentId })
  }
  return ops
}

/**
 * Project a balcony rectangle outboard from the facade edge (a → b)
 * by `depthM`, picking the outward normal that points AWAY from the
 * unit centroid. Returns the rectangle as four CCW-ish vertices
 * `[a, b, b + n×depthM, a + n×depthM]` or null if the edge is
 * degenerate.
 *
 * The rectangle's winding direction follows the outward-normal pick,
 * so for a CCW unit polygon the balcony is also CCW (Pascal's slab
 * extrusion is winding-tolerant in practice but we keep the
 * convention consistent).
 */
function projectBalconyRect(
  unitPolygon: ReadonlyArray<readonly [number, number]>,
  a: readonly [number, number],
  b: readonly [number, number],
  depthM: number,
): [number, number][] | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  // Unit normal candidates — perpendicular to the edge.
  const cand1: [number, number] = [-dy / len, dx / len]
  const cand2: [number, number] = [dy / len, -dx / len]
  // Pick the one pointing AWAY from the unit centroid.
  const cx =
    unitPolygon.reduce((s, p) => s + p[0], 0) / unitPolygon.length
  const cy =
    unitPolygon.reduce((s, p) => s + p[1], 0) / unitPolygon.length
  const midx = (a[0] + b[0]) / 2
  const midy = (a[1] + b[1]) / 2
  // Vector from centroid to edge midpoint:
  const outX = midx - cx
  const outY = midy - cy
  const dot1 = cand1[0] * outX + cand1[1] * outY
  const dot2 = cand2[0] * outX + cand2[1] * outY
  const outward = dot1 >= dot2 ? cand1 : cand2
  const offsetX = outward[0] * depthM
  const offsetY = outward[1] * depthM
  return [
    [a[0], a[1]],
    [b[0], b[1]],
    [b[0] + offsetX, b[1] + offsetY],
    [a[0] + offsetX, a[1] + offsetY],
  ]
}
