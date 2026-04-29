// Pascal ↔ IFC coordinate-system bridge.
//
// Pascal:  Y-up, ground plane is X-Z. Walls use [x, z] start/end; slabs and
//          zones are [x, z] polygons; level elevation lives on the slab's `y`
//          (encoded as `elevation` in metres) and on the building floor
//          stack via `floorToFloorHeight * level`.
//
// IFC:     Z-up, ground plane is X-Y. The same physical point is laid out
//          with the planar Z swapped into the second coordinate slot.
//
// We perform every Pascal→IFC conversion through this single helper.
// Inlining the swap at each emitter is how axis-mistakes leak into release
// builds; if you find yourself writing `[x, z, y]` in geometry.ts or
// write.ts, you have a bug — call `pascalToIfc` instead.
//
// IfcCartesianPoint is just a `number[]`; this module is web-ifc-free so it
// stays trivially testable. The geometry layer wraps these into entity
// instances.

/** A Pascal-space 3D point: `[x, y_up, z_planar]`. */
export type Pascal3D = readonly [number, number, number]

/** A Pascal-space 2D ground-plane point: `[x, z_planar]`. */
export type Pascal2D = readonly [number, number]

/** An IFC-space 3D point: `[x, y_planar, z_up]`. */
export type Ifc3D = [number, number, number]

/**
 * Pascal `[x, y_up, z_planar]` → IFC `[x, y_planar, z_up]`.
 *
 * The swap is `[a, b, c] -> [a, c, b]` — Pascal's vertical axis (Y) lands
 * in IFC's vertical axis (Z), and Pascal's planar Z lands in IFC's planar Y.
 *
 * Tested against the canonical case `(1, 2, 3) → (1, 3, 2)` to lock the
 * convention; ignore the urge to "fix" the order without changing the test
 * — every other helper in this file derives from this swap.
 */
export function pascalToIfc(p: Pascal3D): Ifc3D {
  return [p[0], p[2], p[1]]
}

/**
 * Pascal ground-plane `[x, z_planar]` at elevation `y_up` → IFC
 * `[x, y_planar, z_up]`.
 *
 * Used for slab profiles, zone footprints, and wall start/end (each of
 * which Pascal stores as 2D and lifts to 3D via the parent level's
 * elevation). The 2D pair already lines up with IFC's planar X-Y, so this
 * is just `(x, z, y) → (x, z, y)` — no swap on the planar pair.
 */
export function pascal2DToIfc(p: Pascal2D, elevation: number): Ifc3D {
  return [p[0], p[1], elevation]
}

/**
 * Pascal-space ground polygon → IFC-space lifted polygon. Convenience
 * wrapper for slab/zone footprint emitters; semantically identical to
 * mapping `pascal2DToIfc` over the array.
 */
export function pascalPolygonToIfc(
  polygon: ReadonlyArray<Pascal2D>,
  elevation: number,
): Ifc3D[] {
  return polygon.map((p) => pascal2DToIfc(p, elevation))
}

/**
 * Compute level elevation in metres from a Pascal level index and the
 * project's floor-to-floor height. Phase 3-6 assumes uniform stacking — the
 * BimAI generator emits levels at `level * floorToFloorHeight`. If a future
 * variant introduces per-level heights, this helper widens; emitters keep
 * calling it the same way.
 */
export function elevationForLevel(
  levelIndex: number,
  floorToFloorHeightM: number,
): number {
  return levelIndex * floorToFloorHeightM
}
