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
import type { Program, ZoningRules } from '../schemas'

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface GeneratorInput {
  siteId: AnyNodeId
  buildingId: AnyNodeId
  plotPolygon: [number, number][]
  zoning: ZoningRules
  program: Program
  /** Optional. When omitted, the pipeline derives a stable seed from inputs. */
  seed?: number
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

export type GeneratorOutput =
  | { ok: true; plan: BuildingPlan; opsApplied: number; warnings: string[] }
  | { ok: false; reason: GeneratorFailureReason; issues: string[] }
