// Generator-tagging helpers.
//
// Every node the generator produces gets a tag in `metadata.bimai`:
//   { generatedBy: 'procedural-v1', generationId: <nanoid> }
// Cleanup uses `generatedBy` to find old generated nodes for deletion.
// The `generationId` distinguishes nodes from different generation runs —
// useful when we want to diff "this generation" vs "previous generation".
//
// IMPORTANT: tag merging is a deep merge. A generated ZoneNode also carries
// `metadata.bimai.unitType` and `metadata.bimai.targetArea` (set by the zones
// emitter). We must not clobber them when stamping the tag.

import type { AnyNode } from '@pascal-app/core'
import { z } from 'zod'

export const GENERATED_BY = 'procedural-v1' as const

export const GeneratedTag = z.object({
  generatedBy: z.literal(GENERATED_BY),
  generationId: z.string().min(1),
})
export type GeneratedTag = z.infer<typeof GeneratedTag>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

/**
 * Returns a new node with the procedural-generation tag attached under
 * `metadata.bimai`. Existing `metadata.bimai` fields (e.g. unitType,
 * targetArea on a ZoneNode) are preserved via deep merge.
 */
export function tagAsGenerated<T extends AnyNode>(
  node: T,
  generationId: string,
): T {
  const metadata = (node.metadata ?? {}) as Record<string, unknown>
  const existingBimai = isPlainObject(metadata.bimai) ? metadata.bimai : {}
  const nextBimai: Record<string, unknown> = {
    ...existingBimai,
    generatedBy: GENERATED_BY,
    generationId,
  }
  const nextMetadata: Record<string, unknown> = {
    ...metadata,
    bimai: nextBimai,
  }
  return {
    ...node,
    // Same TS-cast pattern as bimai/lib/metadata.ts: Pascal's `metadata: z.json()`
    // has a stricter recursive type than the validated tag shape (which is plain
    // JSON). The runtime value is fine; the type system can't see that.
    metadata: nextMetadata as unknown as T['metadata'],
  }
}

/**
 * True iff `node.metadata.bimai` carries the procedural-generation tag.
 * If `generationId` is provided, also requires the tag's `generationId`
 * to match — useful for narrowing to "nodes from this specific run".
 */
export function isGenerated(node: AnyNode, generationId?: string): boolean {
  const metadata = (node.metadata ?? {}) as Record<string, unknown>
  const bimai = metadata.bimai
  if (!isPlainObject(bimai)) return false
  const parsed = GeneratedTag.safeParse(bimai)
  if (!parsed.success) return false
  if (generationId !== undefined && parsed.data.generationId !== generationId) {
    return false
  }
  return true
}
