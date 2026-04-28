'use client'

// BIM Properties panel.
//
// Phase 3-4 GATE 2 resolution: dedicated tab (not an upstream Pascal
// element-panel slot). Reads the current selection from
// `useViewer.selection` — Pascal's selection state is hierarchical
// (buildingId / levelId / zoneId / selectedIds). For BIM-property
// editing we look at `selectedIds`: walls / slabs / doors / windows
// land here when clicked in the viewer.
//
// Multi-select is out of scope for this phase. When `selectedIds.length > 1`
// we render a placeholder; one-element editing is the only supported flow
// today. A future "apply to all selected" affordance is plausible — Phase 3-5+.
//
// All writes use the same pattern Phase 3-1's `writeBuildingMetadata` set:
// validate the merged blob through Zod, reject silently on failure (with a
// console.warn), call `useScene.getState().updateNode(id, { metadata })`.

import { type AnyNodeId, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import {
  BIMAI_MATERIALS,
  defaultMaterialFor,
  getMaterial,
  materialsApplicableTo,
} from '../../bim/materials'
import {
  type BimAIMaterialId,
  ComponentBIM,
  FireRating,
} from '../../bim/schemas/component-bim'
import {
  hasNodeBIM,
  type MergeBIMResult,
  mergeBIMPatch,
  metadataWithBIM,
  readNodeBIM,
} from '../../lib/component-bim'
import { useNodeById } from '../../lib/active-nodes'

const FIELD_CLASS =
  'h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

const EUR0 = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
})

type SupportedType = 'wall' | 'slab' | 'door' | 'window'
const SUPPORTED: ReadonlySet<string> = new Set([
  'wall',
  'slab',
  'door',
  'window',
])

export function BIMPropertiesPanel() {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  // Treat a single-id selection as "primary". No primary field exists in
  // Pascal's selection shape today (see store/use-viewer.ts), so length===1
  // is the proxy. Multi-select is the explicit error case below.
  const primaryId: AnyNodeId | null =
    selectedIds.length === 1 ? (selectedIds[0] as AnyNodeId) : null
  const node = useNodeById(primaryId)

  if (selectedIds.length === 0) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        Select a wall, slab, door, or window in the viewer to edit its BIM
        properties.
      </div>
    )
  }
  if (selectedIds.length > 1) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        Multiple selected — select one element to edit BIM properties.
      </div>
    )
  }
  if (!node) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        Selected node not found in the scene.
      </div>
    )
  }
  if (!SUPPORTED.has(node.type)) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        BIM properties not applicable to this element type ({node.type}).
      </div>
    )
  }

  const type = node.type as SupportedType
  const bim = readNodeBIM(node)

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <Header node={node} hasBIM={hasNodeBIM(node)} />
      {!hasNodeBIM(node) && <ApplyDefaultsRow node={node} type={type} />}
      <BIMForm nodeId={node.id} type={type} bim={bim} />
    </div>
  )
}

// ── Header / affordances ────────────────────────────────────────────────────

function Header({
  node,
  hasBIM,
}: {
  node: { id: string; type: string; name?: string }
  hasBIM: boolean
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {node.type} — {node.name ?? node.id.slice(0, 12)}
      </h3>
      {!hasBIM && (
        <p className="text-amber-300 text-xs">
          No BIM data set. Defaults will apply until set.
        </p>
      )}
    </section>
  )
}

function ApplyDefaultsRow({
  node,
  type,
}: {
  node: { id: AnyNodeId; metadata?: unknown }
  type: SupportedType
}) {
  const onClick = () => {
    // For walls we don't know the wallRole on user-drawn nodes — fall back
    // to interior non-load-bearing (the safer default per bim-defaults.ts
    // Task 3 rules). Slabs/doors/windows have a single canonical default.
    const material = defaultMaterialFor(type)
    const mat = getMaterial(material)
    const seed = mergeBIMPatch(null, {
      material,
      fireRating: mat.fireRating,
      loadBearing: type === 'slab',
    })
    if (!seed.ok) return // shouldn't happen — defaults validate
    writeBIMToStore(node.id, seed.value, /* extras */ {})
  }
  return (
    <button
      className="self-start rounded-md border border-input bg-transparent px-2 py-1 text-xs hover:bg-muted/40"
      onClick={onClick}
      type="button"
    >
      Apply defaults
    </button>
  )
}

// ── Form ────────────────────────────────────────────────────────────────────

function BIMForm({
  nodeId,
  type,
  bim,
}: {
  nodeId: AnyNodeId
  type: SupportedType
  bim: ComponentBIM | null
}) {
  // The form drives off whatever is currently in the BIM blob. When `bim`
  // is null (no data yet) we show empty controls — submitting any one of
  // them stamps a fresh blob via `mergeBIMPatch(null, ...)`.
  return (
    <section className="flex flex-col gap-3">
      <MaterialField nodeId={nodeId} type={type} bim={bim} />
      <FireRatingField nodeId={nodeId} bim={bim} />
      <LoadBearingField nodeId={nodeId} type={type} bim={bim} />
      <CostOverrideField nodeId={nodeId} type={type} bim={bim} />
    </section>
  )
}

function MaterialField({
  nodeId,
  type,
  bim,
}: {
  nodeId: AnyNodeId
  type: SupportedType
  bim: ComponentBIM | null
}) {
  const options = materialsApplicableTo(type)
  const current = bim?.material ?? ''
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    if (value === '') {
      // Clear material — falls back to default-by-type at compute time.
      applyPatch(nodeId, bim, {}, { clearKeys: ['material'] })
    } else {
      applyPatch(nodeId, bim, { material: value as BimAIMaterialId })
    }
  }
  return (
    <Field label="Material">
      <select className={FIELD_CLASS} onChange={onChange} value={current}>
        <option value="">— default —</option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </Field>
  )
}

function FireRatingField({
  nodeId,
  bim,
}: {
  nodeId: AnyNodeId
  bim: ComponentBIM | null
}) {
  const current = bim?.fireRating ?? 'unrated'
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    applyPatch(nodeId, bim, { fireRating: e.target.value as ComponentBIM['fireRating'] })
  }
  return (
    <Field label="Fire rating">
      <select className={FIELD_CLASS} onChange={onChange} value={current}>
        {FireRating.options.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </Field>
  )
}

function LoadBearingField({
  nodeId,
  type,
  bim,
}: {
  nodeId: AnyNodeId
  type: SupportedType
  bim: ComponentBIM | null
}) {
  // Slabs are always load-bearing in this phase; the toggle is read-only
  // (we still display it so the panel feels complete and a future phase
  // that introduces non-structural slabs can flip it).
  const readOnly = type === 'slab' || type === 'door' || type === 'window'
  const value = bim?.loadBearing ?? (type === 'slab')
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly) return
    applyPatch(nodeId, bim, { loadBearing: e.target.checked })
  }
  return (
    <Field label="Load-bearing">
      <label className="flex h-8 items-center gap-2">
        <input
          checked={value}
          disabled={readOnly}
          onChange={onChange}
          type="checkbox"
        />
        <span className="text-xs text-muted-foreground">
          {readOnly ? `(fixed for ${type})` : value ? 'yes' : 'no'}
        </span>
      </label>
    </Field>
  )
}

function CostOverrideField({
  nodeId,
  type,
  bim,
}: {
  nodeId: AnyNodeId
  type: SupportedType
  bim: ComponentBIM | null
}) {
  // Doors and windows are unit-priced (`flat`); walls and slabs are surface-
  // priced (`perM2`). One slot per element type — keeps the UI single-purpose.
  const slot: 'perM2' | 'flat' = type === 'door' || type === 'window' ? 'flat' : 'perM2'
  const current = bim?.costOverride?.[slot]
  const catalogPrice = catalogPriceForCurrentMaterial(bim, type, slot)
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    if (raw === '') {
      // Clear override — fall back to catalog.
      applyPatch(nodeId, bim, { costOverride: undefined }, { clearKeys: ['costOverride'] })
      return
    }
    const num = Number(raw)
    if (!Number.isFinite(num)) return
    applyPatch(nodeId, bim, { costOverride: { [slot]: num } })
  }
  return (
    <Field
      label={slot === 'perM2' ? 'Cost override (€/m²)' : 'Cost override (€/unit)'}
    >
      <div className="flex items-center gap-2">
        <input
          className={`${FIELD_CLASS} w-32`}
          inputMode="decimal"
          onChange={onChange}
          placeholder="—"
          type="text"
          value={current === undefined ? '' : String(current)}
        />
        {catalogPrice !== undefined && (
          <span className="text-muted-foreground text-xs">
            catalog: {EUR0.format(catalogPrice)}
            {slot === 'perM2' ? '/m²' : ''}
          </span>
        )}
      </div>
    </Field>
  )
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  )
}

// ── Catalog read for the "ghost" caption ───────────────────────────────────

function catalogPriceForCurrentMaterial(
  bim: ComponentBIM | null,
  type: SupportedType,
  slot: 'perM2' | 'flat',
): number | undefined {
  // Use the user's current material if set, otherwise the type default —
  // this way the ghost caption tracks what the cost layer would actually use.
  const id = bim?.material ?? defaultMaterialFor(type)
  // The `as const satisfies` declaration narrows each entry's costPerM2 /
  // costPerUnit to its literal type — present on some, absent on others.
  // Reading via the structural shape sidesteps the union narrowing.
  const mat = BIMAI_MATERIALS[id as keyof typeof BIMAI_MATERIALS] as
    | { costPerM2?: number; costPerUnit?: number }
    | undefined
  if (!mat) return undefined
  if (slot === 'perM2') return mat.costPerM2
  // flat slot maps to costPerUnit on the catalog side
  return mat.costPerUnit
}

// ── Write side ──────────────────────────────────────────────────────────────

function applyPatch(
  nodeId: AnyNodeId,
  current: ComponentBIM | null,
  patch: Parameters<typeof mergeBIMPatch>[1],
  options: Parameters<typeof mergeBIMPatch>[2] = {},
): MergeBIMResult {
  const merged = mergeBIMPatch(current, patch, options)
  if (!merged.ok) {
    // Soft-fail with a console warning. The panel doesn't show inline
    // validation errors yet — the only user-reachable invalid is an
    // unselected fireRating, which the dropdown can't produce. Pin via
    // tests rather than UI.
    console.warn('[bimai] BIM patch rejected:', merged.error)
    return merged
  }
  writeBIMToStore(nodeId, merged.value, {})
  return merged
}

function writeBIMToStore(
  nodeId: AnyNodeId,
  bim: ComponentBIM,
  _extras: Record<string, unknown>,
): void {
  const node = useScene.getState().nodes[nodeId]
  if (!node) return
  const nextMetadata = metadataWithBIM(node, bim)
  // Pascal's `metadata: z.json()` has a stricter recursive type than the
  // validated BIM blob; cast at the boundary, same as Phase 3-1.
  useScene
    .getState()
    .updateNode(nodeId, { metadata: nextMetadata as unknown as Record<string, never> })
}
