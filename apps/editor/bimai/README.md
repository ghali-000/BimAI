# bimai/

BimAI-specific code for this fork lives here, isolated from Pascal's upstream packages. The folder layout mirrors concerns: `schemas/` defines Zod schemas for everything we attach to Pascal nodes via `node.metadata.bimai` (the canonical extension point — see `schemas/index.ts`); `state/` holds Zustand stores for BimAI-only UI state (scene data still goes through Pascal's `useScene`); `panels/` contains React sidebar tabs wired into Pascal's editor; `lib/` is for pure helpers with no React or I/O. Future phases will add `generator/`, `optimizer/`, `schedule/`, and `ifc/` siblings.

**Rule:** Pascal's source is upstream — extend, don't modify. Files under `packages/core`, `packages/viewer`, and `packages/editor` are untouched whenever possible. New behavior lives here, importing Pascal's public API.
