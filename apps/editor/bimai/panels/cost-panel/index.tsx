'use client'

// Cost panel.
//
// Layout mirrors architechtures.com's cost-estimate sidebar — the
// "ABOVE GRADE → HARD COST → SOFT COSTS → TOTAL PROJECT ESTIMATE"
// hierarchy. The dual-section split (per-component "modelled" vs
// typology "estimated") is the honest framing the hybrid cost model
// promised: users see exactly which numbers their material edits move
// and which numbers we're estimating off €/m² baselines.
//
// Compute lives in `cost/compute.ts` and is pure — this component reads
// the live scene + site override and feeds them in. The schedule is
// computed once here and passed down so the cost layer doesn't redo
// area math.

import { useScene } from '@pascal-app/core'
import { computeCost } from '../../cost/compute'
import type { CostResult } from '../../cost/types'
import { useActiveSite, useFirstBuildingId } from '../../lib/active-nodes'
import { readSiteMetadata } from '../../lib/metadata'
import { computeSchedule } from '../../schedule/compute'

const EUR = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
})
const EUR_PSM = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
})

export function CostPanel() {
  const site = useActiveSite()
  const buildingId = useFirstBuildingId(site?.id ?? null)
  const nodes = useScene((state) => state.nodes)

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

  // Pull the per-project typology override (if any) off the site. Reads via
  // the standard metadata helper — same contract zoning + program use.
  const siteMeta = readSiteMetadata(site.id)
  const typologyOverride = siteMeta.typologyOverride

  const schedule = computeSchedule({ nodes }, { buildingId })
  const cost = computeCost(
    { nodes },
    { buildingId, schedule, typologyOverride },
  )

  if (schedule.floorCount === 0) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        Nothing generated yet. Run the generator from the Generate tab to see
        the cost estimate.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <AboveGradeSection cost={cost} />
      <TypologySection cost={cost} />
      <TotalsSection cost={cost} schedule={schedule} />
      {cost.warnings.length > 0 && <WarningsSection cost={cost} />}
      <FootnoteSection />
    </div>
  )
}

// ── Sections ────────────────────────────────────────────────────────────────

function AboveGradeSection({ cost }: { cost: CostResult }) {
  const { walls, slabs, openings, stairs } = cost.perComponent
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Above grade — modelled
      </h3>
      <Indent label="Walls — exterior" amount={walls.exterior} />
      <Indent label="Walls — interior" amount={walls.interior} />
      {walls.loadBearing > 0 && (
        <Indent label="Walls — load-bearing" amount={walls.loadBearing} />
      )}
      <Indent label="Slabs" amount={slabs} />
      <Indent label="Openings — doors" amount={openings.doors} />
      <Indent label="Openings — windows" amount={openings.windows} />
      {stairs > 0 && <Indent label="Stairs" amount={stairs} />}
      <Subtotal label="Per-component subtotal" amount={cost.perComponentTotal} />
    </section>
  )
}

function TypologySection({ cost }: { cost: CostResult }) {
  const { typology } = cost
  return (
    <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Typology — estimated (€/m² × GEA)
      </h3>
      <Indent label="MEP" amount={typology.mep} />
      <Indent label="Finishes" amount={typology.finishes} />
      <Indent label="General conditions" amount={typology.generalConditions} />
      <Indent label="Contingency" amount={typology.contingency} />
      <Subtotal label="Typology subtotal" amount={cost.typologyTotal} />
    </section>
  )
}

function TotalsSection({
  cost,
  schedule,
}: {
  cost: CostResult
  schedule: ReturnType<typeof computeSchedule>
}) {
  return (
    <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
      <Big label="Hard cost" amount={cost.hardCost} />
      <Indent label="Soft costs" amount={cost.softCosts} />
      <div className="my-1 border-border/50 border-t" />
      <Big label="Total project estimate" amount={cost.totalProjectCost} primary />
      <div className="mt-2 flex flex-col gap-1 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">per m² of GEA</span>
          <span>{EUR_PSM.format(cost.perM2OfGEA)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">per unit</span>
          <span>{schedule.residential.totalUnits === 0 ? '—' : EUR.format(cost.perUnit)}</span>
        </div>
      </div>
    </section>
  )
}

function WarningsSection({ cost }: { cost: CostResult }) {
  return (
    <section className="flex flex-col gap-1 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Warnings
      </h3>
      <ul className="flex flex-col gap-1">
        {cost.warnings.map((w, i) => (
          <li
            className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-300 text-xs"
            key={i}
          >
            {w}
          </li>
        ))}
      </ul>
    </section>
  )
}

function FootnoteSection() {
  return (
    <p className="border-border/50 border-t pt-3 text-[10px] text-muted-foreground leading-relaxed">
      Defaults: EU mid-rise residential 2025 baselines. Per-component prices
      come from the BimAI material catalog; typology categories use catalog
      €/m² figures unless overridden via{' '}
      <code className="font-mono">site.metadata.bimai.typologyOverride</code>.
      Treat as a starting estimate, not a quote.
    </p>
  )
}

// ── Bits ────────────────────────────────────────────────────────────────────

function Indent({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex justify-between pl-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span>{EUR.format(amount)}</span>
    </div>
  )
}

function Subtotal({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="mt-0.5 flex justify-between border-border/30 border-t pt-1 text-xs">
      <span className="font-medium">{label}</span>
      <span className="font-medium">{EUR.format(amount)}</span>
    </div>
  )
}

function Big({
  label,
  amount,
  primary,
}: { label: string; amount: number; primary?: boolean }) {
  return (
    <div
      className={
        primary
          ? 'flex justify-between text-base font-semibold'
          : 'flex justify-between text-sm font-medium'
      }
    >
      <span>{label}</span>
      <span>{EUR.format(amount)}</span>
    </div>
  )
}
