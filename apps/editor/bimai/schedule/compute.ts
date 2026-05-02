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
  ScheduleRoomBreakdown,
  ScheduleRoomBucket,
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
  // Phase 3-8 Task 7: the emitter inserts a synthetic "Roof" LevelNode so
  // parapet walls inherit the correct top-of-top-slab elevation (WallNode has
  // no Y of its own — it inherits from its parent level). That synthetic
  // level is not a habitable floor; including it in byFloor would inflate
  // `floorCount`, leave a level with no slab/zones in the per-floor table,
  // and trigger the "no slab" warning every time. We filter it here via the
  // `metadata.bimai.roofRole === 'roof-level'` tag stamped at emit time.
  // Roof-parented slabs (none today, but reserved) flow into the separate
  // `roofArea` accumulator below rather than into GEA.
  const levels: LevelNode[] = []
  const roofLevelIds = new Set<AnyNodeId>()
  const slabs: SlabNode[] = []
  const zones: ZoneNode[] = []

  for (const node of Object.values(scene.nodes)) {
    if (!isGenerated(node)) continue
    if (buildingId !== undefined && !isDescendantOf(node, buildingId, scene.nodes)) {
      continue
    }
    if (node.type === 'level') {
      const bimai = readBimai(node)
      if (bimai.roofRole === 'roof-level') {
        roofLevelIds.add(node.id)
      } else {
        levels.push(node as LevelNode)
      }
    } else if (node.type === 'slab') slabs.push(node as SlabNode)
    else if (node.type === 'zone') zones.push(node as ZoneNode)
  }

  // Roof slab area — slabs parented to a synthetic Roof level. Today the
  // emitter does not produce one (the topmost floor's slab doubles as the
  // roof deck), but the accumulator is wired up so a future "explicit roof
  // slab" emission lands here without a second compute pass change. Roof
  // slabs are routed away from the per-floor GEA aggregation below.
  let roofArea = 0

  // ── Pass 2: bucket slabs + zones by parent level ───────────────────────────
  // Levels are the per-floor anchor; slabs and zones reference their level
  // via parentId. A slab/zone whose parent isn't in our `levels` list is
  // dropped with a warning rather than miscounted.
  const levelById = new Map<AnyNodeId, LevelNode>()
  for (const l of levels) levelById.set(l.id, l)

  const slabsByLevel = new Map<AnyNodeId, SlabNode[]>()
  for (const s of slabs) {
    const parent = s.parentId as AnyNodeId | null
    if (parent && roofLevelIds.has(parent)) {
      // Roof-parented slab: contributes to roofArea, not per-floor GEA.
      roofArea += polyArea(s.polygon)
      continue
    }
    if (!parent || !levelById.has(parent)) {
      warnings.push(`slab ${s.id}: parent level not found, dropped from schedule`)
      continue
    }
    const arr = slabsByLevel.get(parent) ?? []
    arr.push(s)
    slabsByLevel.set(parent, arr)
  }

  // Phase 3-7: zones split into "unit zones" (the unit envelope, no roomKind
  // in metadata) and "room zones" (sub-rooms within a unit, roomKind set).
  // NIA / per-unit-type aggregation walks unit zones only — including room
  // zones would double-count area, since rooms tile their unit. The
  // roomBreakdown is computed from room zones.
  const unitZones: ZoneNode[] = []
  const roomZones: ZoneNode[] = []
  for (const z of zones) {
    const bimai = readBimai(z)
    if (typeof bimai.roomKind === 'string' && bimai.roomKind.length > 0) {
      roomZones.push(z)
    } else {
      unitZones.push(z)
    }
  }

  const zonesByLevel = new Map<AnyNodeId, ZoneNode[]>()
  for (const z of unitZones) {
    const parent = z.parentId as AnyNodeId | null
    if (!parent || !levelById.has(parent)) {
      warnings.push(`zone ${z.id}: parent level not found, dropped from schedule`)
      continue
    }
    const arr = zonesByLevel.get(parent) ?? []
    arr.push(z)
    zonesByLevel.set(parent, arr)
  }
  // Room zones still need the same orphan check so a stray one doesn't
  // silently distort the breakdown.
  const liveRoomZones: ZoneNode[] = []
  for (const z of roomZones) {
    const parent = z.parentId as AnyNodeId | null
    if (!parent || !levelById.has(parent)) {
      warnings.push(`zone ${z.id}: parent level not found, dropped from schedule`)
      continue
    }
    liveRoomZones.push(z)
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
  // Walks unitZones only (room zones are aggregated separately into
  // roomBreakdown below).
  const buckets = new Map<string, { count: number; totalArea: number }>()
  for (const z of unitZones) {
    const bimai = readBimai(z)
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

  // ── Pass 5: room-kind breakdown (Phase 3-7) ────────────────────────────────
  // Sums room zone areas grouped by canonical kind. Unit-shell zones are
  // not emitted by the generator (unit zone alone covers the shell), so they
  // never appear here. Unknown kinds are silently dropped — roomBreakdown is
  // a curated, panel-ready view of the five residential room types.
  const roomBreakdown = computeRoomBreakdown(liveRoomZones)

  // ── Aggregate totals ───────────────────────────────────────────────────────
  const totalUnits = unitZones.length
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
    roomBreakdown,
    roof: { area: roofArea },
    warnings,
  }
}

// ── Room-breakdown helpers ───────────────────────────────────────────────────

const ROOM_KIND_TO_KEY: Record<string, keyof ScheduleRoomBreakdown> = {
  bedroom: 'bedrooms',
  bathroom: 'bathrooms',
  kitchen: 'kitchens',
  living: 'livingRooms',
  hallway: 'hallways',
}

function emptyBucket(): ScheduleRoomBucket {
  return { count: 0, totalArea: 0, avgArea: 0 }
}

/** Exported for test fixtures that need a concrete `ScheduleResult`. */
export function emptyRoomBreakdown(): ScheduleRoomBreakdown {
  return {
    bedrooms: emptyBucket(),
    bathrooms: emptyBucket(),
    kitchens: emptyBucket(),
    livingRooms: emptyBucket(),
    hallways: emptyBucket(),
  }
}

function computeRoomBreakdown(roomZones: readonly ZoneNode[]): ScheduleRoomBreakdown {
  const result: ScheduleRoomBreakdown = {
    bedrooms: emptyBucket(),
    bathrooms: emptyBucket(),
    kitchens: emptyBucket(),
    livingRooms: emptyBucket(),
    hallways: emptyBucket(),
  }
  for (const z of roomZones) {
    const bimai = readBimai(z)
    const kind = typeof bimai.roomKind === 'string' ? bimai.roomKind : ''
    const key = ROOM_KIND_TO_KEY[kind]
    if (!key) continue // unknown kind: silently drop
    const bucket = result[key]
    bucket.count += 1
    bucket.totalArea += polyArea(z.polygon)
  }
  for (const k of Object.keys(result) as Array<keyof ScheduleRoomBreakdown>) {
    const b = result[k]
    b.avgArea = b.count === 0 ? 0 : b.totalArea / b.count
  }
  return result
}

function readBimai(node: AnyNode): Record<string, unknown> {
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  return (meta.bimai ?? {}) as Record<string, unknown>
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
