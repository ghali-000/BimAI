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

import { useState } from 'react'
import {
  useActiveSite,
  useFirstBuildingId,
  useNodeById,
} from '../../lib/active-nodes'
import {
  readBuildingMetadata,
  readSiteMetadata,
} from '../../lib/metadata'
import { createPascalSceneWriter } from '../../generator/pascal-writer'
import { runGenerator } from '../../generator/pipeline'
import type { GeneratorOutput } from '../../generator/types'
import type { Program, ZoningRules } from '../../schemas'

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
    </div>
  )
}

function ResultSection({ result }: { result: GeneratorOutput }) {
  if (result.ok) {
    return (
      <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Last generation
        </h3>
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
            {result.warnings.map((w, i) => (
              <li
                className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-300 text-xs"
                key={i}
              >
                {w}
              </li>
            ))}
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
