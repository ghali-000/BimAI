// Per-component BIM metadata.
//
// Lives at `node.metadata.bimai.bim` for any node BimAI cares about
// (walls, slabs, doors, windows in Phase 3-4; roofs and ceilings later).
// The generator's `bim-defaults` stage seeds this for every emitted node
// based on a few rules-of-thumb (exterior detection, load-bearing
// inference). Users can override anything per-component from the BIM
// section that integrates into Pascal's element-edit panels.
//
// Why this isn't on Pascal's own schemas. Pascal's `MaterialSchema` and
// `MaterialPreset` cover *visual* rendering — colour, roughness, metalness.
// They don't carry cost, density, or fire rating. Extending them would
// couple BimAI semantics to Pascal's renderer and force every fork to
// agree on cost models. Putting our data on `metadata.bimai.bim` keeps
// Pascal's schemas pristine and gives BimAI a single owned namespace.

import { z } from 'zod'

/**
 * Fire ratings per EN 13501-1, Reaction-to-fire classification.
 *
 *   A1 — non-combustible (no contribution to fire)
 *   A2 — limited combustibility
 *   B  — very limited contribution to fire
 *   C  — limited contribution to fire
 *   D  — medium contribution to fire
 *   E  — high contribution to fire
 *   F  — no performance determined / fails E
 *
 * `unrated` is the BimAI default for newly-generated components — it
 * means "no rating has been specified yet", not "F". The cost / schedule
 * panels treat `unrated` as missing data, not a hazard.
 */
export const FireRating = z.enum(['A1', 'A2', 'B', 'C', 'D', 'E', 'F', 'unrated'])
export type FireRating = z.infer<typeof FireRating>

/**
 * Reference into BimAI's material catalog (`bim/materials.ts`). Branded
 * so a `BimAIMaterialId` cannot be silently confused with Pascal's
 * `MaterialSchema.id` strings — both are runtime strings, but the type
 * system enforces the distinction at every boundary that matters
 * (catalog lookups, panel form state, generator defaults).
 *
 * Construction sites: build a value via the catalog (`BIMAI_MATERIALS[id]`
 * returns one already typed) or via `BimAIMaterialId.parse('foo')` when
 * a string crosses the runtime boundary (panel input, JSON load).
 */
export const BimAIMaterialId = z.string().brand('BimAIMaterialId')
export type BimAIMaterialId = z.infer<typeof BimAIMaterialId>

/**
 * Per-component cost override. Three slots so the same shape covers
 * surface-priced (walls, slabs), volumetric (rare today; structural
 * concrete by m³ is the canonical case), and fixed-price (doors,
 * windows). All optional — present-but-zero means "explicitly free",
 * absent means "fall back to the catalog".
 *
 * The cost computation in `cost/compute.ts` picks the slot that matches
 * the component's pricing dimension; a wall with `flat` set but no
 * `perM2` falls through to the catalog rather than silently using flat.
 */
const CostOverride = z.object({
  perM2: z.number().optional(),
  perM3: z.number().optional(),
  flat: z.number().optional(),
})
export type CostOverride = z.infer<typeof CostOverride>

/**
 * The BimAI BIM blob attached to one node's `metadata.bimai.bim`.
 *
 * `material` is optional because not every node type in Pascal has a
 * sensible material today (e.g. levels, zones used as units). The
 * generator's `bim-defaults` stage fills it in for the four types we do
 * care about — walls, slabs, doors, windows. Reading code should treat
 * a missing material as "unknown / fall through to category-default
 * costing" rather than an error.
 *
 * `fireRating` and `loadBearing` always carry values via Zod defaults so
 * downstream readers can index them without guards.
 */
export const ComponentBIM = z.object({
  material: BimAIMaterialId.optional(),
  fireRating: FireRating.default('unrated'),
  loadBearing: z.boolean().default(false),
  costOverride: CostOverride.optional(),
})
export type ComponentBIM = z.infer<typeof ComponentBIM>
