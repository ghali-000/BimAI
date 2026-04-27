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
  DoorNode,
  LevelNode,
  SlabNode,
  useScene,
  WallNode,
  WindowNode,
  ZoneNode,
} from '@pascal-app/core'
import type { SceneSnapshot } from './cleanup'
import type { SceneWriter } from './scene-writer'
import type { NodeOp } from './types'

// Boundary-validation: our emitter constructs nodes with `{...} as unknown as
// Foo` casts that bypass Zod defaults. Pascal's render systems then read those
// defaulted fields directly (e.g. door-system computes `width - 2 *
// frameThickness`); when frameThickness is undefined the result is NaN, which
// poisons mesh bounding boxes and breaks drei's CameraControls. We re-parse
// each emitted node here so every defaulted field is materialised before the
// store sees it. Tests use MemoryWriter and skip this path because importing
// `@pascal-app/core` schemas in vitest crashes via three-mesh-bvh's eager
// barrel evaluation — see `bimai/generator/emit.guardrail.md`.
//
// Our `metadata.bimai` blob survives parsing because BaseNode declares
// `metadata: z.json()` (accepts arbitrary JSON). Top-level fields outside
// each schema would be stripped — keep emit.ts honest about what it sets.
const SCHEMAS: Record<
  string,
  { parse: (v: unknown) => unknown } | undefined
> = {
  door: DoorNode,
  window: WindowNode,
  wall: WallNode,
  slab: SlabNode,
  zone: ZoneNode,
  level: LevelNode,
}

function applyDefaults(op: NodeOp): NodeOp {
  const schema = SCHEMAS[op.node.type]
  if (!schema) return op
  return { ...op, node: schema.parse(op.node) as AnyNode }
}

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
      useScene.getState().createNodes(ops.map(applyDefaults))
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
