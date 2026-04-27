// Pascal store-backed SceneWriter implementation.
//
// Lives in its own file because it imports `useScene` from `@pascal-app/core`,
// which transitively pulls three-mesh-bvh and crashes under vitest's node
// runner. Tests use `createMemoryWriter` from `./scene-writer` instead; this
// file is only loaded from the browser bundle (Generation panel, Task 11).
//
// `pauseHistory` / `resumeHistory` go through the Zundo temporal store, which
// is exposed on `useScene.temporal`. Pausing while we delete-then-create
// collapses the whole regeneration into a single undo step — that's the whole
// point of running the pipeline through this seam.

import {
  type AnyNode,
  type AnyNodeId,
  useScene,
} from '@pascal-app/core'
import type { SceneSnapshot } from './cleanup'
import type { SceneWriter } from './scene-writer'
import type { NodeOp } from './types'

/**
 * Returns a SceneWriter that proxies to Pascal's `useScene` store. Lazily
 * reads the latest state on each call so writers remain valid across React
 * re-renders without needing to be re-created.
 */
export function createPascalSceneWriter(): SceneWriter {
  return {
    getSnapshot(): SceneSnapshot {
      return { nodes: useScene.getState().nodes as Record<AnyNodeId, AnyNode> }
    },
    createNodes(ops: NodeOp[]): void {
      useScene.getState().createNodes(ops)
    },
    deleteNodes(ids: AnyNodeId[]): void {
      useScene.getState().deleteNodes(ids)
    },
    pauseHistory(): void {
      useScene.temporal.getState().pause()
    },
    resumeHistory(): void {
      useScene.temporal.getState().resume()
    },
  }
}
