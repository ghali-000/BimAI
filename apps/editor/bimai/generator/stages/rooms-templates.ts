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

export interface UnitTemplate {
  /** Matches `UnitMixEntry.type`: "Studio", "1BR", "2BR", "3BR", "4BR". */
  unitType: string
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
          // master 24%, bath 12%, bed-2 22%, bed-3 21%, bed-4 21% = 1.0
          slices: [
            { fraction: 0.24, kind: 'bedroom' }, // master
            { fraction: 0.12, kind: 'bathroom' }, // en-suite
            { fraction: 0.22, kind: 'bedroom' },
            { fraction: 0.21, kind: 'bedroom' },
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
  validateSpec(t.rootSplit, t.unitType, 'rootSplit')
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
