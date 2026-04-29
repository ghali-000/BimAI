// IFC material entities and BimAI cost property set.
//
// Bridges the BimAI material catalog (`bim/materials.ts`) into IFC4. For
// every BimAI material id referenced by a generated component we emit:
//
//   • One `IfcMaterial` (deduplicated by catalog id — the writer asks for
//     the same id many times across walls / slabs and gets the same handle
//     back). Materials carry only `Name` and `Category` in IFC4; cost,
//     density, fire rating, and embodied CO₂ live on a custom property
//     set attached to each *component*, not to the material itself.
//
//   • One `IfcRelAssociatesMaterial` per (component, material) pair —
//     the standard IFC4 way to bind a building element to its material.
//
// Cost / fire / CO₂ data lives in `Pset_BimAI_Cost` rather than in
// `Pset_*Common` because:
//
//   1. The buildingSMART standard psets don't have a "cost per m²" slot
//      that's machine-readable across vendors. Putting it in our own
//      namespace makes it explicit that BimAI is the authoring tool for
//      these values, and keeps the standard-pset layer (slab.ThermalU,
//      wall.IsExternal) clean.
//   2. Per-unit cost and embodied CO₂ live alongside the material name on
//      every element a downstream BIM tool inspects, which is what users
//      need ("how much does this wall cost?" should be answerable from
//      the property panel without joining tables).
//
// All entities are constructed eagerly the first time they're requested
// and cached on the builder so subsequent lookups reuse the same handle.

import { IFC4 } from 'web-ifc'
import type { IfcAPI } from 'web-ifc'
import {
  BIMAI_MATERIALS,
  tryGetMaterial,
  type BimAIMaterial,
} from '../bim/materials'
import type { BimAIMaterialId } from '../bim/schemas/component-bim'
import { deterministicIfcGuid } from './guid'

/**
 * Per-export wiring shared with `write.ts`. The orchestrator constructs
 * one of these and passes it to every helper that needs to spawn entities.
 */
export interface IfcWriteContext {
  api: IfcAPI
  modelId: number
  /** Reuse-once OwnerHistory shared by every owned entity in the file. */
  ownerHistory: IFC4.IfcOwnerHistory
  /** Project-wide GUID salt — see `guid.ts`. */
  projectSalt: string
  /** Allocates a fresh expressID for a new entity. */
  nextId(): number
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Tag a fresh entity with a fresh expressID and write it. */
export function writeEntity<T extends IFC4.IfcRoot | IFC4.IfcOwnerHistory | { expressID: number }>(
  ctx: IfcWriteContext,
  entity: T,
): T {
  // IfcLineObject.expressID is mutable; web-ifc uses it as the line number
  // in the STEP file. We allocate from a single counter so the file is
  // dense and reproducible.
  ;(entity as { expressID: number }).expressID = ctx.nextId()
  ctx.api.WriteLine(ctx.modelId, entity as unknown as IFC4.IfcRoot)
  return entity
}

/** Build a deterministic IfcGloballyUniqueId for a given seed. */
export function ifcGuid(
  ctx: IfcWriteContext,
  seed: string,
  discriminator = '',
): IFC4.IfcGloballyUniqueId {
  return new IFC4.IfcGloballyUniqueId(
    deterministicIfcGuid(ctx.projectSalt, seed, discriminator),
  )
}

// ── material builder ────────────────────────────────────────────────────────

/**
 * Per-export material registry. Construct once at the top of `writeIFC`,
 * call `getOrCreate` whenever a wall / slab / door / window references a
 * BimAI material, and the resulting `IfcMaterial` is cached for reuse.
 */
export class MaterialRegistry {
  private cache = new Map<string, IFC4.IfcMaterial>()

  constructor(private ctx: IfcWriteContext) {}

  /**
   * Look up the IfcMaterial for a BimAI material id, creating it on
   * first use. Unknown ids fall back to a generic "Unknown" material so
   * the resulting IFC file is still valid even if a node references a
   * material that's been removed from the catalog.
   */
  getOrCreate(id: BimAIMaterialId | undefined): IFC4.IfcMaterial {
    const key = (id as string | undefined) ?? '__unknown__'
    const cached = this.cache.get(key)
    if (cached) return cached

    const cat = tryGetMaterial(id)
    const mat = cat
      ? this.buildFromCatalog(cat)
      : this.buildUnknown()
    this.cache.set(key, mat)
    return mat
  }

  /** IFC4 IfcMaterial(Name, Description, Category). */
  private buildFromCatalog(m: BimAIMaterial): IFC4.IfcMaterial {
    const entity = new IFC4.IfcMaterial(
      new IFC4.IfcLabel(m.name),
      new IFC4.IfcText(`BimAI catalog id: ${String(m.id)}`),
      new IFC4.IfcLabel(this.categoryFor(m)),
    )
    return writeEntity(this.ctx, entity)
  }

  private buildUnknown(): IFC4.IfcMaterial {
    const entity = new IFC4.IfcMaterial(
      new IFC4.IfcLabel('Unknown'),
      new IFC4.IfcText('Component had no BimAI material assigned at export'),
      new IFC4.IfcLabel('Other'),
    )
    return writeEntity(this.ctx, entity)
  }

  /** IFC `Category` is freeform; we use a small fixed taxonomy that
   *  downstream tools can group by. */
  private categoryFor(m: BimAIMaterial): string {
    if (m.applicableTo.includes('window')) return 'Glazing'
    if (m.applicableTo.includes('door')) return 'Joinery'
    if (m.applicableTo.length === 1 && m.applicableTo[0] === 'slab')
      return 'Structure'
    if (m.pascalPreset === 'concrete') return 'Concrete'
    if (m.pascalPreset === 'brick') return 'Masonry'
    if (m.pascalPreset === 'plaster') return 'Partition'
    if (m.pascalPreset === 'wood') return 'Joinery'
    return 'Other'
  }

  /**
   * Bind a BimAI material to one or more building elements via
   * `IfcRelAssociatesMaterial`. The relationship itself doesn't carry
   * geometric semantics — it's how IFC validators and BIM viewers know
   * to colour and cost the element by its material.
   */
  associate(
    relatedObjects: IFC4.IfcObjectDefinition[],
    id: BimAIMaterialId | undefined,
    seed: string,
  ): IFC4.IfcRelAssociatesMaterial {
    const material = this.getOrCreate(id)
    const rel = new IFC4.IfcRelAssociatesMaterial(
      ifcGuid(this.ctx, seed, 'rel-mat'),
      this.ctx.ownerHistory,
      new IFC4.IfcLabel('MaterialAssociation'),
      null,
      relatedObjects as unknown as IFC4.IfcDefinitionSelect[],
      material as unknown as IFC4.IfcMaterialSelect,
    )
    return writeEntity(this.ctx, rel)
  }
}

// ── BimAI cost property set ─────────────────────────────────────────────────

/**
 * `Pset_BimAI_Cost` carries the catalog-derived cost / sustainability
 * fields for a single component. Values resolve at the time of export —
 * if the user later changes the catalog, re-exporting picks up the new
 * numbers. Per-component overrides on the Pascal node win over catalog
 * values when present.
 *
 * Property keys (kept short, no spaces — Solibri / BIMcollab show them
 * verbatim in their property panels):
 *
 *   • CatalogId        — BimAI material id (audit trail)
 *   • CostPerM2        — €/m², when applicable
 *   • CostPerM3        — €/m³, when applicable
 *   • CostPerUnit      — €, when applicable (doors, windows)
 *   • FireRating       — EN 13501-1 reaction-to-fire class
 *   • EmbodiedCO2      — kg CO₂-eq per kg of material
 *   • Density          — kg/m³ (informational)
 */
export function buildBimAICostPset(
  ctx: IfcWriteContext,
  relatedObjects: IFC4.IfcObjectDefinition[],
  materialId: BimAIMaterialId | undefined,
  override: { perM2?: number; perM3?: number; flat?: number } | undefined,
  seed: string,
): IFC4.IfcRelDefinesByProperties {
  const cat = tryGetMaterial(materialId)
  const props: IFC4.IfcProperty[] = []

  const text = (name: string, value: string) =>
    new IFC4.IfcPropertySingleValue(
      new IFC4.IfcIdentifier(name),
      null,
      new IFC4.IfcLabel(value) as unknown as IFC4.IfcValue,
      null,
    )
  const real = (name: string, value: number) =>
    new IFC4.IfcPropertySingleValue(
      new IFC4.IfcIdentifier(name),
      null,
      new IFC4.IfcReal(value) as unknown as IFC4.IfcValue,
      null,
    )

  if (cat) props.push(text('CatalogId', String(cat.id)))

  const m2 = override?.perM2 ?? cat?.costPerM2
  if (m2 !== undefined) props.push(real('CostPerM2', m2))
  const m3 = override?.perM3 ?? cat?.costPerM3
  if (m3 !== undefined) props.push(real('CostPerM3', m3))
  const flat = override?.flat ?? cat?.costPerUnit
  if (flat !== undefined) props.push(real('CostPerUnit', flat))

  if (cat) {
    props.push(text('FireRating', cat.fireRating))
    props.push(real('EmbodiedCO2', cat.embodiedCO2))
    props.push(real('Density', cat.density))
  }

  // Each property line has to live in the file before the pset that
  // references it.
  for (const p of props) writeEntity(ctx, p as unknown as { expressID: number })

  const pset = new IFC4.IfcPropertySet(
    ifcGuid(ctx, seed, 'pset-cost'),
    ctx.ownerHistory,
    new IFC4.IfcLabel('Pset_BimAI_Cost'),
    new IFC4.IfcText('BimAI catalog-derived cost and sustainability data'),
    props as unknown as IFC4.IfcProperty[],
  )
  writeEntity(ctx, pset as unknown as { expressID: number })

  const rel = new IFC4.IfcRelDefinesByProperties(
    ifcGuid(ctx, seed, 'rel-pset-cost'),
    ctx.ownerHistory,
    new IFC4.IfcLabel('Pset_BimAI_Cost'),
    null,
    relatedObjects as unknown as IFC4.IfcObjectDefinition[],
    pset as unknown as IFC4.IfcPropertySetDefinitionSelect,
  )
  return writeEntity(ctx, rel as unknown as IFC4.IfcRelDefinesByProperties)
}

/** All BimAI material ids — exposed for tests that want to assert the
 *  registry creates a material per catalog entry without round-tripping
 *  through node generation. */
export const ALL_BIMAI_MATERIAL_IDS = Object.values(BIMAI_MATERIALS).map(
  (m) => m.id,
)
