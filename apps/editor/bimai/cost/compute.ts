// Cost computation — pure pass over a scene snapshot.
//
// Architecture (hybrid model — see cost/types.ts):
//   1. Walk generated walls/slabs/doors/windows. For each, resolve a price:
//      first the per-component `costOverride` slot that matches the unit
//      (perM2 for surfaces, flat for openings), then the catalog material's
//      `costPerM2` / `costPerUnit`, then a soft fallback (€0 + warning).
//   2. Bucket walls into exterior / loadBearing / interior (disjoint).
//   3. Multiply per-area items by their geometric extent (wall = length ×
//      height, slab = polygon area).
//   4. Pull GEA + unit count from `computeSchedule` — DO NOT recompute area
//      here. Single source of truth keeps the schedule and cost panels
//      consistent under override edits.
//   5. Apply typology categories (MEP, finishes, general conditions,
//      contingency) on top of per-component subtotals.
//   6. Soft costs are a percentage of hard cost; total = hard + soft.
//
// Failure semantics: never throws, never returns NaN/Infinity, populates
// `warnings` for everything that silently degraded (missing material,
// wall with zero length, etc).

import type { AnyNode, AnyNodeId, WallNode } from '@pascal-app/core'
import { BIMAI_MATERIALS, getMaterial, tryGetMaterial } from '../bim/materials'
import type { BimAIMaterial } from '../bim/materials'
import type {
  BimAIMaterialId,
  ComponentBIM,
  CostOverride,
} from '../bim/schemas/component-bim'
import { calculatePolygonArea } from '../lib/geometry'
import { isGenerated } from '../generator/tag'
import { computeSchedule } from '../schedule/compute'
import type { ScheduleResult } from '../schedule/types'
import { resolveTypology, type TypologyOverride } from './typology'
import type {
  CostByWallCategory,
  CostPerComponent,
  CostResult,
} from './types'

export interface CostSceneSnapshot {
  nodes: Record<AnyNodeId, AnyNode>
}

export interface ComputeCostOptions {
  buildingId?: AnyNodeId
  /** Override the typology baseline (defaults pulled from `DEFAULT_TYPOLOGY`).
   *  Callers in the React tree pass the value they read off the site's
   *  `metadata.bimai.typologyOverride`; pure-test callers omit this and
   *  the catalog defaults apply. Keeping the metadata read out of compute
   *  keeps this module zustand-free (and vitest-safe given the
   *  three-mesh-bvh barrel issue with bare `@pascal-app/core` imports). */
  typologyOverride?: TypologyOverride
  /** Pre-computed schedule. Pass to avoid double work in the panel where
   *  the schedule is already on screen. When omitted, computed internally. */
  schedule?: ScheduleResult
}

// ── Wall classification ────────────────────────────────────────────────────

/** Material ids the cost layer treats as "exterior" for wall bucketing. */
const EXTERIOR_WALL_MATERIALS: ReadonlySet<string> = new Set([
  BIMAI_MATERIALS['brick-exterior'].id,
  BIMAI_MATERIALS['concrete-precast-facade'].id,
])

function classifyWall(
  material: BimAIMaterialId | undefined,
  loadBearing: boolean,
): keyof CostByWallCategory {
  if (material && EXTERIOR_WALL_MATERIALS.has(material as string)) return 'exterior'
  if (loadBearing) return 'loadBearing'
  return 'interior'
}

// ── ComponentBIM read ───────────────────────────────────────────────────────

function readComponentBIM(node: AnyNode): Partial<ComponentBIM> {
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const bimai = (meta.bimai ?? {}) as Record<string, unknown>
  const bim = bimai.bim
  if (typeof bim !== 'object' || bim === null) return {}
  return bim as Partial<ComponentBIM>
}

// ── Geometry helpers ────────────────────────────────────────────────────────

function wallSurfaceM2(node: WallNode): number {
  const dx = node.end[0] - node.start[0]
  const dy = node.end[1] - node.start[1]
  const length = Math.hypot(dx, dy)
  const height = node.height ?? 0
  if (!Number.isFinite(length) || !Number.isFinite(height)) return 0
  return length * height
}

function slabAreaM2(node: AnyNode): number {
  const polygon = (node as unknown as { polygon?: [number, number][] }).polygon
  if (!polygon || polygon.length < 3) return 0
  return calculatePolygonArea(polygon)
}

// ── Per-component pricing ───────────────────────────────────────────────────

interface PriceContext {
  warnings: string[]
}

/**
 * Resolve €/m² for a surface (wall, slab). Override beats catalog beats 0.
 * `costOverride.perM2 === 0` means "explicitly free" — honoured, not coalesced.
 */
function pricePerM2(
  override: CostOverride | undefined,
  material: BimAIMaterial | undefined,
  ctx: PriceContext,
  nodeId: string,
  kind: 'wall' | 'slab',
): number {
  if (override?.perM2 !== undefined) return override.perM2
  if (material?.costPerM2 !== undefined) return material.costPerM2
  ctx.warnings.push(
    `${kind} ${nodeId}: no costPerM2 (override absent, material missing or per-unit), priced at €0`,
  )
  return 0
}

/**
 * Resolve flat per-unit price for openings. Override beats catalog beats 0.
 */
function priceFlat(
  override: CostOverride | undefined,
  material: BimAIMaterial | undefined,
  ctx: PriceContext,
  nodeId: string,
  kind: 'door' | 'window',
): number {
  if (override?.flat !== undefined) return override.flat
  if (material?.costPerUnit !== undefined) return material.costPerUnit
  ctx.warnings.push(
    `${kind} ${nodeId}: no costPerUnit (override absent, material missing or per-area), priced at €0`,
  )
  return 0
}

// ── Public entry point ──────────────────────────────────────────────────────

export function computeCost(
  scene: CostSceneSnapshot,
  options: ComputeCostOptions = {},
): CostResult {
  const ctx: PriceContext = { warnings: [] }
  const { buildingId, schedule, typologyOverride } = options

  const typology = resolveTypology(typologyOverride)

  // Resolve schedule — must come from a single source. Skip the `siteId`
  // metadata.read when computing internally to keep the function pure for
  // test consumers passing only `scene`.
  const sched = schedule ?? computeSchedule(scene, { buildingId })

  // ── Per-component walk ────────────────────────────────────────────────────
  const walls: CostByWallCategory = { exterior: 0, interior: 0, loadBearing: 0 }
  let slabs = 0
  let doors = 0
  let windows = 0
  let stairs = 0

  for (const node of Object.values(scene.nodes)) {
    if (!isGenerated(node)) continue
    if (buildingId !== undefined && !isDescendantOf(node, buildingId, scene.nodes)) {
      continue
    }
    const bim = readComponentBIM(node)
    const mat = tryGetMaterial(bim.material)

    switch (node.type) {
      case 'wall': {
        const wn = node as WallNode
        const m2 = wallSurfaceM2(wn)
        if (m2 === 0) {
          ctx.warnings.push(`wall ${wn.id}: zero length or height, skipped`)
          break
        }
        const ratePerM2 = pricePerM2(bim.costOverride, mat, ctx, wn.id, 'wall')
        const cost = m2 * ratePerM2
        const bucket = classifyWall(bim.material, bim.loadBearing ?? false)
        walls[bucket] += cost
        break
      }
      case 'slab': {
        const m2 = slabAreaM2(node)
        if (m2 === 0) {
          ctx.warnings.push(`slab ${node.id}: degenerate polygon, skipped`)
          break
        }
        const ratePerM2 = pricePerM2(bim.costOverride, mat, ctx, node.id, 'slab')
        slabs += m2 * ratePerM2
        break
      }
      case 'door': {
        doors += priceFlat(bim.costOverride, mat, ctx, node.id, 'door')
        break
      }
      case 'window': {
        windows += priceFlat(bim.costOverride, mat, ctx, node.id, 'window')
        break
      }
      case 'stair-segment': {
        // Phase 3-8 Task 8. Stair flights/landings are priced as a tread
        // surface (width × length) × €/m². bim-defaults does not stamp
        // stair-segments today, so `mat` is normally undefined here — fall
        // back to the catalog's concrete-cast price so the cost is non-zero
        // and audit-friendly. Override beats catalog beats fallback.
        const seg = node as unknown as { width?: number; length?: number }
        const width = Number.isFinite(seg.width) ? (seg.width as number) : 0
        const length = Number.isFinite(seg.length) ? (seg.length as number) : 0
        const m2 = width * length
        if (m2 === 0) {
          ctx.warnings.push(
            `stair-segment ${node.id}: zero surface area, skipped`,
          )
          break
        }
        const stairMat: BimAIMaterial | undefined =
          mat ?? BIMAI_MATERIALS['concrete-cast']
        const ratePerM2 = pricePerM2(
          bim.costOverride,
          stairMat,
          ctx,
          node.id,
          'slab',
        )
        stairs += m2 * ratePerM2
        break
      }
      default:
        break
    }
  }

  const perComponent: CostPerComponent = {
    walls,
    slabs,
    openings: { doors, windows },
    stairs,
  }
  const perComponentTotal =
    walls.exterior +
    walls.interior +
    walls.loadBearing +
    slabs +
    doors +
    windows +
    stairs

  // ── Typology categories ───────────────────────────────────────────────────
  const gea = sched.totals.gea
  const mep = typology.mep * gea
  const finishes = typology.finishes * gea
  const generalConditions = typology.generalConditions * gea
  const contingency =
    typology.contingencyPct * (perComponentTotal + mep + finishes + generalConditions)

  const typologyTotal = mep + finishes + generalConditions + contingency
  const hardCost = perComponentTotal + typologyTotal
  const softCosts = typology.softCostsPct * hardCost
  const totalProjectCost = hardCost + softCosts

  // ── Ratios (defensive against /0) ─────────────────────────────────────────
  const perM2OfGEA = gea === 0 ? 0 : totalProjectCost / gea
  const totalUnits = sched.residential.totalUnits
  const perUnit = totalUnits === 0 ? 0 : totalProjectCost / totalUnits

  // Surface schedule warnings too — the cost panel users care about both.
  const warnings = [...ctx.warnings, ...sched.warnings]

  return {
    perComponent,
    perComponentTotal,
    typology: { mep, finishes, generalConditions, contingency },
    typologyTotal,
    hardCost,
    softCosts,
    totalProjectCost,
    perM2OfGEA,
    perUnit,
    warnings,
  }
}

// Re-exposed for symmetry with the schedule module — useful in tests that
// want to know what the "exterior" wall set is without reaching into the
// catalog directly.
export { EXTERIOR_WALL_MATERIALS }
// Re-export getMaterial so test files can construct expected totals using
// the same prices the compute reads (avoids drift if catalog values change).
export { getMaterial }

// ── Helpers ─────────────────────────────────────────────────────────────────

function isDescendantOf(
  node: AnyNode,
  ancestorId: AnyNodeId,
  nodes: Record<AnyNodeId, AnyNode>,
): boolean {
  const seen = new Set<AnyNodeId>()
  let current: AnyNode | undefined = node
  while (current?.parentId) {
    const pid = current.parentId as AnyNodeId
    if (pid === ancestorId) return true
    if (seen.has(pid)) return false
    seen.add(pid)
    current = nodes[pid]
  }
  return false
}
