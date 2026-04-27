'use client'

import {
  useActiveSite,
  useFirstBuildingId,
  useNodeById,
} from '../../lib/active-nodes'
import {
  readBuildingMetadata,
  writeBuildingMetadata,
} from '../../lib/metadata'
import type { Program, UnitMixEntry } from '../../schemas'

const UNIT_TYPES = ['Studio', '1BR', '2BR', '3BR', '4BR'] as const

const FIELD_CLASS =
  'h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

export function ProgramPanel() {
  const site = useActiveSite()
  const buildingId = useFirstBuildingId(site?.id ?? null)
  // IMPORTANT: subscribe to the building node so the panel re-renders when
  // metadata is patched. Without this, controlled inputs (`value={row.count}`)
  // visually freeze on the initial store value — onChange writes succeed, but
  // the next render reads from a stale closure and overwrites the user's
  // keystroke. See `useNodeById` for the long story.
  const buildingNode = useNodeById(buildingId)

  if (!buildingId || !buildingNode) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        No building in scene.
      </div>
    )
  }

  const meta = readBuildingMetadata(buildingId)
  const program: Program = meta.program ?? {
    unitMix: [],
    floorToFloorHeight: 3,
  }

  const writeProgram = (next: Program) => {
    writeBuildingMetadata(buildingId, { program: next })
  }

  const updateRow = (index: number, patch: Partial<UnitMixEntry>) => {
    const nextMix = program.unitMix.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    )
    writeProgram({ ...program, unitMix: nextMix })
  }

  const addRow = () => {
    const nextRow: UnitMixEntry = {
      type: UNIT_TYPES[0],
      count: 0,
      targetArea: 50,
    }
    writeProgram({ ...program, unitMix: [...program.unitMix, nextRow] })
  }

  const deleteRow = (index: number) => {
    writeProgram({
      ...program,
      unitMix: program.unitMix.filter((_, i) => i !== index),
    })
  }

  const totalUnits = program.unitMix.reduce((sum, r) => sum + r.count, 0)
  const totalTargetArea = program.unitMix.reduce(
    (sum, r) => sum + r.count * r.targetArea,
    0,
  )

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Unit mix
        </h3>

        {program.unitMix.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No unit types yet — add one below.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-[1fr_60px_70px_28px] items-center gap-2 text-muted-foreground text-xs">
              <span>Type</span>
              <span>Count</span>
              <span>m²/unit</span>
              <span />
            </div>
            {program.unitMix.map((row, i) => (
              <div
                className="grid grid-cols-[1fr_60px_70px_28px] items-center gap-2"
                key={i}
              >
                <select
                  className={FIELD_CLASS}
                  onChange={(e) => updateRow(i, { type: e.target.value })}
                  value={row.type}
                >
                  {UNIT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  {!UNIT_TYPES.includes(
                    row.type as (typeof UNIT_TYPES)[number],
                  ) && <option value={row.type}>{row.type}</option>}
                </select>
                <input
                  className={FIELD_CLASS}
                  min={0}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10)
                    if (Number.isFinite(v)) updateRow(i, { count: v })
                  }}
                  step={1}
                  type="number"
                  value={row.count}
                />
                <input
                  className={FIELD_CLASS}
                  min={0}
                  onChange={(e) => {
                    const v = Number.parseFloat(e.target.value)
                    if (Number.isFinite(v)) updateRow(i, { targetArea: v })
                  }}
                  step={1}
                  type="number"
                  value={row.targetArea}
                />
                <button
                  aria-label="Remove row"
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-red-500/20 hover:text-red-400"
                  onClick={() => deleteRow(i)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          className="mt-1 w-fit cursor-pointer rounded-md border border-border/50 px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-accent/50 hover:text-foreground"
          onClick={addRow}
          type="button"
        >
          + Add unit type
        </button>
      </section>

      <section className="border-border/50 border-t pt-3 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Σ units</span>
          <span>{totalUnits}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Σ target area</span>
          <span>{totalTargetArea.toFixed(0)} m²</span>
        </div>
      </section>
    </div>
  )
}
