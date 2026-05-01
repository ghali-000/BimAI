// Phase 3-8 Task 3: Stair core templates.
//
// One template = one set of geometric/code constants for a stair flight.
// Phase 3-8 ships a single residential template (`RESIDENTIAL_STAIR`); the
// shape is forward-compatible with commercial / accessibility-oriented
// variants (wider treads, gentler rise) in later phases.
//
// Constants are EU residential mid-rise defaults loosely aligned with
// EN 17037 / national codes. National codes vary considerably (e.g. UK
// Approved Document K caps domestic risers at 0.22 m, much higher than
// the 0.20 m EU average); these values are *reasonable starting points*,
// not certified compliance values.
//
// `flightStepCount(floorHeight)` computes step count from floor-to-floor
// height by targeting a 0.18 m riser — the midpoint of the typical
// residential 0.15–0.20 m range. The resulting riser then falls in-band
// for any floor height between 2.4 m and 3.6 m.

import type { StairFlightPlan } from '../types'

export interface StairTemplate {
  /** Shaft outer width (m), perpendicular to corridor centerline. */
  width: number
  /** Shaft outer depth (m), along corridor centerline. */
  depth: number
  /**
   * Nominal step count for one inter-floor flight at the given
   * floor-to-floor height. Targets a 0.18 m riser (mid-range);
   * `Math.ceil` rounds up so the actual riser is at-or-below the
   * target rather than pushing into the over-0.20 m "uncomfortable"
   * band.
   */
  flightStepCount: (floorHeight: number) => number
  /** Residential typical 0.15–0.20 m. Anything outside fails the spec. */
  stepHeightRangeM: { min: number; max: number }
  /** Residential typical 0.25–0.30 m (tread "going"). */
  stepDepthRangeM: { min: number; max: number }
}

/**
 * EU residential mid-rise default. Width 2.5 m accommodates IFC
 * `IfcStair` minimum-clear-width recommendations for residential and
 * leaves room for a 0.9 m landing-to-corridor door without crowding
 * the shaft walls. Depth 4.0 m = one straight flight + landing run.
 */
export const RESIDENTIAL_STAIR: StairTemplate = {
  width: 2.5,
  depth: 4.0,
  // 1e-9 tolerance avoids fp drift turning exact integer ratios (e.g.
  // 2.7 / 0.18 = 15.0000000000000018 in IEEE-754) into a spurious extra
  // step. Floor heights that genuinely exceed an integer-multiple of
  // 0.18 m still round up correctly because the slack is well below
  // 0.001 m of "extra" rise.
  flightStepCount: (h) => Math.max(2, Math.ceil(h / 0.18 - 1e-9)),
  stepHeightRangeM: { min: 0.15, max: 0.2 },
  stepDepthRangeM: { min: 0.25, max: 0.3 },
}

/**
 * Build a `StairFlightPlan` for one inter-floor span. Pure helper —
 * `placeStairCores` calls it floorCount-1 times (once per inter-storey
 * flight). Picks `stepDepth` at the midpoint of the template's range
 * (0.275 m for residential); the shaft `depth` constraint isn't enforced
 * here because the shaft also accommodates a landing whose footprint
 * isn't materialised in 3-8 — sized into the 4 m default.
 */
export function buildFlightPlan(
  template: StairTemplate,
  fromLevel: number,
  startElevation: number,
  floorHeight: number,
): StairFlightPlan {
  const stepCount = template.flightStepCount(floorHeight)
  const stepHeight = floorHeight / stepCount
  const stepDepth =
    (template.stepDepthRangeM.min + template.stepDepthRangeM.max) / 2
  return {
    fromLevel,
    toLevel: fromLevel + 1,
    startElevation,
    endElevation: startElevation + floorHeight,
    stepCount,
    stepHeight,
    stepDepth,
  }
}
