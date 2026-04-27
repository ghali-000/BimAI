import {
  type AnyNode,
  type AnyNodeId,
  type SiteNode,
  useScene,
} from '@pascal-app/core'

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

// Hook: the first BuildingNode under the given site.
//
// Pascal's default scene leaves BuildingNode.parentId === null even though
// the site embeds the building in site.children (schema asymmetry). Prefer
// the site.children array — it's the canonical hierarchy per the schema —
// and fall back to a type scan if no embedded children are present.
export function useFirstBuildingId(siteId: AnyNodeId | null): AnyNodeId | null {
  return useScene((state) => {
    if (!siteId) return null
    const site = state.nodes[siteId] as SiteNode | undefined
    if (site?.children) {
      for (const child of site.children) {
        if (typeof child === 'object' && child !== null && child.type === 'building') {
          return child.id
        }
      }
    }
    for (const node of Object.values(state.nodes)) {
      if (node.type === 'building') return node.id
    }
    return null
  })
}

// Hook: subscribe to a node by id. Returns the live node from the flat store
// so callers re-render when its metadata (or any other field) changes.
//
// Why this exists. Reading metadata via `useScene.getState().nodes[id]` is
// non-reactive — components that only call `useFirstBuildingId` get the id
// once and never re-render when the building's metadata is patched. Panels
// that read+write a node's metadata MUST go through this hook so the value
// they hand to controlled inputs (`value={row.count}`) tracks the store.
export function useNodeById(id: AnyNodeId | null): AnyNode | null {
  return useScene((state) =>
    id ? ((state.nodes[id] as AnyNode | undefined) ?? null) : null,
  )
}
