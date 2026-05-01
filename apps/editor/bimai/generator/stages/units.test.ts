import { describe, expect, it } from 'vitest'
import type { Program } from '../../schemas'
import { calculatePolygonArea } from '../../lib/geometry'
import type { CorridorPlan } from '../types'
import { TARGET_STRIP_DEPTH_M, placeCorridor } from './corridor'
import {
  MAX_UNIT_WIDTH_M,
  MIN_UNIT_WIDTH_M,
  MIN_VIABLE_WIDTH_M,
  packUnits,
} from './units'

// 50 (long) × 30 (short) axis-aligned floor plate. Usable perpendicular
// = 30 − 1.5 = 28.5 ≥ 2 × TARGET_STRIP_DEPTH_M (18) ⇒ double-loaded with
// fixed 9 m strips. The previous test fixture (30 × 10) is now narrow
// enough to fall back to single-loaded — exercised in its own suite below.
const OUTLINE_50x30: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 30],
  [0, 30],
]
// Fixed strip depth in double-loaded mode (Phase 3-7 close-out).
const STRIP_DEPTH = TARGET_STRIP_DEPTH_M

function corridorFor(outline: [number, number][]): CorridorPlan {
  const c = placeCorridor(outline)
  if (!c) throw new Error('test setup: corridor placement failed')
  return c
}

const baseMix = (mix: Program['unitMix']): Program['unitMix'] => mix

describe('packUnits — double-loaded (50×30)', () => {
  it('places a single unit on the first strip', () => {
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      // targetArea = depth × 5 = 45 ⇒ derived width 5m, no clamp.
      unitMix: baseMix([{ type: 'studio', count: 1, targetArea: STRIP_DEPTH * 5 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(1)
    expect(result.units[0]!.type).toBe('studio')
    expect(result.units[0]!.area).toBeCloseTo(STRIP_DEPTH * 5, 6)
    expect(result.unplaced).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('honours declaration order across the queue', () => {
    // Uses lowercase test-only types so the per-type minViable gate
    // doesn't kick in — this spec is about queue ordering, not the
    // 1BR/2BR template-feasibility logic added in Phase 3-7 Fix A.
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'studio', count: 2, targetArea: STRIP_DEPTH * 5 },
        { type: 'apartment', count: 2, targetArea: STRIP_DEPTH * 5 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units.map((u) => u.type)).toEqual([
      'studio',
      'studio',
      'apartment',
      'apartment',
    ])
  })

  it('overflows to the second strip when the first fills', () => {
    // width 7m. Strip 0 fits 7×7 = 49m of 50m; remainder 1m < MIN ⇒ rule 4
    // (switch strips) sends the 8th unit to strip 1.
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        // Lowercase test-only type — bypasses the per-type minViable
        // gate so this spec exercises only strip-overflow mechanics.
        { type: 'apartment', count: 8, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(8)
    expect(result.unplaced).toEqual([])
    // Centroids: strip 0 lies on +y side of corridor (y=15); strip 1 on −y side.
    const cy = (u: { polygon: [number, number][] }) =>
      u.polygon.reduce((s, p) => s + p[1], 0) / u.polygon.length
    for (let i = 0; i < 7; i++) expect(cy(result.units[i]!)).toBeGreaterThan(15)
    expect(cy(result.units[7]!)).toBeLessThan(15)
  })

  it('records unplaced units and warns when the program exceeds capacity', () => {
    // 12 units × 6m. Each strip holds floor(50/6)=8 → 8×6=48m, remainder 2m
    // < MIN, switch strips. Both strips → 16 placed if mix allows; here we
    // request 12, all placed (8 + 4). Use a tighter fixture to actually
    // overflow: 18 units forces unplaced.
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        // Lowercase test-only type — see "overflows" spec above.
        { type: 'apartment', count: 18, targetArea: STRIP_DEPTH * 6 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(16)
    expect(result.unplaced).toHaveLength(2)
    expect(result.warnings.some((w) => /could not be placed/.test(w))).toBe(true)
  })

  it('skips zero-count entries entirely', () => {
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'studio', count: 0, targetArea: STRIP_DEPTH * 5 },
        // Lowercase test-only type so the minViable gate is inert.
        { type: 'apartment', count: 1, targetArea: STRIP_DEPTH * 5 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(1)
    expect(result.units[0]!.type).toBe('apartment')
  })

  it('labels facade and corridor edges on every unit', () => {
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 4, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      expect(u.corridorEdges).toEqual([0])
      expect(u.facadeEdges).toContain(2)
    }
  })

  it('flags first/last units in a strip with end-wall facade edges', () => {
    // 5 units × 7m ⇒ 35m of 50m on strip 0, all five fit.
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 5, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units[0]!.facadeEdges).toContain(3)
    expect(result.units[4]!.facadeEdges).toContain(1)
    expect(result.units[2]!.facadeEdges).not.toContain(1)
    expect(result.units[2]!.facadeEdges).not.toContain(3)
  })

  it('returns null for non-rectangular outlines', () => {
    const triangle: [number, number][] = [
      [0, 0],
      [10, 0],
      [5, 10],
    ]
    expect(
      packUnits({
        outline: triangle,
        corridor: corridorFor(OUTLINE_50x30),
        corridorWidth: 1.5,
        unitMix: baseMix([{ type: 'studio', count: 1, targetArea: 20 }]),
      }),
    ).toBeNull()
  })

  it('returns null when the corridor consumes the whole short dimension', () => {
    // Corridor as wide as the short axis ⇒ no usable strip depth ⇒
    // placeCorridor returns null. The packer must agree.
    expect(placeCorridor(OUTLINE_50x30, { width: 30 })).toBeNull()
  })

  it('returns null for non-positive corridor width', () => {
    expect(
      packUnits({
        outline: OUTLINE_50x30,
        corridor: corridorFor(OUTLINE_50x30),
        corridorWidth: 0,
        unitMix: baseMix([{ type: 'studio', count: 1, targetArea: 20 }]),
      }),
    ).toBeNull()
  })

  it('produces unit polygons whose computed area matches the recorded area', () => {
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 3, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      expect(calculatePolygonArea(u.polygon)).toBeCloseTo(u.area, 4)
    }
  })

  it('keeps unit polygons inside the floor outline', () => {
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: 'studio', count: 6, targetArea: STRIP_DEPTH * 5 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      for (const [x, y] of u.polygon) {
        expect(x).toBeGreaterThanOrEqual(-1e-9)
        expect(x).toBeLessThanOrEqual(50 + 1e-9)
        expect(y).toBeGreaterThanOrEqual(-1e-9)
        expect(y).toBeLessThanOrEqual(30 + 1e-9)
      }
    }
  })

  it('places units on a rotated rectangle along its long axis', () => {
    const a = Math.PI / 4
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const rot = (x: number, y: number): [number, number] => [
      x * cos - y * sin,
      x * sin + y * cos,
    ]
    const outline = [rot(0, 0), rot(50, 0), rot(50, 30), rot(0, 30)] as [
      number,
      number,
    ][]
    const corridor = placeCorridor(outline)
    expect(corridor).not.toBeNull()
    if (!corridor) return
    const result = packUnits({
      outline,
      corridor,
      corridorWidth: 1.5,
      unitMix: baseMix([
        // Lowercase test-only type — see "overflows" spec above.
        { type: 'apartment', count: 3, targetArea: STRIP_DEPTH * 7 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(3)
    for (const u of result.units) {
      expect(u.area).toBeCloseTo(STRIP_DEPTH * 7, 4)
    }
  })

  it('returns an empty result for an empty unit mix', () => {
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toEqual([])
    expect(result.unplaced).toEqual([])
    expect(result.warnings).toEqual([])
  })
})

// ── Phase 3-7 close-out: fixed strip depth + mode discriminator ─────────────
// Five specs covering the user-specified scenarios for the strip-depth packer
// refactor. These pin the new contract: TARGET_STRIP_DEPTH_M is the designed
// depth for double-loaded floors; single-loaded is the narrow-plate fallback;
// plates that can't fit even a single habitable strip emit a typed warning.

describe('Phase 3-7 close-out — strip depth + mode', () => {
  it('1BR @ 55 m² is blocked at 9 m strip depth — needs ≥13 m wide to bisect, would overshoot 1BR area gate', () => {
    // Phase 3-7 Fix A contract: 55/9 ≈ 6.11 m derived, but the 1BR
    // template can't bisect below 12.5 m at strip depth 9 (root 0.12
    // hallway × 9 = 1.08 m, fails 1.5 m floor). Widening to the 13 m
    // minViable would make the unit 117 m² — over the 1BR gate
    // ceiling of 105 m² (1.5 × max-band 70). Packer refuses placement
    // and surfaces a unit_too_narrow_for_template warning.
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: '1BR', count: 1, targetArea: 55 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(0)
    expect(
      result.warnings.some((w) =>
        w.startsWith('unit_too_narrow_for_template'),
      ),
    ).toBe(true)
    // The warning suggests the user-actionable next steps.
    const w = result.warnings.find((w) =>
      w.startsWith('unit_too_narrow_for_template'),
    )!
    expect(w).toMatch(/reduce 1BR count/)
    expect(w).toMatch(/increase footprint depth/)
  })

  it('50×30 plate → double-loaded with 9 m strips on each side of corridor', () => {
    const c = corridorFor(OUTLINE_50x30)
    expect(c.mode).toBe('double-loaded')
    expect(c.stripDepth).toBe(TARGET_STRIP_DEPTH_M)
    // Centerline runs along long (X) axis through the rectangle centre.
    expect(c.centerline[0]).toEqual([0, 15])
    expect(c.centerline[1]).toEqual([50, 15])
  })

  it('30×12 plate → single-loaded fallback with 10.5 m strip depth', () => {
    // usable = 12 − 1.5 = 10.5. < 2 × TARGET (18) ⇒ single-loaded; depth =
    // residual usable. Corridor hugs the −perpendicular outline edge.
    const outline: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 12],
      [0, 12],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.mode).toBe('single-loaded')
    expect(c.stripDepth).toBeCloseTo(10.5)
    // Corridor centerline offset toward y=0 edge: cy = corridorHalf = 0.75.
    expect(c.centerline[0]).toEqual([0, 0.75])
    expect(c.centerline[1]).toEqual([30, 0.75])

    // Packer honours the single-strip layout — units only on +y side.
    const result = packUnits({
      outline,
      corridor: c,
      corridorWidth: 1.5,
      // Lowercase test-only type — see notes on similar specs above.
      unitMix: baseMix([{ type: 'apartment', count: 3, targetArea: 55 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      const cy = u.polygon.reduce((s, p) => s + p[1], 0) / u.polygon.length
      expect(cy).toBeGreaterThan(0.75)
    }
  })

  it('30×30 plate → double-loaded at fixed 9 m strips (unused buffer accepted)', () => {
    // usable = 28.5 ≥ 18 ⇒ double-loaded, depth = 9. Strip outer edges at
    // ±9.75; outline spans ±15 ⇒ 5.25 m unused buffer on each long side.
    const outline: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 30],
      [0, 30],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.mode).toBe('double-loaded')
    expect(c.stripDepth).toBe(TARGET_STRIP_DEPTH_M)
    const result = packUnits({
      outline,
      corridor: c,
      corridorWidth: 1.5,
      // Lowercase test-only type so this spec keeps testing the
      // "unused-buffer" geometry contract (strip depth honoured at
      // 9 m on a wider plate) without entanglement with Fix A's per-
      // type minViable/area-gate machinery.
      unitMix: baseMix([{ type: 'apartment', count: 4, targetArea: 55 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(4)
    for (const u of result.units) {
      // Strip-local depth honoured exactly (no plot-derived stretch).
      expect(u.area).toBeCloseTo((55 / TARGET_STRIP_DEPTH_M) * TARGET_STRIP_DEPTH_M, 4)
    }
  })

  // ── Fix A: per-type widen-or-skip behavior ─────────────────────────
  // Six specs pinning the contract introduced by Phase 3-7 Fix A:
  // (1) widen, (2) skip on band overshoot, (3) above-minViable unchanged,
  // (4) mixed program 21×21, (5) 3BR @ 50×30 widens to 13 m,
  // (6) no silent unit-shell fallback for any registered placed unit.

  it('Fix A (1): below minViable + room in area band → packs at minViable width with unit_widened warning', () => {
    // 2BR target 70 m² ⇒ derived 70/9 ≈ 7.78 m, below minViable 11.
    // 11 × 9 = 99 m², still inside 2BR upper gate (100 × 1.5 = 150).
    // Packer widens; warning is surfaced exactly once per queued unit.
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: '2BR', count: 1, targetArea: 70 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(1)
    const u = result.units[0]!
    // Width along strip ≈ 11 m (minViable for 2BR), area ≈ 11 × 9 = 99.
    expect(u.area).toBeCloseTo(MIN_VIABLE_WIDTH_M['2BR']! * STRIP_DEPTH, 4)
    expect(
      result.warnings.some((w) =>
        w.startsWith('unit_widened_for_bisection'),
      ),
    ).toBe(true)
  })

  it('Fix A (3): derived width above minViable → unchanged, no widen/skip warning', () => {
    // 2BR target 110 m² ⇒ derived 110/9 ≈ 12.22 m, above minViable 11.
    // Packer leaves it alone; no widen warning, no skip warning.
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: '2BR', count: 1, targetArea: 110 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(1)
    expect(result.units[0]!.area).toBeCloseTo(110, 4)
    expect(
      result.warnings.some(
        (w) =>
          w.startsWith('unit_widened_for_bisection') ||
          w.startsWith('unit_too_narrow_for_template'),
      ),
    ).toBe(false)
  })

  it('Fix A (4): 21×21 plot + 4×2BR + 2×1BR → no placed unit below minViable for its type', () => {
    // usable = 21 − 1.5 = 19.5 ≥ 18 ⇒ double-loaded, depth 9 m.
    // 1BRs are blocked (minViable 13 × 9 = 117 > 105 ceiling); 2BRs widen
    // to 11 m (≤ 150 ceiling). Strip length 21 m / 11 m ≈ 1 per strip, so
    // 2 of 4 2BRs place. The contract under test is per-unit width ≥ minViable
    // for everything that DID get placed; no silent narrow-pack fallback.
    const outline: [number, number][] = [
      [0, 0],
      [21, 0],
      [21, 21],
      [0, 21],
    ]
    const c = placeCorridor(outline)
    expect(c).not.toBeNull()
    if (!c) return
    const result = packUnits({
      outline,
      corridor: c,
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 4, targetArea: 70 },
        { type: '1BR', count: 2, targetArea: 55 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      const minViable = MIN_VIABLE_WIDTH_M[u.type]
      if (minViable === undefined) continue
      // Polygon long-edge length on a strip-aligned axis-aligned outline
      // is the unit width. We check via area / strip depth as a proxy
      // (clamps that shrink width also shrink area — both flag).
      const inferredWidth = u.area / STRIP_DEPTH
      expect(inferredWidth).toBeGreaterThanOrEqual(minViable - 1e-6)
    }
    // 1BR is blocked at gate; emits the typed skip warning.
    expect(
      result.warnings.some(
        (w) =>
          w.startsWith('unit_too_narrow_for_template') && /1BR/.test(w),
      ),
    ).toBe(true)
  })

  it('Fix A (5): 50×30 plot + 2×3BR target 105 → packs at 13 m width (architechtures regression)', () => {
    // 3BR nominal 105 ⇒ derived 105/9 ≈ 11.67 m, below minViable 13.
    // 13 × 9 = 117 ≤ 195 (3BR ceiling) ⇒ widen. Both fit on strip 0
    // (2 × 13 = 26 m of 50 m).
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([{ type: '3BR', count: 2, targetArea: 105 }]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.units).toHaveLength(2)
    for (const u of result.units) {
      expect(u.area).toBeCloseTo(MIN_VIABLE_WIDTH_M['3BR']! * STRIP_DEPTH, 4)
    }
    expect(
      result.warnings.some((w) =>
        w.startsWith('unit_widened_for_bisection'),
      ),
    ).toBe(true)
  })

  it('Fix A (6): no silent unit-shell fallback — every placed registered unit has width ≥ its minViable', () => {
    // Probe across 2BR/3BR/4BR targets, all of which are below their
    // type's minViable in the derived calculation but inside the area
    // gate after widening. After Fix A the queue is widened up front, so
    // no placed registered-type unit ever narrower than its minViable.
    const result = packUnits({
      outline: OUTLINE_50x30,
      corridor: corridorFor(OUTLINE_50x30),
      corridorWidth: 1.5,
      unitMix: baseMix([
        { type: '2BR', count: 1, targetArea: 70 },
        { type: '3BR', count: 1, targetArea: 105 },
        { type: '4BR', count: 1, targetArea: 145 },
      ]),
    })
    expect(result).not.toBeNull()
    if (!result) return
    for (const u of result.units) {
      const minViable = MIN_VIABLE_WIDTH_M[u.type]
      if (minViable === undefined) continue
      const inferredWidth = u.area / STRIP_DEPTH
      expect(inferredWidth).toBeGreaterThanOrEqual(minViable - 1e-6)
    }
  })

  it('30×4 plate → too narrow for any strip, placeCorridor returns null', () => {
    // usable = 4 − 1.5 = 2.5 < MIN_STRIP_DEPTH_M (4). Caller surfaces this
    // as `plot_too_narrow` + corridor_layout_failed.
    const outline: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 4],
      [0, 4],
    ]
    expect(placeCorridor(outline)).toBeNull()
  })
})
