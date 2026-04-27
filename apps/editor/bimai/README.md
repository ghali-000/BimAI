# bimai/

BimAI-specific code for this fork lives here, isolated from Pascal's upstream packages.

## Layout

- `schemas/` — Zod schemas for everything we attach to Pascal nodes via `node.metadata.bimai` (the canonical extension point). `SiteBimAIMetadata` (project info + zoning rules) lives on the SiteNode; `BuildingBimAIMetadata` (program/unit mix) lives on the BuildingNode. **This is the canonical data shape — read these files first.**
- `lib/` — pure helpers, no React, no I/O. `metadata.ts` exposes typed read/write helpers (`readSiteMetadata`, `writeSiteMetadata`, `readBuildingMetadata`, `writeBuildingMetadata`) that validate through the schemas at every boundary. `active-nodes.ts` provides hooks for the active site and first building. `geometry.ts` has area/perimeter helpers (copied from Pascal's site-panel since they aren't exported). `seed.ts` materializes default metadata onto fresh scenes.
- `state/` — Zustand stores for BimAI-only UI state (e.g. active panel). Scene data still goes through Pascal's `useScene` from `@pascal-app/core`.
- `panels/` — React sidebar tabs (Project, Zoning, Program) wired into Pascal's editor in `apps/editor/app/page.tsx`.

Future phases will add `generator/`, `optimizer/`, `schedule/`, and `ifc/` siblings.

## Rule

Pascal's source is upstream — extend, don't modify. Files under `packages/core`, `packages/viewer`, and `packages/editor` stay untouched. New behavior lives here, importing Pascal's public API.
