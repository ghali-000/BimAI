// Phase 3-8 Task 4 — stair core placement.

import { describe, expect, it } from 'vitest'
import type { CorridorPlan } from '../types'
import { RESIDENTIAL_STAIR } from './stairs-templates'
import {
  computeStairReservation,
  pickEastEndIndex,
  placeStairCores,
} from './stairs'

const FOOTPRINT_30x18: [number, number][] = [
  [0, 0],
  [30, 0],
  [30, 18],
  [0, 18],
]

function makeCorridor(
  centerline: [[number, number], [number, number]],
  runLength: number,
): CorridorPlan {
  return {
    polygon: [],
    centerline,
    mode: 'double-loaded',
    runLength,
    stripDepth: 9,
  }
}

describe('pickEastEndIndex — east-bias deterministic tie-break', () => {
  it('returns 1 when centerline[1] has the larger x', () => {
    expect(pickEastEndIndex([[0, 0], [10, 0]])).toBe(1)
  })
  it('returns 0 when centerline[0] has the larger x', () => {
    expect(pickEastEndIndex([[10, 0], [0, 0]])).toBe(0)
  })
  it('breaks an x-tie by larger y', () => {
    expect(pickEastEndIndex([[5, 0], [5, 10]])).toBe(1)
    expect(pickEastEndIndex([[5, 10], [5, 0]])).toBe(0)
  })
})

describe('placeStairCores — basic shapes', () => {
  it('returns an empty array for single-floor buildings', () => {
    const cores = placeStairCores(
      {
        footprint: FOOTPRINT_30x18,
        floorCount: 1,
        floorHeight: 3,
        corridor: makeCorridor(
          [
            [2, 9],
            [28, 9],
          ],
          26,
        ),
      },
      RESIDENTIAL_STAIR,
    )
    expect(cores).toEqual([])
  })

  it('produces 1 core with N-1 flights for an N-floor building', () => {
    const cores = placeStairCores(
      {
        footprint: FOOTPRINT_30x18,
        floorCount: 5,
        floorHeight: 3,
        corridor: makeCorridor(
          [
            [2, 9],
            [28, 9],
          ],
          26,
        ),
      },
      RESIDENTIAL_STAIR,
    )
    expect(cores).toHaveLength(1)
    expect(cores[0]!.flights).toHaveLength(4)
    // First flight ground → level 1; last flight level 3 → level 4.
    expect(cores[0]!.flights[0]!.fromLevel).toBe(0)
    expect(cores[0]!.flights[0]!.toLevel).toBe(1)
    expect(cores[0]!.flights.at(-1)!.fromLevel).toBe(3)
    expect(cores[0]!.flights.at(-1)!.toLevel).toBe(4)
  })

  it('places shaft at corridor east end with the right size', () => {
    const cores = placeStairCores(
      {
        footprint: FOOTPRINT_30x18,
        floorCount: 2,
        floorHeight: 3,
        corridor: makeCorridor(
          [
            [2, 9],
            [28, 9],
          ],
          26,
        ),
      },
      RESIDENTIAL_STAIR,
    )
    expect(cores[0]!.width).toBe(2.5)
    expect(cores[0]!.depth).toBe(4.0)
    const xs = cores[0]!.shaftPolygon.map((p) => p[0])
    const ys = cores[0]!.shaftPolygon.map((p) => p[1])
    // East = (28, 9). Shaft east edge x = 28, west edge x = 24, y in [9-1.25, 9+1.25].
    expect(Math.max(...xs)).toBeCloseTo(28, 6)
    expect(Math.min(...xs)).toBeCloseTo(24, 6)
    expect(Math.max(...ys)).toBeCloseTo(10.25, 6)
    expect(Math.min(...ys)).toBeCloseTo(7.75, 6)
  })

  it('east-end pick is deterministic regardless of centerline order', () => {
    const fwd = placeStairCores(
      {
        footprint: FOOTPRINT_30x18,
        floorCount: 2,
        floorHeight: 3,
        corridor: makeCorridor(
          [
            [2, 9],
            [28, 9],
          ],
          26,
        ),
      },
      RESIDENTIAL_STAIR,
    )
    const rev = placeStairCores(
      {
        footprint: FOOTPRINT_30x18,
        floorCount: 2,
        floorHeight: 3,
        corridor: makeCorridor(
          [
            [28, 9],
            [2, 9],
          ],
          26,
        ),
      },
      RESIDENTIAL_STAIR,
    )
    // Same shaft footprint (max x = 28) regardless of centerline winding.
    const fwdMaxX = Math.max(...fwd[0]!.shaftPolygon.map((p) => p[0]))
    const revMaxX = Math.max(...rev[0]!.shaftPolygon.map((p) => p[0]))
    expect(fwdMaxX).toBeCloseTo(28, 6)
    expect(revMaxX).toBeCloseTo(28, 6)
  })

  it('returns [] when corridor is too short for the shaft depth', () => {
    const cores = placeStairCores(
      {
        footprint: [
          [0, 0],
          [3, 0],
          [3, 18],
          [0, 18],
        ],
        floorCount: 3,
        floorHeight: 3,
        corridor: makeCorridor(
          [
            [0.5, 9],
            [2.5, 9],
          ],
          2,
        ),
      },
      RESIDENTIAL_STAIR,
    )
    expect(cores).toEqual([])
  })
})

describe('placeStairCores — stable identifiers across regen', () => {
  it('produces the same stair id and wall ids for the same input', () => {
    const input = {
      footprint: FOOTPRINT_30x18,
      floorCount: 3,
      floorHeight: 3,
      corridor: makeCorridor(
        [
          [2, 9],
          [28, 9],
        ],
        26,
      ),
    }
    const a = placeStairCores(input, RESIDENTIAL_STAIR)
    const b = placeStairCores(input, RESIDENTIAL_STAIR)
    expect(a[0]!.id).toBe(b[0]!.id)
    expect(a[0]!.id).toMatch(/^stair_[0-9a-f]{12}$/)
    expect(a[0]!.enclosingWallIds).toHaveLength(4)
    for (const id of a[0]!.enclosingWallIds) {
      expect(id).toMatch(/^stair-shaft_[0-9a-f]{12}$/)
    }
    expect(a[0]!.enclosingWallIds).toEqual(b[0]!.enclosingWallIds)
  })
})

describe('placeStairCores — flight elevations have no drift', () => {
  it('flight n.startElevation === floor n elevation, no drift', () => {
    const cores = placeStairCores(
      {
        footprint: FOOTPRINT_30x18,
        floorCount: 4,
        floorHeight: 3,
        corridor: makeCorridor(
          [
            [2, 9],
            [28, 9],
          ],
          26,
        ),
      },
      RESIDENTIAL_STAIR,
    )
    const flights = cores[0]!.flights
    expect(flights).toHaveLength(3)
    for (let i = 0; i < flights.length; i++) {
      expect(flights[i]!.startElevation).toBeCloseTo(i * 3, 9)
      expect(flights[i]!.endElevation).toBeCloseTo((i + 1) * 3, 9)
      expect(
        flights[i]!.endElevation - flights[i]!.startElevation,
      ).toBeCloseTo(3, 9)
    }
  })
})

describe('computeStairReservation', () => {
  it('returns null for single-floor buildings', () => {
    const r = computeStairReservation(
      RESIDENTIAL_STAIR,
      1,
      makeCorridor(
        [
          [2, 9],
          [28, 9],
        ],
        26,
      ),
    )
    expect(r).toBeNull()
  })

  it('reserves an interval of length `template.depth` at +halfL when east = centerline[1]', () => {
    const r = computeStairReservation(
      RESIDENTIAL_STAIR,
      3,
      makeCorridor(
        [
          [2, 9],
          [28, 9],
        ],
        26,
      ),
    )
    expect(r).not.toBeNull()
    expect(r!.uMax).toBeCloseTo(13, 6) // halfL = 13
    expect(r!.uMin).toBeCloseTo(13 - 4, 6) // halfL - depth
    expect(r!.reason).toBe('stair-shaft')
  })

  it('reserves an interval at -halfL when east = centerline[0]', () => {
    const r = computeStairReservation(
      RESIDENTIAL_STAIR,
      3,
      makeCorridor(
        [
          [28, 9],
          [2, 9],
        ],
        26,
      ),
    )
    expect(r).not.toBeNull()
    expect(r!.uMin).toBeCloseTo(-13, 6)
    expect(r!.uMax).toBeCloseTo(-13 + 4, 6)
  })
})
