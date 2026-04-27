'use client'

import { useActiveSite } from '../../lib/active-nodes'
import type { Issue } from '../../lib/constraints/zoning'
import {
  calculatePerimeter,
  calculatePolygonArea,
} from '../../lib/geometry'
import { readSiteMetadata, writeSiteMetadata } from '../../lib/metadata'
import { useActiveSiteEnvelopeData } from '../../lib/use-active-site-envelope-data'
import type { ZoningRules } from '../../schemas'

const NUMBER_FIELD_CLASS =
  'h-8 w-24 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

function NumberField({
  label,
  value,
  step,
  min,
  max,
  unit,
  onChange,
}: {
  label: string
  value: number
  step: number
  min?: number
  max?: number
  unit: string
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          className={NUMBER_FIELD_CLASS}
          max={max}
          min={min}
          onChange={(e) => {
            const next = Number.parseFloat(e.target.value)
            if (Number.isFinite(next)) onChange(next)
          }}
          step={step}
          type="number"
          value={value}
        />
        <span className="w-6 text-muted-foreground text-xs">{unit}</span>
      </div>
    </div>
  )
}

function severityClass(severity: Issue['severity']): string {
  switch (severity) {
    case 'error':
      return 'border-red-500/40 bg-red-500/10 text-red-300'
    case 'warning':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-300'
    default:
      return 'border-border/40 bg-muted/20 text-muted-foreground'
  }
}

export function ZoningPanel() {
  const site = useActiveSite()
  const { envelope, issues } = useActiveSiteEnvelopeData()

  if (!site) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        No site loaded.
      </div>
    )
  }

  const meta = readSiteMetadata(site.id)
  // Schemas guarantee inner field defaults populate via parse({}). meta.zoning
  // is optional at the top level — fall back to a fully-defaulted parse.
  const zoning: ZoningRules = meta.zoning ?? {
    setbacks: { front: 5, side: 3, rear: 4 },
    maxHeight: 24,
    maxFAR: 2,
    maxCoverage: 0.6,
    minOpenSpace: 0.3,
  }

  const patchZoning = (patch: Partial<ZoningRules>) => {
    writeSiteMetadata(site.id, { zoning: { ...zoning, ...patch } })
  }
  const patchSetback = (key: 'front' | 'side' | 'rear', v: number) => {
    patchZoning({ setbacks: { ...zoning.setbacks, [key]: v } })
  }

  const points = site.polygon?.points ?? []
  const area = calculatePolygonArea(points)
  const perimeter = calculatePerimeter(points)

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Setbacks
        </h3>
        <NumberField
          label="Front"
          onChange={(v) => patchSetback('front', v)}
          step={0.5}
          min={0}
          unit="m"
          value={zoning.setbacks.front}
        />
        <NumberField
          label="Side"
          onChange={(v) => patchSetback('side', v)}
          step={0.5}
          min={0}
          unit="m"
          value={zoning.setbacks.side}
        />
        <NumberField
          label="Rear"
          onChange={(v) => patchSetback('rear', v)}
          step={0.5}
          min={0}
          unit="m"
          value={zoning.setbacks.rear}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Envelope
        </h3>
        <NumberField
          label="Max height"
          onChange={(v) => patchZoning({ maxHeight: v })}
          step={0.5}
          min={0}
          unit="m"
          value={zoning.maxHeight}
        />
        <NumberField
          label="Max FAR"
          onChange={(v) => patchZoning({ maxFAR: v })}
          step={0.1}
          min={0}
          unit=""
          value={zoning.maxFAR}
        />
        <NumberField
          label="Max coverage"
          onChange={(v) => patchZoning({ maxCoverage: v })}
          step={0.05}
          min={0}
          max={1}
          unit=""
          value={zoning.maxCoverage}
        />
        <NumberField
          label="Min open space"
          onChange={(v) => patchZoning({ minOpenSpace: v })}
          step={0.05}
          min={0}
          max={1}
          unit=""
          value={zoning.minOpenSpace}
        />
      </section>

      <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Plot info
        </h3>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Area</span>
          <span>{area.toFixed(1)} m²</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Perimeter</span>
          <span>{perimeter.toFixed(1)} m</span>
        </div>
      </section>

      <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Buildable envelope
        </h3>
        {envelope?.ok ? (
          <>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Envelope area</span>
              <span>{envelope.area.toFixed(1)} m²</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Coverage</span>
              <span>
                {area > 0
                  ? `${((envelope.area / area) * 100).toFixed(1)}%`
                  : '—'}
              </span>
            </div>
          </>
        ) : (
          <div className="text-muted-foreground text-xs">
            No envelope — setbacks consume the plot.
          </div>
        )}
      </section>

      {issues.length > 0 && (
        <section className="flex flex-col gap-1.5 border-border/50 border-t pt-3">
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Issues
          </h3>
          <ul className="flex flex-col gap-1.5">
            {issues.map((issue) => (
              <li
                className={`rounded-md border px-2 py-1.5 text-xs ${severityClass(issue.severity)}`}
                key={issue.code}
              >
                {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
