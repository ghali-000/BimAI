'use client'

import { type AnyNodeId, type SiteNode, useScene } from '@pascal-app/core'
import { useMemo } from 'react'
import { useShallow } from 'zustand/shallow'
import { SiteBimAIMetadata, ZoningRules } from '../schemas'
import { type Issue, computeZoningIssues } from './constraints/zoning'
import { type EnvelopeResult, type Polygon2D, computeEnvelope } from './envelope'
import { calculatePolygonArea } from './geometry'

export interface ActiveSiteEnvelopeData {
  siteId: AnyNodeId | null
  plotPolygon: Polygon2D | null
  plotArea: number
  envelope: EnvelopeResult | null
  issues: Issue[]
}

interface RawSelection {
  siteId: AnyNodeId | null
  plotPolygon: Polygon2D | null
  bimaiRaw: unknown
}

// Selects the active site's polygon + raw bimai metadata via shallow equality
// so the hook only re-runs when those primitives change. Envelope and issues
// are derived in a useMemo keyed on stable references.
export function useActiveSiteEnvelopeData(): ActiveSiteEnvelopeData {
  const raw = useScene(
    useShallow((state): RawSelection => {
      let siteId: AnyNodeId | null = null
      for (const id of state.rootNodeIds) {
        if (state.nodes[id]?.type === 'site') {
          siteId = id
          break
        }
      }
      if (!siteId) {
        return { siteId: null, plotPolygon: null, bimaiRaw: undefined }
      }
      const site = state.nodes[siteId] as SiteNode | undefined
      const polygon = site?.polygon?.points ?? null
      const metadata = (site?.metadata ?? {}) as Record<string, unknown>
      return {
        siteId,
        plotPolygon: polygon ? (polygon as Polygon2D) : null,
        bimaiRaw: metadata.bimai,
      }
    }),
  )

  return useMemo<ActiveSiteEnvelopeData>(() => {
    const { siteId, plotPolygon, bimaiRaw } = raw
    if (!(siteId && plotPolygon)) {
      return {
        siteId,
        plotPolygon: null,
        plotArea: 0,
        envelope: null,
        issues: [],
      }
    }

    const parsed = SiteBimAIMetadata.safeParse(bimaiRaw ?? {})
    const meta = parsed.success ? parsed.data : SiteBimAIMetadata.parse({})
    const zoning = meta.zoning ?? ZoningRules.parse({})

    const plotArea = calculatePolygonArea(plotPolygon)
    const envelope = computeEnvelope(plotPolygon, zoning)
    const envelopeArea = envelope.ok ? envelope.area : null
    const issues = computeZoningIssues({ plotArea, envelopeArea, zoning })

    return { siteId, plotPolygon, plotArea, envelope, issues }
  }, [raw])
}
