// Floors stage: decide how many storeys the building should have, and how tall.
//
// Three competing forces drive the result:
//   1. Program demand — how much gross floor area (GFA) the unit mix asks for.
//   2. Height cap — `zoning.maxHeight / program.floorToFloorHeight` storeys.
//   3. FAR cap — `zoning.maxFAR × plotArea / footprintArea` storeys.
//
// We pick the *smallest* that still satisfies the program, but never exceed
// the two zoning caps. If the program asks for more than the caps allow, the
// stage still succeeds with `floorCount` clamped to the tighter cap and a
// warning is emitted; the orchestrator may later decide to surface this as a
// `program_exceeds_capacity` failure once unit packing confirms units cannot
// fit. We keep the call non-fatal here so partial generations are possible
// during early authoring.
//
// Returns null only on truly degenerate inputs (non-positive footprint or
// plot area, missing floorToFloorHeight) — those represent broken upstream
// data, not user-correctable program/zoning conflicts.

import type { Program, ZoningRules } from '../../schemas'
import type { Polygon2D } from '../../lib/envelope'
import { calculatePolygonArea } from '../../lib/geometry'

/**
 * Multiplier applied to summed unit areas when estimating required GFA.
 * Accounts for corridors, stairs, lift cores, and structure that the unit
 * mix doesn't model directly. 1.25 ≈ 80% efficient floor plate, which is in
 * the typical range for double-loaded residential.
 */
export const GROSS_TO_NET_FACTOR = 1.25

/** A building always has at least one storey unless rejected outright. */
export const MIN_FLOOR_COUNT = 1

export interface PlanFloorsInput {
  footprint: Polygon2D
  plotArea: number
  zoning: ZoningRules
  program: Program
}

export interface FloorsPlan {
  floorCount: number
  floorHeight: number
  /** Per-storey footprint area, m². Cached so downstream stages don't recompute. */
  footprintArea: number
  /** Sum of `floorCount × footprintArea`. */
  grossFloorArea: number
  warnings: string[]
}

export function planFloors(input: PlanFloorsInput): FloorsPlan | null {
  const { footprint, plotArea, zoning, program } = input

  if (footprint.length < 3) return null
  const footprintArea = calculatePolygonArea(footprint)
  if (footprintArea <= 0) return null
  if (plotArea <= 0) return null

  const f2f = program.floorToFloorHeight
  if (!Number.isFinite(f2f) || f2f <= 0) return null

  const warnings: string[] = []

  // 1. Demand from the program.
  const requestedNet = program.unitMix.reduce(
    (sum, entry) => sum + entry.count * entry.targetArea,
    0,
  )
  const requestedGross = requestedNet * GROSS_TO_NET_FACTOR
  const floorsByDemand = Math.max(
    MIN_FLOOR_COUNT,
    Math.ceil(requestedGross / footprintArea),
  )

  // 2. Height cap. `Math.floor` because a partial storey is not a storey.
  const floorsByHeight = Math.max(MIN_FLOOR_COUNT, Math.floor(zoning.maxHeight / f2f))

  // 3. FAR cap. Same reasoning.
  const farCapGross = zoning.maxFAR * plotArea
  const floorsByFAR = Math.max(MIN_FLOOR_COUNT, Math.floor(farCapGross / footprintArea))

  // The two zoning caps form the hard ceiling.
  const zoningCap = Math.min(floorsByHeight, floorsByFAR)
  const floorCount = Math.min(floorsByDemand, zoningCap)

  if (floorsByDemand > zoningCap) {
    if (floorsByDemand > floorsByHeight && floorsByHeight <= floorsByFAR) {
      warnings.push(
        `Program needs ${floorsByDemand} storeys but height cap allows only ${floorsByHeight}.`,
      )
    } else if (floorsByDemand > floorsByFAR && floorsByFAR < floorsByHeight) {
      warnings.push(
        `Program needs ${floorsByDemand} storeys but FAR cap allows only ${floorsByFAR}.`,
      )
    } else {
      warnings.push(
        `Program needs ${floorsByDemand} storeys but zoning caps allow only ${zoningCap}.`,
      )
    }
  }

  return {
    floorCount,
    floorHeight: f2f,
    footprintArea,
    grossFloorArea: floorCount * footprintArea,
    warnings,
  }
}
