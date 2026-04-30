// Corner-offset door positioning tests (Phase 3-7, Task 8).
//
// Locks the math in `pickDoorPosition`:
//   - East-bias: hallway centroid east of midpoint ⇒ door 0.5 m from
//     the east endpoint, offset toward west.
//   - West-bias: symmetric.
//   - Tie (centroid on perpendicular bisector): pick the east endpoint
//     (deterministic).
//   - Short wall (< 1.9 m): fall back to midpoint.
//
// Also asserts the duplicated DOOR_CLEAR_WIDTH_M stays in sync with
// emit.ts's DEFAULT_DOOR_WIDTH_M (the layering-inversion guard mentioned
// in the rooms-doors.ts module header).

import { describe, expect, it } from 'vitest'
import {
  DOOR_CLEAR_WIDTH_M,
  DOOR_CORNER_OFFSET_M,
  MIN_PARTITION_LENGTH_FOR_CORNER_OFFSET_M,
  pickDoorPosition,
  placeRoomDoors,
} from './rooms-doors'
import { DEFAULT_DOOR_WIDTH_M } from '../emit'
import type { RoomPlan } from '../types'

const EPS = 1e-9

describe('pickDoorPosition (corner-offset rule)', () => {
  // Horizontal partition along y=0 from (0,0) to (4,0). Midpoint x=2.
  const a: [number, number] = [0, 0]
  const b: [number, number] = [4, 0]

  it('places the door 0.5 m from the east endpoint when hallway is east of midpoint', () => {
    // Hallway centroid east of midpoint ⇒ east endpoint (b) is closer ⇒
    // offset 0.5 m back toward west (a) ⇒ x = 4 - 0.5 = 3.5.
    const p = pickDoorPosition(a, b, [3, 0])
    expect(p[0]).toBeCloseTo(3.5, 9)
    expect(p[1]).toBeCloseTo(0, 9)
  })

  it('places the door 0.5 m from the west endpoint when hallway is west of midpoint', () => {
    // Hallway centroid west ⇒ west endpoint (a) is closer ⇒ offset
    // 0.5 m toward east ⇒ x = 0 + 0.5 = 0.5.
    const p = pickDoorPosition(a, b, [1, 0])
    expect(p[0]).toBeCloseTo(0.5, 9)
    expect(p[1]).toBeCloseTo(0, 9)
  })

  it('breaks ties by picking the east endpoint (deterministic)', () => {
    // Hallway centroid exactly on the partition's perpendicular
    // bisector ⇒ both endpoints equidistant. Tie-break picks the east
    // endpoint (b at x=4), so the door sits 0.5 m west of b.
    const p = pickDoorPosition(a, b, [2, 5])
    expect(p[0]).toBeCloseTo(3.5, 9)
    expect(p[1]).toBeCloseTo(0, 9)
  })

  it('falls back to midpoint on partitions shorter than the corner-offset rule supports', () => {
    // 1.5 m < MIN_PARTITION_LENGTH_FOR_CORNER_OFFSET_M (1.9 m).
    const shortA: [number, number] = [0, 0]
    const shortB: [number, number] = [1.5, 0]
    const p = pickDoorPosition(shortA, shortB, [1, 5])
    expect(p[0]).toBeCloseTo(0.75, 9)
    expect(p[1]).toBeCloseTo(0, 9)
  })

  it('lands on the partition (no perpendicular drift) for vertical walls', () => {
    // Vertical partition x=0, y∈[0,4]; centroid east at (5,1).
    // Closer endpoint: (0,0). Offset 0.5 m along the partition toward (0,4).
    const p = pickDoorPosition([0, 0], [0, 4], [5, 1])
    expect(p[0]).toBeCloseTo(0, 9)
    expect(p[1]).toBeCloseTo(0.5, 9)
  })
})

describe('rooms-doors module constants', () => {
  it('keeps DOOR_CLEAR_WIDTH_M in sync with emit.ts DEFAULT_DOOR_WIDTH_M', () => {
    // Layering-inversion guard: stages mustn't import emit, so we
    // duplicate the constant. This test fails if they drift.
    expect(DOOR_CLEAR_WIDTH_M).toBe(DEFAULT_DOOR_WIDTH_M)
  })

  it('derives MIN_PARTITION_LENGTH_FOR_CORNER_OFFSET_M from offset + width', () => {
    expect(MIN_PARTITION_LENGTH_FOR_CORNER_OFFSET_M).toBeCloseTo(
      2 * DOOR_CORNER_OFFSET_M + DOOR_CLEAR_WIDTH_M,
      9,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// placeRoomDoors — single-owner dedup behaviour
// ─────────────────────────────────────────────────────────────────────

function room(
  kind: RoomPlan['kind'],
  polygon: [number, number][],
  walls: RoomPlan['walls'],
): RoomPlan {
  return {
    kind,
    polygon,
    area: 0,
    walls,
    doors: [],
    windowAccess: false,
  }
}

describe('placeRoomDoors (single-owner dedup)', () => {
  it('attaches the door to the non-hallway side only; hallway stays empty', () => {
    // Two rectangles sharing the partition x=2, y∈[0,3]. Hallway on
    // the east, bedroom on the west. Partition length = 3 m, well
    // above the short-wall fallback threshold.
    const partition = {
      id: 'partition_test',
      from: [2, 0] as [number, number],
      to: [2, 3] as [number, number],
      isExterior: false,
    }
    const bedroom = room(
      'bedroom',
      [
        [0, 0],
        [2, 0],
        [2, 3],
        [0, 3],
      ],
      [
        {
          id: 'w_bed_s',
          from: [0, 0],
          to: [2, 0],
          isExterior: true,
        },
        partition,
        {
          id: 'w_bed_n',
          from: [2, 3],
          to: [0, 3],
          isExterior: true,
        },
        {
          id: 'w_bed_w',
          from: [0, 3],
          to: [0, 0],
          isExterior: true,
        },
      ],
    )
    const hallway = room(
      'hallway',
      [
        [2, 0],
        [4, 0],
        [4, 3],
        [2, 3],
      ],
      [
        {
          id: 'w_hall_s',
          from: [2, 0],
          to: [4, 0],
          isExterior: true,
        },
        {
          id: 'w_hall_e',
          from: [4, 0],
          to: [4, 3],
          isExterior: true,
        },
        {
          id: 'w_hall_n',
          from: [4, 3],
          to: [2, 3],
          isExterior: true,
        },
        partition,
      ],
    )

    const placed = placeRoomDoors([bedroom, hallway])
    expect(placed).toHaveLength(1)
    expect(hallway.doors).toEqual([])
    expect(bedroom.doors).toHaveLength(1)
    const d = bedroom.doors[0]!
    expect(d.from).toBe('hallway')
    expect(d.to).toBe('bedroom')
    expect(d.wallId).toBe('partition_test')
    // Hallway centroid is at (3, 1.5); the partition's south endpoint
    // (2, 0) and north endpoint (2, 3) are equidistant from (3, 1.5)
    // (both √(1+2.25)). Tie-break picks the east endpoint by x — but
    // here both endpoints share x=2, so the y-tiebreak picks the
    // larger-y endpoint (2, 3). Door sits 0.5 m south of it ⇒ (2, 2.5).
    expect(d.position[0]).toBeCloseTo(2, EPS)
    expect(d.position[1]).toBeCloseTo(2.5, EPS)
  })

  it('skips partitions where neither side is a hallway', () => {
    const partition = {
      id: 'partition_no_hall',
      from: [2, 0] as [number, number],
      to: [2, 3] as [number, number],
      isExterior: false,
    }
    const bedroom = room(
      'bedroom',
      [
        [0, 0],
        [2, 0],
        [2, 3],
        [0, 3],
      ],
      [partition],
    )
    const kitchen = room(
      'kitchen',
      [
        [2, 0],
        [4, 0],
        [4, 3],
        [2, 3],
      ],
      [partition],
    )
    const placed = placeRoomDoors([bedroom, kitchen])
    expect(placed).toEqual([])
    expect(bedroom.doors).toEqual([])
    expect(kitchen.doors).toEqual([])
  })

  it('returns doors sorted by wallId for deterministic test ordering', () => {
    const partA = {
      id: 'partition_aaa',
      from: [2, 0] as [number, number],
      to: [2, 3] as [number, number],
      isExterior: false,
    }
    const partB = {
      id: 'partition_bbb',
      from: [4, 0] as [number, number],
      to: [4, 3] as [number, number],
      isExterior: false,
    }
    const bedroom = room(
      'bedroom',
      [
        [0, 0],
        [2, 0],
        [2, 3],
        [0, 3],
      ],
      [partA],
    )
    const hallway = room(
      'hallway',
      [
        [2, 0],
        [4, 0],
        [4, 3],
        [2, 3],
      ],
      [partA, partB],
    )
    const bathroom = room(
      'bathroom',
      [
        [4, 0],
        [6, 0],
        [6, 3],
        [4, 3],
      ],
      [partB],
    )
    const placed = placeRoomDoors([bedroom, hallway, bathroom])
    expect(placed.map((d) => d.wallId)).toEqual([
      'partition_aaa',
      'partition_bbb',
    ])
  })
})
