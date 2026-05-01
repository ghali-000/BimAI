// Integration / E2E tests for the IFC writer.
//
// Each spec boots web-ifc via `initIfcApi`, builds a small in-memory
// SceneSnapshot, calls `writeIFC`, decodes the resulting bytes as text
// (STEP files are ASCII), and asserts on substrings + structure. We
// reset the wasm singleton between specs so vitest's worker reuse
// doesn't leak model state across tests.

import { afterEach, describe, expect, it } from 'vitest'
import type {
  AnyNode,
  AnyNodeId,
  BuildingNode,
  DoorNode,
  LevelNode,
  SiteNode,
  SlabNode,
  WallNode,
  WindowNode,
  ZoneNode,
} from '@pascal-app/core'
import type { ComponentBIM } from '../bim/schemas/component-bim'
import type { SceneSnapshot } from '../generator/cleanup'
import { __resetIfcApiForTests, initIfcApi } from './init'
import { writeIFC } from './write'

// ── fixture helper ──────────────────────────────────────────────────────────

interface SceneIds {
  site: string
  building: string
  level: string
  slab: string
  wall: string
  door: string
  window: string
  zone: string
}

interface BuildSceneOpts {
  /** When set, attach `metadata.bimai.bim.material` to the slab/wall using
   *  the catalog ids "concrete-slab-residential" + "brick-exterior". */
  withMaterials?: boolean
  /** When false, omit the door from the scene (used by the spec that
   *  asserts the bare spatial spine). Defaults to true. */
  withDoor?: boolean
  /** When false, omit the window. Defaults to true. */
  withWindow?: boolean
  /** When false, omit the zone. Defaults to true. */
  withZone?: boolean
  /** When false, omit the wallId on the door so no opening is emitted. */
  doorHostsWall?: boolean
}

function buildScene(opts: BuildSceneOpts = {}): { scene: SceneSnapshot; ids: SceneIds } {
  const withDoor = opts.withDoor ?? true
  const withWindow = opts.withWindow ?? true
  const withZone = opts.withZone ?? true
  const doorHostsWall = opts.doorHostsWall ?? true

  const ids: SceneIds = {
    site: 'site_test_001',
    building: 'building_test_001',
    level: 'level_test_001',
    slab: 'slab_test_001',
    wall: 'wall_test_001',
    door: 'door_test_001',
    window: 'window_test_001',
    zone: 'zone_test_001',
  }

  const slabBim: ComponentBIM | undefined = opts.withMaterials
    ? ({
        material: 'concrete-slab-residential',
        fireRating: 'unrated',
        loadBearing: true,
      } as unknown as ComponentBIM)
    : undefined
  const wallBim: ComponentBIM | undefined = opts.withMaterials
    ? ({
        material: 'brick-exterior',
        fireRating: 'unrated',
        loadBearing: false,
      } as unknown as ComponentBIM)
    : undefined

  // Build plain objects matching the Pascal node shapes. We use `as
  // unknown as AnyNode` casts at the test seam — the writer reads only
  // a subset of each schema and tolerates missing optional fields.
  const site = {
    object: 'node',
    id: ids.site,
    type: 'site',
    parentId: null,
    name: 'Test Site',
    visible: true,
    metadata: {},
    polygon: { type: 'polygon', points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] },
    children: [],
  } as unknown as SiteNode

  const building = {
    object: 'node',
    id: ids.building,
    type: 'building',
    parentId: ids.site,
    name: 'Test Building',
    visible: true,
    metadata: {},
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    children: [],
  } as unknown as BuildingNode

  const level = {
    object: 'node',
    id: ids.level,
    type: 'level',
    parentId: ids.building,
    name: 'Level 0',
    visible: true,
    metadata: {},
    level: 0,
    children: [],
  } as unknown as LevelNode

  const slab = {
    object: 'node',
    id: ids.slab,
    type: 'slab',
    parentId: ids.level,
    name: 'Slab',
    visible: true,
    metadata: slabBim ? { bimai: { bim: slabBim } } : {},
    polygon: [
      [-5, -5],
      [5, -5],
      [5, 5],
      [-5, 5],
    ],
    holes: [],
    holeMetadata: [],
    elevation: 0,
    autoFromWalls: false,
  } as unknown as SlabNode

  const wall = {
    object: 'node',
    id: ids.wall,
    type: 'wall',
    parentId: ids.level,
    name: 'Wall',
    visible: true,
    metadata: wallBim ? { bimai: { bim: wallBim } } : {},
    start: [-5, 0],
    end: [5, 0],
    thickness: 0.2,
    height: 3,
    frontSide: 'exterior',
    backSide: 'interior',
    children: [],
  } as unknown as WallNode

  // Doors are parented to their host wall (matching the generator's
  // `parentId: wall.id` in `emit.ts`), not to the level. The IFC
  // writer walks Level → Wall → Door for discovery.
  const door = {
    object: 'node',
    id: ids.door,
    type: 'door',
    parentId: ids.wall,
    name: 'Door',
    visible: true,
    metadata: {},
    position: [0, 1.05, 0],
    rotation: [0, 0, 0],
    wallId: doorHostsWall ? ids.wall : undefined,
    width: 0.9,
    height: 2.1,
    frameThickness: 0.05,
    frameDepth: 0.07,
    threshold: true,
    thresholdHeight: 0.02,
    hingesSide: 'left',
    swingDirection: 'inward',
    segments: [],
    handle: true,
    handleHeight: 1.05,
    handleSide: 'right',
    contentPadding: [0.04, 0.04],
    doorCloser: false,
    panicBar: false,
    panicBarHeight: 1,
  } as unknown as DoorNode

  // Windows: same parenting rule as doors — host wall is the parent.
  const win = {
    object: 'node',
    id: ids.window,
    type: 'window',
    parentId: ids.wall,
    name: 'Window',
    visible: true,
    metadata: {},
    position: [2, 1.5, 0],
    rotation: [0, 0, 0],
    wallId: ids.wall,
    width: 1.2,
    height: 1.2,
    frameThickness: 0.05,
    frameDepth: 0.07,
    columnRatios: [1],
    rowRatios: [1],
    columnDividerThickness: 0.03,
    rowDividerThickness: 0.03,
    sill: true,
    sillDepth: 0.08,
    sillThickness: 0.03,
  } as unknown as WindowNode

  const zone = {
    object: 'node',
    id: ids.zone,
    type: 'zone',
    parentId: ids.level,
    name: 'Living Room',
    visible: true,
    metadata: {},
    polygon: [
      [-4, -4],
      [4, -4],
      [4, 4],
      [-4, 4],
    ],
    color: '#3b82f6',
  } as unknown as ZoneNode

  const nodes: Record<AnyNodeId, AnyNode> = {
    [ids.site as AnyNodeId]: site as unknown as AnyNode,
    [ids.building as AnyNodeId]: building as unknown as AnyNode,
    [ids.level as AnyNodeId]: level as unknown as AnyNode,
    [ids.slab as AnyNodeId]: slab as unknown as AnyNode,
    [ids.wall as AnyNodeId]: wall as unknown as AnyNode,
  }
  if (withDoor) nodes[ids.door as AnyNodeId] = door as unknown as AnyNode
  if (withWindow) nodes[ids.window as AnyNodeId] = win as unknown as AnyNode
  if (withZone) nodes[ids.zone as AnyNodeId] = zone as unknown as AnyNode

  return { scene: { nodes }, ids }
}

async function runWrite(
  scene: SceneSnapshot,
  projectSalt = 'test-salt',
  projectName = 'BimAI Test',
): Promise<{ bytes: Uint8Array; text: string }> {
  const api = await initIfcApi()
  const bytes = await writeIFC(api, scene, { projectName, projectSalt })
  const text = new TextDecoder().decode(bytes)
  return { bytes, text }
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('writeIFC', () => {
  afterEach(() => {
    __resetIfcApiForTests()
  })

  describe('STEP file structure', () => {
    it('returns a non-empty Uint8Array', async () => {
      const { scene } = buildScene()
      const { bytes } = await runWrite(scene)
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.length).toBeGreaterThan(0)
    })

    it('starts with the STEP physical-file prelude and ends with END-ISO-10303-21', async () => {
      const { scene } = buildScene()
      const { text } = await runWrite(scene)
      expect(text.startsWith('ISO-10303-21;')).toBe(true)
      expect(text.trim().endsWith('END-ISO-10303-21;')).toBe(true)
    })

    it('emits a header section with FILE_DESCRIPTION, FILE_NAME and FILE_SCHEMA', async () => {
      const { scene } = buildScene()
      const { text } = await runWrite(scene)
      expect(text).toContain('FILE_DESCRIPTION')
      expect(text).toContain('FILE_NAME')
      expect(text).toContain('FILE_SCHEMA')
    })

    it('declares the IFC4 schema in FILE_SCHEMA', async () => {
      const { scene } = buildScene()
      const { text } = await runWrite(scene)
      expect(text).toContain('IFC4')
    })
  })

  describe('required IFC entities', () => {
    it('contains the spatial spine: project, site, building, storey', async () => {
      const { scene } = buildScene()
      const { text } = await runWrite(scene)
      expect(text).toContain('IFCPROJECT')
      expect(text).toContain('IFCSITE')
      expect(text).toContain('IFCBUILDING(')
      expect(text).toContain('IFCBUILDINGSTOREY')
    })

    it('contains the building elements: slab, wall, door, window, space', async () => {
      const { scene } = buildScene()
      const { text } = await runWrite(scene)
      expect(text).toContain('IFCSLAB')
      expect(text).toContain('IFCWALLSTANDARDCASE')
      expect(text).toContain('IFCDOOR')
      expect(text).toContain('IFCWINDOW')
      expect(text).toContain('IFCSPACE')
    })

    it('contains the foundational singletons: owner history, units, geometric context', async () => {
      const { scene } = buildScene()
      const { text } = await runWrite(scene)
      expect(text).toContain('IFCOWNERHISTORY')
      expect(text).toContain('IFCUNITASSIGNMENT')
      expect(text).toContain('IFCGEOMETRICREPRESENTATIONCONTEXT')
    })
  })

  describe('materials and psets', () => {
    it('emits IfcMaterial + IfcRelAssociatesMaterial with catalog names for slab and wall', async () => {
      const { scene } = buildScene({
        withMaterials: true,
        withDoor: false,
        withWindow: false,
        withZone: false,
      })
      const { text } = await runWrite(scene)
      expect(text).toContain('IFCMATERIAL(')
      expect(text).toContain('IFCRELASSOCIATESMATERIAL')
      // Catalog names from BIMAI_MATERIALS — slab uses concrete slab w/ insulation,
      // wall uses brick veneer.
      expect(text).toContain('Reinforced concrete slab w/ thermal insulation')
      expect(text).toContain('Brick veneer on stud')
    })

    it('emits Pset_BimAI_Cost with a CostPerM2 property', async () => {
      const { scene } = buildScene({ withMaterials: true })
      const { text } = await runWrite(scene)
      expect(text).toContain('Pset_BimAI_Cost')
      expect(text).toContain('CostPerM2')
    })
  })

  describe('determinism', () => {
    it('produces byte-identical output for the same scene and salt', async () => {
      const { scene } = buildScene({ withMaterials: true })
      const { bytes: first } = await runWrite(scene, 'fixed-salt')
      __resetIfcApiForTests()
      const { bytes: second } = await runWrite(scene, 'fixed-salt')
      expect(second.length).toBe(first.length)
      // Compare full byte content.
      const a = Buffer.from(first)
      const b = Buffer.from(second)
      expect(a.equals(b)).toBe(true)
    })

    it('produces different output for different project salts', async () => {
      const { scene } = buildScene()
      const { text: a } = await runWrite(scene, 'salt-a')
      __resetIfcApiForTests()
      const { text: b } = await runWrite(scene, 'salt-b')
      expect(a).not.toBe(b)
      // The IfcProject GUID is derived from `(salt, "project", "")`, so at
      // minimum the IFCPROJECT line should differ.
      const projA = a
        .split('\n')
        .find((line) => line.includes('IFCPROJECT('))
      const projB = b
        .split('\n')
        .find((line) => line.includes('IFCPROJECT('))
      expect(projA).toBeDefined()
      expect(projB).toBeDefined()
      expect(projA).not.toBe(projB)
    })
  })

  describe('door/window opening pattern', () => {
    it('emits IfcOpeningElement, IfcRelVoidsElement and IfcRelFillsElement when a door hosts a wall', async () => {
      const { scene } = buildScene({ doorHostsWall: true })
      const { text } = await runWrite(scene)
      expect(text).toContain('IFCOPENINGELEMENT')
      expect(text).toContain('IFCRELVOIDSELEMENT')
      expect(text).toContain('IFCRELFILLSELEMENT')
    })
  })

  // Regression: Pascal's `loadScene` seeds the default Site/Building/Level
  // with `parentId: null`, relying on the embedded `children` arrays for
  // hierarchy (documented Phase 3-1 schema asymmetry). The writer must
  // normalize from those `children` arrays before walking — without that
  // step, the strict `parentId === parent.id` filter in `childrenOf`
  // finds zero descendants below the Site and emits only the IfcSite.
  // The bug shipped in the first IFC export and was caught by validator
  // ("file does not contain any viewable geometries").
  describe('parentId normalization (Pascal loadScene asymmetry)', () => {
    it('emits the Building when Site.children embeds the Building object and Building.parentId is null', async () => {
      // Mimic Pascal `loadScene`: Site has the Building embedded inline
      // in `children`, the Building's `parentId` is null. Strip the
      // standard fixture's parentId chain to reproduce the bug shape.
      const { scene, ids } = buildScene({ withDoor: false, withWindow: false, withZone: false })
      const building = scene.nodes[ids.building as AnyNodeId]!
      const level = scene.nodes[ids.level as AnyNodeId]!
      const site = scene.nodes[ids.site as AnyNodeId] as unknown as SiteNode & {
        children: unknown[]
      }
      // Site embeds the full Building object (matches loadScene shape).
      site.children = [building]
      // Building uses string-id form for its child Level (matches the
      // other half of the asymmetry).
      ;(building as unknown as { children: unknown[] }).children = [ids.level]
      // Strip parentIds — the bug-trigger condition.
      ;(building as unknown as { parentId: AnyNodeId | null }).parentId = null
      ;(level as unknown as { parentId: AnyNodeId | null }).parentId = null

      const { text } = await runWrite(scene)
      const buildingMatches = text.match(/IFCBUILDING\(/g) ?? []
      expect(buildingMatches.length).toBe(1)
      expect(text).toContain('IFCBUILDINGSTOREY')
      expect(text).toContain('IFCSLAB')
      expect(text).toContain('IFCWALLSTANDARDCASE')
    })

    it('is a no-op when parentIds are already correct (does not double-emit or misroute)', async () => {
      // Standard fixture has correct parentIds. Run twice and assert the
      // entity counts match the spine we expect — no extras, no
      // duplicates from the normalizer mistakenly re-parenting.
      const { scene } = buildScene({ withDoor: false, withWindow: false, withZone: false })
      const { text } = await runWrite(scene)
      const count = (re: RegExp) => (text.match(re) ?? []).length
      expect(count(/IFCSITE\(/g)).toBe(1)
      expect(count(/IFCBUILDING\(/g)).toBe(1)
      expect(count(/IFCBUILDINGSTOREY\(/g)).toBe(1)
      expect(count(/IFCSLAB\(/g)).toBe(1)
      expect(count(/IFCWALLSTANDARDCASE\(/g)).toBe(1)
    })

    it('walks three levels deep when Site, Building, and Level all have parentId: null', async () => {
      // Worst-case shape: every parentId is null and only the embedded
      // `children` arrays describe the hierarchy. The normalizer has to
      // chase the chain top-down for the descendant elements to make it.
      const { scene, ids } = buildScene({ withDoor: false, withWindow: false, withZone: false })
      const site = scene.nodes[ids.site as AnyNodeId] as unknown as SiteNode & {
        children: unknown[]
      }
      const building = scene.nodes[ids.building as AnyNodeId]!
      const level = scene.nodes[ids.level as AnyNodeId]!
      site.children = [building]
      ;(building as unknown as { children: unknown[] }).children = [level]
      ;(building as unknown as { parentId: AnyNodeId | null }).parentId = null
      ;(level as unknown as { parentId: AnyNodeId | null }).parentId = null

      const { text } = await runWrite(scene)
      expect(text).toContain('IFCSITE')
      expect(text).toContain('IFCBUILDING(')
      expect(text).toContain('IFCBUILDINGSTOREY')
      // Descendants under the level (slab, wall) must also make it.
      expect(text).toContain('IFCSLAB')
      expect(text).toContain('IFCWALLSTANDARDCASE')
      // Three IfcRelAggregates: Project→Site, Site→Building, Building→Storey.
      const aggMatches = text.match(/IFCRELAGGREGATES/g) ?? []
      expect(aggMatches.length).toBeGreaterThanOrEqual(3)
    })
  })

  // Regression: Pascal's `loadScene` seeds an *untagged* Level 0 alongside
  // each generated level. The sidebar already hides it (Phase 3-6 Task 2,
  // via cleanup.ts/findStaleLevelNodes), but the writer was emitting it
  // as a phantom third storey. The filter rule: when at least one tagged
  // level exists under the building, drop the untagged ones; otherwise
  // ship every level (so a hand-drawn-only building still exports).
  describe('phantom level filter (Phase 3-6 Task 2 leftover)', () => {
    it('drops the untagged Level 0 when a tagged level coexists under the same building', async () => {
      const { scene, ids } = buildScene({ withDoor: false, withWindow: false, withZone: false })
      // Tag the standard fixture's level as generated.
      const taggedLevel = scene.nodes[ids.level as AnyNodeId]!
      ;(taggedLevel as unknown as { metadata: Record<string, unknown> }).metadata = {
        bimai: { generatedBy: 'procedural-v1', generationId: 'test-gen-001' },
      }
      // Add an *untagged* second level under the same building (the
      // Pascal-default "Level 0" that survives a regen).
      const untaggedId = 'level_test_untagged' as AnyNodeId
      const untaggedLevel = {
        object: 'node',
        id: untaggedId,
        type: 'level',
        parentId: ids.building,
        name: 'Level 0',
        visible: true,
        metadata: {}, // <-- no bimai tag
        level: 0,
        children: [],
      } as unknown as LevelNode
      scene.nodes[untaggedId] = untaggedLevel as unknown as AnyNode

      const { text } = await runWrite(scene)
      const storeys = (text.match(/IFCBUILDINGSTOREY\(/g) ?? []).length
      expect(storeys).toBe(1)
    })

    it('ships every level when no level is tagged (hand-drawn-only building)', async () => {
      const { scene, ids } = buildScene({ withDoor: false, withWindow: false, withZone: false })
      // Standard fixture has no tags; add a second untagged level.
      const secondId = 'level_test_002' as AnyNodeId
      const secondLevel = {
        object: 'node',
        id: secondId,
        type: 'level',
        parentId: ids.building,
        name: 'Level 1',
        visible: true,
        metadata: {},
        level: 1,
        children: [],
      } as unknown as LevelNode
      scene.nodes[secondId] = secondLevel as unknown as AnyNode

      const { text } = await runWrite(scene)
      const storeys = (text.match(/IFCBUILDINGSTOREY\(/g) ?? []).length
      expect(storeys).toBe(2)
    })
  })

  // Regression: doors and windows are parented to their host wall, not
  // to the level (`emit.ts:436` / `:479` — `parentId: wall.id`). The
  // writer's level-rooted query missed them entirely, producing IFC
  // exports with zero doors / windows / openings. The fix walks
  // Level → Wall → Door / Window.
  describe('door / window discovery via host wall', () => {
    it('emits doors and windows even when their parentId is the host wall, not the level', async () => {
      // Standard fixture already parents door/window to the wall.
      const { scene } = buildScene({ doorHostsWall: true })
      const { text } = await runWrite(scene)
      expect(text).toContain('IFCDOOR(')
      expect(text).toContain('IFCWINDOW(')
      // And the opening pattern must follow.
      expect(text).toContain('IFCOPENINGELEMENT')
      expect(text).toContain('IFCRELVOIDSELEMENT')
      expect(text).toContain('IFCRELFILLSELEMENT')
    })
  })

  // GATE 1 lock-in #8: every Pascal→IFC coordinate hop goes through
  // `pascalToIfc` / `pascal2DToIfc` / `pascalPolygonToIfc`. Inlined
  // swaps (e.g. `[a, b, c]` written as `[a, c, b]` by hand) are the
  // exact way axis bugs leaked into Phase 3-6 the first time. These
  // tests fixture each entity at coordinates whose Y and Z components
  // differ unmistakably (Y=7, Z=3) and assert the IFC output reflects
  // the swap — Pascal `(x, 7, 3)` must surface as IFC `(x, 3, 7)`.
  describe('Pascal → IFC coordinate swap (GATE 1 lock-in #8)', () => {
    it('swaps Y and Z on a wall-hosted door', async () => {
      const { scene, ids } = buildScene({ withWindow: false, withZone: false })
      // Pascal door position: x = 1.5 along wall, y_up = 7 (centroid),
      // z_transverse = 3. After pascalToIfc the local point is
      // (1.5, 3, 7); the writer then subtracts `door.height / 2 = 1.05`
      // from the Z component to convert Pascal's center-anchor to IFC's
      // bottom-edge-anchor convention, yielding (1.5, 3, 5.95).
      const door = scene.nodes[ids.door as AnyNodeId] as unknown as DoorNode & {
        position: [number, number, number]
      }
      door.position = [1.5, 7, 3]

      const { text } = await runWrite(scene)
      // The door's IfcCartesianPoint is the only one with three
      // unmistakable coords — assert the swapped triple is present
      // verbatim (with the half-height-shifted Z) and the un-swapped
      // triple is absent.
      expect(text).toMatch(/IFCCARTESIANPOINT\(\(1\.5,3\.,5\.95\)\)/)
      expect(text).not.toMatch(/IFCCARTESIANPOINT\(\(1\.5,7\.,3\.\)\)/)
    })

    it('swaps Y and Z on a wall-hosted window', async () => {
      const { scene, ids } = buildScene({ withDoor: false, withZone: false })
      // Default fixture window has height 1.2, so the writer subtracts
      // 0.6 from the IFC Z (Pascal centroid Y → IFC bottom-edge Z).
      // Pascal (2.5, 7, 3) → swapped (2.5, 3, 7) → shifted (2.5, 3, 6.4).
      const win = scene.nodes[ids.window as AnyNodeId] as unknown as WindowNode & {
        position: [number, number, number]
      }
      win.position = [2.5, 7, 3]

      const { text } = await runWrite(scene)
      expect(text).toMatch(/IFCCARTESIANPOINT\(\(2\.5,3\.,6\.4\)\)/)
      expect(text).not.toMatch(/IFCCARTESIANPOINT\(\(2\.5,7\.,3\.\)\)/)
    })

    it('anchors a wall placement at wall.start (start-relative convention)', async () => {
      // The wall's `IfcLocalPlacement` origin is `pascal2DToIfc(start, 0)` —
      // the start point, NOT the midpoint. This anchors the wall's local X
      // at 0 = wall start, length = wall end, so doors and windows whose
      // Pascal `position[0]` is start-relative drop into IFC local X
      // verbatim. The matching `wallShape` profile is shifted by `+L/2` so
      // the wall body still occupies local X ∈ [0, length] under this
      // anchor.
      const { scene, ids } = buildScene({ withDoor: false, withWindow: false, withZone: false })
      const wall = scene.nodes[ids.wall as AnyNodeId] as unknown as WallNode & {
        start: [number, number]
        end: [number, number]
      }
      wall.start = [0, 4] // Pascal2D = [x, z_planar]
      wall.end = [0, 10]

      const { text } = await runWrite(scene)
      // Start Pascal2D = (0, 4) at elevation 0 → IFC (0, 4, 0). The midpoint
      // (0, 7) MUST NOT appear as a placement origin — the previous
      // midpoint-anchored convention was the source of the L/2 along-wall
      // drift in BIMcollab.
      expect(text).toMatch(/IFCCARTESIANPOINT\(\(0\.,4\.,0\.\)\)/)
      expect(text).not.toMatch(/IFCCARTESIANPOINT\(\(0\.,7\.,0\.\)\)/)
    })

    it('lifts a slab polygon from Pascal 2D into IFC X/Y at the slab elevation', async () => {
      const { scene, ids } = buildScene({ withDoor: false, withWindow: false, withZone: false })
      const slab = scene.nodes[ids.slab as AnyNodeId] as unknown as SlabNode & {
        polygon: ReadonlyArray<readonly [number, number]>
        elevation: number
      }
      // Use a vertex with an unmistakable planar Y so the swap is
      // visible in the STEP file.
      slab.polygon = [
        [-3, -3],
        [11, -3],
        [11, 7],
        [-3, 7],
      ] as unknown as typeof slab.polygon
      slab.elevation = 0

      const { text } = await runWrite(scene)
      // Slab profile is 2D (IfcCartesianPoint with two coords). The
      // vertex (11, 7) in Pascal2D maps to IFC2D (11, 7) — the planar
      // pair stays put (pascal2DToIfc semantics: ground-plane already
      // lines up with IFC X/Y). What matters is that we don't see the
      // *3D* form `(11., ?, 7.)` — i.e. nobody silently lifted the
      // polygon into 3D with the wrong axis.
      expect(text).toMatch(/IFCCARTESIANPOINT\(\(11\.,7\.\)\)/)
    })
  })

  // Regression: the writer used to resolve the host wall solely from
  // `door.wallId` / `window.wallId`. Pre-Phase-3-6 generator outputs
  // (and any externally-loaded scene that only set `parentId`) had
  // `wallId === undefined`, so the lookup missed and `host` fell
  // back to the storey placement. The visible bug in BIMcollab was a
  // diagonal staircase of doors/windows with no opening cut. The
  // writer now falls back to `parentId` — which the level-walk
  // already proves to be a wall.
  describe('host fallback (wallId missing, parentId is the wall)', () => {
    it('still resolves the host wall and emits the opening pattern', async () => {
      // doorHostsWall:false leaves door.parentId === wall.id but
      // strips door.wallId. The fixture's window keeps wallId set, so
      // strip it explicitly too to isolate the parentId fallback path.
      const { scene, ids } = buildScene({
        doorHostsWall: false,
        withZone: false,
      })
      const win = scene.nodes[ids.window as AnyNodeId] as unknown as WindowNode & {
        wallId?: string
      }
      delete win.wallId

      const { text } = await runWrite(scene)
      // Door + window must both appear.
      expect(text).toContain('IFCDOOR(')
      expect(text).toContain('IFCWINDOW(')
      // The opening pattern is the proof that the host wall was
      // resolved — emitOpening only runs under `if (host)`.
      const openings = (text.match(/IFCOPENINGELEMENT/g) ?? []).length
      const voids = (text.match(/IFCRELVOIDSELEMENT/g) ?? []).length
      const fills = (text.match(/IFCRELFILLSELEMENT/g) ?? []).length
      expect(openings).toBe(2) // one for door, one for window
      expect(voids).toBe(2)
      expect(fills).toBe(2)
    })
  })

  // Beyond verifying the placement chain exists structurally, walk
  // the actual numerical coordinates the writer emits. Decode the
  // STEP graph, follow IfcDoor → IfcLocalPlacement chain, sum the
  // local origins, and confirm the resolved IFC world position
  // matches the expected swap of the input Pascal coordinates.
  // Anchors GATE 1 lock-in #8 numerically — any future regression in
  // the swap, the relative-placement nesting, or the storey
  // elevation calculation will fail this test with a precise number.
  describe('placement chain coordinate round-trip', () => {
    it('resolves a door at wall-local (along=2, centroid up=1.05) on a wall start Pascal (5,0) at storey elev 3 to IFC world (7, 0, 3) bottom-edge', async () => {
      // Fixture rebuilt to mirror the *generator's* convention exactly:
      //   - `wall.start` / `wall.end` are world Pascal2D points; the
      //     writer anchors the wall's IfcLocalPlacement at `wall.start`,
      //     RefDirection along start→end.
      //   - `door.position[0]` is start-relative along the wall (the
      //     `clamped` produced by `wallLocalX` in `emit.ts`), in
      //     `[0, length]`.
      //   - `door.position[1]` is the door's centroid height (Pascal's
      //     mesh-center-anchored renderer convention — see
      //     `packages/core/src/systems/door/door-system.tsx:239`).
      //   - `door.position[2]` is the perpendicular offset (must be 0
      //     for an in-wall door).
      //
      // The writer converts Pascal centroid Z to IFC bottom-edge Z by
      // subtracting `door.height / 2`, because IFC IfcDoor.ObjectPlacement
      // is the bottom-edge midpoint and the body extrudes upward from
      // origin.
      //
      // For door at along=2, centroid up=1.05 (height 2.1 → bottom 0)
      // on a wall from Pascal (5,0) to (15,0) (length 10) on a storey
      // elevated 3 m, the resolved IFC world position is:
      //
      //   site (0,0,0) + building (0,0,0) + storey (0,0,3)
      //       + wall start (5,0,0) + door wall-local (2,0,0)
      //   = (7, 0, 3)
      //
      // The test that this replaced used midpoint-relative inputs and
      // asserted midpoint-relative outputs (12, 0, 4.05) — passing the
      // round-trip while masking the runtime convention mismatch that
      // produced "diagonal staircase" doors floating beside the
      // building in BIMcollab.
      const { scene, ids } = buildScene({
        withWindow: false,
        withZone: false,
      })

      // Storey elevation 3.0 — level=1 with the writer's default
      // 3 m floor-to-floor.
      const level = scene.nodes[ids.level as AnyNodeId] as unknown as LevelNode & {
        level: number
      }
      level.level = 1

      // Wall start at Pascal2D (5, 0), end at (15, 0). Wall length = 10,
      // RefDirection along +X.
      const wall = scene.nodes[ids.wall as AnyNodeId] as unknown as WallNode & {
        start: [number, number]
        end: [number, number]
      }
      wall.start = [5, 0]
      wall.end = [15, 0]
      const wallLength = Math.hypot(
        wall.end[0] - wall.start[0],
        wall.end[1] - wall.start[1],
      )

      // Door at wall-local (along=2, up=1.05, perp=0) — start-relative
      // along the wall.
      const door = scene.nodes[ids.door as AnyNodeId] as unknown as DoorNode & {
        position: [number, number, number]
      }
      door.position = [2, 1.05, 0]

      const { text } = await runWrite(scene)

      // Build a tiny STEP entity index. The regex captures the
      // outermost arg list (one level of paren nesting allowed for
      // tuple args like IfcCartesianPoint's coordinate triple).
      const entities = new Map<number, { type: string; args: string }>()
      const ENT_RE = /^#(\d+)=([A-Z0-9_]+)\(((?:[^()]|\([^()]*\))*)\)/gm
      for (const m of text.matchAll(ENT_RE)) {
        entities.set(Number(m[1]), { type: m[2]!, args: m[3]! })
      }

      const ref = (s: string): number | null =>
        s === '$' ? null : Number(s.slice(1))

      // Find the IfcDoor.
      const doorEntry = [...entities.entries()].find(
        ([, v]) => v.type === 'IFCDOOR',
      )
      expect(doorEntry, 'IFCDOOR not found in STEP output').toBeDefined()
      const doorArgs = splitTopLevel(doorEntry![1].args)
      // IfcDoor args (IFC4): GlobalId, OwnerHistory, Name, Description,
      // ObjectType, ObjectPlacement, Representation, Tag,
      // OverallHeight, OverallWidth, PredefinedType, OperationType,
      // UserDefinedOperationType. ObjectPlacement is positional 5.
      const doorPlacementId = ref(doorArgs[5]!)
      expect(doorPlacementId, 'door has no ObjectPlacement').not.toBeNull()

      // Walk the IfcLocalPlacement chain. Since every wall in this
      // fixture has identity rotation (RefDirection +X, Axis +Z),
      // the resolved world position is simply the sum of the local
      // origins along the chain. (A test with a rotated wall would
      // need to apply the basis at each step — not needed here.)
      let totalX = 0
      let totalY = 0
      let totalZ = 0
      let depth = 0
      let firstLocal: [number, number, number] | null = null
      let placementId: number | null = doorPlacementId
      while (placementId !== null) {
        depth++
        const ent = entities.get(placementId)
        expect(
          ent?.type,
          `expected IFCLOCALPLACEMENT at #${placementId}, got ${ent?.type ?? 'undefined'}`,
        ).toBe('IFCLOCALPLACEMENT')
        // IfcLocalPlacement(PlacementRelTo, RelativePlacement)
        const lp = splitTopLevel(ent!.args)
        const ax = entities.get(ref(lp[1]!)!)
        expect(ax?.type).toBe('IFCAXIS2PLACEMENT3D')
        // IfcAxis2Placement3D(Location, Axis, RefDirection)
        const axArgs = splitTopLevel(ax!.args)
        const pt = entities.get(ref(axArgs[0]!)!)
        expect(pt?.type).toBe('IFCCARTESIANPOINT')
        // IfcCartesianPoint args wrap the coordinate tuple in another
        // pair of parens: `((x,y,z))`. Pull out the numbers directly.
        const nums = pt!.args.match(/-?\d+(?:\.\d*)?(?:E[+-]?\d+)?/g) ?? []
        const x = Number(nums[0] ?? '0')
        const y = Number(nums[1] ?? '0')
        const z = Number(nums[2] ?? '0')
        if (firstLocal === null) firstLocal = [x, y, z]
        totalX += x
        totalY += y
        totalZ += z
        placementId = ref(lp[0]!)
      }

      // Chain depth: door → wall → storey → building → site = 5.
      expect(depth, 'placement chain should be 5 levels deep').toBe(5)

      // ── door's own (wall-local) origin assertions ─────────────────
      // The first placement on the chain is the door's own local frame
      // under the wall. Pascal `[2, 1.05, 0]` (centroid) → IFC bottom
      // edge `(2, 0, 0)` after the writer's half-height subtraction.
      const [doorLocalX, doorLocalY, doorLocalZ] = firstLocal!
      expect(doorLocalX).toBeCloseTo(2, 5)
      // Perpendicular component MUST be exactly zero — a non-zero value
      // is the bug from "doors floating outside their wall plane".
      expect(doorLocalY, 'door perpendicular offset must be 0').toBe(0)
      // Door bottom-edge must be at floor (Z=0). Pascal centroid 1.05
      // minus half-height 1.05 = 0. Catches a regression where the
      // writer forgets to subtract `height / 2` and doors protrude
      // above wall top (the bug from PROGRESS-3-6 vertical anchor).
      expect(doorLocalZ, 'door bottom-edge must be at floor (Z=0)').toBeCloseTo(0, 2)

      // ── door must lie within the wall's profile envelope ──────────
      // Catches the L/2 along-wall drift in either direction. Under the
      // start-anchored convention, `0 ≤ doorLocalX ≤ wallLength`.
      expect(doorLocalX).toBeGreaterThanOrEqual(0)
      expect(doorLocalX).toBeLessThanOrEqual(wallLength)

      // ── full-chain resolution ─────────────────────────────────────
      expect(totalX).toBeCloseTo(7, 5)
      expect(totalY).toBeCloseTo(0, 5)
      expect(totalZ).toBeCloseTo(3, 5)
    })

    it('resolves a window at wall-local (along=3, centroid up=1.65, height=1.5) to IFC bottom-edge Z = sill 0.9', async () => {
      // Window vertical convention mirrors the door:
      //   - Pascal stores `position[1]` as the window's *centroid*
      //     height (window-system.tsx places frame children at
      //     ±height/2 around mesh center).
      //   - IFC's IfcWindow.ObjectPlacement is the bottom-edge
      //     midpoint; geometry extrudes upward.
      //
      // WindowNode has no separate `sillHeight` field; the sill is
      // implicit in `position[1] - height / 2`. For a window with
      // height 1.5 and a desired sill at 0.9, Pascal stores
      // `position[1] = 0.9 + 1.5 / 2 = 1.65`, and the writer must emit
      // local Z = 0.9.
      const { scene, ids } = buildScene({
        withDoor: false,
        withZone: false,
      })

      const level = scene.nodes[ids.level as AnyNodeId] as unknown as LevelNode & {
        level: number
      }
      level.level = 1

      const wall = scene.nodes[ids.wall as AnyNodeId] as unknown as WallNode & {
        start: [number, number]
        end: [number, number]
      }
      wall.start = [5, 0]
      wall.end = [15, 0]

      const win = scene.nodes[ids.window as AnyNodeId] as unknown as WindowNode & {
        position: [number, number, number]
        height: number
      }
      win.height = 1.5
      win.position = [3, 1.65, 0]

      const { text } = await runWrite(scene)

      const entities = new Map<number, { type: string; args: string }>()
      const ENT_RE = /^#(\d+)=([A-Z0-9_]+)\(((?:[^()]|\([^()]*\))*)\)/gm
      for (const m of text.matchAll(ENT_RE)) {
        entities.set(Number(m[1]), { type: m[2]!, args: m[3]! })
      }
      const ref = (s: string): number | null => (s === '$' ? null : Number(s.slice(1)))

      const winEntry = [...entities.entries()].find(([, v]) => v.type === 'IFCWINDOW')
      expect(winEntry, 'IFCWINDOW not found in STEP output').toBeDefined()
      const winArgs = splitTopLevel(winEntry![1].args)
      // IfcWindow ObjectPlacement is positional 5 (same slot as IfcDoor).
      const winPlacementId = ref(winArgs[5]!)
      expect(winPlacementId).not.toBeNull()

      const lpEnt = entities.get(winPlacementId!)
      expect(lpEnt?.type).toBe('IFCLOCALPLACEMENT')
      const lpArgs = splitTopLevel(lpEnt!.args)
      const ax = entities.get(ref(lpArgs[1]!)!)
      expect(ax?.type).toBe('IFCAXIS2PLACEMENT3D')
      const axArgs = splitTopLevel(ax!.args)
      const pt = entities.get(ref(axArgs[0]!)!)
      expect(pt?.type).toBe('IFCCARTESIANPOINT')
      const nums = pt!.args.match(/-?\d+(?:\.\d*)?(?:E[+-]?\d+)?/g) ?? []
      const windowLocalX = Number(nums[0] ?? '0')
      const windowLocalY = Number(nums[1] ?? '0')
      const windowLocalZ = Number(nums[2] ?? '0')

      expect(windowLocalX).toBeCloseTo(3, 5)
      expect(windowLocalY, 'window perpendicular offset must be 0').toBe(0)
      expect(
        windowLocalZ,
        'window bottom-edge must be at sill height (centroid - height/2)',
      ).toBeCloseTo(0.9, 2)
    })
  })

  // Slabs sit one level shallower than wall-hosted elements, but the
  // same convention check applies: the slab's `IfcLocalPlacement`
  // origin should be at the storey-local (0, 0, slab.elevation), and
  // the polygon vertices should be expressed in storey-local ground
  // coordinates with no axis swap. Slabs have visually passed the
  // BIMcollab eyeball test so far; this test pins the convention so
  // any future drift surfaces in CI rather than on the validator.
  describe('slab placement chain (regression)', () => {
    it('anchors slab placement at (0, 0, slab.elevation) in storey-local coordinates', async () => {
      const { scene, ids } = buildScene({
        withDoor: false,
        withWindow: false,
        withZone: false,
      })
      const slab = scene.nodes[ids.slab as AnyNodeId] as unknown as SlabNode & {
        polygon: ReadonlyArray<readonly [number, number]>
        elevation: number
      }
      // Distinguishable elevation so any drift is visible in the trace.
      slab.elevation = 0.42

      const { text } = await runWrite(scene)
      const entities = new Map<number, { type: string; args: string }>()
      const ENT_RE = /^#(\d+)=([A-Z0-9_]+)\(((?:[^()]|\([^()]*\))*)\)/gm
      for (const m of text.matchAll(ENT_RE)) {
        entities.set(Number(m[1]), { type: m[2]!, args: m[3]! })
      }
      const ref = (s: string): number | null =>
        s === '$' ? null : Number(s.slice(1))

      const slabEntry = [...entities.entries()].find(
        ([, v]) => v.type === 'IFCSLAB',
      )
      expect(slabEntry, 'IFCSLAB not found').toBeDefined()
      // IfcSlab.ObjectPlacement is positional index 5 (same layout as
      // IfcDoor's spatial-element prefix).
      const slabArgs = splitTopLevel(slabEntry![1].args)
      const placementId = ref(slabArgs[5]!)
      const lp = entities.get(placementId!)
      expect(lp?.type).toBe('IFCLOCALPLACEMENT')
      const lpArgs = splitTopLevel(lp!.args)
      const ax = entities.get(ref(lpArgs[1]!)!)
      expect(ax?.type).toBe('IFCAXIS2PLACEMENT3D')
      const axArgs = splitTopLevel(ax!.args)
      const pt = entities.get(ref(axArgs[0]!)!)
      expect(pt?.type).toBe('IFCCARTESIANPOINT')
      const nums = pt!.args.match(/-?\d+(?:\.\d*)?(?:E[+-]?\d+)?/g) ?? []
      const [x, y, z] = nums.map(Number)
      // Storey-local: planar pair zero (the polygon carries the world
      // shape), Z = slab.elevation.
      expect(x).toBeCloseTo(0, 5)
      expect(y).toBeCloseTo(0, 5)
      expect(z).toBeCloseTo(0.42, 5)
    })
  })

  // ── Phase 3-7 Task 9: room IfcSpaces with IfcRelAggregates ──────────────
  //
  // Room zones (metadata.bimai.{roomKind, unitId} set) emit one
  // IfcSpace each, *not* contained in the storey directly — they're
  // aggregated under their parent unit IfcSpace via one
  // IfcRelAggregates per unit. The unit IfcSpace's storey containment
  // is unchanged. Studios with no rooms (or any unit-shell fallback)
  // emit only the unit IfcSpace; the generator's `emitRoomZones`
  // already suppresses unit-shell zones at emit time, so the IFC
  // writer sees zero room zones for those units naturally.
  describe('room IfcSpaces (Phase 3-7 Task 9)', () => {
    interface RoomSpec {
      id: string
      kind: string
    }
    interface UnitWithRooms {
      unitId: string
      unitName: string
      rooms: RoomSpec[]
    }

    /**
     * Build a scene with the standard spine (site/building/level/slab/wall)
     * plus N unit zones, each with its own room zones. Reuses `buildScene`
     * for the spine to keep this helper short. The default fixture's zone
     * is omitted — we build all zones here.
     */
    function buildSceneWithUnits(
      units: UnitWithRooms[],
    ): { scene: SceneSnapshot; ids: SceneIds } {
      const { scene, ids } = buildScene({
        withDoor: false,
        withWindow: false,
        withZone: false,
      })
      let xOffset = 0
      for (const unit of units) {
        const unitZone = {
          object: 'node',
          id: unit.unitId,
          type: 'zone',
          parentId: ids.level,
          name: unit.unitName,
          visible: true,
          metadata: {},
          polygon: [
            [xOffset, 0],
            [xOffset + 8, 0],
            [xOffset + 8, 8],
            [xOffset, 8],
          ],
          color: '#a78bfa',
        } as unknown as ZoneNode
        scene.nodes[unit.unitId as AnyNodeId] = unitZone as unknown as AnyNode
        // Slice the unit's 8×8 footprint into N horizontal strips, one
        // per room. Geometry doesn't matter for the IFC structural specs;
        // we only need every room to have a valid 4-vertex polygon.
        const stripH = unit.rooms.length > 0 ? 8 / unit.rooms.length : 0
        unit.rooms.forEach((room, i) => {
          const y0 = i * stripH
          const y1 = y0 + stripH
          const roomZone = {
            object: 'node',
            id: room.id,
            type: 'zone',
            parentId: ids.level,
            name: `${unit.unitName} · ${room.kind}`,
            visible: true,
            metadata: {
              bimai: {
                roomKind: room.kind,
                unitId: unit.unitId,
                unitType: unit.unitName,
                roomArea: 16,
                windowAccess: false,
              },
            },
            polygon: [
              [xOffset, y0],
              [xOffset + 8, y0],
              [xOffset + 8, y1],
              [xOffset, y1],
            ],
            color: '#3b82f6',
          } as unknown as ZoneNode
          scene.nodes[room.id as AnyNodeId] = roomZone as unknown as AnyNode
        })
        xOffset += 10
      }
      return { scene, ids }
    }

    /**
     * Build a Map<expressID, {type, args}> from the STEP text. Used by
     * specs that need to walk relationships (IfcRelAggregates →
     * RelatingObject + RelatedObjects).
     */
    function parseEntities(text: string): Map<number, { type: string; args: string }> {
      const entities = new Map<number, { type: string; args: string }>()
      const ENT_RE = /^#(\d+)=([A-Z0-9_]+)\(((?:[^()]|\([^()]*\))*)\)/gm
      for (const m of text.matchAll(ENT_RE)) {
        entities.set(Number(m[1]), { type: m[2]!, args: m[3]! })
      }
      return entities
    }

    /** Resolve `(#1,#2,#3)` → [1, 2, 3]. Tolerates `$`. */
    function parseRefList(s: string): number[] {
      const inner = s.replace(/^\(/, '').replace(/\)$/, '')
      if (inner === '' || inner === '$') return []
      return inner
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.startsWith('#'))
        .map((p) => Number(p.slice(1)))
    }

    it('1 unit + 4 rooms → 1 unit IfcSpace + 4 room IfcSpaces + 1 IfcRelAggregates linking them', async () => {
      const { scene } = buildSceneWithUnits([
        {
          unitId: 'zone_unit_1br_a',
          unitName: '1BR',
          rooms: [
            { id: 'zone_room_a_bed', kind: 'bedroom' },
            { id: 'zone_room_a_bath', kind: 'bathroom' },
            { id: 'zone_room_a_kit', kind: 'kitchen' },
            { id: 'zone_room_a_liv', kind: 'living' },
          ],
        },
      ])
      const { text } = await runWrite(scene)
      const entities = parseEntities(text)

      const spaces = [...entities.values()].filter((e) => e.type === 'IFCSPACE')
      expect(spaces.length).toBe(5) // 1 unit + 4 rooms

      const aggs = [...entities.values()].filter((e) => e.type === 'IFCRELAGGREGATES')
      // Storey ←IfcRelAggregates→ building (1), building ←Aggregates→ site (1),
      // site ←Aggregates→ project (1), unit ←Aggregates→ rooms (1) = at least 4.
      // The Phase 3-7 addition is exactly one *unit-rooms* aggregate.
      const unitRoomsAggs = aggs.filter((e) => {
        const args = splitTopLevel(e.args)
        const related = parseRefList(args[5]!)
        // Find aggregates whose all related are IfcSpace.
        if (related.length !== 4) return false
        return related.every((id) => entities.get(id)?.type === 'IFCSPACE')
      })
      expect(unitRoomsAggs.length).toBe(1)
    })

    it('Studio with no rooms → only unit IfcSpace, no IfcRelAggregates linking room spaces', async () => {
      const { scene } = buildSceneWithUnits([
        { unitId: 'zone_unit_studio_a', unitName: 'Studio', rooms: [] },
      ])
      const { text } = await runWrite(scene)
      const entities = parseEntities(text)

      const spaces = [...entities.values()].filter((e) => e.type === 'IFCSPACE')
      expect(spaces.length).toBe(1)

      const aggs = [...entities.values()].filter((e) => e.type === 'IFCRELAGGREGATES')
      const spaceAggs = aggs.filter((e) => {
        const args = splitTopLevel(e.args)
        const relating = Number(args[4]!.slice(1))
        return entities.get(relating)?.type === 'IFCSPACE'
      })
      expect(spaceAggs.length).toBe(0)
    })

    it('mixed scene (2 units with rooms, 1 unit-shell) → counts match', async () => {
      const { scene } = buildSceneWithUnits([
        {
          unitId: 'zone_unit_1br',
          unitName: '1BR',
          rooms: [
            { id: 'zone_room_1br_bed', kind: 'bedroom' },
            { id: 'zone_room_1br_bath', kind: 'bathroom' },
          ],
        },
        {
          unitId: 'zone_unit_2br',
          unitName: '2BR',
          rooms: [
            { id: 'zone_room_2br_bed1', kind: 'bedroom' },
            { id: 'zone_room_2br_bed2', kind: 'bedroom' },
            { id: 'zone_room_2br_bath', kind: 'bathroom' },
          ],
        },
        // unit-shell unit: emitRoomZones suppresses the shell zone, so
        // here we model the post-emit state — only the unit zone, no
        // children. Same path the IFC writer sees in production.
        { unitId: 'zone_unit_studio', unitName: 'Studio', rooms: [] },
      ])
      const { text } = await runWrite(scene)
      const entities = parseEntities(text)

      const spaces = [...entities.values()].filter((e) => e.type === 'IFCSPACE')
      // 3 units + (2 + 3) rooms = 8.
      expect(spaces.length).toBe(8)

      const aggs = [...entities.values()].filter((e) => e.type === 'IFCRELAGGREGATES')
      const spaceAggs = aggs.filter((e) => {
        const args = splitTopLevel(e.args)
        const relating = Number(args[4]!.slice(1))
        return entities.get(relating)?.type === 'IFCSPACE'
      })
      // 2 unit-with-rooms → 2 IfcRelAggregates. Studio (no rooms) → 0.
      expect(spaceAggs.length).toBe(2)
    })

    it('LongName populated correctly for every roomKind (bedroom, bathroom, kitchen, living, hallway)', async () => {
      const { scene } = buildSceneWithUnits([
        {
          unitId: 'zone_unit_4br',
          unitName: '4BR',
          rooms: [
            { id: 'zone_room_bed', kind: 'bedroom' },
            { id: 'zone_room_bath', kind: 'bathroom' },
            { id: 'zone_room_kit', kind: 'kitchen' },
            { id: 'zone_room_liv', kind: 'living' },
            { id: 'zone_room_hall', kind: 'hallway' },
          ],
        },
      ])
      const { text } = await runWrite(scene)

      // Each LongName is on the IfcSpace at positional index 7
      // (...,Representation,LongName,CompositionType,...). The simplest
      // check: the bare roomKind label appears as its own quoted string
      // somewhere in an IFCSPACE line. Pair with the unit-prefixed Name
      // assertion to lock both fields.
      for (const kind of ['bedroom', 'bathroom', 'kitchen', 'living', 'hallway']) {
        const spaceLineRe = new RegExp(`IFCSPACE\\([^\\n]*'${kind}'[^\\n]*`)
        expect(text).toMatch(spaceLineRe)
        // Unit-prefixed Name: "4BR - bedroom" etc.
        expect(text).toContain(`'4BR - ${kind}'`)
      }
    })

    it('storey containment unchanged: unit IfcSpaces still appear in IfcRelContainedInSpatialStructure, room IfcSpaces do not', async () => {
      const { scene } = buildSceneWithUnits([
        {
          unitId: 'zone_unit_1br',
          unitName: '1BR',
          rooms: [
            { id: 'zone_room_bed', kind: 'bedroom' },
            { id: 'zone_room_bath', kind: 'bathroom' },
          ],
        },
      ])
      const { text } = await runWrite(scene)
      const entities = parseEntities(text)

      const containment = [...entities.values()].find(
        (e) => e.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE',
      )
      expect(containment).toBeDefined()
      const args = splitTopLevel(containment!.args)
      // RelatedElements is positional index 4 ((#1,#2,...)).
      const related = parseRefList(args[4]!)
      const relatedTypes = related.map((id) => entities.get(id)?.type)

      // Exactly one IfcSpace in containment (the unit). Room spaces
      // must not be in this list — they reach the storey transitively
      // via the unit's IfcRelAggregates.
      const spaceIds = related.filter((id) => entities.get(id)?.type === 'IFCSPACE')
      expect(spaceIds.length).toBe(1)
      // Other building elements (slab, wall) are still contained directly
      // — guard the regression.
      expect(relatedTypes).toContain('IFCSLAB')
      expect(relatedTypes).toContain('IFCWALLSTANDARDCASE')
    })

    it('room IfcSpace GUID is deterministic across runs (same scene + same projectSalt → same GUID)', async () => {
      const build = () =>
        buildSceneWithUnits([
          {
            unitId: 'zone_unit_1br',
            unitName: '1BR',
            rooms: [{ id: 'zone_room_bed', kind: 'bedroom' }],
          },
        ])

      const { text: text1 } = await runWrite(build().scene, 'lock-salt')
      __resetIfcApiForTests()
      const { text: text2 } = await runWrite(build().scene, 'lock-salt')

      // Pull the IfcSpace whose Name contains '1BR - bedroom' from each
      // run; their GlobalId (positional index 0) must match.
      const guidFor = (text: string): string => {
        const m = text.match(/IFCSPACE\('([^']+)',[^)]*'1BR - bedroom'/)
        if (!m) throw new Error('room IfcSpace not found in STEP output')
        return m[1]!
      }
      expect(guidFor(text1)).toBe(guidFor(text2))
    })

    it('tag invariant: every room IfcSpace is the target of exactly one IfcRelAggregates whose RelatingObject is a unit IfcSpace', async () => {
      const { scene } = buildSceneWithUnits([
        {
          unitId: 'zone_unit_1br',
          unitName: '1BR',
          rooms: [
            { id: 'zone_room_bed', kind: 'bedroom' },
            { id: 'zone_room_bath', kind: 'bathroom' },
          ],
        },
        {
          unitId: 'zone_unit_2br',
          unitName: '2BR',
          rooms: [
            { id: 'zone_room_bed2', kind: 'bedroom' },
            { id: 'zone_room_kit2', kind: 'kitchen' },
            { id: 'zone_room_liv2', kind: 'living' },
          ],
        },
      ])
      const { text } = await runWrite(scene)
      const entities = parseEntities(text)

      // Build the set of all room-IfcSpace IDs (those with LongName set).
      // Easier: collect IfcSpaces whose Name contains " - " (the unit-
      // prefixed naming convention).
      const roomSpaceIds = new Set<number>()
      for (const [id, e] of entities) {
        if (e.type !== 'IFCSPACE') continue
        const args = splitTopLevel(e.args)
        const name = args[2]!
        if (name.includes(' - ')) roomSpaceIds.add(id)
      }
      expect(roomSpaceIds.size).toBe(5)

      // For each room space, count incoming IfcRelAggregates whose
      // RelatingObject is an IfcSpace. Must be exactly 1.
      for (const roomId of roomSpaceIds) {
        let parents = 0
        for (const e of entities.values()) {
          if (e.type !== 'IFCRELAGGREGATES') continue
          const args = splitTopLevel(e.args)
          const relating = Number(args[4]!.slice(1))
          const related = parseRefList(args[5]!)
          if (
            related.includes(roomId) &&
            entities.get(relating)?.type === 'IFCSPACE'
          ) {
            parents++
          }
        }
        expect(parents).toBe(1)
      }
    })

    it('round-trip: 4 units (3 with rooms, 1 unit-shell) → 4 unit IfcSpaces + Σrooms IfcSpaces + 3 IfcRelAggregates', async () => {
      // Scaled-down version of the brief's 14-unit fixture (each unit
      // emits the same 5+ entities chain, so 4 units already exercises
      // the loop without ballooning test-runtime). Shape: 1BR×2 (2
      // bedrooms+bathroom each), 2BR×1 (3 rooms), Studio×1 (no rooms).
      const { scene } = buildSceneWithUnits([
        {
          unitId: 'zone_unit_1br_a',
          unitName: '1BR',
          rooms: [
            { id: 'zone_room_a_bed', kind: 'bedroom' },
            { id: 'zone_room_a_bath', kind: 'bathroom' },
          ],
        },
        {
          unitId: 'zone_unit_1br_b',
          unitName: '1BR',
          rooms: [
            { id: 'zone_room_b_bed', kind: 'bedroom' },
            { id: 'zone_room_b_bath', kind: 'bathroom' },
          ],
        },
        {
          unitId: 'zone_unit_2br',
          unitName: '2BR',
          rooms: [
            { id: 'zone_room_2br_bed1', kind: 'bedroom' },
            { id: 'zone_room_2br_bed2', kind: 'bedroom' },
            { id: 'zone_room_2br_kit', kind: 'kitchen' },
          ],
        },
        { unitId: 'zone_unit_studio', unitName: 'Studio', rooms: [] },
      ])
      const { text } = await runWrite(scene)
      const entities = parseEntities(text)

      const spaces = [...entities.values()].filter((e) => e.type === 'IFCSPACE')
      // 4 units + (2 + 2 + 3 + 0) rooms = 11.
      expect(spaces.length).toBe(11)

      const aggs = [...entities.values()].filter((e) => e.type === 'IFCRELAGGREGATES')
      const unitRoomAggs = aggs.filter((e) => {
        const args = splitTopLevel(e.args)
        const relating = Number(args[4]!.slice(1))
        return entities.get(relating)?.type === 'IFCSPACE'
      })
      expect(unitRoomAggs.length).toBe(3) // Studio contributes 0.
    })
  })
})

/**
 * Split a STEP argument list at top level, respecting both
 * parenthesis nesting and single-quoted string literals (which may
 * contain commas). Used by the placement-chain round-trip test to
 * pull positional fields out of an entity's argument string.
 */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inQuote = false
  let current = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === "'") {
      // STEP escapes a literal apostrophe by doubling it (`''`); the
      // toggle naturally handles that — two flips cancel out.
      inQuote = !inQuote
      current += c
      continue
    }
    if (!inQuote) {
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === ',' && depth === 0) {
        out.push(current)
        current = ''
        continue
      }
    }
    current += c
  }
  out.push(current)
  return out
}
