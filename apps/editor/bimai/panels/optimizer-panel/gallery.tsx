'use client'

// Gallery — six-card grid (or however many top-K compliant) of plan
// thumbnails. Subscribes to the optimizer store; the panel renders
// this component below the summary section.
//
// Card anatomy (top to bottom):
//   - SVG thumbnail (60% of card height)
//   - Composed score, large
//   - Metrics row: units placed / NIA m² / €/unit
//   - No sub-score bars in card; selection toggles the Details
//     section below the gallery instead.
//
// Selection: click the card to toggle. Clicking a different card
// swaps. The store auto-selects the top-ranked compliant candidate
// when a search finishes, so the Details panel is populated on first
// paint without an extra click.
//
// "Load into scene" lives below the gallery (full-width button) and
// dispatches `loadSelectedToScene` on the store. Task 11 wires the
// listener that does the actual scene apply.

import type {
  ScoredCandidate,
  OptimizationResult,
} from '../../optimizer/search/run'
import type { ObjectiveName } from '../../optimizer/objectives'
import { useOptimizer } from '../../optimizer/store'
import { CandidateThumbnail } from './candidate-thumbnail'

const OBJECTIVE_LABELS: Record<ObjectiveName, string> = {
  mixAccuracy: 'Mix accuracy',
  sellableArea: 'Sellable area',
  costPerUnit: 'Cost / unit',
  compliance: 'Compliance',
}

export function OptimizerGallery() {
  const result = useOptimizer((s) => s.result)
  const selectedIndex = useOptimizer((s) => s.selectedCandidateIndex)
  const selectCandidate = useOptimizer((s) => s.selectCandidate)
  const loadSelectedToScene = useOptimizer((s) => s.loadSelectedToScene)

  if (!result) return null
  // Empty state: every candidate failed compliance, so topK is empty.
  if (result.topK.length === 0) {
    return <EmptyState />
  }

  const selected = selectedIndex == null
    ? null
    : result.topK.find((c) => c.candidateIndex === selectedIndex) ?? null

  const handleClickCard = (candidateIndex: number) => {
    // Toggle: clicking the active card deselects, clicking a sibling
    // swaps.
    selectCandidate(
      selectedIndex === candidateIndex ? null : candidateIndex,
    )
  }

  return (
    <section className="flex flex-col gap-3 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Top candidates
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {result.topK.map((c) => (
          <CandidateCard
            key={c.candidateIndex}
            candidate={c}
            selected={c.candidateIndex === selectedIndex}
            onClick={() => handleClickCard(c.candidateIndex)}
          />
        ))}
      </div>
      <button
        className="w-full cursor-pointer rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!selected}
        onClick={() => loadSelectedToScene()}
        type="button"
      >
        Load into scene
      </button>
      {selected && <CandidateDetails candidate={selected} result={result} />}
    </section>
  )
}

// ── card ────────────────────────────────────────────────────────────────────

function CandidateCard({
  candidate,
  selected,
  onClick,
}: {
  candidate: ScoredCandidate
  selected: boolean
  onClick: () => void
}) {
  const { plan, schedule, cost, composedScore } = candidate
  // Heavy fields are populated on top-K only. TypeScript can't see
  // that we only render top-K here, so we guard explicitly.
  const unitsPlaced = schedule?.residential.totalUnits ?? 0
  const nia = schedule?.totals.nia ?? 0
  const costPerUnit = cost?.perUnit ?? 0
  return (
    <button
      className={`group flex flex-col gap-1.5 rounded-md border bg-transparent p-1.5 text-left transition-colors ${
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border/60 hover:border-border'
      }`}
      onClick={onClick}
      type="button"
      data-candidate-index={candidate.candidateIndex}
    >
      <div className="aspect-[4/3] w-full overflow-hidden rounded bg-muted/30">
        {plan ? (
          <CandidateThumbnail plan={plan} className="h-full w-full" />
        ) : (
          <div className="grid h-full w-full place-items-center text-muted-foreground text-[10px]">
            no plan
          </div>
        )}
      </div>
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-base text-foreground tabular-nums">
          {composedScore.toFixed(3)}
        </span>
        <span className="text-muted-foreground text-[10px]">
          #{candidate.candidateIndex}
        </span>
      </div>
      <div className="flex justify-between text-muted-foreground text-[10px] tabular-nums">
        <span>{unitsPlaced} units</span>
        <span>{Math.round(nia)} m²</span>
        <span>€{Math.round(costPerUnit / 1000)}k/u</span>
      </div>
    </button>
  )
}

// ── details ─────────────────────────────────────────────────────────────────

function CandidateDetails({
  candidate,
  result,
}: { candidate: ScoredCandidate; result: OptimizationResult }) {
  const breakdown = candidate.breakdown
  const params = candidate.params
  return (
    <section className="flex flex-col gap-3 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Selected — #{candidate.candidateIndex}
      </h3>
      {breakdown && (
        <div className="flex flex-col gap-1.5">
          {(Object.keys(breakdown) as ObjectiveName[]).map((name) => (
            <SubScoreBar
              key={name}
              label={OBJECTIVE_LABELS[name]}
              value={breakdown[name].score}
            />
          ))}
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <ParamRow label="Packing" value={params.packingStrategy} />
        <ParamRow label="Floors" value={params.floorCountStrategy} />
        <ParamRow label="Unit order" value={params.unitOrderingHeuristic} />
        <ParamRow label="Corridor axis" value={params.corridorOrientation} />
        <ParamRow
          label="Corridor width"
          value={`${params.corridorWidthM.toFixed(2)} m`}
        />
        <ParamRow
          label="Footprint inset"
          value={`${params.footprintInsetM.toFixed(2)} m`}
        />
        <ParamRow
          label="Orientation"
          value={`${((params.footprintOrientation * 180) / Math.PI).toFixed(1)}°`}
        />
        <ParamRow label="Variant" value={String(params.variant)} />
        <ParamRow label="Seed" value={String(params.seed)} />
      </dl>
      <p className="text-muted-foreground text-[10px]">
        Out of {result.stats.compliant} compliant candidates ({result.stats.sampled} sampled).
      </p>
    </section>
  )
}

function SubScoreBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{value.toFixed(2)}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </>
  )
}

// ── empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <section className="flex flex-col items-center gap-2 border-border/50 border-t px-2 py-6 text-center">
      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 text-base">
        !
      </div>
      <p className="text-amber-300 text-xs">
        No compliant candidates found.
      </p>
      <p className="text-muted-foreground text-[10px]">
        Try widening the parameter space or relaxing zoning.
      </p>
    </section>
  )
}

