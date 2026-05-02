// Studio variants.
//
// Studios at 30-50 m² are too small for meaningful subdivision —
// architechtures.com itself ships them as bath strip + open living.
// Two variants: the Phase 3-7 bath-along-short-end layout, plus a
// kitchenette-corner alternate that hugs the bath against the
// corridor wall and parks the kitchen counter in a corner.
//
// No balcony variant for Studio: the unit is too narrow at the
// bottom of the band for a 1.5 m balcony projection without
// compromising the living rect's habitability.

import { validateUnitVariantCatalog, type UnitVariantTemplate } from './types'

export const STUDIO_VARIANTS: readonly UnitVariantTemplate[] = [
  {
    id: 'studio-bath-end',
    unitType: 'Studio',
    label: 'Studio with bath at one end',
    areaBand: { minM2: 30, maxM2: 50 },
    preferredConditions: {},
    hasBalcony: false,
    slices: {
      // Mirrors the Phase 3-7 STUDIO_TEMPLATE so the existing
      // rooms-packing test corpus continues to pass when the selector
      // routes Studios through this variant.
      axis: 'along',
      slices: [
        { fraction: 0.15, kind: 'bathroom' },
        { fraction: 0.85, kind: 'living' },
      ],
    },
  },
  {
    id: 'studio-kitchenette-corner',
    unitType: 'Studio',
    label: 'Studio with bath at one end, kitchen tucked at the other',
    // Kitchen-as-leaf only makes sense above ~38 m² — below that the
    // rectangle is too narrow for the kitchen + bath + living split.
    areaBand: { minM2: 38, maxM2: 50 },
    preferredConditions: {},
    hasBalcony: false,
    slices: {
      axis: 'along',
      slices: [
        { fraction: 0.15, kind: 'bathroom' },
        { fraction: 0.65, kind: 'living' },
        { fraction: 0.2, kind: 'kitchen' },
      ],
    },
  },
]

validateUnitVariantCatalog(STUDIO_VARIANTS)
