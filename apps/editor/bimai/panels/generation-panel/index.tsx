'use client'

// Generation panel — the user-facing surface for the procedural generator.
//
// Contract: a single Generate button takes the site polygon + zoning + program
// from the active site/building's metadata, runs the pipeline against Pascal's
// store via the SceneWriter seam, and surfaces the typed result (ok with
// opsApplied + warnings, or { reason, issues }). Everything inside the click
// handler is synchronous and wrapped in temporal pause/resume by the pipeline,
// so a single Cmd-Z rolls the entire generation back.
//
// Phase 3-3 deliberately avoids streaming progress, cancellation, or preview
// — the generator runs in O(ms) on plausible inputs. If we add expensive
// stages later (BLF packing, optimisation), revisit and move work off the
// click thread.

import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { useEffect, useRef, useState } from 'react'
import { findGeneratedNodes } from '../../generator/cleanup'
import { createPascalSceneWriter } from '../../generator/pascal-writer'
import { runGenerator } from '../../generator/pipeline'
import type { GeneratorOutput } from '../../generator/types'
import {
  useActiveSite,
  useFirstBuildingId,
  useNodeById,
} from '../../lib/active-nodes'
import {
  readBuildingMetadata,
  readSiteMetadata,
} from '../../lib/metadata'
import type { Program, ZoningRules } from '../../schemas'
// `exportToIFC` is a tiny wrapper over the writer; web-ifc's wasm
// (~3 MB) sits behind a dynamic import inside it, so importing the
// wrapper statically here does NOT pull wasm into the panel chunk.
import {
  type ExportStatus,
  exportToIFC,
} from '../../ifc/export'

const DEFAULT_ZONING: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}

const DEFAULT_PROGRAM: Program = {
  unitMix: [],
  floorToFloorHeight: 3,
}

export function GenerationPanel() {
  const site = useActiveSite()
  const buildingId = useFirstBuildingId(site?.id ?? null)
  // Subscribe so the inputs panel reflects program/zoning edits made in
  // sibling panels without a refresh. (Same reason as ProgramPanel — see
  // `useNodeById` doc.)
  useNodeById(buildingId)
  const [last, setLast] = useState<GeneratorOutput | null>(null)
  const [running, setRunning] = useState(false)

  if (!site) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        No site loaded.
      </div>
    )
  }
  if (!buildingId) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        No building in scene.
      </div>
    )
  }

  const siteMeta = readSiteMetadata(site.id)
  const buildingMeta = readBuildingMetadata(buildingId)
  const zoning = siteMeta.zoning ?? DEFAULT_ZONING
  const program = buildingMeta.program ?? DEFAULT_PROGRAM
  const plotPolygon = (site.polygon?.points ?? []) as [number, number][]
  const totalUnits = program.unitMix.reduce((s, r) => s + Math.max(0, r.count), 0)
  const canGenerate = plotPolygon.length >= 3 && !running

  const handleGenerate = () => {
    if (!canGenerate) return
    setRunning(true)
    try {
      const writer = createPascalSceneWriter()
      const result = runGenerator(
        {
          siteId: site.id,
          buildingId,
          plotPolygon,
          zoning,
          program,
        },
        writer,
      )
      setLast(result)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Inputs
        </h3>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Plot vertices</span>
          <span>{plotPolygon.length}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Setbacks (F/S/R)</span>
          <span>
            {zoning.setbacks.front} / {zoning.setbacks.side} /{' '}
            {zoning.setbacks.rear} m
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Σ units requested</span>
          <span>{totalUnits}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Floor-to-floor</span>
          <span>{program.floorToFloorHeight} m</span>
        </div>
      </section>

      <section>
        <button
          className="w-full cursor-pointer rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canGenerate}
          onClick={handleGenerate}
          type="button"
        >
          {running ? 'Generating…' : 'Generate building'}
        </button>
        <p className="mt-1.5 text-muted-foreground text-xs">
          Replaces all previously-generated nodes under this building. Undoable
          in one step.
        </p>
      </section>

      {last && <ResultSection result={last} />}

      {/* Export sits below the result block on purpose — the mental
          model is "I generated → here's the result → I can export this".
          We render it whether or not `last` is set; the disabled state
          (no generated nodes for this building) carries the prerequisite
          rather than hiding the affordance. */}
      <ExportSection buildingId={buildingId} siteId={site.id} />
    </div>
  )
}

// Pick a colour for the placement-rate percentage. Thresholds match the
// brief: ≥80 % green, 50–80 % default (no colour), <50 % amber, <25 % red.
// Order matters — narrow buckets first so the early returns work.
function placementRateColour(rate: number): string {
  if (rate < 0.25) return 'text-red-400'
  if (rate < 0.5) return 'text-amber-300'
  if (rate >= 0.8) return 'text-emerald-300'
  return ''
}

function PlacementHeadline({
  result,
}: { result: Extract<GeneratorOutput, { ok: true }> }) {
  const { unitsPlacedPerFloor, unitsRequested, placementRate, totalAcrossFloors } =
    result.placement
  const pct = Math.round(placementRate * 100)
  const colour = placementRateColour(placementRate)
  return (
    <p className="text-foreground text-sm">
      Placed <span className="font-medium">{unitsPlacedPerFloor}</span> of{' '}
      <span className="font-medium">{unitsRequested}</span> units per floor (
      <span className={colour ? `${colour} font-medium` : 'font-medium'}>
        {pct}%
      </span>
      ).{' '}
      <span className="text-muted-foreground">
        {totalAcrossFloors} total across {result.plan.floorCount} floor
        {result.plan.floorCount === 1 ? '' : 's'}.
      </span>
    </p>
  )
}

function ResultSection({ result }: { result: GeneratorOutput }) {
  if (result.ok) {
    return (
      <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Last generation
        </h3>
        <PlacementHeadline result={result} />
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Status</span>
          <span className="text-emerald-300">ok</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Floors</span>
          <span>{result.plan.floorCount}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Nodes created</span>
          <span>{result.opsApplied}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Generation ID</span>
          <span className="truncate font-mono text-[10px]">
            {result.plan.generationId}
          </span>
        </div>
        {result.warnings.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1">
            {result.warnings.map((w, i) => {
              // Phase 3-7 Fix A: strip the typed `code: ` prefix for the
              // in-panel rendering — the codes are useful for log greps
              // but noisy in the user-facing list. Suggestions are
              // already part of the message body so they ride along.
              const display = w.replace(
                /^(unit_too_narrow_for_template|unit_widened_for_bisection|unit_clipped_max|plot_too_narrow|corridor_layout_failed|area_drift):\s*/,
                '',
              )
              const isBlocking = w.startsWith('unit_too_narrow_for_template')
              return (
                <li
                  className={
                    isBlocking
                      ? 'rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-300 text-xs'
                      : 'rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-300 text-xs'
                  }
                  key={i}
                >
                  {display}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    )
  }
  return (
    <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Last generation
      </h3>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">Status</span>
        <span className="text-red-300">{result.reason}</span>
      </div>
      {result.issues.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {result.issues.map((m, i) => (
            <li
              className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-300 text-xs"
              key={i}
            >
              {m}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ── IFC export ──────────────────────────────────────────────────────────────
//
// Disabled until at least one generated node exists for the active
// building (taught via tooltip). On click: lazy-load wasm, build the
// IFC bytes, push a Blob download, surface a green "Exported …" line
// for ~5 seconds. Errors render red and persist until the next click.
//
// Status progression in the button label: idle → "Loading IFC engine…"
// (first-call wasm fetch + Init) → "Exporting…" (writer running) →
// "Done" (briefly, until the result line takes over). The two pre-done
// states are user-visible because the wasm fetch can take 1-2 s on a
// cold cache and "stuck" buttons feel broken otherwise.

const RESULT_FADE_MS = 5_000

interface ExportFeedback {
  kind: 'ok' | 'error'
  message: string
}

function ExportSection({
  buildingId,
  siteId,
}: { buildingId: AnyNodeId; siteId: AnyNodeId }) {
  // Subscribe to Pascal's node dictionary so the disabled-state recomputes
  // automatically the moment the generator commits its first nodes — without
  // this the button stays greyed out until the user clicks somewhere.
  const nodes = useScene((s) => s.nodes) as Record<AnyNodeId, AnyNode>
  const [status, setStatus] = useState<ExportStatus | 'idle'>('idle')
  const [feedback, setFeedback] = useState<ExportFeedback | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const generatedCount = findGeneratedNodes({ nodes }, buildingId).length
  const hasGenerated = generatedCount > 0
  const busy = status !== 'idle' && status !== 'done' && status !== 'error'
  const disabled = !hasGenerated || busy

  // Auto-clear the success/error chip after RESULT_FADE_MS. Cancelled if
  // the user clicks again before then (the next click clears feedback up
  // front and either restarts the timer on success or sets a fresh
  // error).
  useEffect(() => {
    if (!feedback) return
    fadeTimer.current = setTimeout(() => setFeedback(null), RESULT_FADE_MS)
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
    }
  }, [feedback])

  const handleClick = async () => {
    if (disabled) return
    // Clicking again while a chip is showing dismisses it; matches the
    // "click button again to dismiss" rule from the integration spec.
    if (feedback) {
      setFeedback(null)
      return
    }
    if (fadeTimer.current) clearTimeout(fadeTimer.current)

    const siteMeta = readSiteMetadata(siteId)
    const projectName = siteMeta.project?.name
    try {
      const { bytes, filename } = await exportToIFC(
        { nodes },
        {
          ...(projectName !== undefined && { projectName }),
          // Use site id as the salt so two sibling sites never share GUIDs
          // even when their project names match.
          projectSalt: `${siteId}|${projectName ?? 'bimai_export'}`,
          onStatus: setStatus,
        },
      )
      downloadBlob(
        new Blob([bytes as BlobPart], { type: 'model/ifc' }),
        filename,
      )
      const sizeKb = Math.max(1, Math.round(bytes.length / 1024))
      setFeedback({
        kind: 'ok',
        message: `Exported ${filename} · ${sizeKb} KB`,
      })
    } catch (err) {
      setFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      // Hold on the terminal status briefly so the label transition is
      // visible, then drop back to idle so the button is clickable again.
      setStatus('idle')
    }
  }

  return (
    <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Export
      </h3>
      <button
        className="w-full cursor-pointer rounded-md border border-border bg-background px-3 py-2 font-medium text-foreground text-sm transition-opacity hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        disabled={disabled}
        onClick={handleClick}
        title={!hasGenerated ? 'Generate a building first' : undefined}
        type="button"
      >
        {labelForStatus(status, hasGenerated)}
      </button>
      {feedback && (
        <p
          className={
            feedback.kind === 'ok'
              ? 'text-emerald-300 text-xs'
              : 'text-red-300 text-xs'
          }
        >
          {feedback.message}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        IFC4 STEP file. Opens in BIMcollab Zoom, Solibri Anywhere, and
        other BIM viewers.
      </p>
    </section>
  )
}

function labelForStatus(
  status: ExportStatus | 'idle',
  hasGenerated: boolean,
): string {
  switch (status) {
    case 'loading-engine':
      return 'Loading IFC engine…'
    case 'exporting':
      return 'Exporting…'
    case 'done':
      return 'Done'
    case 'error':
      return 'Export as IFC'
    case 'idle':
      return hasGenerated ? 'Export as IFC' : 'Export as IFC'
  }
}

// Tiny blob-download helper. Pascal has the same five lines in
// `packages/editor/src/components/editor/export-manager.tsx` but it
// isn't exported, so we inline it here rather than reach across the
// package boundary. Unit tests don't exercise this path — JSDOM
// doesn't fully support `URL.createObjectURL` and the panel test
// (when we add one) will mock it.
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
