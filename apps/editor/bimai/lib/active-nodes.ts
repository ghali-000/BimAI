import { type AnyNodeId, type SiteNode, useScene } from '@pascal-app/core'

// Hook: the first SiteNode in the scene. Phase 3-1 has only one site;
// future phases that introduce multi-site projects will swap this for an
// "active site" selector.
export function useActiveSite(): SiteNode | null {
  const siteId = useScene((state) => {
    for (const id of state.rootNodeIds) {
      if (state.nodes[id]?.type === 'site') return id
    }
    return null
  })
  return useScene((state) =>
    siteId ? ((state.nodes[siteId] as SiteNode | undefined) ?? null) : null,
  )
}

// Hook: the first BuildingNode whose parent is the given site.
export function useFirstBuildingId(siteId: AnyNodeId | null): AnyNodeId | null {
  return useScene((state) => {
    if (!siteId) return null
    for (const node of Object.values(state.nodes)) {
      if (node.type === 'building' && node.parentId === siteId) return node.id
    }
    return null
  })
}
