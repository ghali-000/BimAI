'use client'

// Optimizer panel — UI surface for kicking off a random-search run.
//
// Mirrors the generation-panel layout: read-only inputs at top, a Run
// button, and a result section that swaps in once the search settles.
// What's different from generation-panel:
//
//   - Search runs off-thread via runSearchInWorker; the click handler
//     fires-and-forgets the worker and the UI subscribes to progress
//     through the optimizer store.
//   - Two extra controls: count (samples) and seed. The seed makes the
//     run reproducible without exposing the parameter space (the
//     ParamSpace UI is intentionally deferred per the gate-1 decision).
//   - Four weight sliders for the objectives. Defaults match
//     DEFAULT_WEIGHTS; the user can mute any objective by zeroing it.
//   - Status section: idle / running with progress bar / done with
//     summary / error / canceled. Cancel is a worker.terminate()
//     under the hood — clean and instant.
//
// The Task 9 gallery will read `result` + `selectedCandidateIndex`
// from the same store and render the top-K cards alongside this
// panel's summary.

import { useRef, useState } from 'react'
import {
  useActiveSite,
  useFirstBuildingId,
  useNodeById,
} from '../../lib/active-nodes'
import {
  readBuildingMetadata,
  readSiteMetadata,
} from '../../lib/metadata'
import { DEFAULT_WEIGHTS, type ObjectiveName } from '../../optimizer/objectives'
import { useOptimizer } from '../../optimizer/store'
import {
  CanceledError,
  runSearchInWorker,
  type SearchHandle,
} from '../../optimizer/worker/client'
import type { Program, ZoningRules } from '../../schemas'
import { OptimizerGallery } from './gallery'

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

const DEFAULT_COUNT = 50
const DEFAULT_SEED = 1
const DEFAULT_TOP_K = 6

const OBJECTIVE_LABELS: Record<ObjectiveName, string> = {
  mixAccuracy: 'Mix accuracy',
  sellableArea: 'Sellable area',
  costPerUnit: 'Cost / unit',
  compliance: 'Compliance',
}

export function OptimizerPanel() {
  const site = useActiveSite()
  const buildingId = useFirstBuildingId(site?.id ?? null)
  // Same trick as generation-panel — keep the inputs panel reactive
  // to upstream metadata edits.
  useNodeById(buildingId)

  const status = useOptimizer((s) => s.status)
  const progress = useOptimizer((s) => s.progress)
  const result = useOptimizer((s) => s.result)
  const error = useOptimizer((s) => s.error)
  const startStore = useOptimizer((s) => s.start)
  const setProgress = useOptimizer((s) => s.setProgress)
  const setResult = useOptimizer((s) => s.setResult)
  const setError = useOptimizer((s) => s.setError)
  const setCanceled = useOptimizer((s) => s.setCanceled)

  const [count, setCount] = useState(DEFAULT_COUNT)
  const [seed, setSeed] = useState(DEFAULT_SEED)
  const [topK, setTopK] = useState(DEFAULT_TOP_K)
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS })

  // Kept in a ref so cancel() doesn't depend on stale state.
  const handleRef = useRef<SearchHandle | null>(null)

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
  const canRun = plotPolygon.length >= 3 && status !== 'running'

  const handleRun = () => {
    if (!canRun) return
    startStore()
    const handle = runSearchInWorker({
      input: {
        siteId: site.id,
        buildingId,
        plotPolygon,
        zoning,
        program,
      },
      count,
      seed,
      topK,
      weights,
      onProgress: (p) => setProgress(p),
    })
    handleRef.current = handle
    handle.result
      .then((r) => {
        if (handleRef.current === handle) {
          setResult(r)
          handleRef.current = null
        }
      })
      .catch((err: unknown) => {
        if (handleRef.current !== handle) return
        if (err instanceof CanceledError) {
          setCanceled()
        } else {
          setError(err instanceof Error ? err.message : String(err))
        }
        handleRef.current = null
      })
  }

  const handleCancel = () => {
    handleRef.current?.cancel()
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Search controls
        </h3>
        <NumberRow
          label="Samples"
          value={count}
          min={1}
          max={5000}
          step={1}
          onChange={setCount}
          disabled={status === 'running'}
        />
        <NumberRow
          label="Seed"
          value={seed}
          min={0}
          max={2_147_483_647}
          step={1}
          onChange={setSeed}
          disabled={status === 'running'}
        />
        <NumberRow
          label="Top-K (heavy fields)"
          value={topK}
          min={1}
          max={32}
          step={1}
          onChange={setTopK}
          disabled={status === 'running'}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Objective weights
        </h3>
        {(Object.keys(weights) as ObjectiveName[]).map((name) => (
          <NumberRow
            key={name}
            label={OBJECTIVE_LABELS[name]}
            value={weights[name]}
            min={0}
            max={2}
            step={0.1}
            onChange={(v) => setWeights((w) => ({ ...w, [name]: v }))}
            disabled={status === 'running'}
          />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        {status === 'running' ? (
          <button
            className="w-full cursor-pointer rounded-md border border-border bg-transparent px-3 py-2 font-medium text-foreground text-sm transition-opacity hover:opacity-80"
            onClick={handleCancel}
            type="button"
          >
            Cancel
          </button>
        ) : (
          <button
            className="w-full cursor-pointer rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canRun}
            onClick={handleRun}
            type="button"
          >
            Run search
          </button>
        )}
      </section>

      <StatusSection
        status={status}
        progress={progress}
        result={result}
        error={error}
      />

      <OptimizerGallery />
    </div>
  )
}

// ── small input row ─────────────────────────────────────────────────────────

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  disabled: boolean
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-right text-foreground text-xs disabled:opacity-40"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(clamp(n, min, max))
        }}
      />
    </label>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

// ── status section ──────────────────────────────────────────────────────────

function StatusSection({
  status,
  progress,
  result,
  error,
}: {
  status: ReturnType<typeof useOptimizer.getState>['status']
  progress: ReturnType<typeof useOptimizer.getState>['progress']
  result: ReturnType<typeof useOptimizer.getState>['result']
  error: ReturnType<typeof useOptimizer.getState>['error']
}) {
  if (status === 'idle') return null
  return (
    <section className="flex flex-col gap-2 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Status
      </h3>
      {status === 'running' && <RunningRow progress={progress} />}
      {status === 'done' && result && <DoneRows result={result} />}
      {status === 'canceled' && (
        <p className="text-amber-300 text-xs">Search canceled.</p>
      )}
      {status === 'error' && error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-300 text-xs">
          {error}
        </p>
      )}
    </section>
  )
}

function RunningRow({
  progress,
}: { progress: ReturnType<typeof useOptimizer.getState>['progress'] }) {
  const sampled = progress?.sampled ?? 0
  const total = progress?.total ?? 0
  const compliant = progress?.compliantSoFar ?? 0
  const pct = total > 0 ? Math.round((sampled / total) * 100) : 0
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-muted-foreground text-xs">
        <span>{sampled} / {total} sampled</span>
        <span>{compliant} compliant</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
        <div
          className="h-full bg-primary transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function DoneRows({
  result,
}: { result: NonNullable<ReturnType<typeof useOptimizer.getState>['result']> }) {
  const { stats, topK } = result
  const failures = Object.entries(stats.failures).filter(([, n]) => (n ?? 0) > 0)
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <Row label="Sampled" value={String(stats.sampled)} />
      <Row label="Compliant" value={`${stats.compliant} / ${stats.sampled}`} />
      <Row
        label="Best score"
        value={stats.bestScore.toFixed(3)}
        highlight={stats.bestScore > 0}
      />
      <Row
        label="Top-K loaded"
        value={`${topK.length} (heavy fields)`}
      />
      <Row label="Duration" value={`${Math.round(stats.durationMs)} ms`} />
      {failures.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5">
          <span className="text-muted-foreground">Failures</span>
          {failures.map(([reason, n]) => (
            <div key={reason} className="flex justify-between pl-2">
              <span className="text-red-300/80">{reason}</span>
              <span>{n}</span>
            </div>
          ))}
        </div>
      )}
      {stats.compliant === 0 && (
        <p className="mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-300 text-xs">
          No compliant candidates found. Try loosening the zoning rules,
          changing the seed, or upping the sample count.
        </p>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  highlight,
}: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={highlight ? 'text-emerald-300 font-medium' : ''}>
        {value}
      </span>
    </div>
  )
}
