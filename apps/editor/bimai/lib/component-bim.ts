// Pure read/merge helpers for `metadata.bimai.bim` on Pascal nodes.
//
// Why a separate file rather than tacking onto `lib/metadata.ts`. Two reasons:
//   1. metadata.ts is already site/building-scoped — it knows about
//      `SiteBimAIMetadata` and `BuildingBimAIMetadata`, not arbitrary nodes.
//      Adding component-level reads would muddy that surface.
//   2. The store-bound helpers in metadata.ts reach into `useScene` from the
//      bare `@pascal-app/core` barrel, which crashes vitest's collection
//      (three-mesh-bvh circular-import issue documented in Phase 3-3). The
//      pure helpers here have NO runtime import of `@pascal-app/core` —
//      only `type AnyNode` for typing — so they're freely testable. The
//      panel (which does write back to the store) lives in the panel file
//      and its own zustand call doesn't run under vitest.
//
// Vocabulary recap:
//   - `metadata.bimai.bim`  — the per-component BIM blob (ComponentBIM).
//   - `metadata.bimai.bim` is OPTIONAL on every node. Absent means
//      "fall through to defaults" — *not* an error. The reader returns
//      `null` for absent so callers can distinguish from `{}` (which
//      Zod would happily fill with defaults but means something else).

import type { AnyNode } from '@pascal-app/core'
import { ComponentBIM } from '../bim/schemas/component-bim'

/**
 * Read and validate the per-component BIM blob from a node's metadata.
 *
 * Returns `null` (not an empty object) when:
 *   - the node is null / undefined
 *   - `metadata.bimai.bim` is absent
 *   - `metadata.bimai.bim` is present but fails Zod validation (corrupt
 *     blob; we don't silently coerce it to a default — caller should
 *     surface the issue or re-stamp defaults explicitly)
 */
export function readNodeBIM(
  node: AnyNode | null | undefined,
): ComponentBIM | null {
  if (!node) return null
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const bimai = meta.bimai
  if (typeof bimai !== 'object' || bimai === null) return null
  const bim = (bimai as Record<string, unknown>).bim
  if (bim === undefined || bim === null) return null
  const parsed = ComponentBIM.safeParse(bim)
  return parsed.success ? parsed.data : null
}

/**
 * Merge a partial patch into an existing BIM blob and re-validate.
 *
 * Semantics:
 *   - `existing === null` is treated as "start from a freshly-parsed empty
 *      object" — `ComponentBIM.parse({})` fills its defaults
 *      (fireRating='unrated', loadBearing=false). This lets the panel
 *      build a valid ComponentBIM the first time the user touches a
 *      previously-unstamped node.
 *   - Patch fields with `undefined` are dropped (no-op), so callers can
 *      pass `{ material: undefined }` to mean "leave as-is" or use the
 *      explicit clearer below.
 *   - To clear an optional field, pass it as the literal `undefined`
 *      with `clearKeys` listing the slot — see `BIM_FIELDS` for the
 *      enumerated names. This is how the panel "clear material" button
 *      reverts to the type default.
 *   - costOverride is a nested object; the patch's costOverride REPLACES
 *      the existing one wholesale (you can't deep-merge a partial
 *      override). The panel always sends the full intended override.
 *
 * Rejects invalid input (e.g. a bogus FireRating) with `ok: false` and
 * the Zod error message — the panel shows it as a tooltip.
 */
export type BIMPatch = Partial<ComponentBIM>

export type MergeBIMResult =
  | { ok: true; value: ComponentBIM }
  | { ok: false; error: string }

export function mergeBIMPatch(
  existing: ComponentBIM | null,
  patch: BIMPatch,
  options: { clearKeys?: ReadonlyArray<keyof ComponentBIM> } = {},
): MergeBIMResult {
  const base: ComponentBIM = existing ?? ComponentBIM.parse({})
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    next[key] = value
  }
  for (const key of options.clearKeys ?? []) {
    delete next[key as string]
  }
  // Re-validate. ComponentBIM has Zod defaults on fireRating/loadBearing
  // — feeding the merged plain object back through .safeParse keeps the
  // schema as the single source of truth for what's valid.
  const parsed = ComponentBIM.safeParse(next)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') }
  }
  return { ok: true, value: parsed.data }
}

/**
 * True iff `metadata.bimai.bim` exists on the node (regardless of its
 * validity). The panel uses this to decide between "show form" and
 * "show 'apply defaults' button" affordances.
 */
export function hasNodeBIM(node: AnyNode | null | undefined): boolean {
  if (!node) return false
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const bimai = meta.bimai
  if (typeof bimai !== 'object' || bimai === null) return false
  return 'bim' in (bimai as Record<string, unknown>)
}

/**
 * Build the `metadata` object to write back to the store after a merge.
 * Pure helper that the panel composes with `useScene.getState().updateNode`.
 *
 * Preserves all existing metadata keys (other panels' data, generator
 * tags, unitType / targetArea on zones, etc.) — only the
 * `metadata.bimai.bim` slot is replaced.
 */
export function metadataWithBIM(
  node: AnyNode,
  bim: ComponentBIM,
): Record<string, unknown> {
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const bimai = (meta.bimai ?? {}) as Record<string, unknown>
  return {
    ...meta,
    bimai: { ...bimai, bim },
  }
}
