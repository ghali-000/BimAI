// IFC4 geometry helpers shared by `write.ts`.
//
// Every entity that lands in the STEP file passes through `writeEntity`
// from `materials.ts` so it picks up a fresh expressID and is persisted
// via `IfcAPI.WriteLine`. Helpers in this module construct the entity
// graph (placements, profiles, swept solids, shape representations,
// product shapes) and return the top-level handle the orchestrator
// attaches to a building element.
//
// Coordinate handling. Every placement here is built in *IFC* space —
// Z-up, with the planar pair on X/Y. The orchestrator translates from
// Pascal coordinates via `coords.ts` before calling in. Helpers in this
// file MUST NOT swap axes: that's the contract that keeps the Pascal /
// IFC bridge auditable in one place.
//
// Why so many casts to `unknown as IFC4.Foo`. The web-ifc d.ts uses
// `Handle<T> | T` unions for every reference slot — TypeScript can't
// see that a freshly-constructed entity is a valid `T` once we've
// assigned its `expressID`. Casting at the call site (rather than
// loosening the helper signatures) keeps the rest of the writer typed
// against the real IFC class shapes.

import { IFC4 } from 'web-ifc'
import type { Ifc3D } from './coords'
import { writeEntity, type IfcWriteContext } from './materials'

// ── primitives ──────────────────────────────────────────────────────────────

/** Cartesian point at the given IFC-space coordinates. */
function cartesianPoint(ctx: IfcWriteContext, p: Ifc3D): IFC4.IfcCartesianPoint {
  // IFC accepts a plain number list for coordinates, but materials.ts
  // wraps every numeric measure in its semantic class for parity with
  // the IFC4 schema; we follow the same rule here.
  const coords = p.map((n) => new IFC4.IfcLengthMeasure(n))
  const point = new IFC4.IfcCartesianPoint(coords)
  return writeEntity(ctx, point as unknown as { expressID: number }) as IFC4.IfcCartesianPoint
}

/** A 2D cartesian point — used inside profile polylines. The IFC schema
 *  still uses `IfcCartesianPoint` for 2D, with `Coordinates.length === 2`. */
function cartesianPoint2D(
  ctx: IfcWriteContext,
  x: number,
  y: number,
): IFC4.IfcCartesianPoint {
  const point = new IFC4.IfcCartesianPoint([
    new IFC4.IfcLengthMeasure(x),
    new IFC4.IfcLengthMeasure(y),
  ])
  return writeEntity(ctx, point as unknown as { expressID: number }) as IFC4.IfcCartesianPoint
}

/** Direction vector. Direction ratios are dimensionless reals. */
function direction(ctx: IfcWriteContext, ratios: readonly number[]): IFC4.IfcDirection {
  const dir = new IFC4.IfcDirection(ratios.map((n) => new IFC4.IfcReal(n)))
  return writeEntity(ctx, dir as unknown as { expressID: number }) as IFC4.IfcDirection
}

// ── placements ──────────────────────────────────────────────────────────────

/**
 * Reusable world-origin 3D placement. We don't memoize — each caller
 * gets a fresh entity — because most placements need their own copy
 * anyway (they're referenced once by an extruded solid). Building a
 * shared placement and reusing it across many profiles is legal IFC
 * but complicates expressID accounting, so we keep it simple.
 */
export function worldPlacement3D(ctx: IfcWriteContext): IFC4.IfcAxis2Placement3D {
  const origin = cartesianPoint(ctx, [0, 0, 0])
  // Axis (Z) and RefDirection (X) are nullable per the IFC4 schema —
  // omitting them means "use defaults": Z = +Z, X = +X. The d.ts at
  // line 15084 marks both as `| null`.
  const placement = new IFC4.IfcAxis2Placement3D(origin, null, null)
  return writeEntity(ctx, placement as unknown as { expressID: number }) as IFC4.IfcAxis2Placement3D
}

/**
 * Local placement relative to (an optional) parent placement. Used to
 * position building elements (walls, slabs, openings) inside their
 * containing storey or wall.
 *
 * `axis` and `refDirection` let the caller rotate the local frame —
 * walls use a non-default `refDirection` aligned with the start→end
 * vector so their length runs along local X.
 */
export function localPlacement(
  ctx: IfcWriteContext,
  origin: Ifc3D,
  parent?: IFC4.IfcLocalPlacement | null,
  axis?: readonly [number, number, number] | null,
  refDirection?: readonly [number, number, number] | null,
): IFC4.IfcLocalPlacement {
  const loc = cartesianPoint(ctx, origin)
  const axisDir = axis ? direction(ctx, axis) : null
  const refDir = refDirection ? direction(ctx, refDirection) : null
  const rel = new IFC4.IfcAxis2Placement3D(loc, axisDir, refDir)
  writeEntity(ctx, rel as unknown as { expressID: number })
  const lp = new IFC4.IfcLocalPlacement(
    parent ?? null,
    rel as unknown as IFC4.IfcAxis2Placement,
  )
  return writeEntity(ctx, lp as unknown as { expressID: number }) as IFC4.IfcLocalPlacement
}

// ── profiles ────────────────────────────────────────────────────────────────

/**
 * Closed XY profile from a polygon. The polyline is *closed* — IFC4
 * requires the last point to equal the first; we append a copy of the
 * head if the caller didn't.
 */
export function polygonProfile(
  ctx: IfcWriteContext,
  polygonXY: ReadonlyArray<readonly [number, number]>,
  name?: string,
): IFC4.IfcArbitraryClosedProfileDef {
  // Defensive copy + close. Working off a frozen ReadonlyArray means
  // we can't mutate in place even if we wanted to.
  const closed: ReadonlyArray<readonly [number, number]> =
    polygonXY.length > 0 &&
    polygonXY[0]![0] === polygonXY[polygonXY.length - 1]![0] &&
    polygonXY[0]![1] === polygonXY[polygonXY.length - 1]![1]
      ? polygonXY
      : [...polygonXY, polygonXY[0]!]

  const points = closed.map(([x, y]) => cartesianPoint2D(ctx, x, y))
  const polyline = new IFC4.IfcPolyline(points)
  writeEntity(ctx, polyline as unknown as { expressID: number })

  const profile = new IFC4.IfcArbitraryClosedProfileDef(
    IFC4.IfcProfileTypeEnum.AREA,
    name ? new IFC4.IfcLabel(name) : null,
    polyline as unknown as IFC4.IfcCurve,
  )
  return writeEntity(ctx, profile as unknown as { expressID: number }) as IFC4.IfcArbitraryClosedProfileDef
}

/**
 * Rectangle profile, centred on its `position` argument. Walls and
 * openings use this — a rectangle is parametric, which produces a
 * cleaner STEP file than a 4-point arbitrary polyline and lets BIM
 * tools recognise the shape.
 *
 * `position` is the 2D point that the rectangle is centred on (the
 * `IfcRectangleProfileDef.Position` field). When omitted, the
 * rectangle is centred at the local 2D origin (the IFC schema default
 * for `Position = $`). Walls pass `(length/2, 0)` to start-anchor the
 * profile — the rectangle then occupies local X ∈ [0, length] under
 * the wall's local frame, which matches the start-anchored
 * `IfcLocalPlacement` the orchestrator builds (origin at `wall.start`,
 * RefDirection along start→end). Openings leave `position` undefined
 * because the door / window placement already names the opening
 * centre.
 */
function rectangleProfile(
  ctx: IfcWriteContext,
  xDim: number,
  yDim: number,
  name?: string,
  position?: readonly [number, number],
): IFC4.IfcRectangleProfileDef {
  let pos: IFC4.IfcAxis2Placement2D | null = null
  if (position) {
    const loc = cartesianPoint2D(ctx, position[0], position[1])
    // RefDirection left null → default +X (the rectangle's local X is
    // the wall's local X, which is what we want).
    const ax = new IFC4.IfcAxis2Placement2D(loc, null)
    writeEntity(ctx, ax as unknown as { expressID: number })
    pos = ax
  }
  const profile = new IFC4.IfcRectangleProfileDef(
    IFC4.IfcProfileTypeEnum.AREA,
    name ? new IFC4.IfcLabel(name) : null,
    pos,
    new IFC4.IfcPositiveLengthMeasure(xDim),
    new IFC4.IfcPositiveLengthMeasure(yDim),
  )
  return writeEntity(ctx, profile as unknown as { expressID: number }) as IFC4.IfcRectangleProfileDef
}

// ── solids and representations ──────────────────────────────────────────────

/**
 * Vertical extrusion. The profile sweeps along +Z (IFC up) — every
 * plumb building element this writer emits goes through here.
 */
export function extrudeUp(
  ctx: IfcWriteContext,
  profile: IFC4.IfcProfileDef,
  heightM: number,
): IFC4.IfcExtrudedAreaSolid {
  const placement = worldPlacement3D(ctx)
  const upDir = direction(ctx, [0, 0, 1])
  const solid = new IFC4.IfcExtrudedAreaSolid(
    profile,
    placement,
    upDir,
    new IFC4.IfcPositiveLengthMeasure(heightM),
  )
  return writeEntity(ctx, solid as unknown as { expressID: number }) as IFC4.IfcExtrudedAreaSolid
}

/**
 * Sloped extrusion along an arbitrary direction. Used by Phase 3-9
 * stair flights — the profile is the slab cross-section (typically
 * `width × thickness`) and the direction is the slope tangent
 * `(0, run, rise) / |...|` so the swept solid lays along the inclined
 * surface from base to top of the flight.
 *
 * `dir` is normalised here so callers can pass a raw `(0, run, rise)`
 * tuple without precomputing the magnitude. `depthM` is the absolute
 * sweep length (slope length, not horizontal run).
 */
export function extrudeAlong(
  ctx: IfcWriteContext,
  profile: IFC4.IfcProfileDef,
  dir: readonly [number, number, number],
  depthM: number,
): IFC4.IfcExtrudedAreaSolid {
  const mag = Math.hypot(dir[0], dir[1], dir[2])
  if (mag < 1e-12) {
    throw new Error('extrudeAlong: direction vector is zero-length')
  }
  const unit: [number, number, number] = [
    dir[0] / mag,
    dir[1] / mag,
    dir[2] / mag,
  ]
  const placement = worldPlacement3D(ctx)
  const ext = direction(ctx, unit)
  const solid = new IFC4.IfcExtrudedAreaSolid(
    profile,
    placement,
    ext,
    new IFC4.IfcPositiveLengthMeasure(depthM),
  )
  return writeEntity(ctx, solid as unknown as { expressID: number }) as IFC4.IfcExtrudedAreaSolid
}

/**
 * IfcShapeRepresentation in the given subcontext, of representation
 * type "SweptSolid". All the building-element bodies this writer emits
 * are swept solids (extruded profiles); a richer hierarchy can swap in
 * later if we add curved walls or NURBS roofs.
 */
export function bodyRepresentation(
  ctx: IfcWriteContext,
  subcontext: IFC4.IfcGeometricRepresentationSubContext,
  solid: IFC4.IfcExtrudedAreaSolid,
): IFC4.IfcShapeRepresentation {
  const rep = new IFC4.IfcShapeRepresentation(
    subcontext,
    new IFC4.IfcLabel('Body'),
    new IFC4.IfcLabel('SweptSolid'),
    [solid as unknown as IFC4.IfcRepresentationItem],
  )
  return writeEntity(ctx, rep as unknown as { expressID: number }) as IFC4.IfcShapeRepresentation
}

/** IfcProductDefinitionShape wrapping one or more representations. */
export function productShape(
  ctx: IfcWriteContext,
  reps: IFC4.IfcShapeRepresentation[],
): IFC4.IfcProductDefinitionShape {
  const shape = new IFC4.IfcProductDefinitionShape(
    null,
    null,
    reps as unknown as IFC4.IfcRepresentation[],
  )
  return writeEntity(ctx, shape as unknown as { expressID: number }) as IFC4.IfcProductDefinitionShape
}

// ── building-element shape factories ────────────────────────────────────────

/**
 * Slab body: arbitrary polygon profile extruded down by `thicknessM`.
 *
 * Why down. IFC slabs are conventionally placed with their *top* at
 * the storey elevation, so the body extrudes from 0 to `-thickness`
 * along the local Z axis. The local placement passed by the caller
 * already sits on the storey datum; extruding negative keeps the
 * slab below the floor line where users expect it.
 */
export function slabShape(
  ctx: IfcWriteContext,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  polygonXY: ReadonlyArray<readonly [number, number]>,
  thicknessM: number,
): IFC4.IfcProductDefinitionShape {
  const profile = polygonProfile(ctx, polygonXY, 'Slab')
  // Use a custom extrusion (down) rather than `extrudeUp` so callers
  // get the conventional slab placement without post-processing.
  const placement = worldPlacement3D(ctx)
  const downDir = direction(ctx, [0, 0, -1])
  const solid = new IFC4.IfcExtrudedAreaSolid(
    profile,
    placement,
    downDir,
    new IFC4.IfcPositiveLengthMeasure(thicknessM),
  )
  writeEntity(ctx, solid as unknown as { expressID: number })
  const rep = bodyRepresentation(ctx, bodyContext, solid)
  return productShape(ctx, [rep])
}

/**
 * Wall body: a `length × thickness` rectangle, extruded up by
 * `height`. The orchestrator builds a *start-anchored* placement —
 * origin at `wall.start`, RefDirection along start→end — so the wall
 * body must occupy local X ∈ [0, length], not the centred [-L/2,
 * +L/2] that `IfcRectangleProfileDef`'s default `Position` would
 * give. We pass `position = (length/2, 0)` to shift the centred
 * rectangle's centre forward by `L/2`, which lines its near edge up
 * with the placement origin and its far edge with `length`. The
 * thickness axis stays centred on the wall midline (Y ∈ [-T/2,
 * +T/2]) — Pascal's `start`/`end` are points on the midline.
 *
 * Why start-anchored. The IFC convention for `IfcWallStandardCase` is
 * to place the local origin at one of the wall's end points (typically
 * the start) with local X running toward the other end. Doors and
 * windows the writer hangs off the wall placement carry positions in
 * Pascal's start-relative frame (`emit.ts` `emitDoorOnWall`'s
 * `clamped ∈ [halfW, length-halfW]`), so this anchor lets the door's
 * Pascal X drop into IFC local X verbatim — no per-emitter shift, no
 * convention conversion at the door / window seam.
 */
export function wallShape(
  ctx: IfcWriteContext,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  lengthM: number,
  thicknessM: number,
  heightM: number,
): IFC4.IfcProductDefinitionShape {
  const profile = rectangleProfile(ctx, lengthM, thicknessM, 'Wall', [
    lengthM / 2,
    0,
  ])
  const solid = extrudeUp(ctx, profile, heightM)
  const rep = bodyRepresentation(ctx, bodyContext, solid)
  return productShape(ctx, [rep])
}

/**
 * Opening volume for a door / window void: a rectangle of
 * `width × wallThickness`, extruded up by `height`. The opening's
 * placement is the door's placement (the orchestrator passes the same
 * one to `IfcOpeningElement.ObjectPlacement`), so the box ends up
 * centred on the door's local origin in plan and rising from its
 * sill to its head.
 */
export function openingShape(
  ctx: IfcWriteContext,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  widthM: number,
  wallThicknessM: number,
  heightM: number,
): IFC4.IfcProductDefinitionShape {
  // wallThickness is widened slightly when callers want a clean cut —
  // here we leave it as-is and let the orchestrator pad if needed.
  const profile = rectangleProfile(ctx, widthM, wallThicknessM, 'Opening')
  const solid = extrudeUp(ctx, profile, heightM)
  const rep = bodyRepresentation(ctx, bodyContext, solid)
  return productShape(ctx, [rep])
}
