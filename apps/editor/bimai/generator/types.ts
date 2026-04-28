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
   * Rooms inside this unit. The current stub emits a single "open" room
   * matching the unit polygon; a later stage may subdivide into bedroom /
   * bath / kitchen / living. Optional so older fixtures stay valid.
   */
  rooms?: RoomPlan[]
}

export interface RoomPlan {
  /** e.g. "open", "bedroom", "bath". The stub uses "open". */
  name: string
  polygon: [number, number][]
  /** Computed area in m². */
  area: number
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
