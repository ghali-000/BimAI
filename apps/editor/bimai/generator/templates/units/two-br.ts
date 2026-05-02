// 2BR variants.
//
// Three variants:
//   - 'two-br-master-secondary': Phase 3-7's master + secondary
//     bedroom layout (55 / 45 split). Preserved verbatim so the
//     existing fixtures continue to pass for non-corner units.
//   - 'two-br-equal-shared-bath': symmetrical 50 / 50 bedrooms with
//     a wider shared bathroom strip. Cleaner reading on plates with
//     square aspect ratios.
//   - 'two-br-master-secondary-balcony': base layout + balcony off
//     the living room. Eligible when the user opts into balconies
//     and the unit has at least one facade edge.

import { validateUnitVariantCatalog, type UnitVariantTemplate } from './types'

export const TWO_BR_VARIANTS: readonly UnitVariantTemplate[] = [
  {
    id: 'two-br-master-secondary',
    unitType: '2BR',
    label: '2BR with master + secondary bedroom (55/45)',
    areaBand: { minM2: 70, maxM2: 100 },
    preferredConditions: { facadeEdges: 1 },
    hasBalcony: false,
    slices: {
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
            slices: [
              { fraction: 0.55, kind: 'bedroom' }, // master
              { fraction: 0.45, kind: 'bedroom' }, // secondary
            ],
          },
        },
      ],
    },
  },
  {
    id: 'two-br-equal-shared-bath',
    unitType: '2BR',
    label: '2BR with equal bedrooms (50/50) + wider shared bath',
    areaBand: { minM2: 70, maxM2: 95 },
    preferredConditions: { facadeEdges: 1 },
    hasBalcony: false,
    slices: {
      axis: 'along',
      slices: [
        {
          // Wider service strip to make the shared bath usable for two.
          fraction: 0.18,
          subdivide: {
            axis: 'across',
            slices: [
              { fraction: 0.5, kind: 'hallway' },
              { fraction: 0.5, kind: 'bathroom' },
            ],
          },
        },
        {
          fraction: 0.44,
          subdivide: {
            axis: 'across',
            slices: [
              { fraction: 0.45, kind: 'kitchen' },
              { fraction: 0.55, kind: 'living' },
            ],
          },
        },
        {
          fraction: 0.38,
          subdivide: {
            axis: 'across',
            // Equal-split bedrooms; reads as "two same-size bedrooms"
            // typical of mid-band 2BR Spanish / French flats.
            slices: [
              { fraction: 0.5, kind: 'bedroom' },
              { fraction: 0.5, kind: 'bedroom' },
            ],
          },
        },
      ],
    },
  },
  {
    id: 'two-br-master-secondary-balcony',
    unitType: '2BR',
    label: '2BR master + secondary + living-room balcony',
    areaBand: { minM2: 75, maxM2: 100 },
    preferredConditions: { facadeEdges: 1 },
    hasBalcony: true,
    balcony: { attachTo: 'living', depthM: 1.5 },
    slices: {
      // Same indoor layout as the master-secondary base; the balcony
      // is projected outside the unit polygon by the emitter.
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
            slices: [
              { fraction: 0.55, kind: 'bedroom' },
              { fraction: 0.45, kind: 'bedroom' },
            ],
          },
        },
      ],
    },
  },
]

validateUnitVariantCatalog(TWO_BR_VARIANTS)
