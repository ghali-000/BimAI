'use client'

// Schedule panel.
//
// Reads the live scene through `useScene`, runs `computeSchedule` against
// it, and renders the GEA / NIA / unit-breakdown table that mirrors
// architechtures.com's schedule sidebar (Phase 3-4 reference layout).
//
// Subscription: we select `state.nodes` directly so any store mutation
// (regenerate, edit, delete) re-runs the compute. The compute itself is
// O(n) over generated nodes — cheap on plausible scenes — so memoisation
// is overkill at this stage. Revisit if a future stage explodes node
// counts (Phase 3-5+ MEP, fixtures, etc).

import { useScene } from '@pascal-app/core'
import { useState } from 'react'
import { useActiveSite, useFirstBuildingId } from '../../lib/active-nodes'
import { computeSchedule } from '../../schedule/compute'
import type { ScheduleResult, ScheduleRoomBucket } from '../../schedule/types'

const NUM_M2 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 })
const NUM_PCT = new Intl.NumberFormat('en-GB', {
  style: 'percent',
  maximumFractionDigits: 1,
})

export function SchedulePanel() {
  const site = useActiveSite()
  const buildingId = useFirstBuildingId(site?.id ?? null)
  // Subscribe to the entire flat node dictionary so any node-level mutation
  // re-runs the compute. Selector returns the same reference unless `nodes`
  // identity changes, which only happens when the store updates — exactly
  // the trigger we want.
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

  const schedule = computeSchedule({ nodes }, { buildingId })

  if (schedule.floorCount === 0) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        Nothing generated yet. Run the generator from the Generate tab to see
        the schedule.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <TotalsSection schedule={schedule} />
      <ResidentialSection schedule={schedule} />
      <RoomBreakdownSection schedule={schedule} />
      <ByFloorSection schedule={schedule} />
      {schedule.warnings.length > 0 && <WarningsSection schedule={schedule} />}
    </div>
  )
}

// ── Sections ────────────────────────────────────────────────────────────────

function TotalsSection({ schedule }: { schedule: ScheduleResult }) {
  const { totals, floorCount } = schedule
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Totals
      </h3>
      <Row label="Floors" value={String(floorCount)} />
      <Row label="GEA" value={`${NUM_M2.format(totals.gea)} m²`} />
      <Row label="NIA" value={`${NUM_M2.format(totals.nia)} m²`} />
      <Row
        label="Efficiency (NIA/GEA)"
        value={NUM_PCT.format(totals.efficiency)}
        valueClass={efficiencyColour(totals.efficiency)}
      />
    </section>
  )
}

function ResidentialSection({ schedule }: { schedule: ScheduleResult }) {
  const { residential } = schedule
  if (residential.totalUnits === 0) return null
  return (
    <section className="flex flex-col gap-2 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Residential
      </h3>
      <Row label="Total units" value={String(residential.totalUnits)} />
      <Row
        label="Avg unit area"
        value={`${NUM_M2.format(residential.avgUnitArea)} m²`}
      />
      <table className="mt-1 w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="pb-1 text-left font-normal">Type</th>
            <th className="pb-1 text-right font-normal">Count</th>
            <th className="pb-1 text-right font-normal">Total m²</th>
            <th className="pb-1 text-right font-normal">Avg m²</th>
          </tr>
        </thead>
        <tbody>
          {residential.byUnitType.map((bucket) => (
            <tr key={bucket.type}>
              <td className="py-0.5">{bucket.type}</td>
              <td className="py-0.5 text-right">{bucket.count}</td>
              <td className="py-0.5 text-right">
                {NUM_M2.format(bucket.totalArea)}
              </td>
              <td className="py-0.5 text-right">
                {NUM_M2.format(bucket.avgArea)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// Phase 3-7. Aggregates emitted room zones into the five canonical kinds.
// Default collapsed — most users don't need this view by default, and it
// only fires once a building has subdivided units (hidden when empty).
function RoomBreakdownSection({ schedule }: { schedule: ScheduleResult }) {
  const [open, setOpen] = useState(false)
  const { roomBreakdown } = schedule
  const totalRooms =
    roomBreakdown.bedrooms.count +
    roomBreakdown.bathrooms.count +
    roomBreakdown.kitchens.count +
    roomBreakdown.livingRooms.count +
    roomBreakdown.hallways.count
  if (totalRooms === 0) return null
  const rows: Array<{ label: string; bucket: ScheduleRoomBucket }> = [
    { label: 'Bedrooms', bucket: roomBreakdown.bedrooms },
    { label: 'Bathrooms', bucket: roomBreakdown.bathrooms },
    { label: 'Kitchens', bucket: roomBreakdown.kitchens },
    { label: 'Living rooms', bucket: roomBreakdown.livingRooms },
    { label: 'Hallways', bucket: roomBreakdown.hallways },
  ]
  return (
    <section className="flex flex-col gap-2 border-border/50 border-t pt-3">
      <button
        aria-expanded={open}
        className="flex items-center justify-between font-medium text-muted-foreground text-xs uppercase tracking-wide hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span>Room breakdown</span>
        <span className="text-[10px] normal-case tracking-normal">
          {open ? '▾' : '▸'} {totalRooms} room{totalRooms === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="pb-1 text-left font-normal">Kind</th>
              <th className="pb-1 text-right font-normal">Count</th>
              <th className="pb-1 text-right font-normal">Total m²</th>
              <th className="pb-1 text-right font-normal">Avg m²</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, bucket }) => (
              <tr
                className={bucket.count === 0 ? 'text-muted-foreground' : ''}
                key={label}
              >
                <td className="py-0.5">{label}</td>
                <td className="py-0.5 text-right">{bucket.count}</td>
                <td className="py-0.5 text-right">
                  {NUM_M2.format(bucket.totalArea)}
                </td>
                <td className="py-0.5 text-right">
                  {NUM_M2.format(bucket.avgArea)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function ByFloorSection({ schedule }: { schedule: ScheduleResult }) {
  return (
    <section className="flex flex-col gap-2 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        By floor
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="pb-1 text-left font-normal">Level</th>
            <th className="pb-1 text-right font-normal">GEA</th>
            <th className="pb-1 text-right font-normal">NIA</th>
            <th className="pb-1 text-right font-normal">Units</th>
          </tr>
        </thead>
        <tbody>
          {schedule.byFloor.map((row) => (
            <tr key={row.level}>
              <td className="py-0.5">L{row.level}</td>
              <td className="py-0.5 text-right">{NUM_M2.format(row.gea)}</td>
              <td className="py-0.5 text-right">{NUM_M2.format(row.nia)}</td>
              <td className="py-0.5 text-right">{row.unitCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function WarningsSection({ schedule }: { schedule: ScheduleResult }) {
  return (
    <section className="flex flex-col gap-1 border-border/50 border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Warnings
      </h3>
      <ul className="flex flex-col gap-1">
        {schedule.warnings.map((w, i) => (
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

// ── Bits ────────────────────────────────────────────────────────────────────

function Row({
  label,
  value,
  valueClass,
}: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={valueClass ?? ''}>{value}</span>
    </div>
  )
}

// Mid-rise residential rules-of-thumb: < 0.6 corridor-heavy / structural
// inefficient (red), 0.6-0.7 acceptable (default), 0.7-0.85 healthy
// (emerald). Above 0.85 is suspicious (likely missing corridor area in
// the count) so we flag it amber rather than over-celebrate.
function efficiencyColour(eff: number): string {
  if (eff === 0) return ''
  if (eff < 0.6) return 'text-red-300'
  if (eff > 0.85) return 'text-amber-300'
  if (eff >= 0.7) return 'text-emerald-300'
  return ''
}
