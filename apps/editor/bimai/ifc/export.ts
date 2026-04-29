// User-facing IFC export entry point.
//
// Wraps `writeIFC` (the writer) with the bits the panel actually wants:
//
//   • A filename derived from the project name + today's date — picked
//     here, not in the panel, so the same convention applies anywhere a
//     scene is exported (CLI, future "Export to disk" automation).
//   • Lazy wasm loading. `web-ifc`'s wasm bundle is ~3 MB; statically
//     importing `./init` or `./write` from a panel module would drag it
//     into the panel chunk and add a noticeable first-paint delay for
//     users who never click "Export". Inside this function we use
//     dynamic `import()` so the bundler splits both modules off and
//     fetches them on first call. After that, the cached singleton in
//     `init.ts` keeps subsequent exports instant.
//
// This module stays DOM-free on purpose. The panel handles blob download
// and progress UI; this function returns bytes + filename and lets the
// caller decide what to do with them. That makes it trivially testable
// (vitest can call `exportToIFC` and assert on the bytes) and keeps the
// "build the file" path independent of the "deliver the file" path —
// future automation (CLI, headless render-and-export) reuses the same
// function.

import type { SceneSnapshot } from '../generator/cleanup'
// Type-only import — does NOT trigger the runtime web-ifc dependency.
import type { WriteIFCOptions } from './write'

/** Optional inputs that override the panel-derived defaults. Always
 *  optional — `exportToIFC(scene)` works for the common path. */
export interface ExportToIFCOptions {
  /** Project name to embed in IfcProject and the filename. Falls back
   *  to "bimai_export" when absent. */
  projectName?: string
  /** GUID salt for determinism across re-exports. Defaults to the
   *  project name; pass an explicit value when project name might
   *  change but the user still wants stable GUIDs. */
  projectSalt?: string
  /** Storey height in metres. Forwarded to the writer. */
  floorToFloorHeightM?: number
  /**
   * Status callback fired on each phase transition. The panel uses it
   * to update the button label ("Loading IFC engine…" → "Exporting…" →
   * "Done"). Tests usually leave it undefined.
   */
  onStatus?: (status: ExportStatus) => void
}

export type ExportStatus =
  | 'loading-engine'
  | 'exporting'
  | 'done'
  | 'error'

export interface ExportToIFCResult {
  bytes: Uint8Array
  filename: string
}

/**
 * Build an IFC4 file for a scene. Lazy-loads the web-ifc engine on
 * first call.
 *
 * Failure modes:
 *   • The dynamic import of `web-ifc` rejects (network / corrupted
 *     bundle) → re-thrown with a wrapper message. The panel surfaces
 *     this verbatim in its red error chip.
 *   • The writer throws (malformed scene) → re-thrown unchanged.
 *
 * Successful return:
 *   • `bytes` is the STEP physical file (ASCII; safe to wrap in a Blob
 *     with type "application/x-step" or "model/ifc").
 *   • `filename` matches `bimai_<projectName>_<YYYYMMDD>.ifc` (project
 *     name slugified). When projectName is missing we use
 *     "bimai_export_<YYYYMMDD>.ifc".
 */
export async function exportToIFC(
  scene: SceneSnapshot,
  options: ExportToIFCOptions = {},
): Promise<ExportToIFCResult> {
  const { onStatus } = options
  try {
    onStatus?.('loading-engine')
    // Both imports resolve on the same chunk (Next.js / Turbopack
    // splits at the dynamic-import seam). The first call pays the
    // wasm fetch + Init() cost; subsequent calls hit the cached
    // singleton in `init.ts`.
    const [{ initIfcApi }, { writeIFC }] = await Promise.all([
      import('./init'),
      import('./write'),
    ])

    onStatus?.('exporting')
    const api = await initIfcApi()
    const projectName = options.projectName ?? 'bimai_export'
    const writeOpts: WriteIFCOptions = {
      projectName,
      projectSalt: options.projectSalt ?? projectName,
      ...(options.floorToFloorHeightM !== undefined && {
        floorToFloorHeightM: options.floorToFloorHeightM,
      }),
    }
    const bytes = await writeIFC(api, scene, writeOpts)
    const filename = buildFilename(options.projectName)

    onStatus?.('done')
    return { bytes, filename }
  } catch (err) {
    onStatus?.('error')
    throw err
  }
}

/**
 * `bimai_<slug>_<YYYYMMDD>.ifc`. Slug is the project name lowercased,
 * with non-alphanumerics collapsed to underscores. Empty / undefined
 * project name falls through to `bimai_export_<date>.ifc`.
 *
 * Exported for the unit test — the panel calls `exportToIFC` and uses
 * the returned `filename` directly, never this helper.
 */
export function buildFilename(projectName: string | undefined): string {
  const date = todayYYYYMMDD()
  const slug = slugify(projectName ?? '')
  if (!slug || slug === 'bimai_export') return `bimai_export_${date}.ifc`
  return `bimai_${slug}_${date}.ifc`
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function todayYYYYMMDD(): string {
  const d = new Date()
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${y}${m}${day}`
}
