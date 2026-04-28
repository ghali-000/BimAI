// Top-level generator orchestrator.
//
// Composes every stage into the public surface the UI button calls. Two
// stages here:
//   1. `buildPlan(input)` — pure, no scene access. Runs envelope → footprint
//      → floors → corridor + units + rooms (per floor). Returns either a
//      typed failure or a populated BuildingPlan.
//   2. `runGenerator(input, writer)` — wraps `buildPlan`, then if the plan
//      succeeds: pauses history, deletes prior generated nodes under the
//      target building, emits the new node ops, applies them, resumes
//      history. The pause/resume pair (Pascal: `useScene.temporal.getState()
//      .pause()/resume()`) is what collapses the whole generation into a
//      single undo step.
//
// Failure semantics:
//   - Pure planning failures return without ever touching the scene
//     (transactional from the caller's POV).
//   - If we reach the apply phase, both delete and create happen inside the
//     paused window so an undo restores the pre-generation state in one step.
//   - We never throw — every failure is a typed `{ ok: false, reason, issues }`.

import type { AnyNodeId } from '@pascal-app/core'
import { nanoid } from 'nanoid'
import { computeEnvelope } from '../lib/envelope'
import { calculatePolygonArea } from '../lib/geometry'
import { withDefaults } from '../optimizer/params'
import { findGeneratedNodes } from './cleanup'
import { emitBuildingPlan } from './emit'
import { applyBIMDefaults } from './stages/bim-defaults'
import { placeCorridor } from './stages/corridor'
import { chooseFootprint, footprintParamsFrom } from './stages/footprint'
import { planFloors } from './stages/floors'
import { attachRoomsToUnits } from './stages/rooms'
import { packUnits } from './stages/units'
import type { SceneWriter } from './scene-writer'
import type {
  BuildingPlan,
  FloorPlan,
  GeneratorInput,
  GeneratorOutput,
  PlacementSummary,
} from './types'

export interface BuildPlanResult {
  ok: true
  plan: BuildingPlan
}

/**
 * Pure planning. Runs every stage that doesn't need scene access. Safe to
 * call from anywhere (preview UI, headless CLI, tests).
 */
export function buildPlan(
  input: GeneratorInput,
): BuildPlanResult | Extract<GeneratorOutput, { ok: false }> {
  const issues: string[] = []
  if (input.plotPolygon.length < 3) {
    return { ok: false, reason: 'invalid_input', issues: ['plot has < 3 vertices'] }
  }

  // Resolve params once. `withDefaults` merges any partial caller override
  // over the Phase 3-3 defaults, so a no-params call reproduces the prior
  // pipeline byte-for-byte. Every stage downstream reads the resolved bag.
  const params = withDefaults(input.params)

  const envelope = computeEnvelope(input.plotPolygon, input.zoning)
  if (!envelope.ok) {
    return {
      ok: false,
      reason: 'envelope_collapsed',
      issues: [`envelope: ${envelope.reason}`],
    }
  }

  const footprint = chooseFootprint(
    envelope.polygon,
    input.zoning,
    input.program,
    footprintParamsFrom(params),
  )
  if (!footprint) {
    return {
      ok: false,
      reason: 'no_valid_footprint',
      issues: ['structural margin collapsed the footprint'],
    }
  }

  const plotArea = calculatePolygonArea(input.plotPolygon)
  const floorsResult = planFloors({
    footprint: footprint.polygon,
    plotArea,
    zoning: input.zoning,
    program: input.program,
    strategy: params.floorCountStrategy,
  })
  if (!floorsResult) {
    return {
      ok: false,
      reason: 'invalid_input',
      issues: ['floors stage rejected upstream data'],
    }
  }

  const warnings: string[] = [...floorsResult.warnings]

  // Per-floor: corridor + units + rooms. We re-plan corridor + units for
  // every floor even though they're identical — this keeps the door open
  // for floor-specific variation later (e.g. stepped setbacks, ground-floor
  // commercial) without restructuring the loop.
  const floors: FloorPlan[] = []
  for (let i = 0; i < floorsResult.floorCount; i++) {
    const corridor = placeCorridor(footprint.polygon, {
      width: params.corridorWidthM,
      orientation: params.corridorOrientation,
    })
    if (!corridor) {
      return {
        ok: false,
        reason: 'corridor_layout_failed',
        issues: [`floor ${i}: footprint is not rectangular`],
      }
    }

    const packed = packUnits({
      outline: footprint.polygon,
      corridor,
      corridorWidth: params.corridorWidthM,
      unitMix: input.program.unitMix,
      packingStrategy: params.packingStrategy,
      unitOrderingHeuristic: params.unitOrderingHeuristic,
    })
    if (!packed) {
      return {
        ok: false,
        reason: 'unit_packing_failed',
        issues: [`floor ${i}: unit packer rejected geometry`],
      }
    }
    if (packed.warnings.length > 0) {
      warnings.push(...packed.warnings.map((w) => `floor ${i}: ${w}`))
    }

    floors.push({
      level: i,
      outline: footprint.polygon,
      corridor,
      units: attachRoomsToUnits(packed.units),
    })
  }

  // If the program demanded more capacity than zoning allows AND no units
  // could fit at all, escalate to a failure rather than ship an empty plan.
  const totalUnits = floors.reduce((s, f) => s + f.units.length, 0)
  const requestedUnits = input.program.unitMix.reduce(
    (s, u) => s + Math.max(0, u.count),
    0,
  )
  if (requestedUnits > 0 && totalUnits === 0) {
    return {
      ok: false,
      reason: 'program_exceeds_capacity',
      issues: [
        ...issues,
        `requested ${requestedUnits} units, none fit on any floor`,
      ],
    }
  }

  const plan: BuildingPlan = {
    generationId: nanoid(),
    footprint: footprint.polygon,
    floorCount: floorsResult.floorCount,
    floorHeight: floorsResult.floorHeight,
    floors,
    warnings,
    params,
  }
  return { ok: true, plan }
}

// Placement summary — top-line stats for the panel. We treat all floors as
// identical today (every floor re-runs the same pack), so per-floor count
// is just the first floor's unit count; total is per-floor × floorCount.
// When the floors loop diverges in Phase 3-4 this needs to switch to a
// floor-aware reduction.
function computePlacement(
  input: GeneratorInput,
  plan: BuildingPlan,
): PlacementSummary {
  const unitsRequested = input.program.unitMix.reduce(
    (s, u) => s + Math.max(0, u.count),
    0,
  )
  const unitsPlacedPerFloor = plan.floors[0]?.units.length ?? 0
  const totalAcrossFloors = unitsPlacedPerFloor * plan.floorCount
  const placementRate =
    unitsRequested === 0 ? 1 : unitsPlacedPerFloor / unitsRequested
  return { unitsRequested, unitsPlacedPerFloor, placementRate, totalAcrossFloors }
}

/**
 * Plan + apply. Wraps the apply phase in `pauseHistory`/`resumeHistory` so
 * one undo step rolls the whole generation back. Always resumes — the apply
 * call sites are inside a try/finally.
 */
export function runGenerator(
  input: GeneratorInput,
  writer: SceneWriter,
): GeneratorOutput {
  const planResult = buildPlan(input)
  if (planResult.ok !== true) return planResult
  const { plan } = planResult

  const { opsApplied } = applyPlanToScene(plan, input.buildingId, writer)
  return {
    ok: true,
    plan,
    opsApplied,
    warnings: plan.warnings,
    placement: computePlacement(input, plan),
  }
}

/**
 * Apply phase only. Given a pre-baked plan and a target building, sweep
 * stale generated nodes, emit + BIM-default + apply the new ops, all
 * inside one paused-history window so a single Cmd-Z reverses it.
 *
 * Used by:
 *   - `runGenerator` (Phase 3-3): planning + apply in one call.
 *   - Optimizer "Load into scene" (Phase 3-5 Task 11): no planning —
 *     the worker already produced the plan. We just want the apply.
 */
export function applyPlanToScene(
  plan: BuildingPlan,
  buildingId: AnyNodeId,
  writer: SceneWriter,
): { opsApplied: number } {
  writer.pauseHistory()
  try {
    const snapshot = writer.getSnapshot()
    const oldIds = findGeneratedNodes(snapshot, buildingId)
    if (oldIds.length > 0) writer.deleteNodes(oldIds)

    const rawOps = emitBuildingPlan(plan, {
      buildingId,
      generationId: plan.generationId,
    })
    // Stamp `metadata.bimai.bim` (material / fireRating / loadBearing) on
    // every wall / slab / door / window before the writer applies. Pure
    // post-emit pass; doesn't touch geometry or hierarchy.
    const ops = applyBIMDefaults(rawOps)
    writer.createNodes(ops)
    return { opsApplied: ops.length }
  } finally {
    writer.resumeHistory()
  }
}
