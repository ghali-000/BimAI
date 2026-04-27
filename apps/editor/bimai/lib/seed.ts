'use client'

import { type AnyNodeId, useScene } from '@pascal-app/core'
import { useEffect } from 'react'
import {
  BuildingBimAIMetadata,
  ProjectInfo,
  Program,
  SiteBimAIMetadata,
} from '../schemas'
import {
  readBuildingMetadata,
  readSiteMetadata,
  writeBuildingMetadata,
  writeSiteMetadata,
} from './metadata'

// Read raw bimai blob (skipping schema parse) so we can distinguish
// "never seeded" (undefined) from "seeded with defaults" (object).
function getRawBimai(id: AnyNodeId): Record<string, unknown> | undefined {
  const node = useScene.getState().nodes[id]
  if (!node) return undefined
  const metadata = (node.metadata ?? {}) as Record<string, unknown>
  const bimai = metadata.bimai
  return typeof bimai === 'object' && bimai !== null
    ? (bimai as Record<string, unknown>)
    : undefined
}

function findFirstSiteId(): AnyNodeId | null {
  const state = useScene.getState()
  for (const id of state.rootNodeIds) {
    if (state.nodes[id]?.type === 'site') return id
  }
  return null
}

function findFirstBuildingIdUnderSite(siteId: AnyNodeId): AnyNodeId | null {
  const state = useScene.getState()
  const site = state.nodes[siteId]
  if (site && 'children' in site && Array.isArray(site.children)) {
    for (const child of site.children) {
      if (typeof child === 'object' && child !== null && 'type' in child) {
        const c = child as { type?: string; id?: AnyNodeId }
        if (c.type === 'building' && c.id) return c.id
      }
    }
  }
  for (const node of Object.values(state.nodes)) {
    if (node.type === 'building') return node.id
  }
  return null
}

// Seeds default bimai metadata onto the active site + first building if
// none exists yet. Idempotent: subsequent calls are no-ops.
export function seedDefaultMetadata(): void {
  const siteId = findFirstSiteId()
  if (!siteId) return

  const siteRaw = getRawBimai(siteId)
  if (!siteRaw?.project) {
    const defaults = SiteBimAIMetadata.parse({
      project: ProjectInfo.parse({}),
    })
    writeSiteMetadata(siteId, defaults)
  }

  const buildingId = findFirstBuildingIdUnderSite(siteId)
  if (!buildingId) return

  const buildingRaw = getRawBimai(buildingId)
  if (!buildingRaw?.program) {
    const defaults = BuildingBimAIMetadata.parse({
      program: Program.parse({}),
    })
    writeBuildingMetadata(buildingId, defaults)
  }

  // Touch read helpers to assert validity post-seed (no-op on success).
  void readSiteMetadata(siteId)
  void readBuildingMetadata(buildingId)
}

// React hook: seeds once a site appears in the scene. Idempotent across
// re-renders and HMR.
export function useSeedDefaultMetadata(): void {
  useEffect(() => {
    // Try once immediately (covers the case where scene is already loaded).
    seedDefaultMetadata()

    // Subscribe so the seed also runs when Pascal's async scene loader
    // finishes after this effect mounts.
    const unsubscribe = useScene.subscribe((state, prev) => {
      if (state.rootNodeIds === prev.rootNodeIds && state.nodes === prev.nodes)
        return
      seedDefaultMetadata()
    })

    return unsubscribe
  }, [])
}
