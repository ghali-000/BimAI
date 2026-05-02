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
  it('produces the positional stair id and wall ids; both stable across regen', () => {
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
    // Phase 3-9 positional id format: `stair-core-{N}`.
    expect(a[0]!.id).toBe('stair_core_0')
    expect(a[0]!.id).toBe(b[0]!.id)
    expect(a[0]!.enclosingWallIds).toHaveLength(4)
    for (const id of a[0]!.enclosingWallIds) {
      // Wall id format: `stair-core-{N}/wall-<12hex>`. Hash bits stay
      // canonical-edge-deterministic; only the prefix changed.
      expect(id).toMatch(/^stair_core_0\/wall-[0-9a-f]{12}$/)
    }
    expect(a[0]!.enclosingWallIds).toEqual(b[0]!.enclosingWallIds)
  })
})

// Phase 3-9 Task 5/6 — multi-stair-core for fire egress.
//
// End-plus-central strategy: `corridorLength > FIRE_EGRESS_THRESHOLD_M`
// (default 30 m, strict >) flips a sub-threshold single-core building
// into a 2-core building. End core is positional index 0; central
// core is positional index 1.
describe('placeStairCores — multi-core (Phase 3-9)', () => {
  // Build a corridor of arbitrary `runLength` along the world x-axis,
  // centred at world (15, 9).
  function corridorOfLength(runLength: number): CorridorPlan {
    return makeCorridor(
      [
        [15 - runLength / 2, 9],
        [15 + runLength / 2, 9],
      ],
      runLength,
    )
  }

  function makeInput(runLength: number) {
    return {
      footprint: [
        [0, 0],
        [runLength + 4, 0],
        [runLength + 4, 18],
        [0, 18],
      ] as [number, number][],
      floorCount: 3,
      floorHeight: 3,
      corridor: corridorOfLength(runLength),
    }
  }

  it('1 core when corridor length is exactly at the threshold (boundary, strict >)', () => {
    const cores = placeStairCores(makeInput(30.0), RESIDENTIAL_STAIR)
    expect(cores).toHaveLength(1)
    expect(cores[0]!.id).toBe('stair_core_0')
  })

  it('2 cores when corridor length is just above the threshold', () => {
    const cores = placeStairCores(makeInput(30.01), RESIDENTIAL_STAIR)
    expect(cores).toHaveLength(2)
    expect(cores[0]!.id).toBe('stair_core_0')
    expect(cores[1]!.id).toBe('stair_core_1')
  })

  it('1 core when corridor length is just below the threshold', () => {
    const cores = placeStairCores(makeInput(29.99), RESIDENTIAL_STAIR)
    expect(cores).toHaveLength(1)
  })

  it('central core is centred on the corridor midpoint, ±depth/2 along the run-axis', () => {
    const cores = placeStairCores(makeInput(50), RESIDENTIAL_STAIR)
    expect(cores).toHaveLength(2)
    const central = cores[1]!
    // RESIDENTIAL_STAIR.depth = 4. Centred on world (15, 9).
    const xs = central.shaftPolygon.map((p) => p[0])
    const ys = central.shaftPolygon.map((p) => p[1])
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(15, 6)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 6) // template.depth
    // Width perpendicular to corridor run-axis = template.width = 2.5.
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2.5, 6)
  })

  it('end core at index 0 keeps Phase 3-8 positioning (east-end edge alignment)', () => {
    const cores = placeStairCores(makeInput(50), RESIDENTIAL_STAIR)
    const end = cores[0]!
    const xs = end.shaftPolygon.map((p) => p[0])
    // Corridor east end at runLength=50, centre x=15 → east x=40.
    // End core's east edge = 40; west edge = 36 (depth=4).
    expect(Math.max(...xs)).toBeCloseTo(40, 6)
    expect(Math.min(...xs)).toBeCloseTo(36, 6)
  })

  it('central core has the same template metrics as the end core (only position differs)', () => {
    const [end, central] = placeStairCores(makeInput(50), RESIDENTIAL_STAIR)
    expect(central!.width).toBe(end!.width)
    expect(central!.depth).toBe(end!.depth)
    expect(central!.flights).toHaveLength(end!.flights.length)
    expect(central!.enclosingWallIds).toHaveLength(4)
  })

  it('end + central cores have disjoint shaft polygons', () => {
    const [end, central] = placeStairCores(makeInput(50), RESIDENTIAL_STAIR)
    const endXs = end!.shaftPolygon.map((p) => p[0])
    const centralXs = central!.shaftPolygon.map((p) => p[0])
    expect(Math.min(...endXs)).toBeGreaterThan(Math.max(...centralXs))
  })

  it('both cores have stable, positional ids across regen', () => {
    const a = placeStairCores(makeInput(50), RESIDENTIAL_STAIR)
    const b = placeStairCores(makeInput(50), RESIDENTIAL_STAIR)
    expect(a[0]!.id).toBe('stair_core_0')
    expect(a[1]!.id).toBe('stair_core_1')
    expect(a[0]!.enclosingWallIds).toEqual(b[0]!.enclosingWallIds)
    expect(a[1]!.enclosingWallIds).toEqual(b[1]!.enclosingWallIds)
    // Cross-core wall ids are disjoint (different hash inputs).
    const aSet = new Set(a[0]!.enclosingWallIds)
    for (const id of a[1]!.enclosingWallIds) {
      expect(aSet.has(id)).toBe(false)
      expect(id).toMatch(/^stair_core_1\/wall-[0-9a-f]{12}$/)
    }
  })

  it('honours the fireEgressThresholdM option override', () => {
    // 25 m corridor, threshold raised to 50 → still single core.
    const cores = placeStairCores(
      makeInput(40),
      RESIDENTIAL_STAIR,
      'end-plus-central',
      { fireEgressThresholdM: 50 },
    )
    expect(cores).toHaveLength(1)
    // Same corridor, threshold lowered to 20 → two cores.
    const cores2 = placeStairCores(
      makeInput(25),
      RESIDENTIAL_STAIR,
      'end-plus-central',
      { fireEgressThresholdM: 20 },
    )
    expect(cores2).toHaveLength(2)
  })

  it("'end-of-corridor' strategy clamps to single core regardless of length", () => {
    const cores = placeStairCores(
      makeInput(50),
      RESIDENTIAL_STAIR,
      'end-of-corridor',
    )
    expect(cores).toHaveLength(1)
    expect(cores[0]!.id).toBe('stair_core_0')
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
