// web-ifc lifecycle helpers.
//
// The IFC writer can't import `web-ifc` at module load — bimai's "pure"
// architecture rule (architecture.test.ts) keeps compute modules free of
// runtime deps that drag in heavy WASM, and `web-ifc` ships its wasm beside
// the JS bundle. We isolate the lifecycle here so callers from the browser
// (Generation panel "Export as IFC") can `await initIfcApi()` once and reuse
// the singleton.
//
// Writer modules (`bimai/ifc/write.ts`) take the initialized `IfcAPI`
// instance as an argument and never import `web-ifc` themselves — that keeps
// them pure-data and unit-testable without spinning up the wasm runtime.
//
// Server-side / unit tests use `web-ifc/web-ifc-api-node.js` (loaded via
// `web-ifc`'s package `main` field under bun/node). The browser bundle uses
// `web-ifc/web-ifc-api.js` (the package's `module` field) — Next.js picks
// the right entry automatically via the `exports` map.

import { IfcAPI } from 'web-ifc'

let cached: Promise<IfcAPI> | null = null

/**
 * Lazy singleton. Calls `IfcAPI.Init()` exactly once per page-load and
 * resolves to the initialized instance every time. Subsequent calls reuse the
 * same wasm module — the wasm binary is ~5 MB and the init is ~30 ms, so we
 * really don't want to redo it per export.
 */
export async function initIfcApi(): Promise<IfcAPI> {
  if (cached) return cached
  cached = (async () => {
    const api = new IfcAPI()
    await api.Init()
    return api
  })()
  return cached
}

/**
 * For tests: drop the cached instance so a fresh `Init()` runs next time.
 * Production code never needs this — the singleton lives for the page's
 * lifetime — but vitest reuses workers across files and a stale cache leaks
 * model handles between specs.
 */
export function __resetIfcApiForTests(): void {
  cached = null
}
