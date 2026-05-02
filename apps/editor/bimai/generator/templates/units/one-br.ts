// 1BR variants.
//
// Three variants:
//   - 'one-br-base': Phase 3-7's hallway-strip + public + bedroom
//     layout (preserved verbatim so existing rooms-packing fixtures
//     continue to pass).
//   - 'one-br-galley-kitchen': bumps the kitchen against the hallway
//     strip (galley arrangement) for narrower units.
//   - 'one-br-balcony': base layout with a 1.4 m balcony projecting
//     off the living room. Eligible only when the user opts into
//     balconies and the unit has at least one facade edge — gating
//     happens in the selector at run time.

import { validateUnitVariantCatalog, type UnitVariantTemplate } from './types'

export const ONE_BR_VARIANTS: readonly UnitVariantTemplate[] = [
  {
    id: 'one-br-base',
    unitType: '1BR',
    label: '1BR with hallway strip + public + bedroom',
    areaBand: { minM2: 45, maxM2: 70 },
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
  },
  {
    id: 'one-br-galley-kitchen',
    unitType: '1BR',
    label: '1BR with galley kitchen against the hallway',
    areaBand: { minM2: 45, maxM2: 65 },
    preferredConditions: { facadeEdges: 1 },
    hasBalcony: false,
    slices: {
      axis: 'along',
      slices: [
        {
          fraction: 0.16,
          subdivide: {
            axis: 'across',
            slices: [
              { fraction: 0.55, kind: 'hallway' },
              { fraction: 0.45, kind: 'bathroom' },
            ],
          },
        },
        {
          fraction: 0.18,
          // Galley kitchen runs the full across dimension — single leaf,
          // no subdivide. Kitchen-only strip immediately after the
          // hallway echoes the architechtures.com 'narrow 1BR' pattern.
          kind: 'kitchen',
        },
        { fraction: 0.32, kind: 'living' },
        { fraction: 0.34, kind: 'bedroom' },
      ],
    },
  },
  {
    id: 'one-br-balcony',
    unitType: '1BR',
    label: '1BR with hallway + public + bedroom + living-room balcony',
    // Tighten the lower band — at 45 m² there's not enough living
    // depth to give 1.4 m to a balcony without the room feeling
    // pinched.
    areaBand: { minM2: 52, maxM2: 70 },
    preferredConditions: { facadeEdges: 1 },
    hasBalcony: true,
    balcony: { attachTo: 'living', depthM: 1.4 },
    slices: {
      // Same interior layout as one-br-base — the balcony is appended
      // outside the unit polygon by the emitter, so the indoor slice
      // tree doesn't change.
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
  },
]

validateUnitVariantCatalog(ONE_BR_VARIANTS)
