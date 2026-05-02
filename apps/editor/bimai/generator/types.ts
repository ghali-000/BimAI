// Generator contracts. Type-only — no runtime code lives here.
//
// These shapes are the pipeline's lingua franca. Every stage either consumes
// a piece of `BuildingPlan` or contributes a piece of one. The apply stage
// converts the plan into Pascal node operations; the orchestrator returns
// `GeneratorOutput`.
//
// Coordinate convention matches Pascal: `[x, z]` pairs (XZ plane, Y-up).
// Same as `ZoneNode.polygon`, `SlabNode.polygon`, `SiteNode.polygon.points`.

import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import type { GenerationParams } from '../optimizer/params'
import type { Program, ZoningRules } from '../schemas'

export type { GenerationParams } from '../optimizer/params'

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface GeneratorInput {
  siteId: AnyNodeId
  buildingId: AnyNodeId
  plotPolygon: [number, number][]
  zoning: ZoningRules
  program: Program
  /** Optional. When omitted, the pipeline derives a stable seed from inputs. */
  seed?: number
  /**
   * Optional. When omitted (or partial), missing fields fall through to
   * `DEFAULT_PARAMS` — the pre-3-5 pipeline behaviour. Set per-field by the
   * optimizer; the panel UI never sets it directly.
   */
  params?: Partial<GenerationParams>
}

// ── Plan (intermediate) ──────────────────────────────────────────────────────

export interface UnitPlan {
  /** Matches a Program.unitMix entry's `type`. */
  type: string
  polygon: [number, number][]
  /** Computed area in m². */
  area: number
  /** Indices into `polygon` for edges that face the building exterior (windows). */
  facadeEdges: number[]
  /** Indices into `polygon` for edges that face the corridor (doors). */
  corridorEdges: number[]
  /**
   * Rooms inside this unit. Phase 3-7 makes this required: every unit has
   * at least one room. The Phase 3-3 stub interpretation lives on as a
   * degenerate single-room layout — `[{ kind: 'unit-shell', ... }]` — for
   * units that haven't been subdivided yet (Studios, fallback when
   * subdivision fails, fixtures from before 3-7).
   */
  rooms: RoomPlan[]
}

/**
 * Room categories. The optimizer / scheduler / IFC writer / cost layer
 * key off these. `unit-shell` is the degenerate "the whole unit is one
 * open room" case (used for Studios in the simple emission path and for
 * any unit subdivision that opts out, e.g. a future "open-plan" template).
 */
export type RoomKind =
  | 'bedroom'
  | 'bathroom'
  | 'kitchen'
  | 'living'
  | 'hallway'
  | 'unit-shell'

/**
 * Wall segment forming part of a room's boundary. Each wall is a directed
 * line segment from `from` to `to`. `isExterior = true` means the wall
 * coincides with the unit's outer envelope (a unit perimeter wall the
 * Phase 3-3 emitter already produced); `false` means it's an interior
 * partition between rooms inside the same unit (a Phase 3-7 emission).
 *
 * The `id` is a stable identifier the rooms-packing stage assigns so
 * adjacent rooms can refer to the same shared wall by reference rather
 * than by floating-point coordinate equality. Format is opaque — the
 * downstream emitter doesn't parse it; it only de-duplicates by id.
 */
export interface RoomWall {
  id: string
  from: [number, number]
  to: [number, number]
  isExterior: boolean
}

/**
 * Door connecting two rooms. `from` / `to` carry the room kinds (the
 * graph relationship the door encodes), `position` is a world-space
 * point on the shared partition wall, `wallId` references the host
 * RoomWall by its stable canonical-edge id so the emitter can look up
 * the corresponding emitted WallNode without floating-point coordinate
 * matching.
 *
 * Doors are deduplicated at planning time: a door between bedroom and
 * hallway is owned by the non-hallway room (the destination), so each
 * door appears exactly once across the unit's RoomPlan[]. Downstream
 * emitters walk `room.doors` and trust the count.
 */
export interface RoomDoor {
  from: RoomKind
  to: RoomKind
  position: [number, number]
  wallId: string
}

export interface RoomPlan {
  /** Categorical room type. Drives material selection, IFC LongName, schedule grouping. */
  kind: RoomKind
  /** Closed CCW polygon in unit-local world coords. */
  polygon: [number, number][]
  /** Computed area in m². */
  area: number
  /**
   * Walls bounding this room. Includes both exterior (unit envelope) and
   * interior (partition) walls. The interior partitions are what the
   * Phase 3-7 emitter writes as new `WallNode`s with
   * `metadata.bimai.wallRole: 'room-partition'`; exteriors are read-only
   * references — the unit packer already emitted those WallNodes.
   */
  walls: RoomWall[]
  /**
   * Doors on this room's boundary. Each door connects this room (or
   * the unit corridor) to an adjacent room. Position is a 2D point in
   * the same coord frame as `polygon`.
   */
  doors: RoomDoor[]
  /**
   * True if at least one of this room's walls is exterior — i.e. the
   * room has access to a facade and can reasonably be assumed to have
   * a window. Bedrooms / living rooms / kitchens are expected to be
   * `true`; bathrooms / hallways are typically `false`. Used by the
   * subdivision algorithm's quality scoring (Task 4) and by the
   * schedule layer's "habitable rooms" count.
   */
  windowAccess: boolean
}

/**
 * How the corridor partitions the floor plate into habitable strips.
 *
 *   - `'double-loaded'`: corridor runs through the floor centre with units
 *     flanking on both sides. Two strips. The canonical efficient layout
 *     and what residential plans default to whenever the perpendicular
 *     dimension can fit two TARGET_STRIP_DEPTH_M strips plus the corridor.
 *   - `'single-loaded'`: corridor hugs one outline edge with a single
 *     habitable strip on the other side. Used as the fallback for plates
 *     too narrow for double-loaded — keeps units present (and bisecting)
 *     instead of degrading to "no units placed at all". Half the unit
 *     count per floor; the strip is whatever depth the leftover offers.
 *
 * The packer reads this to decide how many strips to place units in.
 */
export type CorridorMode = 'double-loaded' | 'single-loaded'

/**
 * Phase 3-8: a u-axis interval (in the corridor centerline frame) that
 * the unit packer must skip. Used to carve out the stair shaft footprint
 * from the unit-strip run before packing.
 *
 * `uMin` / `uMax` are in OBB-local corridor coords: `uMin = -runLength/2`
 * is the centerline's start, `uMax = +runLength/2` is the end. Phase 3-8
 * supports only end-of-strip reservations (an interval touching either
 * `±runLength/2`); mid-strip "skip-and-resume" is the Phase 3-9 upgrade
 * path for a central stair core. The packer asserts the end-of-strip
 * invariant.
 */
export interface ReservedCorridorRegion {
  /** Lower u-bound (corridor centerline frame, metres). */
  uMin: number
  /** Upper u-bound (corridor centerline frame, metres). */
  uMax: number
  /**
   * Why this region is reserved. Surfaced in the typed packer warning
   * that fires when a unit gets dropped because of the reservation.
   */
  reason: 'stair-shaft' | 'elevator-shaft'
}

export interface CorridorPlan {
  polygon: [number, number][]
  centerline: [[number, number], [number, number]]
  /**
   * Which side of the centerline the strip(s) occupy. `'double-loaded'`
   * fills both sides; `'single-loaded'` fills only the +perpendicular
   * side (the corridor edge then coincides with the −perpendicular
   * outline edge).
   */
  mode: CorridorMode
  /**
   * Corridor run length (parallel to centerline). Equals `longLen` when
   * orientation is 'long-axis', `shortLen` when 'short-axis'. The unit
   * packer reads this rather than re-deriving from `asRectangle`, since
   * the packer's "long axis" is the corridor's run axis (regardless of
   * which rectangle dimension it's parallel to).
   */
  runLength?: number
  /**
   * Strip depth perpendicular to the corridor. For `'double-loaded'` this
   * is the depth of *each* of the two flanking strips (fixed at
   * `TARGET_STRIP_DEPTH_M` once the plate fits two strips + corridor).
   * For `'single-loaded'` this is the depth of the lone strip (whatever
   * `shortLen − corridorWidth` resolves to — capped at TARGET_STRIP_DEPTH_M).
   */
  stripDepth?: number
  /**
   * Phase 3-8: u-axis intervals the packer must skip. Populated by the
   * stairs stage before packing; absent / empty means no reservations.
   * Intervals are in the corridor centerline frame (see
   * `ReservedCorridorRegion`).
   */
  reservedRegions?: ReservedCorridorRegion[]
}

export interface FloorPlan {
  /** 0 = ground floor. */
  level: number
  outline: [number, number][]
  corridor: CorridorPlan
  units: UnitPlan[]
}

/**
 * Phase 3-8: stair core. One per fire-egress shaft. The default residential
 * mid-rise we target ships with a single end-of-corridor core; the array
 * shape is forward-compatible with multi-core fire-egress (Phase 3-9 once
 * plot sizes grow past the single-core walking-distance threshold).
 *
 * Coords are world-space `[x, z]` matching every other plan polygon. The
 * shaft is always rectangular in 3-8 (per the brief's anti-pattern list);
 * `shaftPolygon` is the four-vertex CCW outer rectangle.
 *
 * `enclosingWallIds` are canonical-edge-hashed ids (Phase 3-7 pattern from
 * `rooms-walls.ts`'s `cyrb128Hex` over snapped + lex-min-sorted endpoints)
 * so the walls and the slab penetrations agree on identity across regen.
 */
export interface StairCorePlan {
  /**
   * Stable across regen. Phase 3-9 format: `stair_core_{N}` where N is
   * the positional index — 0 = end-of-corridor core, 1 = central core
   * (when `placeStairCores` returns 2 cores under the end-plus-central
   * strategy). Sub-threshold buildings have only `stair_core_0`.
   * (Phase 3-8 used `stair_<12hex>` content-hashed ids; the positional
   * form is more legible downstream — cost / IFC writers can refer to
   * "the end core" without re-deriving a hash from inputs. Underscores
   * not hyphens because Pascal's StairNode schema enforces
   * `^stair_<rest>$` on node ids.)
   */
  id: string
  /** OBB-local origin in building frame (corner of the shaft rectangle). */
  position: [number, number]
  /** Metres. Default 2.5 (residential template). */
  width: number
  /** Metres. Default 4.0 (flight + landing). */
  depth: number
  /** One flight per inter-floor span. `[]` for single-floor buildings. */
  flights: StairFlightPlan[]
  /** Outer rectangle of the stair shaft (4-vertex CCW). */
  shaftPolygon: [number, number][]
  /** Canonical ids of the four shaft walls. */
  enclosingWallIds: string[]
}

export interface StairFlightPlan {
  /** Source level index (0 = ground). */
  fromLevel: number
  /** Destination level index. Always `fromLevel + 1` in 3-8. */
  toLevel: number
  /** Metres above the building base. */
  startElevation: number
  /** Metres above the building base. */
  endElevation: number
  /** Default ~17 for 3 m floor-to-floor at 0.18 m typical riser. */
  stepCount: number
  /** Metres. */
  stepHeight: number
  /** Metres. */
  stepDepth: number
}

/**
 * Phase 3-8: roof plan. Always present, even on flat-without-parapet roofs
 * (the type still records typology + slab outline so the IFC writer can
 * emit `IfcRoof` regardless of whether parapet walls exist).
 *
 * `slabPolygon` matches the top-floor slab outline byte-for-byte; the
 * top slab itself is already emitted by the floors stage and is not
 * re-emitted by the roof stage.
 *
 * `parapet` is omitted when typology is `'flat-without-parapet'`. When
 * present, `polygon` traces the slab perimeter (same vertices as
 * `slabPolygon` for a rectangular footprint) and `wallIds[i]` is the
 * canonical-edge id of the parapet wall along edge `i` of the polygon.
 */
export interface RoofPlan {
  typology: 'flat-with-parapet' | 'flat-without-parapet' | 'pitched'
  slabPolygon: [number, number][]
  /** Top-of-building elevation (top slab top in metres). */
  elevation: number
  parapet?: {
    polygon: [number, number][]
    /** Metres above roof slab. Default 1.0. */
    height: number
    /** Metres. Default 0.15. */
    thickness: number
    /** Canonical ids per polygon edge. Length === polygon.length. */
    wallIds: string[]
  }
}

export interface BuildingPlan {
  /** Stamped onto every generated node's `metadata.bimai.generationId`. */
  generationId: string
  footprint: [number, number][]
  floorCount: number
  /** Floor-to-floor height in metres. */
  floorHeight: number
  floors: FloorPlan[]
  /**
   * Phase 3-8: stair cores. `[]` for single-floor buildings (no stairs
   * needed). Multi-floor buildings ship with at least one core; the array
   * supports 2+ for fire egress on large plots in Phase 3-9.
   */
  stairs: StairCorePlan[]
  /**
   * Phase 3-8: roof plan. Always present (even single-floor buildings get
   * a roof — the top slab is the roof slab). Default typology is
   * `'flat-with-parapet'` for residential mid-rise.
   */
  roof: RoofPlan
  /** Non-fatal issues, e.g. "could not place all studio units". */
  warnings: string[]
  /**
   * The fully-resolved params this plan was built with. Recorded so the
   * optimizer can reproduce a candidate from its plan (seed + every knob)
   * and so the live scene can show "this generation used corridor: short-axis".
   * Always present after Phase 3-5 — null only on plans loaded from
   * pre-3-5 fixtures.
   */
  params: GenerationParams
}

// ── Apply stage I/O ──────────────────────────────────────────────────────────

export interface NodeOp {
  node: AnyNode
  parentId?: AnyNodeId
}

// ── Output ───────────────────────────────────────────────────────────────────

export type GeneratorFailureReason =
  | 'envelope_collapsed'
  | 'program_exceeds_capacity'
  | 'no_valid_footprint'
  | 'corridor_layout_failed'
  | 'unit_packing_failed'
  | 'invalid_input'

/**
 * Top-line "did we satisfy the program?" stats. Computed from the program
 * mix and the actual unit polygons emitted on a single floor (we assume all
 * floors are identical today — see the floors-vary caveat in PROGRESS.md).
 *
 * placementRate is `unitsPlacedPerFloor / unitsRequested`, in [0, 1]. When
 * unitsRequested is 0 the rate is 1 by convention (no demand → trivially
 * satisfied). totalAcrossFloors lets the UI show absolute building-wide
 * counts without the panel doing arithmetic.
 */
export interface PlacementSummary {
  unitsRequested: number
  unitsPlacedPerFloor: number
  placementRate: number
  totalAcrossFloors: number
}

export type GeneratorOutput =
  | {
      ok: true
      plan: BuildingPlan
      opsApplied: number
      warnings: string[]
      placement: PlacementSummary
    }
  | { ok: false; reason: GeneratorFailureReason; issues: string[] }
