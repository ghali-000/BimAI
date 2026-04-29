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
 * point on the shared partition wall.
 *
 * Doors are deduplicated by the rooms-packing stage so a single door
 * between bedroom and hallway appears once, owned by whichever room the
 * algorithm walks first. Downstream emitters don't need to deduplicate.
 */
export interface RoomDoor {
  from: RoomKind
  to: RoomKind
  position: [number, number]
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

export interface CorridorPlan {
  polygon: [number, number][]
  centerline: [[number, number], [number, number]]
  /**
   * Corridor run length (parallel to centerline). Equals `longLen` when
   * orientation is 'long-axis', `shortLen` when 'short-axis'. The unit
   * packer reads this rather than re-deriving from `asRectangle`, since
   * the packer's "long axis" is the corridor's run axis (regardless of
   * which rectangle dimension it's parallel to).
   */
  runLength?: number
  /**
   * Strip depth on each side of the corridor — perpendicular distance
   * from corridor edge to outline edge. Equals `(perpendicular − width)/2`.
   */
  stripDepth?: number
}

export interface FloorPlan {
  /** 0 = ground floor. */
  level: number
  outline: [number, number][]
  corridor: CorridorPlan
  units: UnitPlan[]
}

export interface BuildingPlan {
  /** Stamped onto every generated node's `metadata.bimai.generationId`. */
  generationId: string
  footprint: [number, number][]
  floorCount: number
  /** Floor-to-floor height in metres. */
  floorHeight: number
  floors: FloorPlan[]
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
