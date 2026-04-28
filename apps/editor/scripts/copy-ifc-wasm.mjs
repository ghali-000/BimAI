#!/usr/bin/env node
// Copy web-ifc wasm bundles into the Next.js public/ tree.
//
// web-ifc's `IfcAPI.Init()` fetches its wasm next to the executing JS
// bundle. In a Next.js / Turbopack build that means the browser asks
// for `/<chunk-path>/web-ifc.wasm` — which 404s, because Turbopack
// doesn't auto-publish arbitrary `.wasm` siblings of node_modules JS.
//
// We sidestep the bundler entirely: copy the wasm files into
// `public/wasm/` at install time and call `api.SetWasmPath('/wasm/')`
// before `Init()` so the runtime fetches them from a stable, version-
// controlled URL.
//
// Re-runs on every `bun install` via the `postinstall` script in
// apps/editor/package.json. The destination is gitignored — the source
// of truth is whichever web-ifc version is in the lockfile.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const editorRoot = join(__dirname, '..')

// Resolve web-ifc relative to *this* script so the layout works under
// hoisting (bun, npm workspaces) and non-hoisting (pnpm). Prefer the
// app-local install if it exists, fall back to the workspace root.
const candidates = [
  join(editorRoot, 'node_modules', 'web-ifc'),
  join(editorRoot, '..', '..', 'node_modules', 'web-ifc'),
]
const src = candidates.find((p) => existsSync(p))
if (!src) {
  // Don't fail the install — web-ifc may legitimately be absent in a
  // fresh checkout that hasn't run `bun install` yet. The next install
  // round will re-run this script.
  console.warn('[copy-ifc-wasm] web-ifc not found; skipping')
  process.exit(0)
}

const destDir = join(editorRoot, 'public', 'wasm')
mkdirSync(destDir, { recursive: true })

// `web-ifc.wasm` is the single-threaded build (the one we actually use).
// `web-ifc-mt.wasm` is the multi-threaded variant; copy it too in case a
// future Init() opts into threading. `web-ifc-node.wasm` is for
// node-side use and stays in node_modules.
const files = ['web-ifc.wasm', 'web-ifc-mt.wasm']
for (const file of files) {
  const from = join(src, file)
  if (!existsSync(from)) continue
  copyFileSync(from, join(destDir, file))
  console.log(`[copy-ifc-wasm] ${file}`)
}
