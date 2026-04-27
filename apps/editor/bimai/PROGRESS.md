# BimAI Progress

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
