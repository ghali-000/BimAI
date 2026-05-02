// Phase 3-9 Task 12 — elevator placement tests.
//
// Pin: floor-count threshold, single-elevator-per-building cap,
// shaft geometry (1.5×1.5 m adjacent to stair_core_0), and
// determinism across regen. The IFC mapping (ZoneNode → IfcTransport-
// Element) is exercised separately in `ifc/write.test.ts`.

import { describe, expect, it } from 'vitest'
import type { StairCorePlan } from '../types'
import {
  ELEVATOR_MIN_FLOORS,
  ELEVATOR_SHAFT_DEPTH_M,
  ELEVATOR_SHAFT_WIDTH_M,
  placeElevators,
  willPlaceElevator,
} from './elevators'

function makePrimaryStair(): StairCorePlan {
  // Mirrors the production shape produced by `placeStairCores` for
  // an east-end-of-corridor stair. The shaft polygon spans
  // u ∈ [22, 26], v ∈ [-1.25, 1.25] in world coords centred on the
  // x-axis corridor at y=0.
  return {
    id: 'stair_core_0',
    position: [22, -1.25],
    width: 2.5,
    depth: 4,
    flights: [],
    shaftPolygon: [
      [22, -1.25],
      [26, -1.25],
      [26, 1.25],
      [22, 1.25],
    ],
    enclosingWallIds: [
      'stair_core_0/wall-aaaaaaaaaaaa',
      'stair_core_0/wall-bbbbbbbbbbbb',
      'stair_core_0/wall-cccccccccccc',
      'stair_core_0/wall-dddddddddddd',
    ],
  }
}

// ── willPlaceElevator + threshold ───────────────────────────────────────────

describe('willPlaceElevator + ELEVATOR_MIN_FLOORS', () => {
  it('returns false below the 3-floor threshold', () => {
    expect(willPlaceElevator(1)).toBe(false)
    expect(willPlaceElevator(2)).toBe(false)
  })
  it('returns true at and above 3 floors', () => {
    expect(willPlaceElevator(3)).toBe(true)
    expect(willPlaceElevator(5)).toBe(true)
  })
  it('threshold constant matches the brief (>2 floors)', () => {
    expect(ELEVATOR_MIN_FLOORS).toBe(3)
  })
})

// ── placeElevators basic shapes ─────────────────────────────────────────────

describe('placeElevators — basic shapes', () => {
  it('emits 0 elevators for 1-floor buildings', () => {
    const out = placeElevators({
      floorCount: 1,
      floorHeight: 3,
      stairs: [makePrimaryStair()],
    })
    expect(out).toEqual([])
  })

  it('emits 0 elevators for 2-floor buildings (below threshold)', () => {
    const out = placeElevators({
      floorCount: 2,
      floorHeight: 3,
      stairs: [makePrimaryStair()],
    })
    expect(out).toEqual([])
  })

  it('emits 0 elevators when there is no primary stair core (degenerate)', () => {
    const out = placeElevators({
      floorCount: 5,
      floorHeight: 3,
      stairs: [],
    })
    expect(out).toEqual([])
  })

  it('emits 1 elevator for 3-floor buildings (Phase 3-9 cap)', () => {
    const out = placeElevators({
      floorCount: 3,
      floorHeight: 3,
      stairs: [makePrimaryStair()],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('elevator_0')
    expect(out[0]!.stairId).toBe('stair_core_0')
  })

  it('emits 1 elevator regardless of floorCount (no multi-elevator in 3-9)', () => {
    const out = placeElevators({
      floorCount: 12,
      floorHeight: 3,
      stairs: [makePrimaryStair()],
    })
    expect(out).toHaveLength(1)
  })
})

// ── geometry ────────────────────────────────────────────────────────────────

describe('placeElevators — shaft geometry', () => {
  it('shaft is 1.5 × 1.5 m', () => {
    const [el] = placeElevators({
      floorCount: 5,
      floorHeight: 3,
      stairs: [makePrimaryStair()],
    })
    expect(el!.width).toBe(ELEVATOR_SHAFT_WIDTH_M)
    expect(el!.depth).toBe(ELEVATOR_SHAFT_DEPTH_M)
    expect(el!.shaftPolygon).toHaveLength(4)
    const xs = el!.shaftPolygon.map((p) => p[0])
    const ys = el!.shaftPolygon.map((p) => p[1])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(
      ELEVATOR_SHAFT_DEPTH_M,
      6,
    )
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(
      ELEVATOR_SHAFT_WIDTH_M,
      6,
    )
  })

  it('shaft sits immediately west of the primary stair core (sharing the stair west edge midpoint)', () => {
    const stair = makePrimaryStair()
    const [el] = placeElevators({
      floorCount: 4,
      floorHeight: 3,
      stairs: [stair],
    })
    // Stair shaft west edge x = 22; elevator east edge should equal 22.
    const xs = el!.shaftPolygon.map((p) => p[0])
    expect(Math.max(...xs)).toBeCloseTo(22, 6)
    // Elevator west edge at 22 - 1.5 = 20.5.
    expect(Math.min(...xs)).toBeCloseTo(20.5, 6)
    // Centred on corridor centerline (y = 0): ys span [-0.75, +0.75].
    const ys = el!.shaftPolygon.map((p) => p[1])
    expect(Math.max(...ys)).toBeCloseTo(0.75, 6)
    expect(Math.min(...ys)).toBeCloseTo(-0.75, 6)
  })

  it('emits 4 enclosingWallIds in the canonical-edge format', () => {
    const [el] = placeElevators({
      floorCount: 4,
      floorHeight: 3,
      stairs: [makePrimaryStair()],
    })
    expect(el!.enclosingWallIds).toHaveLength(4)
    for (const id of el!.enclosingWallIds) {
      expect(id).toMatch(/^elevator_0\/wall-[0-9a-f]{12}$/)
    }
  })

  it('doorEdgeIndex points at a real polygon edge (0..3)', () => {
    const [el] = placeElevators({
      floorCount: 4,
      floorHeight: 3,
      stairs: [makePrimaryStair()],
    })
    expect(el!.doorEdgeIndex).toBeGreaterThanOrEqual(0)
    expect(el!.doorEdgeIndex).toBeLessThan(el!.shaftPolygon.length)
  })
})

// ── determinism ─────────────────────────────────────────────────────────────

describe('placeElevators — determinism across regen', () => {
  it('produces byte-identical id, polygon, and wall ids for the same input', () => {
    const stair = makePrimaryStair()
    const a = placeElevators({ floorCount: 5, floorHeight: 3, stairs: [stair] })
    const b = placeElevators({ floorCount: 5, floorHeight: 3, stairs: [stair] })
    expect(a[0]!.id).toBe(b[0]!.id)
    expect(a[0]!.shaftPolygon).toEqual(b[0]!.shaftPolygon)
    expect(a[0]!.enclosingWallIds).toEqual(b[0]!.enclosingWallIds)
  })

  it('elevator wall ids are disjoint from stair_core_0 wall ids', () => {
    const stair = makePrimaryStair()
    const [el] = placeElevators({
      floorCount: 5,
      floorHeight: 3,
      stairs: [stair],
    })
    const stairSet = new Set(stair.enclosingWallIds)
    for (const id of el!.enclosingWallIds) {
      expect(stairSet.has(id)).toBe(false)
    }
  })
})
