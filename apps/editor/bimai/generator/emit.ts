// Plan-to-NodeOps emitter.
//
// Translates a BuildingPlan into the flat list of `{ node, parentId }` ops
// that Pascal's `useScene.getState().createNodes(...)` consumes. Pure: no
// store reads, no DOM, no mutations of the input plan. The orchestrator
// (Task 10) is responsible for cleanup, transactional wrapping, and undo
// pause/resume.
//
// Coordinate frames:
//   - Levels only offset along Y; level XZ == world XZ. So all wall starts/
//     ends, slab polygons, and zone polygons live in the same XZ plane the
//     plan was authored in.
//   - Doors / windows attach as children of walls and use wall-local 1D
//     position (X along wall from start, Y = height above wall base).
//
// Emit order matters: parents before children so `createNodesAction` has
// somewhere to wire each child's `parentId` reference.

import type {
  AnyNode,
  AnyNodeId,
  DoorNode,
  LevelNode,
  SlabNode,
  WallNode,
  WindowNode,
  ZoneNode,
} from '@pascal-app/core'
import type { Polygon2D, Point2D } from '../lib/envelope'
import { roomColor, unitColor } from '../lib/unit-colors'
import { generateId } from './ids'
import { asRectangle } from './stages/corridor'
import { tagAsGenerated } from './tag'
import type {
  BuildingPlan,
  CorridorPlan,
  FloorPlan,
  NodeOp,
  UnitPlan,
} from './types'

// ── Tunables ─────────────────────────────────────────────────────────────────

export const DEFAULT_WALL_THICKNESS_M = 0.15
/** Interior partition between two rooms inside the same unit. Thinner than
 *  the unit envelope (which is structural perimeter or party wall). */
export const DEFAULT_PARTITION_THICKNESS_M = 0.1
export const DEFAULT_DOOR_WIDTH_M = 0.9
export const DEFAULT_DOOR_HEIGHT_M = 2.1
export const DEFAULT_WINDOW_WIDTH_M = 1.5
export const DEFAULT_WINDOW_HEIGHT_M = 1.5
export const DEFAULT_WINDOW_SILL_M = 0.9
export const DEFAULT_SLAB_ELEVATION_M = 0.05
/** Minimum free wall length around an opening. Keeps openings off corners. */
export const OPENING_CLEAR_MARGIN_M = 0.2

// ── Public API ───────────────────────────────────────────────────────────────

export interface EmitContext {
  /** Owning building. The plan's levels become children of this node. */
  buildingId: AnyNodeId
  /** Stamped onto every emitted node's metadata.bimai.generationId. */
  generationId: string
}

/**
 * Top-level entry point. Returns a flat list of NodeOps in dependency order
 * (level → slab/walls/zones → door/window children of walls).
 */
export function emitBuildingPlan(
  plan: BuildingPlan,
  ctx: EmitContext,
): NodeOp[] {
  const ops: NodeOp[] = []
  for (const floor of plan.floors) {
    ops.push(...emitFloor(floor, plan, ctx))
  }
  return ops
}

// ── Floor-level emitter ──────────────────────────────────────────────────────

function emitFloor(
  floor: FloorPlan,
  plan: BuildingPlan,
  ctx: EmitContext,
): NodeOp[] {
  const ops: NodeOp[] = []

  const levelId = generateId('level')
  ops.push(emitLevel(levelId, floor, ctx))

  ops.push(emitSlab(levelId, floor, ctx))

  // Walls. We pre-allocate IDs so doors/windows can reference them.
  const wallSet = buildWallSet(floor, plan, ctx)
  for (const w of wallSet.all) {
    ops.push({ node: w.node, parentId: levelId })
  }

  // Room-partition walls (Phase 3-7 Task 5). One WallNode per shared
  // interior edge across all units on this floor; deduped by the stable
  // RoomWall.id assigned by `buildRoomWalls` so a single drywall between
  // bedroom and hallway materialises once. Drywall (interior, non-load-
  // bearing) — bim-defaults stamps the material from the wallRole tag.
  for (const partition of emitRoomPartitions(floor, plan, ctx)) {
    ops.push({ node: partition, parentId: levelId })
  }

  // Zones (one per unit, plus one per room within each unit).
  for (const unit of floor.units) {
    const unitZoneOp = emitUnitZone(levelId, unit, ctx)
    ops.push(unitZoneOp)
    // Phase 3-7 Task 6: emit a ZoneNode per RoomPlan, sibling of the
    // unit zone but linked to it via `metadata.bimai.unitId`. Test
    // fixtures predating 3-7 have `unit.rooms === undefined`, so the
    // `?? []` keeps them green.
    for (const op of emitRoomZones(levelId, unit, unitZoneOp.node.id, ctx)) {
      ops.push(op)
    }
  }

  // Openings (children of walls).
  for (const unit of floor.units) {
    const opening = emitUnitOpenings(unit, floor, wallSet, plan, ctx)
    ops.push(...opening)
  }

  return ops
}

// ── Level / slab / zone ──────────────────────────────────────────────────────

function emitLevel(
  levelId: ReturnType<typeof generateId<'level'>>,
  floor: FloorPlan,
  ctx: EmitContext,
): NodeOp {
  const node: LevelNode = {
    object: 'node',
    id: levelId,
    type: 'level',
    name: `Level ${floor.level}`,
    parentId: ctx.buildingId,
    visible: true,
    level: floor.level,
    children: [],
    metadata: {},
  } as unknown as LevelNode
  return { node: tagAsGenerated(node, ctx.generationId), parentId: ctx.buildingId }
}

function emitSlab(
  levelId: AnyNodeId,
  floor: FloorPlan,
  ctx: EmitContext,
): NodeOp {
  const id = generateId('slab')
  const node: SlabNode = {
    object: 'node',
    id,
    type: 'slab',
    parentId: levelId,
    visible: true,
    polygon: floor.outline.map((p) => [p[0], p[1]] as [number, number]),
    holes: [],
    holeMetadata: [],
    elevation: DEFAULT_SLAB_ELEVATION_M,
    autoFromWalls: false,
    metadata: {},
  } as unknown as SlabNode
  return { node: tagAsGenerated(node, ctx.generationId), parentId: levelId }
}

function emitUnitZone(
  levelId: AnyNodeId,
  unit: UnitPlan,
  ctx: EmitContext,
): NodeOp {
  const id = generateId('zone')
  const node: ZoneNode = {
    object: 'node',
    id,
    type: 'zone',
    name: unit.type,
    parentId: levelId,
    visible: true,
    polygon: unit.polygon.map((p) => [p[0], p[1]] as [number, number]),
    color: unitColor(unit.type),
    metadata: {
      bimai: {
        unitType: unit.type,
        targetArea: unit.area,
      },
    },
  } as unknown as ZoneNode
  // tagAsGenerated deep-merges, so unitType / targetArea survive.
  return { node: tagAsGenerated(node, ctx.generationId), parentId: levelId }
}

/**
 * Emit one ZoneNode per RoomPlan inside a unit (Phase 3-7 Task 6).
 *
 * The room zone is a sibling of the unit zone, both children of the level.
 * The relationship to the parent unit is captured in
 * `metadata.bimai.unitId` (the unit ZoneNode's id) — keeping the tree flat
 * matches the "all generated nodes are children of the level" pattern used
 * elsewhere in this emitter and avoids any zone-nesting edge cases the
 * scene-tree UI may not handle yet.
 *
 * Metadata vocabulary (`metadata.bimai`):
 *   - roomKind     RoomKind the room was classified as. Drives material /
 *                  IFC LongName / schedule grouping downstream.
 *   - unitId       Pascal nanoid of the parent unit zone. Lets the IFC
 *                  writer (Task 9) and the schedule layer reconstruct
 *                  "rooms ⊂ unit" without re-running the packer.
 *   - unitType     Cached for read-only consumers that want to filter by
 *                  unit type without resolving `unitId` first.
 *   - roomArea     Pre-computed m². Same source-of-truth note as
 *                  `targetArea` on the unit zone — recomputing from polygon
 *                  is fine, this is just a perf shortcut.
 *   - windowAccess Whether the room touches a facade. Read by the IFC
 *                  writer's IfcSpace `IsExternal` flag and by the schedule
 *                  layer's "habitable rooms" count.
 *
 * Returns an empty array for units with no rooms (pre-3-7 test fixtures).
 */
function emitRoomZones(
  levelId: AnyNodeId,
  unit: UnitPlan,
  unitId: AnyNodeId,
  ctx: EmitContext,
): NodeOp[] {
  const ops: NodeOp[] = []
  for (const room of unit.rooms ?? []) {
    // Suppress unit-shell rooms: their polygon equals the unit zone's
    // polygon, so emitting both would double-count area in the schedule
    // aggregation (NIA, room breakdown). The unit zone alone covers the
    // shell. Tasks 7 (schedule) and 9 (IFC) rely on this convention:
    // Studios → 1 IfcSpace (the unit zone); larger units → 1 unit IfcSpace
    // + N room IfcSpaces with IfcRelAggregates.
    if (room.kind === 'unit-shell') continue
    const id = generateId('zone')
    const node: ZoneNode = {
      object: 'node',
      id,
      type: 'zone',
      name: `${unit.type} · ${room.kind}`,
      parentId: levelId,
      visible: true,
      polygon: room.polygon.map((p) => [p[0], p[1]] as [number, number]),
      color: roomColor(room.kind),
      metadata: {
        bimai: {
          roomKind: room.kind,
          unitId,
          unitType: unit.type,
          roomArea: room.area,
          windowAccess: room.windowAccess,
        },
      },
    } as unknown as ZoneNode
    ops.push({
      node: tagAsGenerated(node, ctx.generationId),
      parentId: levelId,
    })
  }
  return ops
}

// ── Walls ────────────────────────────────────────────────────────────────────

interface WallEntry {
  node: WallNode
  /** Local key so openings can look up the right wall. */
  key: string
}

interface WallSet {
  /** All walls, in insertion order. */
  all: WallEntry[]
  /** Outline (perimeter) walls indexed by side: 'long_pos' | 'long_neg' | 'short_pos' | 'short_neg'. */
  perimeter: Record<string, WallEntry>
  /** Corridor walls indexed by 'pos' (+v side) / 'neg'. */
  corridor: Record<string, WallEntry>
}

function buildWallSet(
  floor: FloorPlan,
  plan: BuildingPlan,
  ctx: EmitContext,
): WallSet {
  const rect = asRectangle(floor.outline)
  if (!rect) {
    // Should never happen — corridor stage already validated rectangularity —
    // but emit zero walls rather than throw if it does.
    return { all: [], perimeter: {}, corridor: {} }
  }

  const ux = rect.longDir[0]
  const uy = rect.longDir[1]
  const vx = -uy
  const vy = ux
  const cx = rect.center[0]
  const cy = rect.center[1]
  const halfL = rect.longLen / 2
  const halfS = rect.shortLen / 2
  const corridorHalf = corridorWidthOf(floor.corridor) / 2

  const toWorld = (u: number, v: number): Point2D => [
    cx + u * ux + v * vx,
    cy + u * uy + v * vy,
  ]

  const wallHeight = plan.floorHeight

  const perimeter: Record<string, WallEntry> = {}
  const corridor: Record<string, WallEntry> = {}
  const all: WallEntry[] = []

  const pushWall = (
    key: string,
    a: Point2D,
    b: Point2D,
    bucket: Record<string, WallEntry> | null,
    role: 'perimeter' | 'corridor' | 'party',
  ) => {
    const id = generateId('wall')
    const node: WallNode = {
      object: 'node',
      id,
      type: 'wall',
      parentId: null, // set by createNodesAction
      visible: true,
      start: [a[0], a[1]],
      end: [b[0], b[1]],
      thickness: DEFAULT_WALL_THICKNESS_M,
      height: wallHeight,
      children: [],
      frontSide: 'unknown',
      backSide: 'unknown',
      // wallRole lives in BimAI's namespace; the bim-defaults stage reads it
      // to pick exterior-vs-interior + load-bearing without re-deriving from
      // geometry. Renderer never sees it.
      metadata: { bimai: { wallRole: role } },
    } as unknown as WallNode
    const entry: WallEntry = {
      node: tagAsGenerated(node, ctx.generationId),
      key,
    }
    all.push(entry)
    if (bucket) bucket[key] = entry
    return entry
  }

  // Perimeter — 4 walls of the floor outline. Direction goes CCW around the
  // rectangle in (u,v) for sign=+1 winding, but openings only need the start
  // and end points so winding is fine either way.
  pushWall('long_pos', toWorld(-halfL, halfS), toWorld(halfL, halfS), perimeter, 'perimeter')
  pushWall('long_neg', toWorld(-halfL, -halfS), toWorld(halfL, -halfS), perimeter, 'perimeter')
  pushWall('short_pos', toWorld(halfL, -halfS), toWorld(halfL, halfS), perimeter, 'perimeter')
  pushWall('short_neg', toWorld(-halfL, -halfS), toWorld(-halfL, halfS), perimeter, 'perimeter')

  // Corridor walls — one along each side of the corridor strip.
  pushWall(
    'corridor_pos',
    toWorld(-halfL, corridorHalf),
    toWorld(halfL, corridorHalf),
    corridor,
    'corridor',
  )
  pushWall(
    'corridor_neg',
    toWorld(-halfL, -corridorHalf),
    toWorld(halfL, -corridorHalf),
    corridor,
    'corridor',
  )

  // Party walls — between adjacent units within each strip. We project each
  // unit's u-extent and emit a wall at every internal boundary u where two
  // units meet. A Set dedupes coincident boundaries shared between strips.
  const partySeen = new Set<string>()
  for (const sign of [1, -1] as const) {
    const cuts = unitUCuts(floor.units, rect, sign)
    for (const u of cuts) {
      const key = `party_${sign === 1 ? 'pos' : 'neg'}_${u.toFixed(4)}`
      if (partySeen.has(key)) continue
      partySeen.add(key)
      const v0 = sign * corridorHalf
      const v1 = sign * halfS
      pushWall(key, toWorld(u, v0), toWorld(u, v1), null, 'party')
    }
  }

  return { all, perimeter, corridor }
}

/**
 * Materialise interior partition walls for every room subdivision on the
 * floor. Walks `floor.units[*].rooms[*].walls`, keeps the entries with
 * `isExterior: false` (interior partitions only — exteriors are the unit
 * envelope, already emitted by `buildWallSet`), and dedupes by the stable
 * RoomWall.id so each shared edge becomes a single WallNode.
 *
 * Returns the WallNodes in insertion order; the caller wires them to the
 * level. Pure; no scene access.
 */
function emitRoomPartitions(
  floor: FloorPlan,
  plan: BuildingPlan,
  ctx: EmitContext,
): WallNode[] {
  const out: WallNode[] = []
  const seen = new Set<string>()
  const wallHeight = plan.floorHeight
  for (const unit of floor.units) {
    // Test fixtures predating Phase 3-7 omit `rooms` — defend against
    // them so the emitter stays useful in narrow unit tests that don't
    // round-trip through `attachRoomsToUnits`.
    for (const room of unit.rooms ?? []) {
      for (const w of room.walls ?? []) {
        if (w.isExterior) continue
        if (seen.has(w.id)) continue
        seen.add(w.id)
        const id = generateId('wall')
        const node: WallNode = {
          object: 'node',
          id,
          type: 'wall',
          parentId: null, // set by createNodesAction
          visible: true,
          start: [w.from[0], w.from[1]],
          end: [w.to[0], w.to[1]],
          thickness: DEFAULT_PARTITION_THICKNESS_M,
          height: wallHeight,
          children: [],
          // Both sides face habitable rooms inside the unit. Renderer-
          // agnostic; the IFC writer turns this into IfcWallStandardCase
          // sides. 'interior' is the schema enum value for "no facade
          // treatment, no party-wall fire rating bump".
          frontSide: 'interior',
          backSide: 'interior',
          metadata: { bimai: { wallRole: 'room-partition' } },
        } as unknown as WallNode
        out.push(tagAsGenerated(node, ctx.generationId) as WallNode)
      }
    }
  }
  return out
}

/** Recover corridor width perpendicular to the long axis from the polygon. */
function corridorWidthOf(corridor: CorridorPlan): number {
  // The corridor polygon is a rectangle [start+px*h, end+px*h, end-px*h, start-px*h].
  // The 0→3 edge runs across the width.
  const p0 = corridor.polygon[0]
  const p3 = corridor.polygon[3]
  if (!p0 || !p3) return 0
  return Math.hypot(p3[0] - p0[0], p3[1] - p0[1])
}

/** Internal u-coordinate cuts where party walls go for a given strip. */
function unitUCuts(
  units: UnitPlan[],
  rect: NonNullable<ReturnType<typeof asRectangle>>,
  sign: 1 | -1,
): number[] {
  const ux = rect.longDir[0]
  const uy = rect.longDir[1]
  const vx = -uy
  const vy = ux
  const cx = rect.center[0]
  const cy = rect.center[1]
  const cuts: number[] = []
  const halfL = rect.longLen / 2
  for (const unit of units) {
    if (sideOfUnit(unit, rect) !== sign) continue
    // Vertices 0 (uStart, vInner) and 1 (uEnd, vInner) define the corridor edge.
    const p0 = unit.polygon[0]!
    const p1 = unit.polygon[1]!
    // Convert to local u — project along (ux,uy) from center.
    const u0 = (p0[0] - cx) * ux + (p0[1] - cy) * uy
    const u1 = (p1[0] - cx) * ux + (p1[1] - cy) * uy
    // Interior cuts only — exclude the building ends.
    for (const u of [u0, u1]) {
      if (Math.abs(u - halfL) < 1e-6 || Math.abs(u + halfL) < 1e-6) continue
      cuts.push(u)
    }
    // Silence unused `vx`,`vy` warning: kept for future use when we project v.
    void vx
    void vy
  }
  // Round and dedupe so coincident-cuts from neighbouring units collapse.
  const rounded = Array.from(new Set(cuts.map((u) => +u.toFixed(4)))).sort(
    (a, b) => a - b,
  )
  return rounded
}

function sideOfUnit(
  unit: UnitPlan,
  rect: NonNullable<ReturnType<typeof asRectangle>>,
): 1 | -1 {
  // Use centroid v-coordinate sign.
  const cx = rect.center[0]
  const cy = rect.center[1]
  const vx = -rect.longDir[1]
  const vy = rect.longDir[0]
  let v = 0
  for (const p of unit.polygon) v += (p[0] - cx) * vx + (p[1] - cy) * vy
  return v / unit.polygon.length >= 0 ? 1 : -1
}

// ── Openings (doors + windows) ───────────────────────────────────────────────

function emitUnitOpenings(
  unit: UnitPlan,
  floor: FloorPlan,
  wallSet: WallSet,
  plan: BuildingPlan,
  ctx: EmitContext,
): NodeOp[] {
  const rect = asRectangle(floor.outline)
  if (!rect) return []
  const side = sideOfUnit(unit, rect)
  const corridorWall = side === 1 ? wallSet.corridor.corridor_pos : wallSet.corridor.corridor_neg
  const facadeWall = side === 1 ? wallSet.perimeter.long_pos : wallSet.perimeter.long_neg
  if (!corridorWall || !facadeWall) return []

  const ops: NodeOp[] = []

  // Door at the corridor edge midpoint.
  const corridorMid = midpoint(unit.polygon[0]!, unit.polygon[1]!)
  const doorOp = emitDoorOnWall(corridorWall.node, corridorMid, plan, ctx)
  if (doorOp) ops.push(doorOp)

  // Window at the facade edge midpoint.
  const facadeMid = midpoint(unit.polygon[2]!, unit.polygon[3]!)
  const winOp = emitWindowOnWall(facadeWall.node, facadeMid, unit, plan, ctx)
  if (winOp) ops.push(winOp)

  return ops
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

function wallLocalX(wall: WallNode, p: Point2D): number {
  const dx = wall.end[0] - wall.start[0]
  const dy = wall.end[1] - wall.start[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return 0
  return ((p[0] - wall.start[0]) * dx + (p[1] - wall.start[1]) * dy) / len
}

function wallLength(wall: WallNode): number {
  return Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
}

function emitDoorOnWall(
  wall: WallNode,
  worldPoint: Point2D,
  _plan: BuildingPlan,
  ctx: EmitContext,
): NodeOp | null {
  const x = wallLocalX(wall, worldPoint)
  const len = wallLength(wall)
  const halfW = DEFAULT_DOOR_WIDTH_M / 2 + OPENING_CLEAR_MARGIN_M
  // Refuse to emit if the wall is too short to host the door.
  if (len < DEFAULT_DOOR_WIDTH_M + 2 * OPENING_CLEAR_MARGIN_M) return null
  const clamped = Math.max(halfW, Math.min(len - halfW, x))

  const id = generateId('door')
  const node: DoorNode = {
    object: 'node',
    id,
    type: 'door',
    parentId: wall.id,
    // The DoorNode schema carries an explicit optional `wallId` for
    // host-wall reference. Pascal itself doesn't currently consume it,
    // but the IFC writer uses it to resolve the door's host placement —
    // without this, doors fall through to the storey placement and end
    // up as a diagonal staircase in BIMcollab. Set it eagerly so the
    // schema invariant ("doors/windows reference their host wall")
    // holds at emit time, decoupled from any future Pascal restructure
    // that might change `parentId`.
    wallId: wall.id,
    visible: true,
    position: [clamped, DEFAULT_DOOR_HEIGHT_M / 2, 0],
    rotation: [0, 0, 0],
    width: DEFAULT_DOOR_WIDTH_M,
    height: DEFAULT_DOOR_HEIGHT_M,
    metadata: {},
  } as unknown as DoorNode
  return {
    node: tagAsGenerated(node, ctx.generationId),
    parentId: wall.id as AnyNodeId,
  }
}

function emitWindowOnWall(
  wall: WallNode,
  worldPoint: Point2D,
  unit: UnitPlan,
  _plan: BuildingPlan,
  ctx: EmitContext,
): NodeOp | null {
  const x = wallLocalX(wall, worldPoint)
  const len = wallLength(wall)

  // Cap the window width to fit inside the unit's facade-edge length, with
  // margin. Otherwise narrow units get a window wider than the unit itself.
  const facadeEdgeLen = Math.hypot(
    unit.polygon[3]![0] - unit.polygon[2]![0],
    unit.polygon[3]![1] - unit.polygon[2]![1],
  )
  const maxW = facadeEdgeLen - 2 * OPENING_CLEAR_MARGIN_M
  if (maxW <= 0) return null
  const width = Math.min(DEFAULT_WINDOW_WIDTH_M, maxW)

  const halfW = width / 2 + OPENING_CLEAR_MARGIN_M
  if (len < width + 2 * OPENING_CLEAR_MARGIN_M) return null
  const clamped = Math.max(halfW, Math.min(len - halfW, x))

  const id = generateId('window')
  const node: WindowNode = {
    object: 'node',
    id,
    type: 'window',
    parentId: wall.id,
    // See emitDoorOnWall: the writer keys host resolution off `wallId`,
    // not `parentId`. Set both so the schema invariant holds eagerly.
    wallId: wall.id,
    visible: true,
    position: [
      clamped,
      DEFAULT_WINDOW_SILL_M + DEFAULT_WINDOW_HEIGHT_M / 2,
      0,
    ],
    rotation: [0, 0, 0],
    width,
    height: DEFAULT_WINDOW_HEIGHT_M,
    metadata: {},
  } as unknown as WindowNode
  return {
    node: tagAsGenerated(node, ctx.generationId),
    parentId: wall.id as AnyNodeId,
  }
}

// ── Type-narrowing re-export so callers don't need @pascal-app/core types ────

export type { AnyNode, NodeOp }
