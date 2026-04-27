// Seam between the generator pipeline and Pascal's scene store.
//
// Phase 3-3 needs the same pipeline to run in two contexts:
//   • Browser — calls Pascal's `useScene.getState().createNodes(...)` and
//     wraps the work in `useScene.temporal.getState().pause()/resume()` so the
//     whole generation collapses into one undo step.
//   • Node CLI (Task 14) — reads/writes a plain JSON snapshot, no zustand,
//     no zundo, no DOM.
//
// Both shapes implement this interface. Tests use the in-memory fake below.

import type { AnyNodeId } from '@pascal-app/core'
import type { SceneSnapshot } from './cleanup'
import type { NodeOp } from './types'

export interface SceneWriter {
  /** Read-only snapshot of the flat node dictionary. Cheap copy is fine. */
  getSnapshot(): SceneSnapshot
  /** Bulk-create nodes (parents before children — caller's responsibility). */
  createNodes(ops: NodeOp[]): void
  /** Bulk-delete nodes by id. No-op for unknown ids. */
  deleteNodes(ids: AnyNodeId[]): void
  /**
   * Pause the undo/redo history. Implementations that don't track history
   * may make these no-ops. Pipeline guarantees `resume` is always called
   * (finally-block) so paired calls stay balanced.
   */
  pauseHistory(): void
  resumeHistory(): void
}

// ── In-memory writer for tests / CLI ─────────────────────────────────────────

/**
 * Snapshot-backed writer. Mutates the wrapped record in place so the same
 * object can be inspected after the pipeline returns. `pauseHistory` /
 * `resumeHistory` increment a counter — tests can assert calls were paired.
 */
export interface MemoryWriterStats {
  pauseCalls: number
  resumeCalls: number
  createBatches: number
  deleteBatches: number
}

export interface MemoryWriter extends SceneWriter {
  stats: MemoryWriterStats
}

export function createMemoryWriter(initial: SceneSnapshot): MemoryWriter {
  // Defensive shallow clone of the dict so the caller's reference is not
  // captured. Node objects themselves are not deep-cloned — the writer never
  // mutates them, only swaps entries.
  const nodes: SceneSnapshot['nodes'] = { ...initial.nodes }
  const stats: MemoryWriterStats = {
    pauseCalls: 0,
    resumeCalls: 0,
    createBatches: 0,
    deleteBatches: 0,
  }
  return {
    stats,
    getSnapshot() {
      return { nodes }
    },
    createNodes(ops) {
      stats.createBatches++
      for (const { node, parentId } of ops) {
        // Mirror Pascal's `createNodesAction`: the child carries parentId, and
        // any existing parent with a `children` array gets the new id appended.
        const withParent = { ...node, parentId: parentId ?? null }
        nodes[node.id] = withParent
        if (parentId && nodes[parentId]) {
          const parent = nodes[parentId] as unknown as {
            children?: unknown[]
          }
          if (Array.isArray(parent.children)) {
            const childIds = parent.children as string[]
            if (!childIds.includes(node.id)) {
              const updated = {
                ...nodes[parentId],
                children: [...childIds, node.id],
              }
              nodes[parentId] = updated as SceneSnapshot['nodes'][AnyNodeId]
            }
          }
        }
      }
    },
    deleteNodes(ids) {
      stats.deleteBatches++
      const idSet = new Set<string>(ids as unknown as string[])
      for (const id of ids) {
        delete nodes[id]
      }
      // Strip the deleted ids from any parent's children array.
      for (const k of Object.keys(nodes)) {
        const n = nodes[k as AnyNodeId] as unknown as { children?: unknown[] }
        if (!Array.isArray(n.children)) continue
        const filtered = (n.children as string[]).filter((c) => !idSet.has(c))
        if (filtered.length !== n.children.length) {
          nodes[k as AnyNodeId] = {
            ...nodes[k as AnyNodeId],
            children: filtered,
          } as SceneSnapshot['nodes'][AnyNodeId]
        }
      }
    },
    pauseHistory() {
      stats.pauseCalls++
    },
    resumeHistory() {
      stats.resumeCalls++
    },
  }
}
