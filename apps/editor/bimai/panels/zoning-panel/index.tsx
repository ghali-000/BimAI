'use client'

import { useActiveSite } from '../../lib/active-nodes'
import {
  calculatePerimeter,
  calculatePolygonArea,
} from '../../lib/geometry'
import { readSiteMetadata, writeSiteMetadata } from '../../lib/metadata'
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

export function ZoningPanel() {
  const site = useActiveSite()

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
    </div>
  )
}
