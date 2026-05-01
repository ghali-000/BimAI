// Phase 3-8 Task 6 (GATE 2) — roof typology decision and roof-plan
// construction.
//
// Locks the residential mid-rise roof typology: `flat-with-parapet`,
// 1.0 m parapet, 0.15 m thickness, polygon === top-slab outline. The
// alternative typologies in the data model (`flat-without-parapet`,
// `pitched`) are forward-compatible placeholders — the planner does
// not select them in 3-8. Phase 3-9 may extend this when the program
// gains explicit "accessory building" or "rural" use-cases.
//
// Why a dedicated stage rather than an inline literal in pipeline.ts:
//   - Roof emission (Task 7) reads `RoofPlan` directly. Centralising
//     the decision means the emitter stays a thin translation layer.
//   - The optimizer (Phase 3-5) records the resolved plan; if roof
//     parameters ever become a knob (parapet height, pitched-roof
//     pitch), this stage is the single place to lift them out of
//     hard-coded defaults.
//   - Tests can lock the decision rule without round-tripping through
//     the entire `buildPlan` pipeline.
//
// Parapet wall ids: canonical-edge-hash under a per-roof seed (the
// snapped lex-min footprint vertex), matching the pattern Phase 3-7
// established for partition walls and Phase 3-8 Task 4 reused for
// shaft walls. Same plan ⇒ same `parapet_<12hex>` ids across regen,
// so the IFC writer's `IfcWallStandardCase` for parapet walls keeps
// stable GlobalIds.
//
// `flat-with-parapet` is the 3-8 default. The decision is a pure
// function of program intent (residential), not a runtime knob — the
// rule lives here so a future "commercial top-floor terrace ⇒ no
// parapet" extension is a one-line branch instead of a hunt across
// the codebase.

import { cyrb128Hex } from '../../lib/hash'
import type { Point2D, Polygon2D } from '../../lib/envelope'
import type { RoofPlan } from '../types'

/** Default parapet height in metres. Residential mid-rise convention. */
export const DEFAULT_PARAPET_HEIGHT_M = 1.0
/** Default parapet thickness in metres. Matches a typical perimeter
 *  upstand (slightly thinner than a structural wall). */
export const DEFAULT_PARAPET_THICKNESS_M = 0.15

/** Public typology slot. `'pitched'` is a forward-compat placeholder
 *  not selected by the planner in Phase 3-8. */
export type RoofTypology = RoofPlan['typology']

export interface ChooseRoofTypologyInput {
  /** Total storeys. Single-floor buildings still get a roof — the top
   *  slab IS the roof — but the typology decision still runs through
   *  here so the rule lives in one place. */
  floorCount: number
}

/**
 * GATE 2 — locked decision. In Phase 3-8 every plan we emit is a
 * residential mid-rise: `flat-with-parapet`. This is intentional and
 * tested; the function exists so the rule is greppable and so future
 * variants slot in as additional branches rather than a sprinkled
 * literal hunt.
 */
export function chooseRoofTypology(
  input: ChooseRoofTypologyInput,
): RoofTypology {
  void input
  return 'flat-with-parapet'
}

export interface PlanRoofInput {
  /** Top-floor slab outline in world coords. Becomes the roof slab
   *  outline byte-for-byte; the slab itself is emitted by the floors
   *  stage and not duplicated by Task 7 emission. */
  footprint: Polygon2D
  floorCount: number
  /** Floor-to-floor height in metres. Roof elevation = floors × this. */
  floorHeight: number
}

/**
 * Build a `RoofPlan` for the given building. Pure: no scene access,
 * no plan-id minting (the parapet wall ids are deterministic hashes
 * over the footprint).
 *
 * For `flat-with-parapet` (the only typology selected in 3-8) the
 * planner returns:
 *   - `slabPolygon` = footprint (matches the top-slab outline so the
 *     IFC writer's `IfcRoof` and the cost / schedule code agree on
 *     the perimeter without re-deriving from the slab op).
 *   - `parapet.polygon` = footprint, traced once around the perimeter.
 *     For a rectangular footprint the polygon has 4 vertices and the
 *     emitter materialises 4 parapet walls, one per edge.
 *   - `parapet.wallIds[i]` = canonical-edge-hash of edge `i` under a
 *     per-roof seed (snapped lex-min footprint vertex). Same plan ⇒
 *     same ids across regen.
 *
 * For `flat-without-parapet` the parapet field is omitted (the data
 * model already permits this); not selected today, but the branch
 * keeps the contract honest.
 */
export function planRoof(input: PlanRoofInput): RoofPlan {
  const typology = chooseRoofTypology({ floorCount: input.floorCount })
  const elevation = input.floorCount * input.floorHeight
  const slabPolygon: Polygon2D = input.footprint.map(
    (p) => [p[0], p[1]] as Point2D,
  )

  if (typology !== 'flat-with-parapet') {
    return { typology, slabPolygon, elevation }
  }

  const seed = roofSeed(input.footprint)
  const wallIds: string[] = []
  for (let i = 0; i < slabPolygon.length; i++) {
    const a = slabPolygon[i]!
    const b = slabPolygon[(i + 1) % slabPolygon.length]!
    wallIds.push(canonicalParapetWallId(seed, a, b))
  }
  return {
    typology,
    slabPolygon,
    elevation,
    parapet: {
      polygon: slabPolygon.map((p) => [p[0], p[1]] as Point2D),
      height: DEFAULT_PARAPET_HEIGHT_M,
      thickness: DEFAULT_PARAPET_THICKNESS_M,
      wallIds,
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SNAP_EPSILON = 1e-4

function snap(n: number): string {
  const r = Math.round(n / SNAP_EPSILON) * SNAP_EPSILON
  return (Math.abs(r) < SNAP_EPSILON / 2 ? 0 : r).toFixed(4)
}

function lexMinVertex(poly: ReadonlyArray<Point2D>): Point2D {
  let lex = poly[0]!
  for (const p of poly) {
    if (p[0] < lex[0] || (p[0] === lex[0] && p[1] < lex[1])) lex = p
  }
  return lex
}

/** Per-roof hash seed. Stable across regen of the same footprint. */
function roofSeed(footprint: ReadonlyArray<Point2D>): string {
  const lex = lexMinVertex(footprint)
  return `roof|${snap(lex[0])},${snap(lex[1])}|${footprint.length}`
}

function canonicalParapetWallId(
  seed: string,
  a: Point2D,
  b: Point2D,
): string {
  const ax = snap(a[0])
  const ay = snap(a[1])
  const bx = snap(b[0])
  const by = snap(b[1])
  const aFirst = ax < bx || (ax === bx && ay <= by)
  const [p, q] = aFirst ? [[ax, ay], [bx, by]] : [[bx, by], [ax, ay]]
  const key = `${seed}|${p[0]},${p[1]}→${q[0]},${q[1]}`
  return `parapet_${cyrb128Hex(key).slice(0, 12)}`
}
