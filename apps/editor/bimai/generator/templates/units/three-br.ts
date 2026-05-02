// 3BR variants.
//
// Three variants. Phase 3-7's single-bath 3BR layout is preserved
// as the base; a corner-preferred dual-aspect variant takes a
// different bedroom arrangement; and a balcony variant attaches a
// wider 1.6 m terrace off the living room.
//
// 3BR is where en-suite-master + separate-WC variants would normally
// live (architechtures.com differentiates the master at this size).
// We're holding those for Phase 3-10 — see PROGRESS.md "What's
// stubbed" — because adding `'wc'` to RoomKind ripples through the
// emit pipeline. The selector therefore picks among layout shapes
// only, not among master-distinction shapes, in 3-9.

import { validateUnitVariantCatalog, type UnitVariantTemplate } from './types'

export const THREE_BR_VARIANTS: readonly UnitVariantTemplate[] = [
  {
    id: 'three-br-base',
    unitType: '3BR',
    label: '3BR with hallway + public + three bedrooms (38/31/31)',
    areaBand: { minM2: 90, maxM2: 130 },
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
            slices: [
              { fraction: 0.38, kind: 'bedroom' }, // master
              { fraction: 0.31, kind: 'bedroom' },
              { fraction: 0.31, kind: 'bedroom' },
            ],
          },
        },
      ],
    },
  },
  {
    id: 'three-br-corner-dual-aspect',
    unitType: '3BR',
    label: '3BR for corner units — dual-aspect master + two equal',
    // Wider band — corner units tend to be larger.
    areaBand: { minM2: 95, maxM2: 135 },
    preferredConditions: { corner: true, facadeEdges: 2 },
    hasBalcony: false,
    slices: {
      axis: 'along',
      slices: [
        {
          fraction: 0.13,
          subdivide: {
            axis: 'across',
            slices: [
              { fraction: 0.55, kind: 'hallway' },
              { fraction: 0.45, kind: 'bathroom' },
            ],
          },
        },
        {
          fraction: 0.4,
          subdivide: {
            axis: 'across',
            slices: [
              { fraction: 0.42, kind: 'kitchen' },
              { fraction: 0.58, kind: 'living' },
            ],
          },
        },
        {
          fraction: 0.47,
          subdivide: {
            axis: 'across',
            // Master 44% (wider, dual-aspect on the corner) +
            // two equal secondary bedrooms.
            slices: [
              { fraction: 0.44, kind: 'bedroom' }, // master, dual-aspect
              { fraction: 0.28, kind: 'bedroom' },
              { fraction: 0.28, kind: 'bedroom' },
            ],
          },
        },
      ],
    },
  },
  {
    id: 'three-br-balcony',
    unitType: '3BR',
    label: '3BR with three bedrooms + 1.6 m living-room balcony',
    areaBand: { minM2: 95, maxM2: 130 },
    preferredConditions: { facadeEdges: 1 },
    hasBalcony: true,
    balcony: { attachTo: 'living', depthM: 1.6 },
    slices: {
      // Indoor identical to three-br-base; balcony added outside.
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
              { fraction: 0.38, kind: 'bedroom' },
              { fraction: 0.31, kind: 'bedroom' },
              { fraction: 0.31, kind: 'bedroom' },
            ],
          },
        },
      ],
    },
  },
]

validateUnitVariantCatalog(THREE_BR_VARIANTS)
