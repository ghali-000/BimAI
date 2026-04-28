// Optimizer writer factory — fresh, isolated MemoryWriter per candidate.
//
// The search loop evaluates many GenerationParams against the same
// program. Each evaluation runs the full generator pipeline against a
// writer; the pipeline reads the writer's snapshot to do its own
// cleanup pass and then writes ops. After the pipeline returns we read
// the resulting snapshot, hand it to schedule + cost + objectives, and
// discard the writer.
//
// Two correctness invariants matter for batch evaluation:
//
//   1. **Isolation per candidate.** A fresh writer per candidate means
//      candidate N's nodes never leak into candidate N+1. We do not
//      try to reuse one writer with the pipeline's built-in
//      "delete previously-generated nodes" cleanup — that path works,
//      but it relies on the cleanup running first, and we want the
//      optimizer's correctness to be obvious from the outside: each
//      candidate is a fresh MemoryWriter, full stop.
//
//   2. **No useScene.** The factory builds plain JS objects only — no
//      zustand, no zundo, no DOM. The same factory works in Node
//      (search-from-CLI) and in a Web Worker (Task 7), where neither
//      Pascal's `useScene` nor the temporal store exist.
//
// What goes in the seeded writer:
//   - One BuildingNode shell with `children: []`. The pipeline needs
//     a parent node to attach generated levels to; without it
//     `createNodes` has nowhere to wire up the new children.
//   - Nothing else. No site, no zoning nodes, no user-drawn geometry.
//     The optimizer doesn't need them — schedule + cost + compliance
//     read everything they need off the snapshot the pipeline writes,
//     plus the ZoningRules / Program / plotPolygon passed alongside
//     in CandidateEvaluation.
//
// The pipeline also accepts `siteId` on its input; for batch eval we
// give it a stub site too (some downstream emitters reference site
// for context). If the pipeline doesn't read the site node we still
// pay one allocation per candidate, which is negligible.

import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import type { MemoryWriter } from '../generator/scene-writer'
import { createMemoryWriter } from '../generator/scene-writer'

export interface OptimizerWriterStubs {
  /** The building node the pipeline attaches generated levels to. */
  buildingId: AnyNodeId
  /** Optional site stub. The pipeline accepts a siteId on input but
   *  doesn't currently require the site node to exist in the snapshot;
   *  we seed one anyway so any future emitter that reads it finds a
   *  node to read. */
  siteId?: AnyNodeId
}

/**
 * Build a stub building node with an empty `children` array. We cast
 * through `unknown` because the optimizer doesn't need (and shouldn't
 * import) Pascal's full BuildingNode schema — the pipeline only reads
 * `children` and `parentId` off this object.
 */
function makeBuildingStub(id: AnyNodeId, parentId: AnyNodeId | null): AnyNode {
  return {
    object: 'node',
    id,
    type: 'building',
    parentId,
    visible: true,
    metadata: {},
    children: [],
    name: 'OptimizerCandidate',
  } as unknown as AnyNode
}

/** Mirror of the building stub for the site, when one is requested. */
function makeSiteStub(id: AnyNodeId): AnyNode {
  return {
    object: 'node',
    id,
    type: 'site',
    parentId: null,
    visible: true,
    metadata: {},
    children: [],
    name: 'OptimizerSite',
  } as unknown as AnyNode
}

/**
 * Build a fresh MemoryWriter seeded with the minimum nodes the pipeline
 * needs. Discard after one candidate's evaluation; do NOT share across
 * candidates (the per-candidate isolation invariant above).
 */
export function createOptimizerWriter(
  stubs: OptimizerWriterStubs,
): MemoryWriter {
  const nodes: Record<string, AnyNode> = {}
  if (stubs.siteId) {
    nodes[stubs.siteId] = makeSiteStub(stubs.siteId)
  }
  nodes[stubs.buildingId] = makeBuildingStub(
    stubs.buildingId,
    stubs.siteId ?? null,
  )
  // The MemoryWriter takes the same SceneSnapshot shape the pipeline
  // produces, so there's nothing further to wire here.
  return createMemoryWriter({
    nodes: nodes as unknown as Record<AnyNodeId, AnyNode>,
  })
}
