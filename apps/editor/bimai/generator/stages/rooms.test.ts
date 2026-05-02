import { describe, expect, it } from 'vitest'
import type { UnitPlan } from '../types'
import {
  UNIT_SHELL_KIND,
  attachRoomsToUnits,
  planRooms,
  unitShellLayout,
} from './rooms'

function makeUnit(overrides: Partial<UnitPlan> = {}): UnitPlan {
  return {
    type: 'unknown-type', // no template → unit-shell fallback path
    polygon: [
      [0, 0],
      [5, 0],
      [5, 4],
      [0, 4],
    ],
    area: 20,
    facadeEdges: [2],
    corridorEdges: [0],
    rooms: [],
    ...overrides,
  }
}

describe('unitShellLayout', () => {
  it('emits exactly one unit-shell room per unit', () => {
    const rooms = unitShellLayout(makeUnit())
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.kind).toBe(UNIT_SHELL_KIND)
  })

  it('matches the unit polygon and area', () => {
    const unit = makeUnit()
    const [room] = unitShellLayout(unit)
    expect(room!.polygon).toEqual(unit.polygon)
    expect(room!.area).toBe(unit.area)
  })

  it('returns a defensive copy of the polygon', () => {
    const unit = makeUnit()
    const [room] = unitShellLayout(unit)
    room!.polygon[0]![0] = 999
    expect(unit.polygon[0]![0]).toBe(0)
  })

  it('returns a fresh array on each call', () => {
    const unit = makeUnit()
    expect(unitShellLayout(unit)).not.toBe(unitShellLayout(unit))
  })

  it('emits no interior walls or doors', () => {
    const [room] = unitShellLayout(makeUnit())
    expect(room!.walls).toEqual([])
    expect(room!.doors).toEqual([])
  })

  it('reports windowAccess=true when the unit has facade edges', () => {
    const [room] = unitShellLayout(makeUnit({ facadeEdges: [2] }))
    expect(room!.windowAccess).toBe(true)
  })

  it('reports windowAccess=false when the unit has no facade edges', () => {
    const [room] = unitShellLayout(makeUnit({ facadeEdges: [] }))
    expect(room!.windowAccess).toBe(false)
  })
})

describe('planRooms', () => {
  it('falls back to unit-shell for unknown unit types', () => {
    const rooms = planRooms(makeUnit({ type: 'made-up-type' }))
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.kind).toBe(UNIT_SHELL_KIND)
  })

  it('falls back to unit-shell when bisection fails (too thin)', () => {
    // 1BR template authored for 50-65 m². A 4×8 unit is 32 m² — far
    // outside the band; even if we tried, bedroom width would fall
    // below minRoomDimensionM = 1.5.
    const rooms = planRooms(
      makeUnit({
        type: '1BR',
        polygon: [
          [0, 0],
          [8, 0],
          [8, 4],
          [0, 4],
        ],
        area: 32,
        facadeEdges: [2],
      }),
    )
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.kind).toBe(UNIT_SHELL_KIND)
  })

  it('subdivides a 2BR unit into the expected room kinds', () => {
    // 2BR mid-band ≈ 82.5 m². 11 × 7.5 = 82.5.
    const rooms = planRooms(
      makeUnit({
        type: '2BR',
        polygon: [
          [0, 0],
          [11, 0],
          [11, 7.5],
          [0, 7.5],
        ],
        area: 82.5,
        // Corner unit: facade on both long edges so both bedrooms in
        // the across-subdivided private strip can satisfy
        // bedroomNeedsFacade. A single-facade 2BR would (correctly)
        // fail bisection and fall back to unit-shell.
        facadeEdges: [0, 2], // top edge faces the facade
      }),
    )
    const kinds = rooms.map((r) => r.kind).sort()
    expect(kinds).toEqual([
      'bathroom',
      'bedroom',
      'bedroom',
      'hallway',
      'kitchen',
      'living',
    ])
  })
})

describe('attachRoomsToUnits', () => {
  it('attaches rooms to every unit', () => {
    const units = [
      makeUnit({ type: 'unknown-1' }),
      makeUnit({ type: 'unknown-2', area: 70 }),
    ]
    const { units: out, warnings } = attachRoomsToUnits(units)
    expect(out).toHaveLength(2)
    for (const u of out) {
      expect(u.rooms).toHaveLength(1)
      expect(u.rooms[0]!.kind).toBe(UNIT_SHELL_KIND)
    }
    // Unknown types fall back silently — no warning.
    expect(warnings).toEqual([])
  })

  it('does not mutate the input units', () => {
    const sentinel: UnitPlan['rooms'] = []
    const units = [makeUnit({ rooms: sentinel })]
    attachRoomsToUnits(units)
    expect(units[0]!.rooms).toBe(sentinel)
  })

  it('preserves the unit area on the unit-shell fallback room', () => {
    const units = [makeUnit({ area: 42.5 })]
    const { units: out } = attachRoomsToUnits(units)
    expect(out[0]!.rooms[0]!.area).toBe(42.5)
  })

  it('returns an empty units array for an empty input', () => {
    const { units, warnings } = attachRoomsToUnits([])
    expect(units).toEqual([])
    expect(warnings).toEqual([])
  })

  it('threads windowAccess through from each unit on the fallback path', () => {
    const units = [
      makeUnit({ type: 'A', facadeEdges: [2] }),
      makeUnit({ type: 'B', facadeEdges: [] }),
    ]
    const { units: out } = attachRoomsToUnits(units)
    expect(out[0]!.rooms[0]!.windowAccess).toBe(true)
    expect(out[1]!.rooms[0]!.windowAccess).toBe(false)
  })

  it('emits a warning when bisection fails and unit falls back', () => {
    const units = [
      // 1BR template, but unit is way too thin → fails dimension check.
      // Phase 3-9: area 32 m² is also below the catalog's 1BR band
      // (45-70 m²), so the variant selector synthesizes the Phase 3-7
      // fallback AND bisection still fails on the degenerate
      // dimensions — two warnings expected: `template_fallback_used`
      // for the catalog miss + the bisection-failure warning.
      makeUnit({
        type: '1BR',
        polygon: [
          [0, 0],
          [8, 0],
          [8, 4],
          [0, 4],
        ],
        area: 32,
        facadeEdges: [2],
      }),
    ]
    const { units: out, warnings } = attachRoomsToUnits(units)
    expect(out[0]!.rooms[0]!.kind).toBe(UNIT_SHELL_KIND)
    expect(warnings).toHaveLength(2)
    expect(warnings.some((w) => w.includes('template_fallback_used'))).toBe(true)
    expect(warnings.some((w) => /1BR/.test(w) && !w.includes('template_fallback_used'))).toBe(true)
  })

  it('emits no warnings when every unit subdivides successfully', () => {
    const units = [
      makeUnit({
        type: '2BR',
        polygon: [
          [0, 0],
          [11, 0],
          [11, 7.5],
          [0, 7.5],
        ],
        area: 82.5,
        // Corner unit: facade on both long edges so both bedrooms in
        // the across-subdivided private strip can satisfy
        // bedroomNeedsFacade. A single-facade 2BR would (correctly)
        // fail bisection and fall back to unit-shell.
        facadeEdges: [0, 2],
      }),
    ]
    const { warnings } = attachRoomsToUnits(units)
    expect(warnings).toEqual([])
  })
})
