# BimAI Progress

## Phase 3-3 — Procedural Generator (in progress)

### Known limitations to revisit later

- **Greedy left-then-right unit packing** fills strip 0 fully before touching strip 1, producing visually front-heavy floors with one full façade and one half-empty one. The clamp path (min/max/strip-end) keeps it correct but doesn't balance — flag as a Phase 3-5 optimizer concern (BLF / two-row balanced packing).

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
