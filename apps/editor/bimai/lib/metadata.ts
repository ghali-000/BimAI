import { type AnyNodeId, useScene } from '@pascal-app/core'
import {
  BuildingBimAIMetadata,
  SiteBimAIMetadata,
} from '../schemas'

let warnedOnceForSite = false
let warnedOnceForBuilding = false

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  patch: Partial<T>,
): T {
  const out: Record<string, unknown> = { ...base }
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue
    const baseValue = out[key]
    if (isPlainObject(patchValue) && isPlainObject(baseValue)) {
      out[key] = deepMerge(
        baseValue,
        patchValue as Partial<typeof baseValue>,
      )
    } else {
      out[key] = patchValue
    }
  }
  return out as T
}

function readNodeMetadataRaw(id: AnyNodeId): Record<string, unknown> {
  const node = useScene.getState().nodes[id]
  if (!node) return {}
  const metadata = (node.metadata ?? {}) as Record<string, unknown>
  return metadata
}

function writeBimaiMetadata(
  id: AnyNodeId,
  nextBimai: Record<string, unknown>,
): void {
  const currentMetadata = readNodeMetadataRaw(id)
  const newMetadata = { ...currentMetadata, bimai: nextBimai }
  // Validated bimai data is plain JSON, but TS can't infer that against
  // Pascal's JSONType. Cast at the boundary.
  useScene.getState().updateNode(id, {
    metadata: newMetadata as unknown as Record<string, never>,
  })
}

export function readSiteMetadata(siteId: AnyNodeId): SiteBimAIMetadata {
  const raw = readNodeMetadataRaw(siteId).bimai
  const parsed = SiteBimAIMetadata.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  if (!warnedOnceForSite) {
    warnedOnceForSite = true
    console.warn('[bimai] invalid site metadata, falling back to defaults', parsed.error)
  }
  return SiteBimAIMetadata.parse({})
}

export function writeSiteMetadata(
  siteId: AnyNodeId,
  patch: Partial<SiteBimAIMetadata>,
): void {
  const current = readSiteMetadata(siteId)
  const merged = deepMerge(
    current as Record<string, unknown>,
    patch as Partial<Record<string, unknown>>,
  )
  const validated = SiteBimAIMetadata.safeParse(merged)
  if (!validated.success) {
    console.warn('[bimai] write rejected — invalid site metadata', validated.error)
    return
  }
  writeBimaiMetadata(siteId, validated.data)
}

export function readBuildingMetadata(
  buildingId: AnyNodeId,
): BuildingBimAIMetadata {
  const raw = readNodeMetadataRaw(buildingId).bimai
  const parsed = BuildingBimAIMetadata.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  if (!warnedOnceForBuilding) {
    warnedOnceForBuilding = true
    console.warn(
      '[bimai] invalid building metadata, falling back to defaults',
      parsed.error,
    )
  }
  return BuildingBimAIMetadata.parse({})
}

export function writeBuildingMetadata(
  buildingId: AnyNodeId,
  patch: Partial<BuildingBimAIMetadata>,
): void {
  const current = readBuildingMetadata(buildingId)
  const merged = deepMerge(
    current as Record<string, unknown>,
    patch as Partial<Record<string, unknown>>,
  )
  const validated = BuildingBimAIMetadata.safeParse(merged)
  if (!validated.success) {
    console.warn(
      '[bimai] write rejected — invalid building metadata',
      validated.error,
    )
    return
  }
  writeBimaiMetadata(buildingId, validated.data)
}
