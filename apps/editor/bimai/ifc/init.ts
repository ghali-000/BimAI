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
//
// Wasm location: in node, `web-ifc-api-node.js` reads `web-ifc-node.wasm`
// off the filesystem (relative to its own location) and "just works" for
// vitest. In the browser, the bundled `web-ifc-api.js` defaults to
// fetching `web-ifc.wasm` next to the executing JS chunk — which 404s
// under Turbopack because the bundler doesn't auto-publish wasm
// siblings of node_modules. We sidestep that by:
//   1. Copying `web-ifc.wasm` into `public/wasm/` at install time
//      (`apps/editor/scripts/copy-ifc-wasm.mjs`, run via `postinstall`).
//   2. Calling `api.SetWasmPath('/wasm/')` before `Init()` in browser
//      contexts so the runtime fetches `/wasm/web-ifc.wasm` — a stable
//      URL the Next.js static-asset server hosts directly.
// The detection is a `typeof window` check; in node the default
// filesystem path is correct and `SetWasmPath` would actively break it.

import { IfcAPI } from 'web-ifc'

let cached: Promise<IfcAPI> | null = null

/**
 * Lazy singleton. Calls `IfcAPI.Init()` exactly once per page-load and
 * resolves to the initialized instance every time. Subsequent calls reuse the
 * same wasm module — the wasm binary is ~3 MB and the init is ~30 ms, so we
 * really don't want to redo it per export.
 */
export async function initIfcApi(): Promise<IfcAPI> {
  if (cached) return cached
  cached = (async () => {
    const api = new IfcAPI()
    if (typeof window !== 'undefined') {
      // `/wasm/` is served by Next.js out of `apps/editor/public/wasm/`.
      // The trailing slash is required — `SetWasmPath` concatenates the
      // wasm filename onto the path verbatim.
      //
      // The second argument (`absolute`) MUST be true. With `false` (the
      // default), web-ifc's locateFileHandler computes
      //   `currentScriptPath + '/wasm/' + 'web-ifc-mt.wasm'`
      // — concatenating onto the executing JS chunk's URL — which under
      // Turbopack resolves to `/_next/static/chunks/.../wasm/web-ifc-mt.wasm`
      // and 404s. With `absolute=true`, the runtime returns the path
      // verbatim, fetching `/wasm/web-ifc-mt.wasm` from the Next.js
      // static-asset root where copy-ifc-wasm.mjs put it.
      api.SetWasmPath('/wasm/', true)
    }
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
