// 4BR variants.
//
// Two variants — at 4BR scale, the layout space narrows because the
// master + en-suite + three secondary configuration is the dominant
// pattern across EU mid-rise. Phase 3-7's en-suite layout is the
// base; a balcony variant adds a 1.8 m terrace off the living room
// (luxury 4BR units are large enough to absorb the depth without
// clipping the living rect's habitability).
//
// The Phase 3-7 close-out pinned the en-suite bath fraction at 0.17
// (raised from 0.12) so the across-dim clears the 1.5 m floor at
// `TARGET_STRIP_DEPTH_M = 9`. Both variants here keep that fix.

import { validateUnitVariantCatalog, type UnitVariantTemplate } from './types'

export const FOUR_BR_VARIANTS: readonly UnitVariantTemplate[] = [
  {
    id: 'four-br-master-ensuite',
    unitType: '4BR',
    label: '4BR with en-suite master + three secondary bedrooms',
    areaBand: { minM2: 120, maxM2: 180 },
    preferredConditions: { facadeEdges: 1 },
    hasBalcony: false,
    slices: {
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
            // master 21%, en-suite 17%, bed-2 21%, bed-3 20%, bed-4 21% = 1.0
            // En-suite at 0.17 clears 1.5 m floor at 9 m strip depth.
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
  },
  {
    id: 'four-br-master-ensuite-balcony',
    unitType: '4BR',
    label: '4BR en-suite master + 1.8 m living-room balcony',
    areaBand: { minM2: 130, maxM2: 180 },
    preferredConditions: { facadeEdges: 1 },
    hasBalcony: true,
    balcony: { attachTo: 'living', depthM: 1.8 },
    slices: {
      // Indoor identical to four-br-master-ensuite; balcony added
      // outside the unit polygon.
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
              { fraction: 0.21, kind: 'bedroom' },
              { fraction: 0.17, kind: 'bathroom' },
              { fraction: 0.21, kind: 'bedroom' },
              { fraction: 0.2, kind: 'bedroom' },
              { fraction: 0.21, kind: 'bedroom' },
            ],
          },
        },
      ],
    },
  },
]

validateUnitVariantCatalog(FOUR_BR_VARIANTS)
