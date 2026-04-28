// Multi-select summarizer for the BIM Properties panel.
//
// The single-select form drives off one node + one ComponentBIM. The
// multi-select form needs a parallel snapshot: which nodes are
// editable (walls/slabs/doors/windows), which fields agree across
// the selection, which disagree ("mixed"), and which slot the
// cost-override field should expose (per-m² for walls+slabs, flat for
// doors+windows, hidden when the selection straddles both).
//
// Pure over `(AnyNode | null | undefined)[]` so the panel doesn't
// have to read the store inline. Lives in lib/ for the same reason
// component-bim.ts does — vitest's `node` env can collect it without
// pulling Pascal's `@pascal-app/core` runtime.

import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import type {
  BimAIMaterialId,
  ComponentBIM,
} from '../bim/schemas/component-bim'
import { readNodeBIM } from './component-bim'

export type SupportedType = 'wall' | 'slab' | 'door' | 'window'
const SUPPORTED: ReadonlySet<string> = new Set([
  'wall',
  'slab',
  'door',
  'window',
])

export type CostOverrideSlot = 'perM2' | 'flat'

/**
 * One supported node in the selection plus its read BIM blob. The
 * panel uses this list to (a) drive the form and (b) call applyPatch
 * once per id at submit-time.
 */
export interface SupportedNodeEntry {
  id: AnyNodeId
  type: SupportedType
  bim: ComponentBIM | null
}

/**
 * Three-state field summary. `shared` means every supported node has
 * the same value (or every node is missing the field with the same
 * default — we don't distinguish "explicitly set to default" from
 * "absent" because the cost engine doesn't either). `mixed` means
 * at least two nodes disagree. `absent` means no supported nodes,
 * which surfaces as a hidden field.
 */
export type Tristate<T> =
  | { kind: 'shared'; value: T }
  | { kind: 'mixed' }
  | { kind: 'absent' }

export interface MultiSelectSummary {
  /** Supported (BIM-applicable) nodes, deduplicated by id, in
   *  selection order. Unsupported types are filtered out. */
  supportedNodes: SupportedNodeEntry[]
  /** Count by element type across the *original* selection (incl.
   *  unsupported). Useful for the panel header. */
  countsByType: Record<string, number>
  /** Number of original ids that landed on unsupported / missing
   *  nodes. The panel surfaces this in the header. */
  unsupportedCount: number
  /** True when supportedNodes contains > 1 distinct `.type`. When
   *  this fires, the material dropdown and cost-override field hide
   *  themselves — both depend on a single applicable type. */
  typesAreMixed: boolean

  material: Tristate<BimAIMaterialId | undefined>
  fireRating: Tristate<ComponentBIM['fireRating']>
  loadBearing: Tristate<boolean>

  /** The cost-override slot exposed by the panel. `'mixed'` when the
   *  selection includes both per-m² (wall/slab) and flat (door/window)
   *  types — the panel hides the field. `null` when there are no
   *  supported nodes. */
  costOverrideSlot: CostOverrideSlot | 'mixed' | null
  /** Tristate for the per-m² value, only meaningful when
   *  costOverrideSlot === 'perM2'. `absent` everywhere else. */
  costOverridePerM2: Tristate<number | undefined>
  /** Mirror of the above for the flat slot. */
  costOverrideFlat: Tristate<number | undefined>
}

/**
 * Build a multi-select summary from a list of nodes. The panel calls
 * this with `selectedIds.map(id => useScene.getState().nodes[id])`.
 *
 * Implementation note: we evaluate every Tristate field over the
 * full supportedNodes list — even when typesAreMixed forces the
 * panel to hide some controls — so tests can verify field
 * detection independent of UI presentation.
 */
export function summarizeMultiSelection(
  nodes: ReadonlyArray<AnyNode | null | undefined>,
): MultiSelectSummary {
  const countsByType: Record<string, number> = {}
  const supportedNodes: SupportedNodeEntry[] = []
  let unsupportedCount = 0

  for (const node of nodes) {
    if (!node) {
      unsupportedCount++
      continue
    }
    countsByType[node.type] = (countsByType[node.type] ?? 0) + 1
    if (!SUPPORTED.has(node.type)) {
      unsupportedCount++
      continue
    }
    supportedNodes.push({
      id: node.id,
      type: node.type as SupportedType,
      bim: readNodeBIM(node),
    })
  }

  const types = new Set(supportedNodes.map((e) => e.type))
  const typesAreMixed = types.size > 1

  const material = summarize(
    supportedNodes,
    (e) => e.bim?.material,
  )
  const fireRating = summarize(
    supportedNodes,
    (e) => e.bim?.fireRating ?? 'unrated',
  )
  const loadBearing = summarize(
    supportedNodes,
    (e) => e.bim?.loadBearing ?? (e.type === 'slab'),
  )

  const costOverrideSlot = computeCostOverrideSlot(supportedNodes)
  const costOverridePerM2: Tristate<number | undefined> =
    costOverrideSlot === 'perM2'
      ? summarize(supportedNodes, (e) => e.bim?.costOverride?.perM2)
      : { kind: 'absent' }
  const costOverrideFlat: Tristate<number | undefined> =
    costOverrideSlot === 'flat'
      ? summarize(supportedNodes, (e) => e.bim?.costOverride?.flat)
      : { kind: 'absent' }

  return {
    supportedNodes,
    countsByType,
    unsupportedCount,
    typesAreMixed,
    material,
    fireRating,
    loadBearing,
    costOverrideSlot,
    costOverridePerM2,
    costOverrideFlat,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function summarize<T>(
  entries: readonly SupportedNodeEntry[],
  pick: (e: SupportedNodeEntry) => T,
): Tristate<T> {
  if (entries.length === 0) return { kind: 'absent' }
  const first = pick(entries[0]!)
  for (let i = 1; i < entries.length; i++) {
    if (!sameValue(first, pick(entries[i]!))) return { kind: 'mixed' }
  }
  return { kind: 'shared', value: first }
}

/** Equality helper that treats `undefined === undefined` as same so
 *  "every node has no material" reads as `shared(undefined)`, which
 *  the panel renders as the "— default —" option. */
function sameValue<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  return false
}

function computeCostOverrideSlot(
  entries: readonly SupportedNodeEntry[],
): CostOverrideSlot | 'mixed' | null {
  if (entries.length === 0) return null
  let hasPerM2 = false
  let hasFlat = false
  for (const e of entries) {
    if (e.type === 'wall' || e.type === 'slab') hasPerM2 = true
    else hasFlat = true
  }
  if (hasPerM2 && hasFlat) return 'mixed'
  return hasPerM2 ? 'perM2' : 'flat'
}
