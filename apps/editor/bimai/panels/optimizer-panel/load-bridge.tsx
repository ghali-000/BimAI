'use client'

// Load-to-scene bridge.
//
// The optimizer gallery's "Load into scene" button dispatches via the
// store: `useOptimizer.loadSelectedToScene()` bumps a monotonic
// `loadRequestSeq` counter. This component subscribes to that
// counter, and on each increment looks up the currently-selected
// candidate's pre-baked BuildingPlan and feeds it to the same
// apply-phase the generator uses (`applyPlanToScene`). Because the
// plan was produced inside the worker against the same site +
// zoning + program, the result is byte-identical to having clicked
// Generate with the candidate's params.
//
// Why a separate component:
//   - The panel and the gallery are sibling render trees; the bridge
//     mounts once near the top of the panel so its useEffect runs
//     regardless of whether the gallery has rendered a card yet.
//   - Keeps the gallery purely presentational and the panel free of
//     scene-write side effects, mirroring the SceneWriter seam used
//     by Phase 3-3's Generate button.
//
// Idempotency: a `lastAppliedRef` tracks the last seq we processed so
// repeat renders (Strict Mode double-mount, etc.) don't double-apply.

import { useEffect, useRef } from 'react'
import type { AnyNodeId } from '@pascal-app/core'
import { applyPlanToScene } from '../../generator/pipeline'
import { createPascalSceneWriter } from '../../generator/pascal-writer'
import { useOptimizer } from '../../optimizer/store'

export function OptimizerLoadBridge({
  buildingId,
}: {
  buildingId: AnyNodeId | null
}) {
  const loadRequestSeq = useOptimizer((s) => s.loadRequestSeq)
  const lastAppliedRef = useRef(0)

  useEffect(() => {
    if (loadRequestSeq <= lastAppliedRef.current) return
    lastAppliedRef.current = loadRequestSeq
    if (!buildingId) return

    const { result, selectedCandidateIndex } = useOptimizer.getState()
    if (!result || selectedCandidateIndex == null) return
    const candidate = result.topK.find(
      (c) => c.candidateIndex === selectedCandidateIndex,
    )
    if (!candidate?.plan) return

    const writer = createPascalSceneWriter()
    applyPlanToScene(candidate.plan, buildingId, writer)
  }, [loadRequestSeq, buildingId])

  return null
}
