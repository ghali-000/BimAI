# BimAI Progress

## Phase 3-3 — Procedural Generator (complete)

### What works (verified in the running app + CLI)

- **Generate button** in the right-sidebar Generation panel takes the active site polygon + zoning + program, runs the pipeline against Pascal's store, and replaces every previously-generated node under the building with a fresh set in one undoable step. Cmd-Z rolls the entire generation back to the pre-click scene; Cmd-Shift-Z replays it.
- Default 30×30 scene with the seeded program (4 Studio + 6 1BR + 4 2BR, FtF 3, setbacks 5/3/4) generates 2 floors, 14 units per floor (Σ 28 zones + 28 doors + 28 windows), 38 walls (perimeter + corridor + party), 2 slabs, 2 levels — 132 nodes total. Visible in 3D: doors render with frame/leaf/handle, windows with sill + dividers, walls miter, slabs cap each floor.
- **Pipeline stages**, all pure: envelope (Phase 3-2) → footprint (structural inset) → floors (FAR + height clamps) → corridor (centreline + width) → unit pack (greedy strip-fill with width clamp band [3, 9] m) → rooms (single open room per unit, stub) → emit (plan → NodeOps).
- **Clamp path** in the unit packer surfaces three warning codes (`unit_clipped_min`, `unit_clipped_max`, `unit_clipped_strip_end`) and a per-type cumulative-drift summary when total area diverges >5% from target. `program_exceeds_capacity` only fires now when the footprint's long axis is shorter than `MIN_UNIT_WIDTH_M` so every queue item fails on both strips.
- **Generation tag**: every emitted node carries `metadata.bimai.generatedBy = 'bimai-generator'` and `generationId = nanoid()`. Cleanup walks the building subtree and only deletes nodes carrying the tag — user-drawn walls / doors / etc. survive a regenerate.
- **Boundary fix** at the SceneWriter: every emitted node is re-parsed through its Pascal Zod schema (DoorNode, WindowNode, WallNode, SlabNode, ZoneNode, LevelNode) inside `pascal-writer.ts` so defaulted fields (`frameThickness`, `frameDepth`, `segments`, `sill*`, …) are materialised before the store sees them. Without this, `door-system.tsx`'s `width − 2 * frameThickness` produced NaN, poisoned mesh bounding boxes, and froze drei's CameraControls after the first Generate.
- **Single-undo regeneration**: `runGenerator` wraps delete + create in `useScene.temporal.pause() / resume()` so Zundo collapses the regeneration into one history step. Verified by clicking Generate twice with edits in between — Cmd-Z restores the previous generation, Cmd-Z again restores the pre-Generate state.
- **Headless CLI**: `bun run generate -- --input config.json --output building.json` (also `--batch in.jsonl --batch-out out.jsonl`, also stdin/stdout). Same pipeline, MemoryWriter instead of zustand. Exit codes 0/1/2 (success / IO+validation / typed pipeline failure). Reuses the panels' `ZoningRules` and `Program` schemas for input validation. Demo fixture in `bimai/cli/fixtures/demo-50x30.json`; piping it through the CLI produces 126 nodes (the missing 6 are the strip-end-clipped 1BR per floor — same warning the panel reports).
- **128 vitest specs** across `geometry`, `envelope`, `constraints/zoning`, `tag`, `cleanup`, `emit`, `pipeline`, and the four packer stages (corridor, footprint, floors, units). `bun run test` is green; `bun run test:watch` works for iteration.
- Zero console errors. Default scene survives full-page reloads (metadata rides on Pascal's existing `localStorage` persistence).

### Pinned regression cases (Gate 1)

The four hand-traced packer cases the strip-fill logic was designed against, encoded in `bimai/generator/stages/units.test.ts`:

1. **4 Studios on a 30×10 outline** — all four fit on strip 0 with leftover room.
2. **Oversize 4BR** — clamps to `MAX_UNIT_WIDTH_M = 9` m and emits `unit_clipped_max`.
3. **20 Studios on 50×12** — 8 placed (4 per strip via strip-end-clip), 12 unplaced; surfaces `unit_clipped_strip_end` and the `program_exceeds_capacity` outcome only escalates when geometry forbids both strips.
4. **Mixed 4 S + 6×1BR + 4×2BR on 50×12** — 13 placed, 1 × 2BR unplaced (rule 3 strip-end clamp bites on the second strip).

Comments in the test file walk through the arithmetic so future packer edits can be reasoned about against the pinned outcomes.

### What's stubbed / known limitations

- **Greedy left-then-right unit packing** fills strip 0 fully before touching strip 1, so floors look front-heavy (one façade fully populated, the opposite façade tail-trimmed). The clamp path keeps the geometry valid but doesn't balance. Flagged for Phase 3-5 optimiser (BLF / two-row balanced packing).
- **Single-room "open" stub per unit**. `attachRoomsToUnits` emits one room matching the unit polygon. Subdivision into bedroom / bath / kitchen / living is the obvious next stage but isn't needed for the buildable-mass milestone.
- **Corridor is a single straight centreline** down the long axis. Works for rectangular footprints; the corridor stage `asRectangle` check rejects anything else with `corridor_layout_failed`. L-shaped / T-shaped corridors are a Phase 3-4 concern.
- **Identical floors** — every level re-runs the same corridor + pack with the same outline. Stepped setbacks, ground-floor commercial, penthouse units would all need the floor loop to vary by `i`.
- **No user-supplied seed yet**. `GeneratorInput.seed` exists but the pipeline ignores it (every call mints a fresh `nanoid()` for `generationId`). When the packer or footprint stage gains stochastic choices, this is the wire to plumb.
- **Drift guardrail test deferred**. A vitest spec that runs every emitted node through `safeParse` with the Pascal schema would catch future drift between `emit.ts` and core's schemas, but importing any symbol from `@pascal-app/core` still crashes vitest via three-mesh-bvh's eager barrel evaluation. The boundary parse in `pascal-writer.ts` is the live signal until subpath exports land in core. Documented in `bimai/generator/emit.guardrail.md`.

### Deviations from the brief

- Added `nanoid@^5.1.6` as a direct dep on `apps/editor` (already transitive via `@pascal-app/core`). Used for `generationId` minting per the transitive-promotion pattern from 3-1.
- The CLI path ships under `bimai/cli/` rather than alongside the generator code. Keeps the IO layer separate from the pure pipeline so the test surface stays tight.
- Boundary parse went into `pascal-writer.ts`, not `emit.ts`. The brief implied applying defaults at the emit site, but `emit.ts` is `import type`-only against `@pascal-app/core` — pulling schemas in would re-trigger the vitest crash. The writer is browser-only and already runtime-imports core.

### Things that surprised me

- **The `as unknown as Foo` cast pattern in the emitter silently dropped every Zod-defaulted field** — door `frameThickness`, `frameDepth`, `segments`, window `sill*` and `*Ratios`, etc. Pascal's render systems compute downstream values without nullish guards (`width − 2 * frameThickness`), and a single NaN in `BoxGeometry(...)` propagates into the bounding-box Box3, which then breaks drei's `CameraControls.update()` math. The 3D camera "freeze" was actually drei refusing to update its target sphere because the sphere had become NaN. 2D viewport survived because it doesn't use the same focus math.
- **Pascal's own tools always parse through Zod** (`DoorNode.parse({...})` in `door-tool.tsx:242`, `WallSchema.parse({...})` in `wall-drafting.ts:96, 102, 452`). The pattern was right there — our emitter just bypassed it for raw object construction speed and discoverability. The boundary parse retroactively brings us in line.
- **`@pascal-app/core` has no subpath exports**, so importing even a leaf Zod schema (`DoorNode`) under vitest pulls the whole barrel and crashes on `three-mesh-bvh/src/core/ObjectBVH.js` extending an undefined class. The `MemoryWriter` / `PascalSceneWriter` seam already worked around this for `useScene`; the same wall blocks the schema-validation guardrail test until either subpath exports land or we vendor a schema-only re-export.
- **Strip-end clamp is sneakier than I expected** in the mixed program case: with 50 m strips and a 5.294 m remaining tail, the 14-th unit gets clipped — not unplaced — and the visual result is one undersize 2BR rather than a missing one. The pinned test comment "rule 3 (strip-end clamp) bites here" captures this so future readers don't try to "fix" it back to an unplaced count.
- **Zustand subscription gotcha** caught the Program panel: `useFirstBuildingId` returns just an id, so a panel that reads metadata via `getState()` after the id is fixed never re-renders when the metadata mutates. Fixed by adding a `useNodeById` hook every read+write panel must subscribe through. Generation panel got the same call to keep the inputs row in sync with sibling panel edits.

### What I'd like a look at before Phase 3-4

1. **Subpath export from `@pascal-app/core`** for `./schema`. One line in `packages/core/package.json` unblocks the drift-guardrail test and removes the only "this can't be a vitest test" caveat in this phase. Two-line PR upstream.
2. **Whether the per-floor pack should be cached** rather than re-planned. We re-run corridor + pack for every floor even though they're identical today. Trivially fixable, but I left it as-is because Phase 3-4 will likely introduce floor-specific variation (stepped setbacks, ground-floor commercial), and a pre-emptive memo would just get unwound.
3. **Whether `program_exceeds_capacity` is escalating at the right threshold**. Today it only fires when the entire queue ends up unplaced. With the clamp path that's geometrically rare (longLen < 3 m). A softer "placed < 50% of requested" failure mode might surface real over-asking inputs the user should know about, but I didn't want to invent a threshold without product input.

## Phase 3-2 — Buildable Envelope (complete)

### What works (verified in the running app)

- Editor loads on http://localhost:3002. Default 30×30 m site renders a translucent blue envelope inset 4 m on every side (mean of front 5 / side 3 / rear 4) inside the orange plot outline. Dashed outline traces the envelope boundary.
- **Zoning panel → Buildable envelope** section shows live envelope area (484.0 m²) and coverage ratio (53.8%) for the default scene.
- Editing any setback in the Zoning panel updates the 3D envelope immediately. Coverage stays under 60 % for sane inputs; pushing setbacks past the plot half-width collapses the envelope and the panel switches to "No envelope — setbacks consume the plot."
- **Issues** section (warning/error chips) renders only when `computeZoningIssues` returns non-empty results. Default scene has no issues. Codes wired: `envelope_collapsed` (error), `envelope_exceeds_coverage_cap` (warning), `plot_unusually_small` (warning).
- 17 vitest specs across `geometry`, `envelope`, and `constraints/zoning`. `bun run test` is green.
- Zero console errors.

### Upstream Pascal change (deliberate, the first one this phase)

- `packages/editor/src/components/editor/index.tsx` — added optional `viewerSceneSlot?: ReactNode` prop on `EditorProps`, plumbed through `ViewerCanvas` → `ViewerSceneContent`, rendered inside the existing scene fragment. All four edit sites are bracketed with `// BIMAI: viewer-scene-slot — Phase 3-2` comments so the diff is auditable. No data-model or store changes.
- This is the slot through which `<EnvelopeRenderer />` (and any future BimAI R3F overlays) gets injected from the host app, keeping the renderer in `apps/editor/bimai/` rather than `packages/`.

### What's stubbed / known limitations

- **Uniform setback model**. We collapse front/side/rear into a single mean distance and offset every edge by that amount. Real zoning treats them per-edge based on edge classification (street-facing vs. neighbour-adjacent). Defer to a later phase that introduces edge metadata.
- **Analytic inward offset** (per-edge perpendicular shift + adjacent-line intersection). Fast and exact for convex polygons. Concave plots with reflex vertices will produce self-intersecting insets — caught and rejected as `envelope_collapsed` via the bounding-box containment + signed-area checks, but no proper Minkowski-style buffering yet. Good enough for Phase 3-2 since Pascal's default plots are rectangular.
- **Polygon-clipping intersection step is a safety net, not the engine**. We use it to clip the analytic inset against the original plot so any overflow is discarded; it's not driving the offset itself. If we move to per-edge setbacks later, a buffer-then-difference approach via polygon-clipping becomes more attractive.
- **`useActiveSiteEnvelopeData` re-derives on every selector change**. `useShallow` keeps the upstream subscription cheap (only re-runs on `siteId` / polygon ref / bimai blob ref changes), but the downstream `useMemo` recomputes envelope + issues on every dependency hit. Fine for one site at interactive scale; revisit if multi-site lands.
- **No active-site selection model**. Still picks "first SiteNode in roots" — same as Phase 3-1.

### Deviations from the brief

- Added `polygon-clipping@^0.15.7` as a direct dep (no transitive promotion this time — Pascal doesn't use it). Ships its own `.d.ts`, no `@types/*` package needed.
- Added `@types/three@^0.184.0` as a dev dep — needed once we started importing `* as THREE` directly. Pascal pulls three transitively for runtime; types weren't on the manifest. Same pattern as the zod/zustand promotions in 3-1.
- Added `vitest@^3.2.4` and a minimal `vitest.config.ts` scoped to `bimai/**/*.test.ts`. Two scripts: `bun run test` (CI) and `bun run test:watch`.
- Renderer uses `<primitive object={threeLineInstance} />` instead of a JSX `<line>` element — R3F's lowercase `<line>` clashes with the SVG intrinsic, and Drei's `<Line>` would pull more weight than needed. Manually instantiate `THREE.Line` in `useMemo` and dispose its geometry/material in the cleanup effect.

### Things that surprised me about Pascal / the offset math

- `THREE.ShapeGeometry` lays the shape on the **XY** plane, but Pascal's ground plane is **XZ** (Y-up). Easy fix — `geometry.rotateX(-Math.PI / 2)` before mounting — but worth knowing for future renderers.
- Analytic inward offset can produce an inverted-but-CCW polygon when setbacks exceed the plot's half-width: edges cross, vertices land *outside* the plot, and `signedArea(inset) > 0` because the resulting shape is still simple and counterclockwise — just bigger than the original. `Math.abs(area)` masks it entirely. Caught it because the envelope-collapse test for a 4×4 plot with 5 m setbacks was returning `ok: true` with area 16. Fixed with a bounding-box containment check before the signed-area check; documented inline in `envelope.ts`.
- `LineDashedMaterial` silently renders solid until you call `computeLineDistances()` on the line instance after construction. Done in `buildObjects` before stashing the `THREE.Line` in the memo result.

### What I'd like a look at before Phase 3-3

1. The bounding-box containment heuristic for envelope collapse is correct for axis-aligned plots but conservative for rotated rectangles (the inset's bbox can stick out past the plot's bbox even when the inset polygon itself is fully contained). For Phase 3-2's default scenes it never triggers a false positive, but if 3-3 starts generating arbitrary plot orientations, swap to `polygonClipping.difference(inset, plot)` and check whether the result is empty.
2. `EnvelopeRenderer` mounts inside the memoized `ViewerSceneContent` and reads from `useScene` directly. That subscription fires for every node-graph change. With one envelope and a small node count it's free; once 3-3 lands and the generator produces dozens of derived nodes per edit, we may want to memoize the polygon→geometry path on a coarser key than the polygon reference.

---

## Phase 3-1 — Foundation (complete)

### What works (verified in the running app)

- `bun install` + `bun dev` clean. Editor on http://localhost:3002. Pascal's drawing tools, viewport, scene tab — all unchanged.
- Sidebar shows four tabs: **Scene** (Pascal's built-in), **Project**, **Zoning**, **Program**.
- **Project**: editable name, real ISO `createdAt` (set once on first scene load, stable across reloads), schema version.
- **Zoning**: setbacks (front/side/rear), max height, max FAR, max coverage, min open space — all editable. "Plot info" section shows live area + perimeter from `site.polygon.points`, recomputing whenever the site polygon changes.
- **Program**: unit-mix table (type select / count / target area / delete), "+ Add unit type" button, Σ summary line.
- All edits persist across browser refresh (Pascal's existing scene persistence handles `metadata.bimai` automatically since it lives inside `BaseNode.metadata`).
- Default metadata seeding is idempotent — re-running the hook on a seeded scene is a no-op; `createdAt` doesn't reset.
- Zero console errors.
- `git diff upstream/main -- packages/` is empty — zero upstream Pascal modifications.

### What's stubbed / known limitations

- **Active site/building lookup**: Phase 3-1 picks "first SiteNode in roots" and "first BuildingNode under that site". Multi-site projects will need a real selection model — defer to a later phase.
- **`useFirstBuildingId` walks `site.children` first.** Pascal's default scene leaves `BuildingNode.parentId === null` even though the building is embedded in `site.children` (schema asymmetry: site holds full child objects via discriminated union, but the flat `state.nodes` dict mirrors them with `parentId: null`). Documented inline in `lib/active-nodes.ts`. If/when Pascal fixes parentId in upstream, the fallback path becomes the canonical one.
- **Zod 4 default semantics**: the brief's snippet `z.object({...}).default({})` doesn't compile under Zod 4 (it requires the full input type). Top-level schemas drop the outer `.default({})`; inner field defaults still populate via `Schema.parse({})`. Metadata helpers always pass `{}` for absent data. Same end-state, slightly different shape.
- **No tests yet** — per the brief, tests start in Phase 3-3 alongside the generator.
- **No icons in panels** — used plain `×` for delete, plus text buttons. `lucide-react` isn't a direct dep of `apps/editor` and didn't seem worth promoting for Phase 3-1's scope. Easy to add later.

### Deviations from the brief (all flagged at the time, all approved or trivial)

- Added `zod@^4.3.5` and `zustand@^5.0.11` to `apps/editor/package.json`. Both were already in the lockfile transitively via `@pascal-app/core` at the same major; this just promotes the manifest. User approved zod, then said going forward this pattern (transitive → direct) doesn't need approval.
- One TS-only cast in `lib/metadata.ts` at the `updateNode` boundary, because Pascal's `metadata: z.json()` has a stricter recursive type than the validated bimai shape (which is pure JSON). Documented inline.

### Things that surprised me about Pascal

- `SiteNode.children` is typed as an array of *full* embedded BuildingNode/ItemNode objects (via `z.discriminatedUnion`), but the flat `state.nodes` dictionary stores those same buildings independently — and the embedded copies have `parentId: null`. So there are two coexisting representations, with subtly different parent linkages. We rely on the embedded `site.children` because that's the schema-canonical hierarchy.
- Pascal persists the scene to `localStorage` under the key `pascal-editor-scene`, not IndexedDB as I'd expected from the brief. Either way, `metadata.bimai` rides along inside `BaseNode.metadata` for free — we never had to wire persistence ourselves.
- Pascal's `useScene` exposes a temporal store (Zundo) for undo/redo — we don't touch it directly, since `updateNode` already handles dirtying and history transparently.

### What I'd like a look at before Phase 3-2

1. Whether the choice to drop outer `.default({})` from schemas is acceptable long-term, or if you'd rather force the brief's literal code with a cast (e.g. `.default({} as never)`).
2. Whether the seeding hook subscribing to *every* `useScene` change is fine — it short-circuits early when bimai metadata is already present, so the cost is one comparison per state change. If you'd rather scope it tighter (e.g. only fire on rootNodeIds change), worth a brief discussion before generators land in 3-3 and the store gets noisier.
