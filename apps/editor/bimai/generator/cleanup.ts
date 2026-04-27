// Find generated nodes for the cleanup phase of the pipeline.
//
// Pure function over a snapshot of the flat `state.nodes` dictionary —
// the source of truth per Phase 3-2 principle 6. We never read from
// embedded `site.children` here.
//
// `parentId` narrows the search to a subtree. Pascal's parent linkage is the
// `parentId` field on every node; we walk that chain backward to decide
// whether a node is a descendant of the given parent.

import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { isGenerated } from './tag'

export interface SceneSnapshot {
  nodes: Record<AnyNodeId, AnyNode>
}

/**
 * Returns the IDs of every node carrying the procedural-generation tag.
 * If `parentId` is provided, only nodes that are descendants of that node
 * (via the `parentId` chain) are included. The parent itself is not
 * returned even if it happens to be tagged.
 */
export function findGeneratedNodes(
  scene: SceneSnapshot,
  parentId?: AnyNodeId,
): AnyNodeId[] {
  const out: AnyNodeId[] = []
  for (const node of Object.values(scene.nodes)) {
    if (!isGenerated(node)) continue
    if (parentId !== undefined && !isDescendantOf(node, parentId, scene.nodes))
      continue
    out.push(node.id)
  }
  return out
}

function isDescendantOf(
  node: AnyNode,
  ancestorId: AnyNodeId,
  nodes: Record<AnyNodeId, AnyNode>,
): boolean {
  // Guard against accidental cycles in malformed scenes.
  const seen = new Set<AnyNodeId>()
  let current: AnyNode | undefined = node
  while (current?.parentId) {
    const pid = current.parentId as AnyNodeId
    if (pid === ancestorId) return true
    if (seen.has(pid)) return false
    seen.add(pid)
    current = nodes[pid]
  }
  return false
}
