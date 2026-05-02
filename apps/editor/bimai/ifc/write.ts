// IFC4 export orchestrator.
//
// Walks a Pascal `SceneSnapshot`, emits the IFC entity graph, and
// serialises the model to STEP bytes. The intent is to produce a file
// that opens cleanly in Solibri / BIMcollab / Revit and round-trips
// through IFC validators with no schema warnings — every owned entity
// carries a deterministic GUID, every wall/slab/door/window has a
// material association and a Pset_*Common standard pset, and BimAI's
// own cost data lives in a clearly-namespaced Pset_BimAI_Cost.
//
// Traversal contract. The Pascal scene is a flat `Record<id, node>`;
// children are discovered by sorting `parentId === parent.id` matches
// for each parent in turn. We sort by id at every level so the file is
// byte-stable across re-exports (web-ifc's expressID assignment is
// order-sensitive — two walks that hit nodes in different orders
// produce different STEP files).
//
// Why a single big function. Each emitter needs the same context
// (api, modelId, ownerHistory, salt, body subcontext, the material
// registry, parent placements). A class would multiply pass-through
// fields without abstraction value. The phases are clearly separated
// by section comments and helpers extracted where they exceeded a
// dozen lines.

import { IFC4 } from 'web-ifc'
import type { IfcAPI } from 'web-ifc'
import type {
  AnyNode,
  AnyNodeId,
  BuildingNode,
  DoorNode,
  LevelNode,
  RoofNode,
  SiteNode,
  SlabNode,
  StairNode,
  StairSegmentNode,
  WallNode,
  WindowNode,
  ZoneNode,
} from '@pascal-app/core'
import type { ComponentBIM } from '../bim/schemas/component-bim'
import type { SceneSnapshot } from '../generator/cleanup'
import { DEFAULT_DOOR_HEIGHT_M, DEFAULT_WINDOW_HEIGHT_M } from '../generator/emit'
import { isGenerated } from '../generator/tag'
import {
  elevationForLevel,
  pascal2DToIfc,
  pascalPolygonToIfc,
  pascalToIfc,
  type Ifc3D,
  type Pascal3D,
} from './coords'
import {
  bodyRepresentation,
  extrudeAlong,
  extrudeUp,
  localPlacement,
  openingShape,
  polygonProfile,
  productShape,
  slabShape,
  wallShape,
  worldPlacement3D,
} from './geometry'
import {
  buildBimAICostPset,
  ifcGuid,
  MaterialRegistry,
  writeEntity,
  type IfcWriteContext,
} from './materials'

// ── public API ──────────────────────────────────────────────────────────────

export interface WriteIFCOptions {
  /** Project name written into IfcProject. */
  projectName: string
  /** Stable salt for deterministic GUIDs across re-exports. */
  projectSalt: string
  /** Default storey height in metres. Defaults to 3.0. */
  floorToFloorHeightM?: number
}

export async function writeIFC(
  api: IfcAPI,
  scene: SceneSnapshot,
  options: WriteIFCOptions,
): Promise<Uint8Array> {
  const floorToFloor = options.floorToFloorHeightM ?? 3
  const modelId = api.CreateModel({ schema: 'IFC4', name: options.projectName })

  // expressID counter. web-ifc assigns line numbers from the value we
  // set on each entity; starting at 1 keeps the STEP file dense and
  // matches the convention from materials.ts tests.
  let nextIdCounter = 0
  const ctxBootstrap = {
    api,
    modelId,
    projectSalt: options.projectSalt,
    nextId: () => ++nextIdCounter,
  }

  // Owner history needs to exist before any owned entity, but it
  // itself references entities that need expressIDs. Build the chain
  // bottom-up here, then synthesise the real `IfcWriteContext` once
  // the OwnerHistory is in hand.
  const ownerHistory = buildOwnerHistory(ctxBootstrap)

  const ctx: IfcWriteContext = {
    ...ctxBootstrap,
    ownerHistory,
  }

  // Units, geometric context, project — every spatial element below
  // depends on these existing first.
  const unitAssignment = buildUnitAssignment(ctx)
  const { context, bodyContext } = buildGeometricContext(ctx)
  const project = buildProject(ctx, options.projectName, [context], unitAssignment)

  const materials = new MaterialRegistry(ctx)

  // Pascal's `loadScene` seeds the default Site/Building/Level with
  // `parentId: null`, relying on the embedded `children` arrays for
  // hierarchy (documented Phase 3-1 schema asymmetry — see PROGRESS.md).
  // Our walk is strictly `parentId`-driven via `childrenOf`, so without
  // normalization the writer reaches the Site and finds zero descendants.
  // Patch the snapshot once at the writer's entry point; the fix is
  // writer-local so other consumers can keep relying on `childrenOf`'s
  // strict semantics.
  const normalizedScene = normalizeParentIds(scene)

  // Walk Pascal nodes top-down: site → building → level → element.
  // Sites have no Pascal parent, so we scan by type rather than by
  // parentId. Every other level uses `childrenOf`.
  const allSites = scanByType<SiteNode>(normalizedScene, 'site')
  for (const site of allSites) {
    emitSite(ctx, normalizedScene, site, project, bodyContext, materials, floorToFloor)
  }

  const bytes = api.SaveModel(modelId)
  api.CloseModel(modelId)
  return bytes
}

// ── header / metadata entities ──────────────────────────────────────────────

/** Single application/person/org chain shared by every owned entity. */
function buildOwnerHistory(
  ctx: Omit<IfcWriteContext, 'ownerHistory'>,
): IFC4.IfcOwnerHistory {
  // Build local helpers that don't need ctx.ownerHistory yet.
  const writeLocal = <T extends { expressID: number }>(e: T): T => {
    e.expressID = ctx.nextId()
    ctx.api.WriteLine(ctx.modelId, e as unknown as IFC4.IfcRoot)
    return e
  }

  const person = writeLocal(
    new IFC4.IfcPerson(
      null,
      new IFC4.IfcLabel('BimAI'),
      new IFC4.IfcLabel('User'),
      null,
      null,
      null,
      null,
      null,
    ),
  )
  const organization = writeLocal(
    new IFC4.IfcOrganization(
      null,
      new IFC4.IfcLabel('BimAI'),
      new IFC4.IfcText('BimAI authoring tool'),
      null,
      null,
    ),
  )
  const personOrg = writeLocal(
    new IFC4.IfcPersonAndOrganization(person, organization, null),
  )
  const application = writeLocal(
    new IFC4.IfcApplication(
      organization,
      new IFC4.IfcLabel('0.1.0'),
      new IFC4.IfcLabel('BimAI'),
      new IFC4.IfcIdentifier('BimAI'),
    ),
  )

  // CreationDate is a UNIX-style integer seconds timestamp. Using `0`
  // keeps re-exports byte-stable; a real "now" would change the file
  // hash on every export which defeats the deterministic-GUID goal.
  return writeLocal(
    new IFC4.IfcOwnerHistory(
      personOrg,
      application,
      IFC4.IfcStateEnum.READWRITE,
      IFC4.IfcChangeActionEnum.NOCHANGE,
      null,
      null,
      null,
      new IFC4.IfcTimeStamp(0),
    ),
  )
}

/** SI metric units — metres, square metres, cubic metres, radians. */
function buildUnitAssignment(ctx: IfcWriteContext): IFC4.IfcUnitAssignment {
  const metre = new IFC4.IfcSIUnit(
    IFC4.IfcUnitEnum.LENGTHUNIT,
    null,
    IFC4.IfcSIUnitName.METRE,
  )
  writeEntity(ctx, metre as unknown as { expressID: number })
  const m2 = new IFC4.IfcSIUnit(
    IFC4.IfcUnitEnum.AREAUNIT,
    null,
    IFC4.IfcSIUnitName.SQUARE_METRE,
  )
  writeEntity(ctx, m2 as unknown as { expressID: number })
  const m3 = new IFC4.IfcSIUnit(
    IFC4.IfcUnitEnum.VOLUMEUNIT,
    null,
    IFC4.IfcSIUnitName.CUBIC_METRE,
  )
  writeEntity(ctx, m3 as unknown as { expressID: number })
  const rad = new IFC4.IfcSIUnit(
    IFC4.IfcUnitEnum.PLANEANGLEUNIT,
    null,
    IFC4.IfcSIUnitName.RADIAN,
  )
  writeEntity(ctx, rad as unknown as { expressID: number })

  const assignment = new IFC4.IfcUnitAssignment([
    metre as unknown as IFC4.IfcUnit,
    m2 as unknown as IFC4.IfcUnit,
    m3 as unknown as IFC4.IfcUnit,
    rad as unknown as IFC4.IfcUnit,
  ])
  return writeEntity(
    ctx,
    assignment as unknown as { expressID: number },
  ) as IFC4.IfcUnitAssignment
}

/** Model context + Body subcontext used by every shape representation. */
function buildGeometricContext(ctx: IfcWriteContext): {
  context: IFC4.IfcGeometricRepresentationContext
  bodyContext: IFC4.IfcGeometricRepresentationSubContext
} {
  const placement = worldPlacement3D(ctx)
  const context = new IFC4.IfcGeometricRepresentationContext(
    null,
    new IFC4.IfcLabel('Model'),
    new IFC4.IfcDimensionCount(3),
    new IFC4.IfcReal(1e-5),
    placement as unknown as IFC4.IfcAxis2Placement,
    null,
  )
  writeEntity(ctx, context as unknown as { expressID: number })

  const bodyContext = new IFC4.IfcGeometricRepresentationSubContext(
    new IFC4.IfcLabel('Body'),
    new IFC4.IfcLabel('Model'),
    context,
    null,
    IFC4.IfcGeometricProjectionEnum.MODEL_VIEW,
    null,
  )
  writeEntity(ctx, bodyContext as unknown as { expressID: number })
  return { context, bodyContext }
}

function buildProject(
  ctx: IfcWriteContext,
  name: string,
  contexts: IFC4.IfcGeometricRepresentationContext[],
  units: IFC4.IfcUnitAssignment,
): IFC4.IfcProject {
  const project = new IFC4.IfcProject(
    ifcGuid(ctx, 'project', ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(name),
    null,
    null,
    null,
    null,
    contexts as unknown as IFC4.IfcRepresentationContext[],
    units,
  )
  return writeEntity(ctx, project as unknown as { expressID: number }) as IFC4.IfcProject
}

// ── spatial structure ───────────────────────────────────────────────────────

function emitSite(
  ctx: IfcWriteContext,
  scene: SceneSnapshot,
  siteNode: SiteNode,
  project: IFC4.IfcProject,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  materials: MaterialRegistry,
  floorToFloorHeightM: number,
): void {
  const placement = localPlacement(ctx, [0, 0, 0])
  const site = new IFC4.IfcSite(
    ifcGuid(ctx, siteNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(siteNode.name ?? 'Site'),
    null,
    null,
    placement,
    null,
    null,
    IFC4.IfcElementCompositionEnum.ELEMENT,
    null,
    null,
    null,
    null,
    null,
  )
  writeEntity(ctx, site as unknown as { expressID: number })

  aggregate(ctx, project, [site], `${siteNode.id}-site`)

  const buildings = childrenOf<BuildingNode>(scene, siteNode.id, 'building')
  for (const building of buildings) {
    emitBuilding(
      ctx,
      scene,
      building,
      site,
      placement,
      bodyContext,
      materials,
      floorToFloorHeightM,
    )
  }
}

function emitBuilding(
  ctx: IfcWriteContext,
  scene: SceneSnapshot,
  buildingNode: BuildingNode,
  site: IFC4.IfcSite,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  materials: MaterialRegistry,
  floorToFloorHeightM: number,
): void {
  // Pascal building.position is `[x, y_up, z_planar]`; route through
  // the single Pascal→IFC helper so the axis swap stays auditable in
  // one place (GATE 1 lock-in #8 — never inline `[a, c, b]`).
  const buildingOrigin: Ifc3D = pascalToIfc(buildingNode.position as Pascal3D)
  const placement = localPlacement(
    ctx,
    buildingOrigin,
    parentPlacement,
  )
  const building = new IFC4.IfcBuilding(
    ifcGuid(ctx, buildingNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(buildingNode.name ?? 'Building'),
    null,
    null,
    placement,
    null,
    null,
    IFC4.IfcElementCompositionEnum.ELEMENT,
    null,
    null,
    null,
  )
  writeEntity(ctx, building as unknown as { expressID: number })

  aggregate(ctx, site, [building], `${buildingNode.id}-bldg`)

  const allLevels = childrenOf<LevelNode>(scene, buildingNode.id, 'level')
  // Phase 3-6 Task 2 leftover: Pascal's `loadScene` seeds an *untagged*
  // Level 0 alongside whatever the generator emits. The sidebar already
  // hides it (cleanup.ts/findStaleLevelNodes powers the regen-replace
  // path), but the IFC writer was still walking it — producing a third
  // phantom storey in the export. Drop untagged levels iff at least one
  // tagged level exists under the same building. The conditional keeps
  // the "ungenerated scene exports as-is" path working: a building with
  // only user-drawn levels (none tagged) still ships every level.
  const hasTaggedLevel = allLevels.some((l) => isGenerated(l))
  const levels = hasTaggedLevel ? allLevels.filter((l) => isGenerated(l)) : allLevels
  // Track storey by level id so post-level emitters (stairs) can resolve
  // their containment storey from `fromLevelId`.
  const storeyByLevelId = new Map<AnyNodeId, IFC4.IfcBuildingStorey>()
  for (const level of levels) {
    const storey = emitLevel(
      ctx,
      scene,
      level,
      building,
      placement,
      bodyContext,
      materials,
      floorToFloorHeightM,
    )
    storeyByLevelId.set(level.id, storey)
  }

  // Stairs are level-children (Phase 3-8 follow-up: the generator
  // parents each StairNode to its `fromLevelId` for Pascal's edit-UX
  // routing). Walk every level (including the synthetic Roof level)
  // and collect their stair children — pre-3-8-follow-up scenes parked
  // stairs directly under the building, so for compatibility we also
  // sweep the building's direct children. `fromLevelId` on the
  // StairNode is what determines IFC storey containment regardless of
  // where the node lives in the Pascal scene tree.
  const stairsByLevel = levels.flatMap((level) =>
    childrenOf<StairNode>(scene, level.id, 'stair'),
  )
  const stairsByBuilding = childrenOf<StairNode>(scene, buildingNode.id, 'stair')
  // Dedup by id in case a scene has both shapes; sort for deterministic
  // emission order (childrenOf already sorts within a parent, but the
  // cross-parent flatMap loses that guarantee).
  const stairById = new Map<AnyNodeId, StairNode>()
  for (const s of [...stairsByLevel, ...stairsByBuilding]) {
    stairById.set(s.id, s)
  }
  const stairs = [...stairById.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  for (const stair of stairs) {
    emitStair(ctx, scene, stair, placement, bodyContext, storeyByLevelId)
  }
}

function emitLevel(
  ctx: IfcWriteContext,
  scene: SceneSnapshot,
  levelNode: LevelNode,
  building: IFC4.IfcBuilding,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  materials: MaterialRegistry,
  floorToFloorHeightM: number,
): IFC4.IfcBuildingStorey {
  const elevation = elevationForLevel(levelNode.level, floorToFloorHeightM)
  const placement = localPlacement(ctx, [0, 0, elevation], parentPlacement)
  const storey = new IFC4.IfcBuildingStorey(
    ifcGuid(ctx, levelNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(levelNode.name ?? `Level ${levelNode.level}`),
    null,
    null,
    placement,
    null,
    null,
    IFC4.IfcElementCompositionEnum.ELEMENT,
    new IFC4.IfcLengthMeasure(elevation),
  )
  writeEntity(ctx, storey as unknown as { expressID: number })

  aggregate(ctx, building, [storey], `${levelNode.id}-storey`)

  // Containment: every wall/slab/door/window on this level lives in
  // one IfcRelContainedInSpatialStructure under the storey. We collect
  // them as we emit and write the rel at the end.
  const contained: IFC4.IfcProduct[] = []

  const slabs = childrenOf<SlabNode>(scene, levelNode.id, 'slab')
  for (const slab of slabs) {
    const ent = emitSlab(ctx, slab, placement, bodyContext, elevation)
    contained.push(ent as unknown as IFC4.IfcProduct)
    const bim = getBim(slab)
    associateAndCost(ctx, materials, ent, slab.id, bim)
    standardPset(ctx, 'Pset_SlabCommon', commonPropsForSlab(bim), [ent], slab.id)
  }

  // Walls — keep a map by id so doors/windows can resolve their host
  // wall placement and thickness.
  const wallEntries = new Map<
    string,
    { node: WallNode; entity: IFC4.IfcWallStandardCase; placement: IFC4.IfcLocalPlacement }
  >()
  const walls = childrenOf<WallNode>(scene, levelNode.id, 'wall')
  for (const wall of walls) {
    const emitted = emitWall(ctx, wall, placement, bodyContext, elevation)
    contained.push(emitted.entity as unknown as IFC4.IfcProduct)
    wallEntries.set(wall.id, { node: wall, entity: emitted.entity, placement: emitted.placement })
    const bim = getBim(wall)
    associateAndCost(ctx, materials, emitted.entity, wall.id, bim)
    standardPset(
      ctx,
      'Pset_WallCommon',
      commonPropsForWall(wall, bim),
      [emitted.entity],
      wall.id,
    )
  }

  // Doors and windows live one tier deeper than the rest: the
  // generator parents each door/window to its host *wall*, not to the
  // level (see `bimai/generator/emit.ts` — `parentId: wall.id`). A
  // level-rooted `childrenOf(level, 'door' | 'window')` therefore
  // returns 0. Walk each emitted wall's children instead. Containment
  // still goes to the storey via `IfcRelContainedInSpatialStructure`
  // — only the discovery query changes.
  //
  // Sort the cross-wall door/window lists by id once at the end so
  // emission order (and therefore expressIDs and IFC GUIDs) stays
  // deterministic across exports regardless of Pascal's wall iteration
  // order.
  const doors: DoorNode[] = []
  const windows: WindowNode[] = []
  for (const wallId of wallEntries.keys()) {
    doors.push(...childrenOf<DoorNode>(scene, wallId as AnyNodeId, 'door'))
    windows.push(...childrenOf<WindowNode>(scene, wallId as AnyNodeId, 'window'))
  }
  doors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  windows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const door of doors) {
    const ent = emitDoor(ctx, door, placement, bodyContext, wallEntries)
    contained.push(ent as unknown as IFC4.IfcProduct)
    const bim = getBim(door)
    associateAndCost(ctx, materials, ent, door.id, bim)
    standardPset(ctx, 'Pset_DoorCommon', commonPropsForDoor(bim), [ent], door.id)
  }

  for (const win of windows) {
    const ent = emitWindow(ctx, win, placement, bodyContext, wallEntries)
    contained.push(ent as unknown as IFC4.IfcProduct)
    const bim = getBim(win)
    associateAndCost(ctx, materials, ent, win.id, bim)
    standardPset(ctx, 'Pset_WindowCommon', commonPropsForWindow(bim), [ent], win.id)
  }

  // Zones split into unit zones (no `roomKind` metadata) and room zones
  // (`roomKind` set, `unitId` set — Phase 3-7 Task 6 emission). The IFC
  // mapping (Phase 3-7 Task 9):
  //
  //   - storey ─IfcRelContainedInSpatialStructure─▶ unit IfcSpace(s)
  //   - unit IfcSpace ─IfcRelAggregates─▶ room IfcSpace(s)
  //
  // Room IfcSpaces deliberately do NOT enter `contained` — IFC reserves
  // a single decomposition relationship per element, and the unit-as-
  // parent aggregation is the more useful one (BIMcollab and Solibri
  // expand units to reveal rooms). The unit IfcSpace stays in `contained`
  // so storey navigation still finds every habitable space directly under
  // it. Studios that fall back to unit-shell emit only the unit IfcSpace
  // — `emitRoomZones` already suppresses unit-shell room zones at emit
  // time, so this loop sees zero room zones for those units naturally.
  // Same path for 3BR/4BR units that fall back to unit-shell when the
  // packer's strip depth pushes them outside the area-band gate.
  const zones = childrenOf<ZoneNode>(scene, levelNode.id, 'zone')
  const unitZones: ZoneNode[] = []
  const elevatorCabinZones: ZoneNode[] = []
  const roomZonesByUnitId = new Map<string, ZoneNode[]>()
  for (const zone of zones) {
    // Phase 3-9 Task 12: elevator cabin marker → IfcTransportElement,
    // not IfcSpace. Detect via metadata.bimai.elevatorRole.
    const bimaiMeta = (zone.metadata as { bimai?: { elevatorRole?: string } } | undefined)
      ?.bimai
    if (bimaiMeta?.elevatorRole === 'elevator-cabin') {
      elevatorCabinZones.push(zone)
      continue
    }
    const meta = getRoomZoneMeta(zone)
    if (meta) {
      const list = roomZonesByUnitId.get(meta.unitId) ?? []
      list.push(zone)
      roomZonesByUnitId.set(meta.unitId, list)
    } else {
      unitZones.push(zone)
    }
  }
  // Emit one IfcTransportElement per elevator-cabin zone, contained
  // in the storey alongside slabs / walls / spaces. PredefinedType is
  // ELEVATOR; no Representation (the cabin is the absence of structure
  // inside the shaft walls — viewers render the shaft walls + door
  // and tag the entity as an elevator).
  for (const cabin of elevatorCabinZones) {
    const ent = emitElevatorCabin(ctx, cabin, placement)
    contained.push(ent as unknown as IFC4.IfcProduct)
  }
  for (const unitZone of unitZones) {
    const unitSpace = emitZone(ctx, unitZone, placement, bodyContext, elevation, floorToFloorHeightM)
    contained.push(unitSpace as unknown as IFC4.IfcProduct)
    standardPset(ctx, 'Pset_SpaceCommon', commonPropsForSpace(), [unitSpace], unitZone.id)

    const rooms = roomZonesByUnitId.get(unitZone.id) ?? []
    if (rooms.length === 0) continue

    const roomSpaces: IFC4.IfcSpace[] = []
    for (const roomZone of rooms) {
      const meta = getRoomZoneMeta(roomZone)!
      const roomSpace = emitZone(
        ctx,
        roomZone,
        placement,
        bodyContext,
        elevation,
        floorToFloorHeightM,
        {
          // `${unitType} - ${roomKind}` for IfcSpace.Name — keeps the unit
          // prefix so a flat list of names still reads "1BR - bedroom"
          // even if a viewer doesn't render the IfcRelAggregates tree.
          // LongName = bare roomKind (matches the Phase 3-7 Task 6
          // schedule contract: roomKind is the canonical kind label).
          name: `${unitZone.name} - ${meta.roomKind}`,
          longName: meta.roomKind,
        },
      )
      standardPset(ctx, 'Pset_SpaceCommon', commonPropsForSpace(), [roomSpace], roomZone.id)
      roomSpaces.push(roomSpace)
    }
    // One IfcRelAggregates per unit (not per room) — N rooms attach with
    // a single relationship, which BIMcollab Zoom and other viewers
    // collapse to one tree branch instead of N siblings.
    aggregate(ctx, unitSpace, roomSpaces, `${unitZone.id}-rooms`)
  }

  // Roof markers (Phase 3-8 Task 7) are RoofNodes parented to a synthetic
  // Roof level; the marker itself carries `metadata.bimai.roofRole ===
  // 'roof-marker'` and has no segment children in BimAI usage. Emit one
  // IfcRoof per marker, contained in the storey alongside slabs/walls.
  // The actual roof slab is already a SlabNode under this same level,
  // so the IfcRoof acts as a semantic tag — viewers (Solibri/BIMcollab)
  // pick it up to colour-code "roof" elements without us needing to
  // model a full roof body.
  const roofs = childrenOf<RoofNode>(scene, levelNode.id, 'roof')
  for (const roofNode of roofs) {
    const ent = emitRoof(ctx, roofNode, placement)
    contained.push(ent as unknown as IFC4.IfcProduct)
  }

  if (contained.length > 0) {
    const rel = new IFC4.IfcRelContainedInSpatialStructure(
      ifcGuid(ctx, levelNode.id, 'contains'),
      ctx.ownerHistory,
      new IFC4.IfcLabel('Contained'),
      null,
      contained as unknown as IFC4.IfcProduct[],
      storey as unknown as IFC4.IfcSpatialElement,
    )
    writeEntity(ctx, rel as unknown as { expressID: number })
  }
  return storey
}

// ── building elements ───────────────────────────────────────────────────────

function emitSlab(
  ctx: IfcWriteContext,
  slabNode: SlabNode,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  storeyElevation: number,
): IFC4.IfcSlab {
  // Slab thickness lives on the Pascal node as a height delta from
  // the level datum; default 0.2 m if missing. Pascal `elevation`
  // is the slab top, expressed in metres (see slab.ts comment).
  const thickness = 0.2
  // Slab placement sits on the storey datum; the polygon already
  // expresses the slab outline relative to the level origin.
  void storeyElevation
  const placement = localPlacement(ctx, [0, 0, slabNode.elevation], parentPlacement)
  const shape = slabShape(ctx, bodyContext, slabNode.polygon, thickness)
  const slab = new IFC4.IfcSlab(
    ifcGuid(ctx, slabNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(slabNode.name ?? 'Slab'),
    null,
    null,
    placement,
    shape,
    null,
    IFC4.IfcSlabTypeEnum.FLOOR,
  )
  return writeEntity(ctx, slab as unknown as { expressID: number }) as IFC4.IfcSlab
}

function emitWall(
  ctx: IfcWriteContext,
  wallNode: WallNode,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  storeyElevation: number,
): { entity: IFC4.IfcWallStandardCase; placement: IFC4.IfcLocalPlacement } {
  void storeyElevation
  const start = wallNode.start
  const end = wallNode.end
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const length = Math.hypot(dx, dy) || 0.001

  // Start-anchored placement: origin at `wall.start`, local X runs
  // from start → end. This matches Pascal's start-relative
  // `wallLocalX` convention so a door's `clamped` (range
  // `[halfW, length-halfW]`, measured from the start) lands as IFC
  // local X verbatim. The matching `wallShape` profile is shifted
  // `+length/2` along its local X so the wall body occupies local X
  // ∈ [0, length] under this anchor — see `geometry.ts:wallShape`
  // for why.
  //
  // Earlier this anchored at the midpoint via
  // `pascal2DToIfc(midpoint, 0)`, which planted every door L/2 past
  // its host wall's east end (BIMcollab "diagonal staircase"
  // pattern). The midline-relative profile masked the drift in
  // unit tests that used midpoint-relative fixtures; the producti­on
  // generator never emitted in that frame.
  const refDir: [number, number, number] = [dx / length, dy / length, 0]
  const origin = pascal2DToIfc(start, 0)
  const placement = localPlacement(ctx, origin, parentPlacement, [0, 0, 1], refDir)

  const thickness = wallNode.thickness ?? 0.2
  const height = wallNode.height ?? 3
  const shape = wallShape(ctx, bodyContext, length, thickness, height)
  const wall = new IFC4.IfcWallStandardCase(
    ifcGuid(ctx, wallNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(wallNode.name ?? 'Wall'),
    null,
    null,
    placement,
    shape,
    null,
    IFC4.IfcWallTypeEnum.STANDARD,
  )
  const entity = writeEntity(ctx, wall as unknown as { expressID: number }) as IFC4.IfcWallStandardCase
  return { entity, placement }
}

function emitDoor(
  ctx: IfcWriteContext,
  doorNode: DoorNode,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  walls: Map<
    string,
    { node: WallNode; entity: IFC4.IfcWallStandardCase; placement: IFC4.IfcLocalPlacement }
  >,
): IFC4.IfcDoor {
  // Resolve the host wall by `wallId` first — that's the schema field
  // that semantically points at the host. Fall back to `parentId` for
  // backwards compatibility with scenes whose generator pre-dated the
  // Phase 3-6 wallId fix (the discovery walk in emitLevel already proves
  // `parentId` is a wall, but the lookup needs an id either way).
  const hostId = doorNode.wallId ?? doorNode.parentId ?? undefined
  const host = hostId ? walls.get(hostId) : undefined
  const host_placement = host ? host.placement : parentPlacement

  // Door position is in *wall-local* coordinates when wallId is set
  // (Pascal local frame: X = along wall, Y = up, Z = transverse) and in
  // level-local coordinates otherwise (Pascal world frame: X = world,
  // Y = up, Z = world-planar). Both frames are Pascal Y-up triples, so
  // the same `pascalToIfc` swap (`[a, b, c] → [a, c, b]`) maps either
  // into the corresponding IFC frame: under the wall placement Y is
  // transverse / Z is up; under the level placement Y is planar / Z is
  // up. Inlining the swap per-branch was the source of doors floating
  // through the wall at Z=0 — see GATE 1 lock-in #8.
  const ifcLocal = pascalToIfc(doorNode.position as Pascal3D) as [number, number, number]
  // Pascal stores element-center Z (consistent with Pascal's mesh-relative renderer).
  // IFC IfcDoor.ObjectPlacement convention is bottom-edge midpoint — geometry extrudes
  // upward from origin. Subtract half-height to convert.
  // Pascal convention reference: packages/core/src/systems/door/door-system.tsx:239
  const halfHeight = (doorNode.height ?? DEFAULT_DOOR_HEIGHT_M) / 2
  ifcLocal[2] -= halfHeight
  const placement = localPlacement(ctx, ifcLocal, host_placement)

  // Door body: a thin box for export — the Pascal door has rich
  // segment geometry, but Phase 3-6 emits a simplified bounding box
  // so the IFC file stays under control. Future passes can add the
  // real leaf/frame geometry.
  const thickness = host?.node.thickness ?? 0.07
  const profile = polygonProfile(
    ctx,
    rectanglePolygonCentred(doorNode.width, thickness),
    'DoorBody',
  )
  const solid = extrudeUp(ctx, profile, doorNode.height)
  const rep = bodyRepresentation(ctx, bodyContext, solid)
  const shape = productShape(ctx, [rep])

  const door = new IFC4.IfcDoor(
    ifcGuid(ctx, doorNode.id, 'door'),
    ctx.ownerHistory,
    new IFC4.IfcLabel(doorNode.name ?? 'Door'),
    null,
    null,
    placement,
    shape,
    null,
    new IFC4.IfcPositiveLengthMeasure(doorNode.height),
    new IFC4.IfcPositiveLengthMeasure(doorNode.width),
    IFC4.IfcDoorTypeEnum.DOOR,
    null,
    null,
  )
  writeEntity(ctx, door as unknown as { expressID: number })

  if (host) {
    emitOpening(
      ctx,
      doorNode.id,
      doorNode.width,
      doorNode.height,
      host.node.thickness ?? 0.2,
      placement,
      bodyContext,
      host.entity,
      door as unknown as IFC4.IfcElement,
    )
  }
  return door
}

function emitWindow(
  ctx: IfcWriteContext,
  winNode: WindowNode,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  walls: Map<
    string,
    { node: WallNode; entity: IFC4.IfcWallStandardCase; placement: IFC4.IfcLocalPlacement }
  >,
): IFC4.IfcWindow {
  // See emitDoor for the wallId/parentId fallback rationale.
  const hostId = winNode.wallId ?? winNode.parentId ?? undefined
  const host = hostId ? walls.get(hostId) : undefined
  const host_placement = host ? host.placement : parentPlacement
  // Same logic as emitDoor: Pascal Y-up in either wall-local or
  // level-local — one swap fits both. See the comment in emitDoor.
  const ifcLocal = pascalToIfc(winNode.position as Pascal3D) as [number, number, number]
  // Pascal stores element-center Z (consistent with Pascal's mesh-relative renderer).
  // IFC IfcWindow.ObjectPlacement convention is bottom-edge midpoint — geometry extrudes
  // upward from origin, so the local Z must equal the sill height. Subtract half-height
  // to convert from Pascal's centroid Y to IFC's bottom-edge Z.
  // Pascal convention reference: packages/core/src/systems/window/window-system.tsx (mesh.position.set with mirrored ±height/2 frame children, identical to door-system.tsx:239's center-anchor convention)
  const halfHeight = (winNode.height ?? DEFAULT_WINDOW_HEIGHT_M) / 2
  ifcLocal[2] -= halfHeight
  const placement = localPlacement(ctx, ifcLocal, host_placement)

  const thickness = host?.node.thickness ?? 0.07
  const profile = polygonProfile(
    ctx,
    rectanglePolygonCentred(winNode.width, thickness),
    'WindowBody',
  )
  const solid = extrudeUp(ctx, profile, winNode.height)
  const rep = bodyRepresentation(ctx, bodyContext, solid)
  const shape = productShape(ctx, [rep])

  const win = new IFC4.IfcWindow(
    ifcGuid(ctx, winNode.id, 'window'),
    ctx.ownerHistory,
    new IFC4.IfcLabel(winNode.name ?? 'Window'),
    null,
    null,
    placement,
    shape,
    null,
    new IFC4.IfcPositiveLengthMeasure(winNode.height),
    new IFC4.IfcPositiveLengthMeasure(winNode.width),
    IFC4.IfcWindowTypeEnum.WINDOW,
    null,
    null,
  )
  writeEntity(ctx, win as unknown as { expressID: number })

  if (host) {
    emitOpening(
      ctx,
      winNode.id,
      winNode.width,
      winNode.height,
      host.node.thickness ?? 0.2,
      placement,
      bodyContext,
      host.entity,
      win as unknown as IFC4.IfcElement,
    )
  }
  return win
}

/**
 * Emit a zone as an IfcSpace.
 *
 * `options.name` overrides the IfcSpace.Name (default: `zoneNode.name`);
 * `options.longName` populates IfcSpatialElement.LongName, which is
 * `null` by default. Phase 3-7 Task 9 uses the override to give room
 * IfcSpaces a "${unitType} - ${roomKind}" name and a bare
 * "${roomKind}" LongName for viewer property panels.
 */
function emitZone(
  ctx: IfcWriteContext,
  zoneNode: ZoneNode,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  storeyElevation: number,
  floorToFloorHeightM: number,
  options: { name?: string; longName?: string } = {},
): IFC4.IfcSpace {
  void storeyElevation
  const placement = localPlacement(ctx, [0, 0, 0], parentPlacement)
  const profile = polygonProfile(ctx, zoneNode.polygon, 'SpaceFootprint')
  const solid = extrudeUp(ctx, profile, floorToFloorHeightM)
  const rep = bodyRepresentation(ctx, bodyContext, solid)
  const shape = productShape(ctx, [rep])
  const space = new IFC4.IfcSpace(
    ifcGuid(ctx, zoneNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(options.name ?? zoneNode.name),
    null,
    null,
    placement,
    shape,
    options.longName != null ? new IFC4.IfcLabel(options.longName) : null,
    IFC4.IfcElementCompositionEnum.ELEMENT,
    IFC4.IfcSpaceTypeEnum.INTERNAL,
    null,
  )
  return writeEntity(ctx, space as unknown as { expressID: number }) as IFC4.IfcSpace
}

function emitOpening(
  ctx: IfcWriteContext,
  seedId: string,
  widthM: number,
  heightM: number,
  wallThicknessM: number,
  placement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  hostWall: IFC4.IfcWallStandardCase,
  filling: IFC4.IfcElement,
): void {
  // Slightly oversize the cut on the thickness axis so floating-point
  // rounding doesn't leave a paper-thin sliver of wall in the void.
  const cutThickness = wallThicknessM + 0.02
  const shape = openingShape(ctx, bodyContext, widthM, cutThickness, heightM)
  const opening = new IFC4.IfcOpeningElement(
    ifcGuid(ctx, seedId, 'opening'),
    ctx.ownerHistory,
    new IFC4.IfcLabel('Opening'),
    null,
    null,
    placement,
    shape,
    null,
    IFC4.IfcOpeningElementTypeEnum.OPENING,
  )
  writeEntity(ctx, opening as unknown as { expressID: number })

  const voids = new IFC4.IfcRelVoidsElement(
    ifcGuid(ctx, seedId, 'voids'),
    ctx.ownerHistory,
    new IFC4.IfcLabel('Voids'),
    null,
    hostWall as unknown as IFC4.IfcElement,
    opening as unknown as IFC4.IfcFeatureElementSubtraction,
  )
  writeEntity(ctx, voids as unknown as { expressID: number })

  const fills = new IFC4.IfcRelFillsElement(
    ifcGuid(ctx, seedId, 'fills'),
    ctx.ownerHistory,
    new IFC4.IfcLabel('Fills'),
    null,
    opening,
    filling,
  )
  writeEntity(ctx, fills as unknown as { expressID: number })
}

// ── stairs and roof (Phase 3-8) ─────────────────────────────────────────────

/**
 * Emit an IfcStair container plus one IfcStairFlight per child
 * StairSegmentNode, aggregate the flights under the stair, and contain
 * the stair in the storey indicated by `stair.fromLevelId`. Falls back
 * to the first storey in the map when `fromLevelId` is unset or the
 * matching storey can't be resolved (e.g. a stair pointing at a level
 * that was filtered out as the untagged Level 0).
 *
 * The IfcStair itself carries no Representation — it's a grouping
 * element; viewers walk IfcRelAggregates to find the geometry on its
 * IfcStairFlight children.
 */
function emitStair(
  ctx: IfcWriteContext,
  scene: SceneSnapshot,
  stairNode: StairNode,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
  storeyByLevelId: Map<AnyNodeId, IFC4.IfcBuildingStorey>,
): void {
  const origin: Ifc3D = pascalToIfc(stairNode.position as Pascal3D)
  const placement = localPlacement(ctx, origin, parentPlacement)

  const stair = new IFC4.IfcStair(
    ifcGuid(ctx, stairNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(stairNode.name ?? 'Stair'),
    null,
    null,
    placement,
    null,
    null,
    IFC4.IfcStairTypeEnum.STRAIGHT_RUN_STAIR,
  )
  writeEntity(ctx, stair as unknown as { expressID: number })

  // Emit one IfcStairFlight per child segment; aggregate under the stair.
  const segments = childrenOf<StairSegmentNode>(scene, stairNode.id, 'stair-segment')
  const flights: IFC4.IfcStairFlight[] = []
  for (const seg of segments) {
    const flight = emitStairFlight(ctx, seg, placement, bodyContext)
    flights.push(flight)
  }
  if (flights.length > 0) {
    aggregate(ctx, stair, flights, `${stairNode.id}-flights`)
  }

  // Contain the IfcStair in the storey corresponding to `fromLevelId`.
  // If that level was filtered out (e.g. untagged Level 0), pick the
  // first available storey so the stair still attaches to the spatial
  // tree rather than dangling.
  let storey: IFC4.IfcBuildingStorey | undefined
  if (stairNode.fromLevelId) {
    storey = storeyByLevelId.get(stairNode.fromLevelId as AnyNodeId)
  }
  if (!storey) {
    const first = storeyByLevelId.values().next()
    if (!first.done) storey = first.value
  }
  if (storey) {
    const rel = new IFC4.IfcRelContainedInSpatialStructure(
      ifcGuid(ctx, stairNode.id, 'stair-contains'),
      ctx.ownerHistory,
      new IFC4.IfcLabel('Contained'),
      null,
      [stair] as unknown as IFC4.IfcProduct[],
      storey as unknown as IFC4.IfcSpatialElement,
    )
    writeEntity(ctx, rel as unknown as { expressID: number })
  }
}

/**
 * Emit one IfcStairFlight for a StairSegmentNode.
 *
 * Phase 3-9 (`segmentType === 'stair'`): the body is a *ramped* slab.
 * Profile = `width × thickness` (cross-section perpendicular to the
 * width axis); extrusion direction = the slope tangent
 * `(0, run, rise) / |...|`; depth = slope length. The IFC primitive
 * (`IfcExtrudedAreaSolid` with a non-axis-aligned ExtrudedDirection)
 * sweeps the cross-section along the inclined plane, producing the
 * inclined slab BIMcollab Zoom and Solibri render as a recognisable
 * stair flight. (Phase 3-8 emitted this as a flat box — visually
 * correct as a tagged "flight" but not a slope.)
 *
 * Note vs the brief sketch. The brief proposed `profile = width ×
 * (treadLength × stepCount)` (i.e., the floor-plan footprint)
 * extruded along the slope by the slope length. That sweep produces
 * a parallelepiped twice as long as the run — geometrically wrong
 * for a slab. The cross-section interpretation (`width × thickness`)
 * is the conventional ramped-slab encoding and matches what real
 * BIM authoring tools (Revit, ArchiCAD) emit for IFC4 stair flights.
 *
 * Landings (`segmentType === 'landing'`): unchanged — flat extrusion
 * by `thickness`, no slope.
 *
 * Pascal segment position is local to the parent StairNode; the
 * IfcLocalPlacement chain naturally composes that under the stair.
 */
function emitStairFlight(
  ctx: IfcWriteContext,
  segNode: StairSegmentNode,
  parentPlacement: IFC4.IfcLocalPlacement,
  bodyContext: IFC4.IfcGeometricRepresentationSubContext,
): IFC4.IfcStairFlight {
  const origin: Ifc3D = pascalToIfc(segNode.position as Pascal3D)
  const placement = localPlacement(ctx, origin, parentPlacement)

  const isStair = segNode.segmentType === 'stair'
  const width = segNode.width ?? 1
  const length = segNode.length ?? 1
  const thickness = Math.max(segNode.thickness ?? 0.2, 0.01)

  let solid: IFC4.IfcExtrudedAreaSolid
  if (isStair && (segNode.height ?? 0) > 1e-9) {
    // Ramped slab. Cross-section profile (`width × thickness`) sits
    // in the local XY plane; the slope tangent in IFC coords is
    // (run-axis, 0, rise) — Pascal's stair runs along its local +Y,
    // which `pascalToIfc` maps to IFC +Y. Slope length is the
    // hypotenuse of run × rise.
    const run = length
    const rise = segNode.height ?? 0
    const profile = polygonProfile(
      ctx,
      rectanglePolygonCentred(width, thickness),
      'StairFlightSection',
    )
    const slopeLength = Math.hypot(run, rise)
    solid = extrudeAlong(ctx, profile, [0, run, rise], slopeLength)
  } else {
    // Landing or zero-rise stair (degenerate, treated as a flat
    // plate). Same axis-aligned extrusion Phase 3-8 emitted.
    const profile = polygonProfile(
      ctx,
      rectanglePolygonCentred(width, length),
      'StairFlightBody',
    )
    const flatHeight = isStair ? Math.max(segNode.height ?? 0, 0.01) : thickness
    solid = extrudeUp(ctx, profile, flatHeight)
  }
  const rep = bodyRepresentation(ctx, bodyContext, solid)
  const shape = productShape(ctx, [rep])

  const stepCount = segNode.stepCount ?? 0
  const hasSteps = isStair && stepCount > 0
  const numberOfRiser = hasSteps ? stepCount : null
  const numberOfTreads = hasSteps ? Math.max(stepCount - 1, 1) : null
  const riserHeight = hasSteps && (segNode.height ?? 0) > 0
    ? new IFC4.IfcPositiveLengthMeasure((segNode.height ?? 0) / stepCount)
    : null
  const treadLength = hasSteps
    ? new IFC4.IfcPositiveLengthMeasure(length / Math.max(stepCount - 1, 1))
    : null

  const flight = new IFC4.IfcStairFlight(
    ifcGuid(ctx, segNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(segNode.name ?? (isStair ? 'StairFlight' : 'Landing')),
    null,
    null,
    placement,
    shape,
    null,
    numberOfRiser,
    numberOfTreads,
    riserHeight,
    treadLength,
  )
  return writeEntity(ctx, flight as unknown as { expressID: number }) as IFC4.IfcStairFlight
}

/**
 * Emit a marker IfcRoof (Phase 3-8 Task 7). The Pascal RoofNode is a
 * container with empty children in BimAI usage — it tags the synthetic
 * Roof level so viewers can filter "roof" semantically. No body: the
 * actual roof slab is a sibling SlabNode handled via `emitSlab`.
 */
function emitRoof(
  ctx: IfcWriteContext,
  roofNode: RoofNode,
  parentPlacement: IFC4.IfcLocalPlacement,
): IFC4.IfcRoof {
  const origin: Ifc3D = pascalToIfc(roofNode.position as Pascal3D)
  const placement = localPlacement(ctx, origin, parentPlacement)
  const roof = new IFC4.IfcRoof(
    ifcGuid(ctx, roofNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(roofNode.name ?? 'Roof'),
    null,
    null,
    placement,
    null,
    null,
    IFC4.IfcRoofTypeEnum.FLAT_ROOF,
  )
  return writeEntity(ctx, roof as unknown as { expressID: number }) as IFC4.IfcRoof
}

/**
 * Emit an IfcTransportElement (PredefinedType: ELEVATOR) for an
 * elevator-cabin marker ZoneNode (Phase 3-9 Task 12). No
 * Representation — the cabin is the absence of structure inside the
 * shaft walls; the IFC entity is the semantic tag viewers (BIMcollab
 * Zoom, Solibri) display in the spatial tree under the storey. The
 * shaft walls + per-floor doors are emitted via the standard wall /
 * door paths and contain themselves in the storey naturally.
 *
 * Cabin id is the ZoneNode id; GUID derived deterministically via
 * `ifcGuid(ctx, zoneNode.id, '')` so regen produces stable IFC ids.
 */
function emitElevatorCabin(
  ctx: IfcWriteContext,
  zoneNode: ZoneNode,
  parentPlacement: IFC4.IfcLocalPlacement,
): IFC4.IfcTransportElement {
  // Anchor at the zone's polygon centroid lifted to 0 in IFC Z. The
  // cabin has no body; this just gives the entity a placement so
  // viewers can locate it in the storey's coordinate frame.
  const cx =
    zoneNode.polygon.reduce((s, p) => s + p[0], 0) / zoneNode.polygon.length
  const cy =
    zoneNode.polygon.reduce((s, p) => s + p[1], 0) / zoneNode.polygon.length
  const origin: Ifc3D = pascalToIfc([cx, 0, cy])
  const placement = localPlacement(ctx, origin, parentPlacement)
  const elevator = new IFC4.IfcTransportElement(
    ifcGuid(ctx, zoneNode.id, ''),
    ctx.ownerHistory,
    new IFC4.IfcLabel(zoneNode.name ?? 'Elevator'),
    null,
    null,
    placement,
    null,
    null,
    IFC4.IfcTransportElementTypeEnum.ELEVATOR,
  )
  return writeEntity(ctx, elevator as unknown as { expressID: number }) as IFC4.IfcTransportElement
}

// ── psets ───────────────────────────────────────────────────────────────────

function standardPset(
  ctx: IfcWriteContext,
  name: string,
  props: Array<{ name: string; value: IfcPsetValue }>,
  related: IFC4.IfcObjectDefinition[],
  seed: string,
): void {
  if (props.length === 0) return
  const ifcProps: IFC4.IfcProperty[] = []
  for (const p of props) {
    const value = p.value
    const ifcValue =
      value.kind === 'bool'
        ? (new IFC4.IfcBoolean(value.v) as unknown as IFC4.IfcValue)
        : value.kind === 'real'
          ? (new IFC4.IfcReal(value.v) as unknown as IFC4.IfcValue)
          : (new IFC4.IfcLabel(value.v) as unknown as IFC4.IfcValue)
    const single = new IFC4.IfcPropertySingleValue(
      new IFC4.IfcIdentifier(p.name),
      null,
      ifcValue,
      null,
    )
    writeEntity(ctx, single as unknown as { expressID: number })
    ifcProps.push(single)
  }
  const pset = new IFC4.IfcPropertySet(
    ifcGuid(ctx, seed, `pset-${name}`),
    ctx.ownerHistory,
    new IFC4.IfcLabel(name),
    null,
    ifcProps as unknown as IFC4.IfcProperty[],
  )
  writeEntity(ctx, pset as unknown as { expressID: number })
  const rel = new IFC4.IfcRelDefinesByProperties(
    ifcGuid(ctx, seed, `rel-pset-${name}`),
    ctx.ownerHistory,
    new IFC4.IfcLabel(name),
    null,
    related as unknown as IFC4.IfcObjectDefinition[],
    pset as unknown as IFC4.IfcPropertySetDefinitionSelect,
  )
  writeEntity(ctx, rel as unknown as { expressID: number })
}

type IfcPsetValue =
  | { kind: 'bool'; v: boolean }
  | { kind: 'real'; v: number }
  | { kind: 'label'; v: string }

function commonPropsForWall(
  wall: WallNode,
  bim: ComponentBIM | undefined,
): Array<{ name: string; value: IfcPsetValue }> {
  // IsExternal: derive from Pascal's `frontSide`/`backSide`. A wall is
  // exterior if either face is marked exterior.
  const isExternal = wall.frontSide === 'exterior' || wall.backSide === 'exterior'
  const out: Array<{ name: string; value: IfcPsetValue }> = [
    { name: 'IsExternal', value: { kind: 'bool', v: isExternal } },
    { name: 'LoadBearing', value: { kind: 'bool', v: bim?.loadBearing ?? false } },
  ]
  if (bim?.fireRating && bim.fireRating !== 'unrated') {
    out.push({ name: 'FireRating', value: { kind: 'label', v: bim.fireRating } })
  }
  return out
}

function commonPropsForSlab(
  bim: ComponentBIM | undefined,
): Array<{ name: string; value: IfcPsetValue }> {
  const out: Array<{ name: string; value: IfcPsetValue }> = [
    { name: 'LoadBearing', value: { kind: 'bool', v: bim?.loadBearing ?? true } },
  ]
  if (bim?.fireRating && bim.fireRating !== 'unrated') {
    out.push({ name: 'FireRating', value: { kind: 'label', v: bim.fireRating } })
  }
  return out
}

function commonPropsForDoor(
  bim: ComponentBIM | undefined,
): Array<{ name: string; value: IfcPsetValue }> {
  const out: Array<{ name: string; value: IfcPsetValue }> = [
    { name: 'IsExternal', value: { kind: 'bool', v: false } },
  ]
  if (bim?.fireRating && bim.fireRating !== 'unrated') {
    out.push({ name: 'FireRating', value: { kind: 'label', v: bim.fireRating } })
  }
  return out
}

function commonPropsForWindow(
  bim: ComponentBIM | undefined,
): Array<{ name: string; value: IfcPsetValue }> {
  const out: Array<{ name: string; value: IfcPsetValue }> = [
    { name: 'IsExternal', value: { kind: 'bool', v: true } },
  ]
  if (bim?.fireRating && bim.fireRating !== 'unrated') {
    out.push({ name: 'FireRating', value: { kind: 'label', v: bim.fireRating } })
  }
  return out
}

function commonPropsForSpace(): Array<{ name: string; value: IfcPsetValue }> {
  return [{ name: 'PubliclyAccessible', value: { kind: 'bool', v: false } }]
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Apply both material association and the BimAI cost pset to one
 *  building element. Centralises the seed convention so the two GUIDs
 *  are derived consistently. */
function associateAndCost(
  ctx: IfcWriteContext,
  materials: MaterialRegistry,
  element: IFC4.IfcObjectDefinition,
  seed: string,
  bim: ComponentBIM | undefined,
): void {
  materials.associate([element], bim?.material, seed)
  buildBimAICostPset(ctx, [element], bim?.material, bim?.costOverride, seed)
}

function aggregate(
  ctx: IfcWriteContext,
  parent: IFC4.IfcObjectDefinition,
  children: IFC4.IfcObjectDefinition[],
  seed: string,
): void {
  const rel = new IFC4.IfcRelAggregates(
    ifcGuid(ctx, seed, 'agg'),
    ctx.ownerHistory,
    new IFC4.IfcLabel('Aggregates'),
    null,
    parent,
    children as unknown as IFC4.IfcObjectDefinition[],
  )
  writeEntity(ctx, rel as unknown as { expressID: number })
}

/**
 * Fill in `parentId: null` from each node's `children` array when
 * possible. Pascal's `loadScene` produces a hybrid representation:
 * the flat `nodes` dictionary lists every node, but the default
 * Site/Building/Level have `parentId: null` and the hierarchy lives
 * inside each parent's `children` field — which may contain either
 * full embedded objects (e.g. `Site.children = [building]`) or string
 * IDs (e.g. `Building.children = [levelId]`).
 *
 * We never overwrite a non-null parentId — this is gap-filling, not
 * authority assertion. Nodes whose parent we can't infer are left
 * with `parentId: null` and silently skipped by the walk, which is
 * the correct degenerate behaviour (a stray node with no parent
 * should not appear in the IFC spatial structure).
 */
function normalizeParentIds(scene: SceneSnapshot): SceneSnapshot {
  const nodes: Record<AnyNodeId, AnyNode> = { ...scene.nodes }
  for (const parent of Object.values(scene.nodes)) {
    const kids = (parent as { children?: unknown }).children
    if (!Array.isArray(kids)) continue
    for (const kid of kids) {
      // children entries are either full embedded objects with an `id`
      // field, or bare string IDs. Treat both forms identically.
      const childId =
        typeof kid === 'string'
          ? (kid as AnyNodeId)
          : (kid as { id?: AnyNodeId } | null)?.id
      if (!childId) continue
      const flatChild = nodes[childId]
      // Only fill the gap; never overwrite an existing valid parentId.
      if (flatChild && flatChild.parentId === null) {
        nodes[childId] = { ...flatChild, parentId: parent.id } as AnyNode
      }
    }
  }
  return { ...scene, nodes }
}

/** Return all `parentId === parentId` nodes of the given type, sorted
 *  by id for deterministic emission order. */
function childrenOf<T extends AnyNode>(
  scene: SceneSnapshot,
  parentId: AnyNodeId,
  type: T['type'],
): T[] {
  const out: T[] = []
  for (const node of Object.values(scene.nodes)) {
    if (node.parentId !== parentId) continue
    if (node.type !== type) continue
    out.push(node as T)
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

function scanByType<T extends AnyNode>(
  scene: SceneSnapshot,
  type: T['type'],
): T[] {
  const out: T[] = []
  for (const node of Object.values(scene.nodes)) {
    if (node.type !== type) continue
    out.push(node as T)
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/** Read `metadata.bimai.bim` if present. Pascal's `metadata` is an
 *  unstructured `z.json()` blob, so this is a runtime probe rather
 *  than a schema-driven access. */
function getBim(node: AnyNode): ComponentBIM | undefined {
  const md = (node as { metadata?: unknown }).metadata
  if (!md || typeof md !== 'object') return undefined
  const bimai = (md as { bimai?: unknown }).bimai
  if (!bimai || typeof bimai !== 'object') return undefined
  const bim = (bimai as { bim?: unknown }).bim
  if (!bim || typeof bim !== 'object') return undefined
  return bim as ComponentBIM
}

/**
 * Phase 3-7 Task 6 room-zone discriminator. A zone is a *room* zone
 * (not a unit zone) iff its metadata carries `bimai.roomKind` and
 * `bimai.unitId`; both fields are written by `emitRoomZones` in the
 * generator. Returns `null` for unit zones, so the IFC writer's split
 * into unit/room buckets stays a one-line check.
 */
function getRoomZoneMeta(node: AnyNode): { roomKind: string; unitId: string } | null {
  const md = (node as { metadata?: unknown }).metadata
  if (!md || typeof md !== 'object') return null
  const bimai = (md as { bimai?: unknown }).bimai
  if (!bimai || typeof bimai !== 'object') return null
  const roomKind = (bimai as { roomKind?: unknown }).roomKind
  const unitId = (bimai as { unitId?: unknown }).unitId
  if (typeof roomKind !== 'string' || typeof unitId !== 'string') return null
  return { roomKind, unitId }
}

/** Centred 4-point rectangle polygon (closed by `polygonProfile`). */
function rectanglePolygonCentred(
  width: number,
  depth: number,
): ReadonlyArray<readonly [number, number]> {
  const hx = width / 2
  const hy = depth / 2
  return [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ]
}

// `pascalPolygonToIfc` is re-exported for callers that need to lift a
// 2D polygon to 3D themselves; the orchestrator keeps the polygon flat
// because Pascal slabs already carry their elevation on the slab node.
void pascalPolygonToIfc
