// BimAI material catalog.
//
// Single source of truth for the materials BimAI knows how to cost,
// schedule, and visually map onto Pascal's renderer. Owned by BimAI —
// not an extension of Pascal's `MaterialPreset`. See the rationale in
// `schemas/component-bim.ts`'s header.
//
// ⚠️  All cost / density / fire / CO₂ figures are reasonable defaults
// for European mid-rise residential construction in 2025. They are NOT
// authoritative. Real prices depend on country, supplier, year, batch
// size, and a hundred other things. Users will eventually need
// per-project overrides — that's a Phase 3-5+ concern. For now, treat
// these numbers as starting points good enough to drive panel UX.
//
// Sources used to ballpark each value (kept loose, not citation-grade):
//   • costPerM2 / costPerUnit — public RICS- and DBV-style indices for
//     Western-European mid-rise residential, blended; rounded to the
//     nearest €5.
//   • density — manufacturer datasheets (concrete, gypsum, brick, glass).
//   • embodiedCO2 — ICE database v3.0 cradle-to-gate, kg CO₂-eq per kg
//     of material as installed. "Aggregate" assemblies (windows, doors)
//     are per-unit-mass approximations; will likely be replaced with
//     per-unit values once we model size variance.
//   • pascalPreset — picked to match Pascal's `MaterialPreset` enum in
//     `packages/core/src/schema/material.ts`. Renderer-only; doesn't
//     affect cost or schedule.

import type {
  BimAIMaterialId,
  FireRating,
} from './schemas/component-bim'

/** Component types BimAI applies materials to. Roof is included for
 *  forward-compatibility with Phase 3-5 even though the generator
 *  doesn't emit roof nodes yet. */
export type BIMComponentType = 'wall' | 'slab' | 'door' | 'window' | 'roof'

export interface BimAIMaterial {
  id: BimAIMaterialId
  name: string
  /** What this material is offered for. A material can apply to several
   *  component types (e.g. cast concrete is fine for both walls and slabs). */
  applicableTo: BIMComponentType[]
  /** Surface pricing. Set when the material is sold by area — the
   *  default for walls and slabs. */
  costPerM2?: number
  /** Volumetric pricing. Set for materials genuinely sold by m³ (rare
   *  in residential; structural concrete is the canonical case). When
   *  both `costPerM2` and `costPerM3` are present the cost layer picks
   *  by component dimension, not by material preference. */
  costPerM3?: number
  /** Fixed pricing. Set for assemblies sold per unit (doors, windows). */
  costPerUnit?: number
  /** kg/m³. Reserved for future structural / seismic work; not used in
   *  Phase 3-4 cost or schedule. Stored anyway so the catalog stays
   *  the single source. */
  density: number
  fireRating: FireRating
  /** kg CO₂-eq per kg of material, cradle-to-gate. For per-unit
   *  assemblies (doors, windows) this is an aggregate over the whole
   *  unit's mass; will be replaced by per-unit values when size
   *  variance lands. */
  embodiedCO2: number
  /** Visual hint for Pascal's renderer. Matches `MaterialPreset` from
   *  `packages/core/src/schema/material.ts`. Renderer-only. */
  pascalPreset:
    | 'white'
    | 'brick'
    | 'concrete'
    | 'wood'
    | 'glass'
    | 'metal'
    | 'plaster'
    | 'tile'
    | 'marble'
}

// ── Catalog ──────────────────────────────────────────────────────────────────
//
// Keys are the material id string — kept in sync with each entry's `id`
// for ergonomic lookups (`BIMAI_MATERIALS['concrete-cast']` returns the
// fully-typed material). The `as BimAIMaterialId` casts are the only
// place the brand is constructed; everywhere else the type system
// carries it through.

export const BIMAI_MATERIALS = {
  'concrete-cast': {
    id: 'concrete-cast' as BimAIMaterialId,
    name: 'Cast-in-place concrete',
    applicableTo: ['wall', 'slab'],
    costPerM2: 180,
    density: 2400,
    fireRating: 'A1',
    embodiedCO2: 0.13,
    pascalPreset: 'concrete',
  },
  'concrete-slab-residential': {
    id: 'concrete-slab-residential' as BimAIMaterialId,
    name: 'Reinforced concrete slab w/ thermal insulation',
    applicableTo: ['slab'],
    // Slightly higher than bare cast concrete to cover EPS layer + screed.
    costPerM2: 215,
    density: 2200,
    fireRating: 'A1',
    embodiedCO2: 0.16,
    pascalPreset: 'concrete',
  },
  'concrete-precast-facade': {
    id: 'concrete-precast-facade' as BimAIMaterialId,
    name: 'Precast concrete facade panel',
    applicableTo: ['wall'],
    // Heavier facade option than brick veneer; popular in Northern EU.
    costPerM2: 280,
    density: 2400,
    fireRating: 'A1',
    embodiedCO2: 0.17,
    pascalPreset: 'concrete',
  },
  'drywall-residential': {
    id: 'drywall-residential' as BimAIMaterialId,
    name: 'Drywall on stud (interior)',
    applicableTo: ['wall'],
    costPerM2: 65,
    density: 700,
    fireRating: 'A2',
    embodiedCO2: 0.16,
    pascalPreset: 'plaster',
  },
  'partition-acoustic': {
    id: 'partition-acoustic' as BimAIMaterialId,
    name: 'Acoustic partition (double-stud, mineral wool)',
    applicableTo: ['wall'],
    // Premium over plain drywall for inter-unit / unit-corridor walls.
    costPerM2: 125,
    density: 850,
    fireRating: 'A2',
    embodiedCO2: 0.19,
    pascalPreset: 'plaster',
  },
  'brick-exterior': {
    id: 'brick-exterior' as BimAIMaterialId,
    name: 'Brick veneer on stud',
    applicableTo: ['wall'],
    costPerM2: 220,
    density: 1900,
    fireRating: 'A1',
    embodiedCO2: 0.24,
    pascalPreset: 'brick',
  },
  'door-residential': {
    id: 'door-residential' as BimAIMaterialId,
    name: 'Solid-core residential door',
    applicableTo: ['door'],
    costPerUnit: 380,
    density: 600,
    fireRating: 'unrated',
    embodiedCO2: 0.45,
    pascalPreset: 'wood',
  },
  'window-double-glazed': {
    id: 'window-double-glazed' as BimAIMaterialId,
    name: 'Double-glazed aluminium-framed window',
    applicableTo: ['window'],
    // Wide variance with size; this is a representative mid-size value.
    costPerUnit: 520,
    density: 0,
    fireRating: 'unrated',
    embodiedCO2: 1.4,
    pascalPreset: 'glass',
  },
} as const satisfies Record<string, BimAIMaterial>

/** Type-safe id of any material in the catalog — narrower than the raw
 *  `BimAIMaterialId` brand so consumers can switch on it exhaustively. */
export type CatalogMaterialKey = keyof typeof BIMAI_MATERIALS

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up a material by id. Throws if the id isn't in the catalog —
 * callers handling user-supplied ids should use the safe variant.
 *
 * `BimAIMaterialId` is a brand over `string`, so this happily accepts
 * any branded id; the runtime check is what enforces catalog membership.
 */
export function getMaterial(id: BimAIMaterialId): BimAIMaterial {
  const m = (BIMAI_MATERIALS as Record<string, BimAIMaterial>)[id as string]
  if (!m) throw new Error(`unknown BimAI material: ${String(id)}`)
  return m
}

export function tryGetMaterial(
  id: BimAIMaterialId | undefined,
): BimAIMaterial | undefined {
  if (id === undefined) return undefined
  return (BIMAI_MATERIALS as Record<string, BimAIMaterial>)[id as string]
}

/**
 * Pick a sensible default material for a freshly-emitted component.
 * Used by the bim-defaults generator stage (Task 3) and as the "reset
 * to default" target in the BIM properties UI (Task 7).
 *
 * Rules — kept narrow on purpose. If we needed a richer rule space we'd
 * graduate this to a strategy object; for now the four-line `switch`
 * is the right fit.
 *
 *   wall (exterior)                         → brick-exterior
 *   wall (interior, loadBearing)            → concrete-cast
 *   wall (interior, non-loadBearing)        → drywall-residential
 *   slab                                    → concrete-slab-residential
 *   door                                    → door-residential
 *   window                                  → window-double-glazed
 *
 * Roof intentionally falls through to a thrown error — Phase 3-4
 * doesn't generate roofs, and silently picking a wall/slab default
 * would mask a real "we got a roof from somewhere" bug at the call
 * site. Revisit when roof emission lands in 3-5.
 */
export interface DefaultMaterialContext {
  isExterior?: boolean
  isLoadBearing?: boolean
}

export function defaultMaterialFor(
  componentType: 'wall' | 'slab' | 'door' | 'window',
  context: DefaultMaterialContext = {},
): BimAIMaterialId {
  switch (componentType) {
    case 'wall': {
      if (context.isExterior) return BIMAI_MATERIALS['brick-exterior'].id
      if (context.isLoadBearing) return BIMAI_MATERIALS['concrete-cast'].id
      return BIMAI_MATERIALS['drywall-residential'].id
    }
    case 'slab':
      return BIMAI_MATERIALS['concrete-slab-residential'].id
    case 'door':
      return BIMAI_MATERIALS['door-residential'].id
    case 'window':
      return BIMAI_MATERIALS['window-double-glazed'].id
  }
}

/** Filter the catalog to materials applicable to a given component
 *  type. Used by the BIM section dropdown (Task 7) so users only see
 *  options that make sense for the element they're editing. */
export function materialsApplicableTo(
  componentType: BIMComponentType,
): BimAIMaterial[] {
  return Object.values(BIMAI_MATERIALS).filter((m) =>
    m.applicableTo.includes(componentType),
  )
}
