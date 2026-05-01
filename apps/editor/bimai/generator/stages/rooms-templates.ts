// Room subdivision templates (Phase 3-7, Task 2).
//
// Format: two-level proportional grid. The root `SubdivideSpec` slices
// the unit polygon along one axis ('along' = parallel to the unit's
// long axis, 'across' = perpendicular). Each child slice is either a
// leaf (`kind` set, becomes a RoomPlan) or another `SubdivideSpec`
// (`subdivide` set, slices its strip again — and that's it; we cap
// recursion at two levels for Phase 3-7).
//
// Why two levels: 1BR through 4BR layouts decompose cleanly into
// "circulation strip + zones, each zone subdivided once". Going deeper
// (recursive bisection trees) would buy us more flexibility but also a
// lot more failure modes. The format shapes the algorithm: Task 4's
// recursive bisector matches this structure 1:1.
//
// Constraint application (in Task 4, not here):
//   1. Fractions are intent.
//   2. `bathroomMaxAreaM2` clamps any bathroom slice over the cap and
//      redistributes surplus to the next sibling in `slices`.
//   3. `minRoomDimensionM`: if any leaf rectangle ends up narrower
//      than this on either dim, the template instantiation fails and
//      the unit falls back to a single `unit-shell` room (degenerate
//      case — documented in PROGRESS.md once 3-7 closes).
//
// Percentages below are starting points based on EU mid-rise
// residential conventions, not authoritative numbers. The optimizer
// (or a future tuning pass) can vary them once cost/sellability data
// gives us a signal.

import type { RoomKind } from '../types'

/**
 * One slice of a parent strip. Either a leaf (a real room — `kind`
 * present, `subdivide` absent) or an internal node that slices the
 * strip again perpendicular to its parent's axis (`subdivide` present,
 * `kind` absent).
 *
 * Invariant: exactly one of `kind` / `subdivide` is set. Enforced by
 * `validateTemplate` at module-load time.
 */
export interface ProportionalSlice {
  /** 0..1. Sum across siblings must equal 1.0 within `FRACTION_EPSILON`. */
  fraction: number
  /** Leaf only: the room kind this slice becomes. */
  kind?: RoomKind
  /** Non-leaf only: how to slice this strip further. */
  subdivide?: SubdivideSpec
}

/**
 * One axis-aligned partition of a strip. `along` means parallel to the
 * unit's long axis; `across` means perpendicular. The root spec uses
 * whichever axis the template author picked; child specs flip it.
 */
export interface SubdivideSpec {
  axis: 'along' | 'across'
  /** Sibling fractions must sum to 1.0. */
  slices: ProportionalSlice[]
}

export interface UnitTemplateConstraints {
  /** Bedrooms must touch a facade edge of the unit. */
  bedroomNeedsFacade: boolean
  /** Hard upper cap on a bathroom slice's area in m². Surplus redistributes. */
  bathroomMaxAreaM2: number
  /**
   * Minimum width and depth of any leaf rectangle in metres. Tighter
   * than this → template instantiation fails, unit falls back to
   * unit-shell. 1.5 is the UK/EU code minimum for habitable spaces;
   * we use it for everything (including bathrooms) as a conservative
   * floor.
   */
  minRoomDimensionM: number
}

/**
 * Inclusive [min, max] area band the template was authored against,
 * with a `nominal` typical-case area for fixtures and reporting.
 *
 * The packer's area-band gate (Phase 3-7 follow-up to Task 8) uses
 * `min`/`max` to decide whether a unit polygon is in the template's
 * design envelope: far outside → fall back to unit-shell rather than
 * instantiate a layout that won't satisfy `minRoomDimensionM` anyway.
 * Tolerances are asymmetric (0.85×min on the small side, 1.5×max on
 * the large side) — real apartments commonly stretch 50% above the
 * "typical 1BR" without ceasing to be a 1BR, but they don't shrink
 * 15% below without changing type. Bands and `nominal` values are EU
 * mid-rise residential 2025 baselines, not authoritative numbers.
 *
 * Bands overlap intentionally: a 70 m² unit could be a generous 1BR
 * or a tight 2BR depending on layout. The unit packer is what assigns
 * type; the template only validates that the chosen type fits.
 */
export interface AreaRangeM2 {
  /** Lower band edge in m². */
  min: number
  /** Upper band edge in m². */
  max: number
  /** Typical-case area used in fixtures and panel reporting. */
  nominal: number
}

export interface UnitTemplate {
  /** Matches `UnitMixEntry.type`: "Studio", "1BR", "2BR", "3BR", "4BR". */
  unitType: string
  /** The polygon-area band this template was authored for. */
  areaRangeM2: AreaRangeM2
  rootSplit: SubdivideSpec
  constraints: UnitTemplateConstraints
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/**
 * Anything bigger is a luxury suite; out of scope for residential
 * mid-rise. Used by the Task 4 packer to clamp oversized bathroom
 * slices in large units (e.g. 4BR at the top of its band).
 */
export const BATHROOM_MAX_AREA_M2 = 8

/** UK/EU code minimum for habitable spaces. Conservative floor. */
export const MIN_ROOM_DIMENSION_M = 1.5

/** Tolerance for the "fractions sum to 1.0" check. */
export const FRACTION_EPSILON = 1e-6

const DEFAULT_CONSTRAINTS: UnitTemplateConstraints = {
  bedroomNeedsFacade: true,
  bathroomMaxAreaM2: BATHROOM_MAX_AREA_M2,
  minRoomDimensionM: MIN_ROOM_DIMENSION_M,
}

// ─────────────────────────────────────────────────────────────────────
// Templates (Studio, 1BR, 2BR, 3BR, 4BR)
//
// All percentages are starting-point conventions, not authoritative.
// Document the band each template targets in the inline comment so a
// reviewer can see at a glance where the layout breaks down.
// ─────────────────────────────────────────────────────────────────────

/** Studio (35-45 m²): bath strip + open living. No hallway at this size. */
const STUDIO_TEMPLATE: UnitTemplate = {
  unitType: 'Studio',
  areaRangeM2: { min: 30, max: 50, nominal: 40 },
  rootSplit: {
    axis: 'along',
    slices: [
      { fraction: 0.15, kind: 'bathroom' },
      { fraction: 0.85, kind: 'living' },
    ],
  },
  constraints: DEFAULT_CONSTRAINTS,
}

/**
 * 1BR (50-65 m²): hallway strip with embedded bathroom, public zone
 * (kitchen + living), bedroom against the facade.
 *
 * The brief's literal numbers were `[hallway 12%, public 50%, bedroom
 * 38%]` with no bathroom — but the test contract expects bathroom +
 * kitchen + living + bedroom + hallway. We embed the bathroom in the
 * hallway strip the same way 3BR/4BR do, which keeps the bathroom
 * accessible from the corridor (not from living) and matches typical
 * EU 1BR layouts.
 */
const ONE_BR_TEMPLATE: UnitTemplate = {
  unitType: '1BR',
  areaRangeM2: { min: 45, max: 70, nominal: 55 },
  rootSplit: {
    axis: 'along',
    slices: [
      {
        fraction: 0.12,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.6, kind: 'hallway' },
            { fraction: 0.4, kind: 'bathroom' },
          ],
        },
      },
      {
        fraction: 0.5,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.4, kind: 'kitchen' },
            { fraction: 0.6, kind: 'living' },
          ],
        },
      },
      { fraction: 0.38, kind: 'bedroom' },
    ],
  },
  constraints: DEFAULT_CONSTRAINTS,
}

/**
 * 2BR (75-90 m²): hallway+bathroom strip, public zone, private zone
 * with two bedrooms (both need facade access — the packer enforces
 * that the private slice sits on the facade side).
 */
const TWO_BR_TEMPLATE: UnitTemplate = {
  unitType: '2BR',
  areaRangeM2: { min: 70, max: 100, nominal: 82 },
  rootSplit: {
    axis: 'along',
    slices: [
      {
        fraction: 0.14,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.6, kind: 'hallway' },
            { fraction: 0.4, kind: 'bathroom' },
          ],
        },
      },
      {
        fraction: 0.48,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.4, kind: 'kitchen' },
            { fraction: 0.6, kind: 'living' },
          ],
        },
      },
      {
        fraction: 0.38,
        subdivide: {
          axis: 'across',
          // bedroom-master 55% / bedroom-2 45% by intent; both leaves
          // are `kind: 'bedroom'` since RoomKind doesn't encode the
          // master/secondary distinction (slot names are documentation
          // only).
          slices: [
            { fraction: 0.55, kind: 'bedroom' },
            { fraction: 0.45, kind: 'bedroom' },
          ],
        },
      },
    ],
  },
  constraints: DEFAULT_CONSTRAINTS,
}

/**
 * 3BR (100-120 m²): same shape as 2BR but private slice has three
 * bedrooms. Single bathroom, embedded in the hallway strip.
 */
const THREE_BR_TEMPLATE: UnitTemplate = {
  unitType: '3BR',
  areaRangeM2: { min: 90, max: 130, nominal: 105 },
  rootSplit: {
    axis: 'along',
    slices: [
      {
        fraction: 0.12,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.6, kind: 'hallway' },
            { fraction: 0.4, kind: 'bathroom' },
          ],
        },
      },
      {
        fraction: 0.42,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.4, kind: 'kitchen' },
            { fraction: 0.6, kind: 'living' },
          ],
        },
      },
      {
        fraction: 0.46,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.38, kind: 'bedroom' }, // master
            { fraction: 0.31, kind: 'bedroom' },
            { fraction: 0.31, kind: 'bedroom' },
          ],
        },
      },
    ],
  },
  constraints: DEFAULT_CONSTRAINTS,
}

/**
 * 4BR (130-160 m²): same root shape as 3BR but private strip has four
 * bedrooms plus a second bathroom (en-suite-style, embedded next to
 * the master). Keeps the two-level cap.
 */
const FOUR_BR_TEMPLATE: UnitTemplate = {
  unitType: '4BR',
  areaRangeM2: { min: 120, max: 180, nominal: 145 },
  rootSplit: {
    axis: 'along',
    slices: [
      {
        fraction: 0.12,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.6, kind: 'hallway' },
            { fraction: 0.4, kind: 'bathroom' },
          ],
        },
      },
      {
        fraction: 0.42,
        subdivide: {
          axis: 'across',
          slices: [
            { fraction: 0.4, kind: 'kitchen' },
            { fraction: 0.6, kind: 'living' },
          ],
        },
      },
      {
        fraction: 0.46,
        subdivide: {
          axis: 'across',
          // master + en-suite bath + 3 secondary bedrooms.
          // Phase 3-7 close-out (Fix A): the en-suite bath fraction was
          // raised from 0.12 → 0.17 so that at the fixed
          // `TARGET_STRIP_DEPTH_M = 9` strip depth, the bath's across
          // dimension (0.17 × 9 = 1.53 m) clears the 1.5 m
          // `minRoomDimensionM` floor. The original 0.12 produced a
          // 1.08 m wide bath rect, causing every 4BR to silently fall
          // back to unit-shell — see PROGRESS.md "Close-out: fixed
          // strip depth + corridor-mode discriminator".
          // master 21%, bath 17%, bed-2 21%, bed-3 20%, bed-4 21% = 1.0
          slices: [
            { fraction: 0.21, kind: 'bedroom' }, // master
            { fraction: 0.17, kind: 'bathroom' }, // en-suite
            { fraction: 0.21, kind: 'bedroom' },
            { fraction: 0.2, kind: 'bedroom' },
            { fraction: 0.21, kind: 'bedroom' },
          ],
        },
      },
    ],
  },
  constraints: DEFAULT_CONSTRAINTS,
}

// ─────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown by `validateTemplate` when a template is malformed. Templates
 * are static module-load constants, so this firing means a code bug,
 * not a runtime input problem.
 */
export class InvalidTemplateError extends Error {
  constructor(
    message: string,
    public readonly unitType: string,
    public readonly path: string,
  ) {
    super(`[${unitType}] ${path}: ${message}`)
    this.name = 'InvalidTemplateError'
  }
}

function validateSpec(
  spec: SubdivideSpec,
  unitType: string,
  path: string,
): void {
  if (spec.slices.length === 0) {
    throw new InvalidTemplateError('subdivide has no slices', unitType, path)
  }
  let sum = 0
  for (const s of spec.slices) sum += s.fraction
  if (Math.abs(sum - 1.0) > FRACTION_EPSILON) {
    throw new InvalidTemplateError(
      `slice fractions sum to ${sum}, expected 1.0`,
      unitType,
      path,
    )
  }
  spec.slices.forEach((slice, i) => {
    const childPath = `${path}.slices[${i}]`
    if (slice.fraction <= 0 || slice.fraction > 1) {
      throw new InvalidTemplateError(
        `fraction ${slice.fraction} out of (0, 1]`,
        unitType,
        childPath,
      )
    }
    const hasKind = slice.kind !== undefined
    const hasSub = slice.subdivide !== undefined
    if (hasKind === hasSub) {
      throw new InvalidTemplateError(
        hasKind
          ? 'slice has both kind and subdivide; pick one'
          : 'slice has neither kind nor subdivide',
        unitType,
        childPath,
      )
    }
    if (slice.subdivide) {
      // Two-level cap: a child subdivide must not contain another
      // subdivide. (Phase 3-7 keeps this hard; relax later if needed.)
      for (let j = 0; j < slice.subdivide.slices.length; j++) {
        const grand = slice.subdivide.slices[j]!
        if (grand.subdivide) {
          throw new InvalidTemplateError(
            'template exceeds two-level depth cap',
            unitType,
            `${childPath}.subdivide.slices[${j}]`,
          )
        }
      }
      validateSpec(slice.subdivide, unitType, `${childPath}.subdivide`)
    }
  })
}

/**
 * Validates one template. Throws `InvalidTemplateError` on the first
 * problem found. Called at module load on every template constant — a
 * malformed template surfaces as a test failure, not a runtime crash
 * deep inside the packer.
 */
export function validateTemplate(t: UnitTemplate): void {
  const { min, max, nominal } = t.areaRangeM2
  if (!(min > 0) || !(max > 0) || min >= max) {
    throw new InvalidTemplateError(
      `areaRangeM2 invalid: min=${min}, max=${max}`,
      t.unitType,
      'areaRangeM2',
    )
  }
  if (!(nominal >= min) || !(nominal <= max)) {
    throw new InvalidTemplateError(
      `areaRangeM2.nominal (${nominal}) must lie in [${min}, ${max}]`,
      t.unitType,
      'areaRangeM2',
    )
  }
  validateSpec(t.rootSplit, t.unitType, 'rootSplit')
}

/**
 * Distributes a total area through the template tree by multiplying
 * fractions level-by-level. Returns one entry per leaf, in template
 * traversal order. The Task 4 packer uses this to:
 *  - sanity-check that no leaf falls below `minRoomDimensionM²`
 *    before it bothers placing geometry,
 *  - decide which slice absorbs surplus from a clamped bathroom
 *    (the next sibling — see brief),
 *  - drive the schedule layer's per-room area report.
 *
 * Pure: ignores actual polygon geometry; only multiplies fractions.
 * The packer reconciles these expectations with the real rectangle
 * dimensions when it bisects.
 */
export interface LeafAllocation {
  kind: RoomKind
  areaM2: number
  /** Path through the template tree, e.g. "rootSplit.slices[1].subdivide.slices[0]". */
  path: string
}

export function computeLeafAllocations(
  template: UnitTemplate,
  totalAreaM2: number,
): LeafAllocation[] {
  const out: LeafAllocation[] = []
  const walk = (
    spec: SubdivideSpec,
    parentArea: number,
    path: string,
  ): void => {
    spec.slices.forEach((slice, i) => {
      const a = parentArea * slice.fraction
      const p = `${path}.slices[${i}]`
      if (slice.kind) out.push({ kind: slice.kind, areaM2: a, path: p })
      else if (slice.subdivide) walk(slice.subdivide, a, `${p}.subdivide`)
    })
  }
  walk(template.rootSplit, totalAreaM2, 'rootSplit')
  return out
}

/** True if the polygon area is inside the template's authored band. */
export function isAreaInBand(template: UnitTemplate, areaM2: number): boolean {
  const { min, max } = template.areaRangeM2
  return areaM2 >= min && areaM2 <= max
}

/**
 * Asymmetric tolerance multipliers for the bisectUnit area-band gate.
 * 0.85 × min on the small side: real apartments don't shrink below their
 * type without becoming a different type (a "tiny 1BR" is a Studio).
 * 1.5 × max on the large side: generous floor plans routinely run 50%
 * above the nominal "1BR/2BR" without changing type. Symmetric
 * tolerances would either over-fail generous-but-real plans or
 * over-accept undersized ones.
 */
export const AREA_BAND_TOLERANCE_LOW = 0.85
export const AREA_BAND_TOLERANCE_HIGH = 1.5

/**
 * Effective gate bounds (the band stretched by the tolerance multipliers).
 * Outside these bounds, `bisectUnit` rejects the unit and the pipeline
 * surfaces a typed warning so the silent fallback doesn't hide an
 * upstream packing bug (Phase 3-7 Task 8 trail: 105×105 plot produced
 * 3 × 51.75 m strips, 155 m² each, way over the 4BR band).
 */
export function effectiveAreaBand(
  template: UnitTemplate,
): { lowerBound: number; upperBound: number } {
  return {
    lowerBound: template.areaRangeM2.min * AREA_BAND_TOLERANCE_LOW,
    upperBound: template.areaRangeM2.max * AREA_BAND_TOLERANCE_HIGH,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Minimum-viable-width computation (Phase 3-7 close-out, Fix A)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the smallest unit-width (m) for which `bisectUnit` can
 * satisfy `minRoomDimensionM` given a fixed strip depth, OR `null` if
 * the template inherently cannot bisect at that strip depth (no width
 * makes every leaf clear the floor).
 *
 * Why this exists: the unit packer used to derive width as
 * `targetArea / stripDepth`, ignoring whether the result still let the
 * type's template pack rooms. At `TARGET_STRIP_DEPTH_M = 9`, a 1BR
 * targeted at 55 m² came out 6.11 m wide; the OBB's long axis flipped
 * to the 9 m strip-perpendicular direction, the root `'along'` 12% slice
 * became `0.12 × 9 = 1.08 m wide`, and bisection rejected on the
 * hallway floor. Result: every "1BR" silently fell back to unit-shell.
 *
 * The packer now consults this function (via the `MIN_VIABLE_WIDTH_M`
 * cache in `units.ts`) to widen too-narrow units OR refuse to place
 * them with an explicit `unit_too_narrow_for_template` warning. The
 * corresponding regression test in `rooms-templates.test.ts` keeps the
 * static cache honest: every entry must be ≥ this value.
 *
 * Algorithm: walk the template tree at every plausible width and find
 * the smallest width whose entire leaf set clears the floor. We only
 * test discrete widths because OBB orientation flips at
 * `width = stripDepth` (the long axis swaps), so the function isn't
 * monotone — sweeping in 0.01 m steps from `stripDepth` upward catches
 * the flip exactly. If we sweep up to `MAX_SWEEP_M` without finding a
 * width that satisfies every leaf, return `null`.
 *
 * The function is intentionally simple/slow (O(sweep × leaves)). It's
 * called once at module-load by tests and never on the hot path.
 */
export function computeMinViableWidth(
  template: UnitTemplate,
  stripDepth: number,
): number | null {
  const MAX_SWEEP_M = 30 // any wider than this is a luxury suite, out of scope
  const STEP_M = 0.01
  const min = template.constraints.minRoomDimensionM
  // The OBB picks max(uw, stripDepth) as the long axis. So sweeping from
  // stripDepth upward covers the "uw is the long axis" regime; we also
  // check uw < stripDepth in a single representative pass below since
  // for those widths the long-axis fractions multiply stripDepth (a
  // constant), so feasibility doesn't depend on uw beyond a fixed
  // threshold — if it works for any uw ≤ stripDepth it works for all.
  for (let uw = stripDepth; uw <= MAX_SWEEP_M + 1e-9; uw += STEP_M) {
    if (allLeavesClearFloor(template, uw, stripDepth, min)) {
      // Round up to 0.01 m precision.
      return Math.ceil(uw * 100) / 100
    }
  }
  return null
}

/** Walk the template tree; return true iff every leaf rect ≥ minDim on both sides. */
function allLeavesClearFloor(
  template: UnitTemplate,
  uw: number,
  stripDepth: number,
  minDim: number,
): boolean {
  // OBB convention: long axis = max(uw, stripDepth). 'along' template axis
  // maps to the long axis; 'across' maps to the short.
  const longLen = Math.max(uw, stripDepth)
  const shortLen = Math.min(uw, stripDepth)
  let ok = true
  const walk = (
    spec: SubdivideSpec,
    rectAlong: number,
    rectAcross: number,
  ): void => {
    // applyBathroomClamp would mutate fractions if a bathroom slice is
    // oversized; for the floor-check we sweep all reasonable widths so
    // running the clamp here would be redundant — skip it. (Bathroom
    // clamp can only *shrink* a bathroom; if the unclamped layout
    // clears the floor, the clamped one does too.)
    for (const slice of spec.slices) {
      const fAlong = spec.axis === 'along' ? slice.fraction : 1
      const fAcross = spec.axis === 'across' ? slice.fraction : 1
      const childAlong = rectAlong * fAlong
      const childAcross = rectAcross * fAcross
      if (slice.subdivide) {
        walk(slice.subdivide, childAlong, childAcross)
      } else {
        // Leaf rect dimensions.
        if (
          childAlong < minDim - FRACTION_EPSILON ||
          childAcross < minDim - FRACTION_EPSILON
        ) {
          ok = false
        }
      }
    }
  }
  walk(template.rootSplit, longLen, shortLen)
  return ok
}

// ─────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────

const ALL_TEMPLATES: UnitTemplate[] = [
  STUDIO_TEMPLATE,
  ONE_BR_TEMPLATE,
  TWO_BR_TEMPLATE,
  THREE_BR_TEMPLATE,
  FOUR_BR_TEMPLATE,
]

// Module-load validation. If any template is malformed, importing this
// file throws — and any test that imports it fails fast with a clear
// path to the bad slice.
for (const t of ALL_TEMPLATES) validateTemplate(t)

const TEMPLATES_BY_TYPE: ReadonlyMap<string, UnitTemplate> = new Map(
  ALL_TEMPLATES.map((t) => [t.unitType, t]),
)

/**
 * Look up the template for a unit type. Returns `undefined` for
 * unknown types so the caller can decide between fallback behaviour
 * (unit-shell) and a hard error.
 */
export function getUnitTemplate(unitType: string): UnitTemplate | undefined {
  return TEMPLATES_BY_TYPE.get(unitType)
}

/** All registered templates, in insertion order. Read-only. */
export function listUnitTemplates(): readonly UnitTemplate[] {
  return ALL_TEMPLATES
}

/**
 * Helper for tests and downstream consumers: walk every leaf slice in
 * a template and yield its kind. Order matches a depth-first traversal
 * of the template tree, which is also the order the Task 4 packer
 * walks slices.
 */
export function leafKinds(t: UnitTemplate): RoomKind[] {
  const out: RoomKind[] = []
  const walk = (spec: SubdivideSpec) => {
    for (const s of spec.slices) {
      if (s.kind) out.push(s.kind)
      else if (s.subdivide) walk(s.subdivide)
    }
  }
  walk(t.rootSplit)
  return out
}
