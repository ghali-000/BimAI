// Typology costs (the "estimated, not modelled" half of the hybrid cost model).
//
// BimAI prices buildings using a hybrid: per-component sum-of-products for
// the things we actually generate (walls, slabs, openings) PLUS additive
// typology categories for everything we don't (MEP, finishes, sitework,
// risk buffer, soft costs). Each typology category is its own line in the
// cost panel — the user sees exactly what's estimated vs. measured.
//
// ⚠️ The default figures below are reasonable for European mid-rise
// residential construction in 2025 — RICS / DBV / Turner & Townsend public
// indices, blended, rounded for legibility. They are NOT authoritative.
// Real prices vary by country, supplier, year, batch size, and a hundred
// other things. Users will eventually need per-project overrides — that's
// what `TypologyOverride` (stored on `SiteNode.metadata.bimai.typologyOverride`)
// is for. UI for editing it lands in Phase 3-5+.
//
// Why additive rather than a multiplier on structural cost. A multiplier
// would compound with material upgrades misleadingly (luxury cladding
// shouldn't 2× the MEP cost) and would hide what's being estimated.
// Additive €/m² of GEA shows the user that MEP is, say, €210/m²
// independent of what the walls cost.

import { z } from 'zod'

/**
 * Effective typology costs after default + override merge. €/m² of GEA
 * for the additive categories; fractions (0..1) for the percentage ones.
 */
export interface TypologyCosts {
  /** Mechanical, electrical, plumbing. €/m² of GEA. */
  mep: number
  /** Floors, paint, kitchen, bath. €/m² of GEA. */
  finishes: number
  /** Site management, scaffolding, hoarding. €/m² of GEA. */
  generalConditions: number
  /** Fraction of (perComponent + mep + finishes + generalConditions). */
  contingencyPct: number
  /** Fraction of hardCost. */
  softCostsPct: number
}

/**
 * EU mid-rise residential 2025 baselines. Sourced from public construction
 * indices, blended, rounded to the nearest €5 / 0.5%. Treat as a starting
 * point — see file header.
 */
export const DEFAULT_TYPOLOGY: TypologyCosts = {
  mep: 210,
  finishes: 175,
  generalConditions: 75,
  contingencyPct: 0.08,
  softCostsPct: 0.1,
}

/**
 * Per-project override for typology baselines. Lives on
 * `SiteNode.metadata.bimai.typologyOverride`. All fields optional;
 * missing fields fall back to `DEFAULT_TYPOLOGY`.
 *
 * No editing UI in Phase 3-4 — the schema and the read path
 * (`resolveTypology`) are the deliverable. UI for typology editing
 * comes in Phase 3-5+ when we have a clearer picture of what users
 * actually want to override.
 */
export const TypologyOverride = z.object({
  mep: z.number().nonnegative().optional(),
  finishes: z.number().nonnegative().optional(),
  generalConditions: z.number().nonnegative().optional(),
  contingencyPct: z.number().min(0).max(1).optional(),
  softCostsPct: z.number().min(0).max(1).optional(),
})
export type TypologyOverride = z.infer<typeof TypologyOverride>

/**
 * Merge an optional override on top of the catalog defaults. Each field
 * is independently overridable — passing `{ mep: 250 }` only moves MEP.
 *
 * Defensive: an undefined override returns the defaults verbatim so the
 * cost compute can call this unconditionally.
 */
export function resolveTypology(
  override: TypologyOverride | undefined,
): TypologyCosts {
  if (!override) return { ...DEFAULT_TYPOLOGY }
  return {
    mep: override.mep ?? DEFAULT_TYPOLOGY.mep,
    finishes: override.finishes ?? DEFAULT_TYPOLOGY.finishes,
    generalConditions:
      override.generalConditions ?? DEFAULT_TYPOLOGY.generalConditions,
    contingencyPct: override.contingencyPct ?? DEFAULT_TYPOLOGY.contingencyPct,
    softCostsPct: override.softCostsPct ?? DEFAULT_TYPOLOGY.softCostsPct,
  }
}
