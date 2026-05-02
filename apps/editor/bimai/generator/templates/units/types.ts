// Phase 3-9 unit-variant template types.
//
// Phase 3-7 introduced one `UnitTemplate` per unit type living in
// `stages/rooms-templates.ts` (recursive proportional-bisection plan).
// Phase 3-9 keeps the proven bisection format — `SubdivideSpec` is
// strictly more expressive than the brief's sketch flat-list — and
// layers variant metadata on top: an id, a human label, an area band,
// preferred-condition flags (corner / deep / facade edges), and a
// balcony presence flag. The selector in `stages/variant-selection.ts`
// reads this metadata and picks one variant per unit at place time.
//
// Why a new file rather than extending `UnitTemplate` in
// `rooms-templates.ts`: keeping the catalog layer and the bisection
// substrate in separate modules makes the data-driven principle
// (Principle A: "templates are data, not code branches") legible —
// the `templates/units/` tree holds *only* data and the metadata that
// describes it. The bisector keeps reading `SubdivideSpec`, so adding
// a Phase 3-10 variant remains a pure data change.
//
// Naming: `UnitVariantTemplate` here, not `UnitTemplate`, so existing
// imports from `rooms-templates.ts` don't shadow.

import type { SubdivideSpec } from '../../stages/rooms-templates'

/**
 * Inclusive area band (m²) the variant was authored for. The selector
 * in `variant-selection.ts` excludes any variant whose band doesn't
 * cover the unit's actual area before scoring.
 *
 * Slightly looser semantics than `AreaRangeM2` from `rooms-templates.ts`
 * — no `nominal` because the variant catalog is for selection, not for
 * panel-side reporting. The bisection engine still runs the unit's real
 * area through its own area-band gate downstream.
 */
export interface VariantAreaBand {
  minM2: number
  maxM2: number
}

/**
 * Optional preferences a variant declares about the unit it'd like to
 * occupy. All fields are optional; an absent field means "indifferent."
 * The selector translates each declared preference into a positive
 * score contribution at scoring time (see `scoreTemplate`).
 */
export interface PreferredConditions {
  /**
   * Variant prefers corner units (units with ≥ 2 facade edges). Used by
   * en-suite-master / dual-aspect layouts that benefit from light on
   * two sides.
   */
  corner?: boolean
  /**
   * Variant prefers deep plates (units with high facade-to-corridor
   * distance). Used by layouts that need long bedrooms or central
   * kitchens.
   */
  deepPlate?: boolean
  /**
   * Variant prefers exactly this many facade edges. Mutually compatible
   * with `corner` (2 facade edges → corner === true). Reserve for
   * variants that only make sense at a specific count (e.g. balcony
   * variants that need one specific facade-edge count to look right).
   */
  facadeEdges?: number
}

/**
 * One catalog entry. Multiple variants per unit type are catalogued in
 * the per-unit-type files (`studio.ts`, `one-br.ts`, …) and re-exported
 * from `index.ts` as `VARIANT_CATALOG`.
 *
 * Constraints (asserted by `validateUnitVariantTemplate`):
 *   - `id` non-empty, globally unique across the whole catalog
 *   - `unitType` matches the file it lives in
 *   - `areaBand.minM2 < areaBand.maxM2`, both positive
 *   - `slices` is a well-formed `SubdivideSpec` (delegated to the
 *     Phase 3-7 validator at module-load time)
 *   - `hasBalcony === true` ⇔ at least one leaf in `slices` is a
 *     balcony slice (Phase 3-9 adds the `balcony` RoomKind in Task 4
 *     when the catalog needs it; `hasBalcony: false` variants must
 *     contain no balcony leaves)
 */
export interface UnitVariantTemplate {
  /** Stable, human-readable, globally unique. e.g. `'two-br-master-secondary'`. */
  id: string
  /** Matches `UnitMixEntry.type`: 'Studio' | '1BR' | '2BR' | '3BR' | '4BR'. */
  unitType: string
  /** Human label for panels / debug logs. */
  label: string
  /** Inclusive area band the variant fits. */
  areaBand: VariantAreaBand
  /**
   * Optional preferences fed into the selector's scoring function. An
   * empty object is valid — variant is indifferent to conditions and
   * wins purely on area-fit.
   */
  preferredConditions: PreferredConditions
  /**
   * True if at least one leaf in `slices` is a balcony. The selector
   * uses this to filter variants under `program.generateBalconies:
   * false` (balcony variants are excluded entirely when the user opts
   * out). Authoring redundancy with `slices` content is intentional —
   * lets the selector skip walking the slice tree just to check.
   */
  hasBalcony: boolean
  /**
   * The recursive proportional-bisection plan, same format Phase 3-7
   * uses in `rooms-templates.ts`. The bisector in `rooms-packing.ts`
   * consumes it identically.
   */
  slices: SubdivideSpec
  /**
   * Optional balcony attachment. Present when `hasBalcony === true`
   * (validator enforces this). Absent for indoor-only variants.
   */
  balcony?: BalconySpec
}

/**
 * Balcony spec. A variant declares one balcony at most; the emitter
 * (`stages/balconies.ts`, Task 11) projects it off the unit's facade
 * according to the spec.
 *
 * Held outside `slices` so we don't need to extend `RoomKind` with an
 * `'outdoor'` value — that change rippled through 18 files of
 * exhaustive switches and the win wasn't worth it. Balconies are not
 * rooms: they don't tile the unit polygon, don't host doors via the
 * Phase 3-7 corner-offset rule, and price out at a different €/m²
 * line. Treating them as a sibling concept keeps the indoor pipeline
 * (rooms-packing → rooms-doors → rooms-walls → emit) untouched.
 */
export interface BalconySpec {
  /**
   * Which interior leaf the balcony attaches to. Matches the `kind` of
   * a leaf in `slices`; the emitter projects the balcony off whichever
   * facade edge of that leaf is exterior.
   */
  attachTo: 'living' | 'bedroom' | 'kitchen'
  /** Depth of the balcony projection beyond the facade, metres. */
  depthM: number
}

/** Catalog entry-set shape: the per-unit-type files export one of these. */
export type UnitVariantCatalog = readonly UnitVariantTemplate[]

/**
 * Thrown by `validateUnitVariantTemplate` on any structural problem.
 * Tests catch this directly.
 */
export class InvalidVariantTemplateError extends Error {
  constructor(template: { id?: string }, reason: string) {
    super(
      `Invalid variant template '${template.id ?? '(no id)'}': ${reason}`,
    )
    this.name = 'InvalidVariantTemplateError'
  }
}

const ALLOWED_UNIT_TYPES = new Set(['Studio', '1BR', '2BR', '3BR', '4BR'])

/**
 * Structural check on a single variant. Module-load-time gate — every
 * file in `templates/units/` calls this on each entry it exports so
 * the catalog can't ship malformed entries. Lightweight by design;
 * the deep `SubdivideSpec` validation lives in
 * `rooms-templates.ts#validateTemplate` and runs separately when the
 * bisector first reads the slices.
 */
export function validateUnitVariantTemplate(t: UnitVariantTemplate): void {
  if (!t.id || t.id.length === 0) {
    throw new InvalidVariantTemplateError(t, 'id must be non-empty')
  }
  if (!ALLOWED_UNIT_TYPES.has(t.unitType)) {
    throw new InvalidVariantTemplateError(
      t,
      `unitType '${t.unitType}' not in {Studio, 1BR, 2BR, 3BR, 4BR}`,
    )
  }
  if (!t.label || t.label.length === 0) {
    throw new InvalidVariantTemplateError(t, 'label must be non-empty')
  }
  if (!Number.isFinite(t.areaBand.minM2) || t.areaBand.minM2 <= 0) {
    throw new InvalidVariantTemplateError(t, 'areaBand.minM2 must be positive')
  }
  if (!Number.isFinite(t.areaBand.maxM2) || t.areaBand.maxM2 <= 0) {
    throw new InvalidVariantTemplateError(t, 'areaBand.maxM2 must be positive')
  }
  if (t.areaBand.minM2 >= t.areaBand.maxM2) {
    throw new InvalidVariantTemplateError(
      t,
      `areaBand inverted: ${t.areaBand.minM2} ≥ ${t.areaBand.maxM2}`,
    )
  }
  if (t.hasBalcony && !t.balcony) {
    throw new InvalidVariantTemplateError(
      t,
      'hasBalcony=true but no balcony spec provided',
    )
  }
  if (!t.hasBalcony && t.balcony) {
    throw new InvalidVariantTemplateError(
      t,
      'balcony spec present but hasBalcony=false',
    )
  }
  if (t.balcony && (!Number.isFinite(t.balcony.depthM) || t.balcony.depthM <= 0)) {
    throw new InvalidVariantTemplateError(t, 'balcony.depthM must be positive')
  }
}

/**
 * Validates a whole catalog batch and asserts global id uniqueness.
 * Catalogs call this from their own module bodies at load time; the
 * thrown error halts module init so a bad data drop can never reach
 * runtime selection.
 */
export function validateUnitVariantCatalog(
  catalog: UnitVariantCatalog,
): void {
  const ids = new Set<string>()
  for (const t of catalog) {
    validateUnitVariantTemplate(t)
    if (ids.has(t.id)) {
      throw new InvalidVariantTemplateError(
        t,
        `duplicate id '${t.id}' within catalog`,
      )
    }
    ids.add(t.id)
  }
}
