// bim-defaults stage.
//
// Walks the emitted ops list and stamps `metadata.bimai.bim` (a parsed
// `ComponentBIM`) onto every node BimAI cares about — walls, slabs,
// doors, windows. Pure: no scene access, no mutations of the input ops.
//
// Why this is a post-emit stage rather than baked into emit.ts. Emit
// concerns itself with geometry and Pascal node shape; BIM defaults are
// a separate semantic layer (cost, fire, structure) that may evolve
// independently — e.g. a future "use catalog X for project Y" knob, or
// an interactive "regenerate defaults from current geometry" action.
// Keeping it as its own pass means we can run it in isolation and unit
// test it against synthetic ops without spinning up the full pipeline.
//
// Wall classification reads the `wallRole` BimAI tagged onto each wall
// during emit (`'perimeter' | 'corridor' | 'party'`). The mapping:
//
//   perimeter → exterior + load-bearing → brick-exterior  (catalog A1)
//   corridor  → interior + non-load-bearing → drywall-residential
//   party     → interior + non-load-bearing → drywall-residential
//
// Party walls are conservatively non-load-bearing today; in real
// residential they often are, but the structural model isn't there yet.
// Revisit with the structural pass in Phase 3-5+.
//
// Levels and zones are skipped on purpose — they don't carry physical
// material in the BimAI cost / schedule model.

import type { AnyNode } from '@pascal-app/core'
import {
  defaultMaterialFor,
  getMaterial,
  type BIMComponentType,
} from '../../bim/materials'
import {
  ComponentBIM,
  type BimAIMaterialId,
} from '../../bim/schemas/component-bim'
import type { NodeOp } from '../types'

interface WallContext {
  isExterior: boolean
  isLoadBearing: boolean
}

function readWallRole(node: AnyNode): 'perimeter' | 'corridor' | 'party' | undefined {
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const bimai = meta.bimai
  if (typeof bimai !== 'object' || bimai === null) return undefined
  const role = (bimai as Record<string, unknown>).wallRole
  if (role === 'perimeter' || role === 'corridor' || role === 'party') return role
  return undefined
}

function wallContextFromRole(
  role: 'perimeter' | 'corridor' | 'party' | undefined,
): WallContext {
  if (role === 'perimeter') return { isExterior: true, isLoadBearing: true }
  // corridor, party, or unknown all default to interior non-load-bearing.
  return { isExterior: false, isLoadBearing: false }
}

function pickDefaultsForNode(
  node: AnyNode,
):
  | { material: BimAIMaterialId; loadBearing: boolean }
  | undefined {
  switch (node.type) {
    case 'wall': {
      const ctx = wallContextFromRole(readWallRole(node))
      return {
        material: defaultMaterialFor('wall', ctx),
        loadBearing: ctx.isLoadBearing,
      }
    }
    case 'slab':
      return { material: defaultMaterialFor('slab'), loadBearing: true }
    case 'door':
      return { material: defaultMaterialFor('door'), loadBearing: false }
    case 'window':
      return { material: defaultMaterialFor('window'), loadBearing: false }
    default:
      return undefined
  }
}

function stampBIM(node: AnyNode): AnyNode {
  const picked = pickDefaultsForNode(node)
  if (!picked) return node
  const mat = getMaterial(picked.material)
  const bim = ComponentBIM.parse({
    material: picked.material,
    fireRating: mat.fireRating,
    loadBearing: picked.loadBearing,
  })

  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const bimai =
    typeof meta.bimai === 'object' && meta.bimai !== null
      ? (meta.bimai as Record<string, unknown>)
      : {}
  const nextBimai = { ...bimai, bim }
  const nextMeta = { ...meta, bimai: nextBimai }
  return {
    ...node,
    metadata: nextMeta as unknown as AnyNode['metadata'],
  }
}

/**
 * Returns a new ops list with `metadata.bimai.bim` stamped on every
 * wall / slab / door / window. Other node types pass through unchanged.
 */
export function applyBIMDefaults(ops: NodeOp[]): NodeOp[] {
  return ops.map((op) => ({ ...op, node: stampBIM(op.node) }))
}

// Re-export for tests / consumers that want the same component-type
// vocabulary without reaching into the catalog module.
export type { BIMComponentType }
