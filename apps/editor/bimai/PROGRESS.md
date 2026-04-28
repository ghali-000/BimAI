# BimAI Progress

## Phase 3-5 — Optimizer (complete)

### What works (verified in the running app)

- New **Optimizer** tab between Generation and Schedule. Three search controls (samples, seed, top-K), four objective weight inputs (mix accuracy / sellable area / cost-per-unit / compliance), Run button. Click Run — search executes off the main thread in a Web Worker, panel shows running progress, settles into a status block with sampled / compliant / best-score / top-K-loaded / duration, and the gallery below populates.
- **Two-tier ScoredCandidate**: every sampled candidate carries the lightweight payload (params, composedScore, breakdown, compliant, failure); only the top-K (default 6) carry the heavy fields (`plan: BuildingPlan`, `schedule`, `cost`, `snapshot`). Memory stays bounded even at large sample counts.
- **Worker integration**: `runSearchInWorker(args): SearchHandle` returns `{ result: Promise, cancel() }`. Cancel calls `worker.terminate()` for instant interruption — no in-loop checks. jobId-tagged postMessage protocol so stale messages from a previously-cancelled run never land on the new handler. The fake-WorkerLike harness lets vitest drive the client end-to-end without spinning a real Worker.
- **Results gallery**: 2-col grid of cards under the status block. Card anatomy: SVG plan thumbnail (4:3, ground floor only), composed score large, metrics row (units placed / NIA m² / €/unit). Click toggles selection — the store auto-selects the top-ranked compliant candidate when a search settles, so the Details section is populated on first paint without an extra click. Selection swaps the Details section: 4 sub-score breakdown bars + a `<dl>` of the candidate's params (packing strategy, floor count strategy, unit ordering, corridor axis/width, footprint inset/orientation, variant, seed).
- **SVG plan thumbnails** are pure builder output. `buildThumbnail(plan, opts): { viewBox, layers }` is in `panels/optimizer-panel/build-thumbnail.ts` — Z-ordered footprint → corridor → unit zones (centralised palette via `lib/unit-colors.ts`) → wall stroke. The React wrapper (`candidate-thumbnail.tsx`) is a thin map of layers to `<path>` elements with a group-level `matrix(1 0 0 -1 0 ty)` transform to bridge math-space (y-up) and SVG (y-down). `vector-effect="non-scaling-stroke"` keeps the wall hairline at any card size. viewBox = building bbox + 10% margin (no plot polygon — the brief locked Option 3 SVG-thumbnails-no-3D).
- **"Load into scene" button** under the gallery dispatches `useOptimizer.loadSelectedToScene()` which bumps a monotonic `loadRequestSeq`. A small `<OptimizerLoadBridge />` mounted in the panel watches the counter and on each increment hands the selected candidate's pre-baked plan to `applyPlanToScene(plan, buildingId, writer)` — a new public seam factored out of `runGenerator` so the optimizer skips the planning phase but reuses the exact same paused-history apply window the Generate button uses. One Cmd-Z reverses the load.
- **Multi-select BIM editing** in the BIM Properties tab. `summarizeMultiSelection(nodes)` (lib/multi-select.ts) reduces the selection to a Tristate snapshot per field — `shared(value)` / `mixed` / `absent` — and identifies the cost-override slot (`'perM2'` for walls+slabs, `'flat'` for doors+windows, `'mixed'` when the selection straddles, `null` when no supported nodes). The form hides material + load-bearing when types straddle (no single options list to pick from), hides cost-override when slots straddle, and shows `(mixed)` placeholders for fields with disagreeing values. Editing a field loops `applyPatch` over every supported id.
- **364 vitest specs** (up from 348 at end of Phase 3-4 + the 14-test architecture suite that landed mid-3-4). New suites: `optimizer/params.test.ts`, `optimizer/objectives.test.ts`, `optimizer/compliance.test.ts`, `optimizer/store.test.ts`, `optimizer/search/run.test.ts`, `optimizer/worker/handle-message.test.ts`, `optimizer/worker/client.test.ts`, `panels/optimizer-panel/build-thumbnail.test.ts`, `lib/multi-select.test.ts`, plus `applyPlanToScene` cases on `pipeline.test.ts` and a handful of unit-color regression locks. `bun run test` is green.
- Zero console errors. End-to-end loop verified in the running app: Run search → 20 samples / 2 compliant / best 0.744 → click candidate #12 → Load into scene → 3D viewport replaces the prior generation with the candidate's building.

### GATE 1 — Parameter space (locked)

The brief offered three packing-axis options. Locked: **strip-pair packing strategy** with `'left-then-right' | 'alternating'`, **floor count strategy** `'max-far' | 'max-units' | 'min-cost'`, **unit-ordering heuristic** `'declared' | 'largest-first' | 'smallest-first'`, **corridor orientation** `'long-axis' | 'short-axis'`, plus three continuous knobs: `corridorWidthM ∈ [1.4, 2.4]`, `footprintInsetM ∈ [0, 4]`, `footprintOrientation ∈ [-π/4, π/4]`. `variant: number` is a tag the packer can read for tie-breaking. `withDefaults(partial)` merges over the Phase 3-3 defaults so a no-params call reproduces the prior pipeline byte-for-byte.

### GATE 2 — Search algorithm (locked)

Random search over the parameter space, two-tier candidate retention, top-K=6 by default. The optimizer runs the existing generator + schedule + cost pipeline against an in-memory writer per sample; only candidates passing compliance contribute to top-K. Determinism is via mulberry32(seed) — same seed + same site/program reproduces the same composedScore and topK indices. `runSearch` accepts an injectable `onProgress(sampled, total, compliantSoFar)` callback, fired every `progressEveryN = max(1, count/20)` samples plus once at the end so the UI gets ~20 ticks regardless of sample size.

### GATE 3 — Results gallery (locked)

Option 3: SVG plan thumbnails of `floors[0]`, no 3D, no plot polygon. 4:3 cards in a 2-col sidebar grid, `preserveAspectRatio="xMidYMid meet"` so the SVG letterboxes inside its card. Click toggles selection (auto-selected to top-ranked on first paint), Details section under the gallery shows breakdown + params on selection. "Load into scene" lives below the gallery as a full-width button, disabled until a candidate is selected. Empty state when `topK.length === 0` ("No compliant candidates found. Try widening the parameter space or relaxing zoning."). No sort or filter controls — top-K is already sorted by composed score descending.

### Architectural decisions worth noting

- **Worker code split into four files.** `protocol.ts` (discriminated-union message types) / `handle-message.ts` (pure handler — `handleMessage(msg, post)` switch on msg.type, runs `runSearch`, posts ProgressMsg/DoneMsg/ErrorMsg) / `search.worker.ts` (thin `self.onmessage` wrapper around `handleMessage`) / `client.ts` (orchestrator with injectable `workerFactory` and `WorkerLike` interface). Vitest can drive the handler in node-env without `Worker`; the bundler gets a clean URL-import for the worker chunk via `new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })`. CanceledError class lets callers distinguish cancel-vs-error.
- **Determinism vs nanoid IDs.** Lightweight ScoredCandidate fields are deterministic — params / composedScore / breakdown / compliant / failure all reproduce byte-for-byte at fixed seed. Heavy fields (plan, snapshot) carry nanoid generationIds and node ids, which vary per run by design. The determinism test strips heavy fields via a `stripVolatile` helper and compares only the lightweight payload + topK indices.
- **Pure SVG-data builder pattern.** All thumbnail geometry math (bbox, viewBox math, polygon paths, layer ordering) lives in `build-thumbnail.ts` so vitest's node env can collect it; the React `.tsx` is a thin layers→`<path>` map. Same lesson as Phase 3-4's pure compute modules — anything that needs tests stays React-free.
- **`applyPlanToScene` factored out of `runGenerator`.** The optimizer's "Load into scene" button needs the apply phase but not the planning phase — the worker already produced the plan. Extracting the apply phase as a public helper keeps both call sites on the same paused-history seam (one Cmd-Z reverses either operation) without duplicating the stale-generation sweep + BIM-default pass + writer-coupling logic.
- **Centralised unit-colour map.** Pre-Task 9 refactor: pulled the inline hue formula out of `generator/emit.ts` into `lib/unit-colors.ts` (`unitColor(type) → hsl(hue, 60%, 70%)`, `unitHue(type)` is `(h*31 + charCode) | 0` mod 360). Same palette is now used by the 2D viewer's zone fill and the new SVG thumbnails. Regression-locked the values so a future hash change can't silently re-paint every existing screenshot (Studio→166, 1BR→257, 2BR→138, 3BR→19).
- **Cross-panel state sharing via Zustand store.** `useOptimizer` holds `status / progress / result / error / selectedCandidateIndex / loadRequestSeq`. The panel writes; the gallery + load-bridge read. `loadRequestSeq` is a monotonic counter so subscribers diff against the previous value — simpler than an event channel and survives strict-mode double-mounts via a `lastAppliedRef` in the bridge.

### What's stubbed / known limitations

- **Compliance ratio is too low at default settings.** Manual integration check (20 samples, default zoning, mixed program) landed 2/20 compliant — the rest failed `no_valid_footprint`. The parameter space samples `footprintInsetM` / `footprintOrientation` outside what a 30×30 plot can sustain. Two fix options on the table: tighten the inset bounds to a fraction of `min(plotWidth, plotDepth)`, or pre-validate footprints before counting them as failures. **Deferred to a Phase 3-6 follow-up** so the gallery reliably fills six cards on the default scene.
- **Stale "Level 0" tree entry observed during integration.** After Load into scene, the scene tree showed a duplicate Level 0 entry. Hard to tell whether `findGeneratedNodes` is missing a level node or the upstream tree component is rendering a phantom on the second pass. Flagged for Phase 3-6.
- **Random search only.** No simulated annealing, evolutionary, or local-refinement strategies. Random gets us a usable gallery in O(20 samples × generator cost ≈ 200 ms) on the default scene; the param-space surface is small enough that random covers it well at 50+ samples. Smarter strategies are a Phase 3-7+ concern once we know which axes correlate with the objective.
- **Single-site / single-building only.** The optimizer reads the active site + first building ids the same way Generation panel does. Multi-site selection still pending across the whole project.
- **Compliance check is binary.** A candidate either passes every compliance rule or doesn't contribute to top-K. No "soft" compliance with penalty weights — a candidate that misses one constraint by 0.1 m looks identical to one that misses every constraint by 5 m. Flagged for the same Phase 3-6 follow-up that fixes the compliance ratio.
- **Multi-select BIM panel writes one node at a time.** `applyPatch` loops over `supportedNodes` and writes each via `useScene.getState().updateNode` — N store updates per change. For typical selections (≤20 elements) it's imperceptible; if multi-select grows to hundreds of elements we'd want a batch-update seam on the store. Pinned via the multi-select tests so the loop body stays isolated.
- **Worker bootstrap doesn't validate StartMsg payloads** — handler trusts the protocol shape. Trusted because the only sender is our own `client.ts`, but if we ever expose the worker entry as a public API a Zod gate at the boundary would be the obvious next move.

### Deviations from the brief

- **Sub-score bars moved out of the card.** The brief allowed sub-score mini-bars under the metrics row; we moved them into the Details section instead because at card scale they were illegible and competed visually with the score number. Selection now drives Details visibility, so the user trades one click for legibility.
- **Cost override slot disambiguation.** The brief didn't specify what to do for a multi-select that mixes wall+slab (per-m²) with door+window (flat). The summarizer adds a fourth slot value `'mixed'`, which the panel hides — same behaviour as `typesAreMixed` for material. Documented inline in `multi-select.ts`.
- **No "Load all top-K" or "Compare" affordance.** Single selection drives one applied plan; the gallery doesn't support batch load or side-by-side comparison. Both came up in the brief as nice-to-haves; deferred until we see whether users actually want to keep multiple candidates around at once.

### Things that surprised me

- **The cache miss isn't where you'd expect it.** First few worker round-trips were slow because each search ran the full generator pipeline cold; once we warmed the v8 IC for the packer, average per-sample cost dropped from ~25 ms to ~4 ms. The progress callback's default `progressEveryN = count / 20` yields ~20 progress ticks, which felt right at 50 samples and started feeling sparse at 500 — minor enough that we didn't promote it to a runtime knob.
- **Strict Mode double-mount bit the load-bridge.** First implementation called `applyPlanToScene` inside the `useEffect` body unconditionally — Strict Mode's double-mount applied the candidate twice on first load, which the stale-generation sweep happily handled but the user saw a flash. Fixed with `lastAppliedRef` so only the *seq* triggers writes, not the effect's mount.
- **Vitest's node env doesn't define `Worker`.** Tests for the client had to inject a fake `WorkerLike`. Tests for `handle-message.ts` skip the worker plumbing entirely and call the handler directly with a mock `post` function. Two-pronged test strategy ended up cleaner than trying to polyfill DOM Worker semantics.
- **`as const satisfies` (again).** Same trap as Phase 3-4's catalog: declaring `DEFAULT_PARAMS` with `as const satisfies GenerationParams` narrowed every numeric field to its literal type, which made `withDefaults` choke when partial overrides arrived. Worked around with a structural `: GenerationParams` annotation on the export instead of `as const`.
- **SVG y-axis flip vs. preserveAspectRatio.** Putting the flip on the SVG's `viewBox` (negative height) breaks `preserveAspectRatio="xMidYMid meet"` — it interprets the negative as "fit minus-height" and produces nothing. Putting the flip on a child `<g transform>` keeps the viewBox positive and aspect-ratio handling sane. Documented at the top of `candidate-thumbnail.tsx`.
- **Two-tier candidate memory model paid for itself immediately.** Storing only lightweight fields for the 18 non-top-K candidates kept the result blob under 3 KB; storing every plan would have been ~40 KB at 20 samples and growing linearly. The store pings React subscribers on every result change, so a cheap result blob keeps the panel re-render snappy.

### What I'd like a look at before Phase 3-6

1. **Compliance ratio fix** — the open follow-up from the integration check. Tightening the param space is the obvious move; whether to simultaneously add a soft-compliance penalty path (so near-miss candidates show up in topK with a partial score) is a product call.
2. **Stale Level 0 tree entry** — needs a 5-minute grep through the upstream sidebar tree component to figure out whether `findGeneratedNodes` is the bug or whether the tree is rendering a stale level snapshot.
3. **Whether "Load all top-K" is worth building** — would let users line up six generations as variant levels under the same building and walk between them. Cheap to wire (call `applyPlanToScene` per candidate against a fresh building copy) but needs a design call on what the building tree should look like.

## Phase 3-4 — Schedule and BIM Data (complete)

### What works (verified in the running app)

- Sidebar grew three new tabs: **Schedule**, **Cost**, **BIM**. Generate from the Generation tab and they all light up against the same scene without further user input.
- **Every generated node now ships with `metadata.bimai.bim`** — a validated `ComponentBIM` blob carrying `material`, `fireRating`, `loadBearing`, and an optional `costOverride`. Walls/slabs/doors/windows all stamped at emit time by the new bim-defaults pipeline stage; the BIM Properties panel reads/writes that same blob.
- **Schedule panel** mirrors architechtures.com's sidebar: Totals (GEA / NIA / efficiency), Residential (avg unit area + per-unit-type table sorted by count desc), By-Floor breakdown, Warnings. GEA = Σ slab polygon area, NIA = Σ zone polygon area, efficiency = NIA/GEA. Default 30×30 / 2-floor scene reports GEA 968 m², NIA ≈ 530 m², efficiency ≈ 55 %.
- **Cost panel** renders the architechtures.com hierarchy: **Above grade — modelled** (per-component €) → **Typology — estimated (€/m² × GEA)** → **Hard cost** → **Soft costs** → **Total project estimate**, plus per-m² and per-unit ratios. Editing a wall material in the BIM tab updates the cost panel live.
- **BIM Properties panel** is selection-driven — read off `useViewer.selection.selectedIds`. Empty selection / multi-select / unsupported type all show distinct placeholders. For wall/slab/door/window: material dropdown filtered by `materialsApplicableTo(type)`, fire-rating select, load-bearing toggle (read-only for slab/door/window per phase-scope), cost-override input with a **catalog ghost caption** (`catalog: €180/m²`) so users see the baseline they're overriding.
- **"Apply defaults" affordance** when a selected node has no `bim` blob (e.g. user-drawn nodes pre-dating Phase 3-4). One click stamps the type-default material + fire rating + structural flag.
- 212 vitest specs (up from 195). New suites: `generator/stages/bim-defaults.test.ts` (11), `schedule/compute.test.ts` (12), `cost/compute.test.ts` (14), `lib/component-bim.test.ts` (17). Plus `bim/materials.test.ts` (existing) covers the catalog. `bun run test` green.
- Zero console errors. Live propagation across panels verified by clicking through Generate → BIM-edit-material → watch Cost numbers change.

### Cost model — design decision (locked in this phase)

The brief listed three candidate cost models; user picked **(c) hybrid** with three explicit refinements:

1. **Additive typology categories**, not a multiplier on structural. Categories are independent line items — `mep`, `finishes`, `generalConditions` (each €/m² × GEA) plus a `contingencyPct` applied to the running subtotal. The "structural × 2.5" pattern was rejected as opaque.
2. **`TypologyOverride` schema** lives on `SiteNode.metadata.bimai.typologyOverride` (read path only this phase — no UI). Resolved at compute time via `resolveTypology(override)` which deep-merges over `DEFAULT_TYPOLOGY`. EU mid-rise residential 2025 baselines: mep €210/m², finishes €175/m², generalConditions €75/m², contingencyPct 8 %, softCostsPct 10 %.
3. **Two computed totals**: `hardCost` = perComponent + typology (incl. contingency), `totalProjectCost` = hardCost × (1 + softCostsPct). Both surfaced in the panel separately so the soft-cost framing is honest.

`computeCost(scene, options)` is pure and pulls **GEA from `computeSchedule`** rather than re-computing area math — schedule is the single source of truth for area. The cost panel composes the two: it runs the schedule once, reads `siteMeta.typologyOverride`, and feeds both into `computeCost`.

### Wall classification — `wallRole` tag

The cost layer needs disjoint wall buckets (exterior / loadBearing / interior) but the emitter doesn't know geometric role from a finished `WallNode` alone. Solution: added `wallRole: 'perimeter' | 'corridor' | 'party'` to `metadata.bimai` at emit time. The bim-defaults stage reads it deterministically:

- `perimeter` → exterior, brick, A1, load-bearing
- `corridor` / `party` → interior, drywall, A2, non-load-bearing

The cost classifier then collapses the trio into the three disjoint buckets via the `EXTERIOR_WALL_MATERIALS` set + the `loadBearing` flag — order: `exterior > loadBearing > interior`, every wall in exactly one. The catalog's `applicableTo` field keeps the BIM panel dropdowns from suggesting `concrete-precast-facade` for an interior wall.

### GATE 2 — BIM Properties UI placement

Brief proposed two options: **(a) dedicated BIM tab** in the BimAI sidebar, or **(b) reuse Pascal's existing element-detail slot**. After grepping `EditorProps`, only `viewerSceneSlot` is exposed upstream — there's no `elementPanelSlot` to slot into. Going with **(a) dedicated tab** kept the phase boundary clean (no upstream PR required) and gave us room to grow the form. The trade-off is that the user has to context-switch tabs after selecting; mitigated by keeping the panel reactive to `useViewer.selection` so it follows the active selection automatically.

### Pure helpers vs. store-bound helpers

Phase 3-3 documented the three-mesh-bvh barrel crash that bites any vitest module which transitively imports `useScene` from the bare `@pascal-app/core` barrel. Phase 3-4 surfaced it again twice:

- `lib/component-bim.ts` was carved out as a **pure** module (only `type` imports of `@pascal-app/core`) so all 17 of its tests collect cleanly. The panel does the actual `useScene.getState().updateNode` write inline; the helpers just compute the next blob and metadata shape.
- `cost/compute.ts` originally imported `readSiteMetadata` from `lib/metadata.ts` (which uses `useScene`) and crashed under vitest collection. Fixed by removing the import and making `typologyOverride` an explicit `options` field — the panel reads site metadata and passes the override down. Architectural rule: **pure compute modules don't reach into the store directly.**

### What's stubbed / known limitations

- **Single-element BIM editing only.** `selectedIds.length > 1` shows a placeholder. A future "apply to all selected" affordance is plausible — Phase 3-5+.
- **Load-bearing toggle is read-only for slab/door/window.** Slabs are always structural in this phase; doors/windows never are. The control still renders so the panel feels complete and a future phase introducing non-structural slabs can flip the readOnly check.
- **`TypologyOverride` has no panel UI** — read-only path. Editing requires hand-mutating `site.metadata.bimai.typologyOverride`. Wiring a control set into the Project or Cost panel is a Phase 3-5 concern.
- **Cost classifier uses `EXTERIOR_WALL_MATERIALS = { 'brick-exterior', 'concrete-precast-facade' }`** as a hardcoded set. If the catalog grows we'll want a `applicableTo` flag or a `category` field on the material entry instead.
- **Catalog ghost caption only updates after material change is committed.** User edits the material dropdown → it writes immediately → ghost re-reads. There's no "preview new material's ghost on hover" affordance.
- **No live cost-override validation in the panel.** `mergeBIMPatch` rejects via Zod and `console.warn`s; the panel doesn't surface the message inline. Pinned via tests instead. Negative `costOverride.perM2` currently passes (Zod has no min) — the test pins this so a future tightening notices.
- **Schedule warnings are informational** — orphan zones, missing slabs, missing `unitType`. Not surfaced as hard failures.

### Deviations from the brief

- The cost "hybrid" model in the brief mentioned `multiplier` framing on the typology side; we replaced it with additive categories per the user's GATE 1 refinement. The `CostResult` shape now exposes both subtotals (`perComponentTotal`, `typologyTotal`) so the panel can render them as peer line items.
- BIM helpers split into a new `bimai/lib/component-bim.ts` rather than tacked onto `bimai/lib/metadata.ts`. metadata.ts is already site/building-scoped; mixing in arbitrary-node reads would muddy the surface, and metadata.ts's `useScene` runtime import would re-trigger the vitest crash for the new test suite. Documented inline at the top of `component-bim.ts`.
- BIM panel writes use `useScene.getState().updateNode(id, { metadata: nextMetadata as unknown as Record<string, never> })` — same boundary cast Phase 3-1 introduced for `metadata: z.json()`'s recursive type vs. the validated bimai blob.

### Things that surprised me

- **`as const satisfies Record<...>` narrows literal types beyond what destructured access expects.** The catalog declaration narrows each entry's `costPerM2`/`costPerUnit` to its literal type or omits the property entirely; reading `mat.costPerM2` on the union fails to typecheck. Worked around in the panel via a structural cast (`{ costPerM2?: number; costPerUnit?: number }`). Also surfaced in pre-existing `bim/materials.test.ts` errors that the test file accepts via the same access pattern — flagged but not fixed in this phase.
- **Pascal's selection store has no `primary` field.** `useViewer((s) => s.selection)` returns `{ buildingId, levelId, zoneId, selectedIds }` — buildings/levels/zones live in their own slots, but walls/slabs/doors/windows all land in `selectedIds`. The panel uses `selectedIds.length === 1` as the proxy.
- **Three-mesh-bvh strikes again, third time this project.** Every new pure module needs to grep its transitive import set for `useScene` before its tests run. The architectural rule (pure compute = type-only imports) caught it on cost/compute.ts after one round-trip; cheap to fix once you know the smell.
- **Zod 4's `.enum().options` returns the literal-tuple** — handy for iterating dropdown options without re-declaring the union. Used in FireRatingField.
- **Strip-end-clamped 2BR units have undersized GEA contribution.** The schedule sums slab polygon area for GEA, which is correct; but the byUnitType `avgUnitArea` for 2BR drops below the program's target because of the rule-3 clip. Pinned via `schedule/compute.test.ts` so the math is auditable.

### What I'd like a look at before Phase 3-5

1. **`TypologyOverride` UI** — **deferred to Phase 3-6** (will land alongside other construction settings; the read path is enough for 3-5).
2. **Multi-select editing** — **deferred to Phase 3-5** alongside the optimiser overrides. Loop `applyPatch` over `selectedIds`; high-leverage once the optimiser starts producing batches users want to re-tag.
3. **Cost-override negative-value policy** — **closed in this phase.** The `CostOverride` schema gained `.min(0)` on perM2 / perM3 / flat (commit `e253e27`). The earlier "negative passes" test was flipped to assert rejection. Explicit zero (= "free") still passes.
4. **Architecture test for type-only imports landed** — see `bimai/architecture.test.ts`. Walks the bimai/ tree, parses every "should be pure" module via TypeScript's compiler API, and asserts every `import` of `@pascal-app/core` (the bare barrel — `'/schema'` is exempt) is type-only. One dynamically-named `it()` per file so a future violation reads as "bimai/cost/compute.ts: non-type-only import of @pascal-app/core (line 12) — pure compute modules must use type-only imports to avoid the three-mesh-bvh barrel crash". Captures the rule that's bitten three times across phases 3-3 / 3-4 in runnable form.

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
- **Placement headline** in the Generation panel — a single prominent line above the per-floor warnings: "Placed 14 of 14 units per floor (100%). 28 total across 2 floors." Percentage colour-codes by threshold (≥80% green, 50–80% default, <50% amber, <25% red). The same `PlacementSummary` ships on `GeneratorOutput.placement` and on the CLI artifact, so headless callers get the same stats without parsing warnings.
- **131 vitest specs** across `geometry`, `envelope`, `constraints/zoning`, `tag`, `cleanup`, `emit`, the new `emit.guardrail` (every emitted node round-trips through its Pascal Zod schema), `pipeline`, and the four packer stages (corridor, footprint, floors, units). `bun run test` is green; `bun run test:watch` works for iteration.
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
- **Identical floors** — every level re-runs the same corridor + pack with the same outline. Stepped setbacks, ground-floor commercial, penthouse units would all need the floor loop to vary by `i`. Per-floor re-plan considered, deferred until Phase 3-4 introduces per-floor variation.
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

1. **Subpath export from `@pascal-app/core`** for `./schema`. Done as an upstream PR (BIMAI: upstreamed PR #NNN); local pick mirrors it on bimai-main with a comment to revert when the PR merges. Drift-guardrail test now lives at `bimai/generator/emit.guardrail.test.ts`.
2. **Whether `program_exceeds_capacity` is escalating at the right threshold**. Today it only fires when the entire queue ends up unplaced. With the clamp path that's geometrically rare (longLen < 3 m). The new placement-rate summary (see below) surfaces partial-fill outcomes prominently in the panel; whether to escalate at e.g. <25% to a hard failure remains a product call.

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
