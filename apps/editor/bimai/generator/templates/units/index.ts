// Variant catalog entry point.
//
// `VARIANT_CATALOG` is the union of every per-unit-type variants
// array, validated as a whole at module-load time so cross-file
// id-uniqueness collisions surface as test failures rather than
// runtime selection bugs.
//
// Selection happens in `stages/variant-selection.ts` (Task 9). The
// catalog is exposed as a `readonly` array — consumers must not
// mutate it.

import { FOUR_BR_VARIANTS } from './four-br'
import { ONE_BR_VARIANTS } from './one-br'
import { STUDIO_VARIANTS } from './studio'
import { THREE_BR_VARIANTS } from './three-br'
import { TWO_BR_VARIANTS } from './two-br'
import {
  type UnitVariantCatalog,
  validateUnitVariantCatalog,
} from './types'

export const VARIANT_CATALOG: UnitVariantCatalog = [
  ...STUDIO_VARIANTS,
  ...ONE_BR_VARIANTS,
  ...TWO_BR_VARIANTS,
  ...THREE_BR_VARIANTS,
  ...FOUR_BR_VARIANTS,
]

// Whole-catalog validation (re-runs per-entry validation as a side
// benefit — duplicates the per-file calls but is cheap and pins the
// global id-uniqueness invariant).
validateUnitVariantCatalog(VARIANT_CATALOG)

export {
  FOUR_BR_VARIANTS,
  ONE_BR_VARIANTS,
  STUDIO_VARIANTS,
  THREE_BR_VARIANTS,
  TWO_BR_VARIANTS,
}
export * from './types'
