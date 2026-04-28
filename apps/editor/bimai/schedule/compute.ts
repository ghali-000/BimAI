// Schedule computation.
//
// Pure function over a scene snapshot. No store reads, no React, no DOM —
// safe to run from the panel, the cost layer, or a headless test. The
// snapshot shape mirrors `generator/cleanup.ts`'s `SceneSnapshot` so both
// modules can be fed the same `useScene.getState()` flat-store dump.
//
// Scoping:
//   - We only count nodes carrying the procedural-generation tag (Phase
//     3-3's `metadata.bimai.generatedBy === 'procedural-v1'`). This keeps
//     hand-drawn or imported nodes out of the schedule until we have a
//     story for "what counts as part of the program" beyond the generator.
//   - When `buildingId` is provided we further restrict to descendants of
//     that building, matching `findGeneratedNodes`'s filter. This is the
//     production code path: the schedule panel shows numbers for the
//     active building, not every generated node in the scene.
//
// Area math: every polygon goes through `calculatePolygonArea` (shoelace,
// absolute-valued). `metadata.bimai` reads are defensive — a node with
// missing or malformed metadata silently degrades to "no contribution"
// rather than throwing, with a warning so the panel can surface it.

import type { AnyNode, AnyNodeId, LevelNode, SlabNode, ZoneNode } from '@pascal-app/core'
import { calculatePolygonArea } from '../lib/geometry'
import { isGenerated } from '../generator/tag'
import type {
  ScheduleByFloor,
  ScheduleByUnitType,
  ScheduleResult,
} from './types'

export interface ScheduleSceneSnapshot {
  nodes: Record<AnyNodeId, AnyNode>
}

export interface ComputeScheduleOptions {
  /** When set, restrict to nodes that are descendants of this building. */
  buildingId?: AnyNodeId
}

/**
 * Compute the schedule (GEA / NIA / unit breakdown) for a scene snapshot.
 *
 * Always returns a populated `ScheduleResult` — an empty scene yields
 * zeros across the board, never `null` or `NaN`. The cost layer relies
 * on this contract for its typology multiplications.
 */
export function computeSchedule(
  scene: ScheduleSceneSnapshot,
  options: ComputeScheduleOptions = {},
): ScheduleResult {
  const { buildingId } = options
  const warnings: string[] = []

  // ── Pass 1: collect generated levels / slabs / zones in scope ──────────────
  const levels: LevelNode[] = []
  const slabs: SlabNode[] = []
  const zones: ZoneNode[] = []

  for (const node of Object.values(scene.nodes)) {
    if (!isGenerated(node)) continue
    if (buildingId !== undefined && !isDescendantOf(node, buildingId, scene.nodes)) {
      continue
    }
    if (node.type === 'level') levels.push(node as LevelNode)
    else if (node.type === 'slab') slabs.push(node as SlabNode)
    else if (node.type === 'zone') zones.push(node as ZoneNode)
  }

  // ── Pass 2: bucket slabs + zones by parent level ───────────────────────────
  // Levels are the per-floor anchor; slabs and zones reference their level
  // via parentId. A slab/zone whose parent isn't in our `levels` list is
  // dropped with a warning rather than miscounted.
  const levelById = new Map<AnyNodeId, LevelNode>()
  for (const l of levels) levelById.set(l.id, l)

  const slabsByLevel = new Map<AnyNodeId, SlabNode[]>()
  for (const s of slabs) {
    const parent = s.parentId as AnyNodeId | null
    if (!parent || !levelById.has(parent)) {
      warnings.push(`slab ${s.id}: parent level not found, dropped from schedule`)
      continue
    }
    const arr = slabsByLevel.get(parent) ?? []
    arr.push(s)
    slabsByLevel.set(parent, arr)
  }

  const zonesByLevel = new Map<AnyNodeId, ZoneNode[]>()
  for (const z of zones) {
    const parent = z.parentId as AnyNodeId | null
    if (!parent || !levelById.has(parent)) {
      warnings.push(`zone ${z.id}: parent level not found, dropped from schedule`)
      continue
    }
    const arr = zonesByLevel.get(parent) ?? []
    arr.push(z)
    zonesByLevel.set(parent, arr)
  }

  // ── Pass 3: per-floor reduction ────────────────────────────────────────────
  const byFloor: ScheduleByFloor[] = []
  let totalGEA = 0
  let totalNIA = 0
  for (const level of levels) {
    const slabsHere = slabsByLevel.get(level.id) ?? []
    const zonesHere = zonesByLevel.get(level.id) ?? []
    const gea = slabsHere.reduce((s, x) => s + polyArea(x.polygon), 0)
    const nia = zonesHere.reduce((s, x) => s + polyArea(x.polygon), 0)
    if (slabsHere.length === 0) {
      warnings.push(`level ${level.level}: no slab — GEA reported as 0`)
    }
    byFloor.push({ level: level.level, gea, nia, unitCount: zonesHere.length })
    totalGEA += gea
    totalNIA += nia
  }
  byFloor.sort((a, b) => a.level - b.level)

  // ── Pass 4: per-unit-type residential breakdown ────────────────────────────
  // Across all floors. For variable-floor layouts later this might need a
  // per-floor view too, but the panel today shows the building-wide totals.
  const buckets = new Map<string, { count: number; totalArea: number }>()
  for (const z of zones) {
    const meta = (z.metadata ?? {}) as Record<string, unknown>
    const bimai = (meta.bimai ?? {}) as Record<string, unknown>
    const rawType = bimai.unitType
    const type = typeof rawType === 'string' && rawType.length > 0 ? rawType : '(unknown)'
    if (type === '(unknown)') {
      warnings.push(`zone ${z.id}: missing metadata.bimai.unitType, bucketed as '(unknown)'`)
    }
    const cur = buckets.get(type) ?? { count: 0, totalArea: 0 }
    cur.count += 1
    cur.totalArea += polyArea(z.polygon)
    buckets.set(type, cur)
  }

  const byUnitType: ScheduleByUnitType[] = []
  for (const [type, b] of buckets) {
    byUnitType.push({
      type,
      count: b.count,
      totalArea: b.totalArea,
      avgArea: b.count === 0 ? 0 : b.totalArea / b.count,
    })
  }
  // Stable display order: count desc, then type asc — common case is "the
  // big bucket on top" without ties bouncing run-to-run.
  byUnitType.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))

  // ── Aggregate totals ───────────────────────────────────────────────────────
  const totalUnits = zones.length
  const efficiency = totalGEA === 0 ? 0 : totalNIA / totalGEA
  const avgUnitArea = totalUnits === 0 ? 0 : totalNIA / totalUnits

  return {
    floorCount: levels.length,
    totals: { gea: totalGEA, nia: totalNIA, efficiency },
    byFloor,
    residential: {
      totalUnits,
      avgUnitArea,
      byUnitType,
    },
    warnings,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function polyArea(polygon: ReadonlyArray<readonly [number, number]>): number {
  // calculatePolygonArea wants a mutable [number, number][]; the snapshot
  // gives us readonly tuples. Cast is safe — the helper doesn't mutate.
  return calculatePolygonArea(polygon as Array<[number, number]>)
}

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
