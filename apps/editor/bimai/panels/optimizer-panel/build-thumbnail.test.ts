// Tests for the pure thumbnail-data builder. Covers paint order,
// colour-resolver injection, viewBox math (margins + tall/wide
// aspect ratios), and click-handler-relevant invariants.

import { describe, expect, it } from 'vitest'
import type { BuildingPlan, FloorPlan, UnitPlan } from '../../generator/types'
import { DEFAULT_PARAMS } from '../../optimizer/params'
import { buildThumbnail, type ThumbnailLayerKind } from './build-thumbnail'

function makeUnit(
  type: string,
  polygon: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ],
): UnitPlan {
  return {
    type,
    polygon,
    area: 4,
    facadeEdges: [],
    corridorEdges: [],
  }
}

function makeFloor(opts: Partial<FloorPlan> = {}): FloorPlan {
  return {
    level: 0,
    outline: [
      [0, 0],
      [10, 0],
      [10, 6],
      [0, 6],
    ],
    corridor: {
      polygon: [
        [0, 2],
        [10, 2],
        [10, 4],
        [0, 4],
      ],
      centerline: [
        [0, 3],
        [10, 3],
      ],
    },
    units: [makeUnit('Studio'), makeUnit('1BR')],
    ...opts,
  }
}

function makePlan(opts: Partial<BuildingPlan> = {}): BuildingPlan {
  return {
    generationId: 'gen_test',
    footprint: [
      [0, 0],
      [10, 0],
      [10, 6],
      [0, 6],
    ],
    floorCount: 1,
    floorHeight: 3,
    floors: [makeFloor()],
    warnings: [],
    params: DEFAULT_PARAMS,
    ...opts,
  }
}

const fakeColor = (type: string) => `color(${type})`

describe('buildThumbnail — paint order', () => {
  it('emits layers in z-order: footprint, corridor, unit*, wall', () => {
    const data = buildThumbnail(makePlan(), { unitColor: fakeColor })
    const kinds = data.layers.map((l) => l.kind)
    // First is footprint, last is wall, units sit between corridor
    // and wall.
    expect(kinds[0]).toBe<ThumbnailLayerKind>('footprint')
    expect(kinds.at(-1)).toBe<ThumbnailLayerKind>('wall')
    const corridorIdx = kinds.indexOf('corridor')
    const firstUnitIdx = kinds.indexOf('unit')
    const wallIdx = kinds.lastIndexOf('wall')
    expect(corridorIdx).toBeGreaterThan(0)
    expect(firstUnitIdx).toBeGreaterThan(corridorIdx)
    expect(wallIdx).toBeGreaterThan(firstUnitIdx)
  })

  it('paints one unit layer per unit, preserving plan order', () => {
    const data = buildThumbnail(
      makePlan({
        floors: [
          makeFloor({
            units: [
              makeUnit('Studio'),
              makeUnit('1BR'),
              makeUnit('2BR'),
            ],
          }),
        ],
      }),
      { unitColor: fakeColor },
    )
    const unitTypes = data.layers
      .filter((l) => l.kind === 'unit')
      .map((l) => l.unitType)
    expect(unitTypes).toEqual(['Studio', '1BR', '2BR'])
  })
})

describe('buildThumbnail — colour palette is injected, not inlined', () => {
  it('asks the resolver for every unit type', () => {
    const seen: string[] = []
    const tracking = (t: string) => {
      seen.push(t)
      return `color(${t})`
    }
    buildThumbnail(
      makePlan({
        floors: [
          makeFloor({ units: [makeUnit('Studio'), makeUnit('2BR')] }),
        ],
      }),
      { unitColor: tracking },
    )
    expect(seen).toEqual(['Studio', '2BR'])
  })

  it('uses the resolver result on the unit layer fill', () => {
    const data = buildThumbnail(
      makePlan({
        floors: [makeFloor({ units: [makeUnit('Studio')] })],
      }),
      { unitColor: () => '#ff00ff' },
    )
    const unitLayer = data.layers.find((l) => l.kind === 'unit')!
    expect(unitLayer.fill).toBe('#ff00ff')
  })
})

describe('buildThumbnail — viewBox math', () => {
  it('centers the building bbox + 10% margin by default', () => {
    // Wide plan: footprint x∈[0,10], y∈[0,6]. 10% margin → x∈[-1,11], y∈[-0.6,6.6].
    // viewBox tuple = "x y w h" = "-1 -0.6 12 7.2".
    const data = buildThumbnail(makePlan(), { unitColor: fakeColor })
    const parts = data.viewBox.split(' ').map(Number)
    const [x, y, w, h] = parts as [number, number, number, number]
    expect(x).toBeCloseTo(-1, 6)
    expect(y).toBeCloseTo(-0.6, 6)
    expect(w).toBeCloseTo(12, 6)
    expect(h).toBeCloseTo(7.2, 6)
  })

  it('respects a custom marginFrac', () => {
    const data = buildThumbnail(makePlan(), {
      unitColor: fakeColor,
      marginFrac: 0,
    })
    const parts = data.viewBox.split(' ').map(Number)
    const [x, y, w, h] = parts as [number, number, number, number]
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(w).toBeCloseTo(10, 6)
    expect(h).toBeCloseTo(6, 6)
  })

  it('handles tall buildings as cleanly as wide ones', () => {
    // Tall: 4 m wide × 20 m deep.
    const tall = makePlan({
      footprint: [
        [0, 0],
        [4, 0],
        [4, 20],
        [0, 20],
      ],
      floors: [
        makeFloor({
          outline: [
            [0, 0],
            [4, 0],
            [4, 20],
            [0, 20],
          ],
          corridor: {
            polygon: [
              [1, 0],
              [3, 0],
              [3, 20],
              [1, 20],
            ],
            centerline: [
              [2, 0],
              [2, 20],
            ],
          },
          units: [],
        }),
      ],
    })
    const data = buildThumbnail(tall, { unitColor: fakeColor })
    const parts = data.viewBox.split(' ').map(Number)
    const [x, y, w, h] = parts as [number, number, number, number]
    // 4×20 + 10% on each side → 4.8 × 24, origin (-0.4, -2).
    expect(w).toBeCloseTo(4.8, 6)
    expect(h).toBeCloseTo(24, 6)
    expect(x).toBeCloseTo(-0.4, 6)
    expect(y).toBeCloseTo(-2, 6)
    // The viewBox is *not* forced to 4:3. Aspect-ratio handling is
    // the *card* renderer's job (it sets preserveAspectRatio=meet
    // on a fixed 4:3 SVG element, letterboxing the tall building).
    expect(h).toBeGreaterThan(w)
  })
})

describe('buildThumbnail — wall layer', () => {
  it('produces a stroke-only wall path closed back to the start', () => {
    const data = buildThumbnail(makePlan(), { unitColor: fakeColor })
    const wall = data.layers.find((l) => l.kind === 'wall')!
    expect(wall.fill).toBeUndefined()
    expect(wall.stroke).toBeTruthy()
    expect(wall.strokeWidth).toBeGreaterThan(0)
    expect(wall.d.endsWith('Z')).toBe(true)
    // Wall traces the footprint, so first move-to should match the
    // first footprint vertex.
    expect(wall.d.startsWith('M 0 0')).toBe(true)
  })
})

describe('buildThumbnail — degenerate inputs', () => {
  it('throws when the plan has no floors (upstream bug)', () => {
    expect(() =>
      buildThumbnail(makePlan({ floors: [] }), { unitColor: fakeColor }),
    ).toThrow(/no floors/)
  })

  it('skips a corridor with fewer than 3 vertices but still emits other layers', () => {
    const data = buildThumbnail(
      makePlan({
        floors: [
          makeFloor({
            corridor: {
              polygon: [],
              centerline: [
                [0, 0],
                [1, 1],
              ],
            },
          }),
        ],
      }),
      { unitColor: fakeColor },
    )
    const kinds = data.layers.map((l) => l.kind)
    expect(kinds).not.toContain('corridor')
    expect(kinds[0]).toBe('footprint')
    expect(kinds.at(-1)).toBe('wall')
  })
})
