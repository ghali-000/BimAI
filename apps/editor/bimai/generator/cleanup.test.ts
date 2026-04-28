import type { AnyNode, AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import { findGeneratedNodes, findStaleLevelNodes } from './cleanup'
import { tagAsGenerated } from './tag'

// Structural node fixtures — see the note in tag.test.ts about avoiding
// `@pascal-app/core` Zod parses in vitest.
function makeNode(
  id: string,
  type: string,
  parentId: AnyNodeId | null,
  metadata?: Record<string, unknown>,
): AnyNode {
  return {
    object: 'node',
    id,
    type,
    parentId,
    visible: true,
    metadata: metadata ?? {},
  } as unknown as AnyNode
}

function buildScene(nodes: AnyNode[]): { nodes: Record<AnyNodeId, AnyNode> } {
  const dict: Record<AnyNodeId, AnyNode> = {}
  for (const n of nodes) dict[n.id] = n
  return { nodes: dict }
}

describe('findGeneratedNodes', () => {
  it('returns empty for an empty scene', () => {
    expect(findGeneratedNodes({ nodes: {} })).toEqual([])
  })

  it('returns empty when nothing is tagged', () => {
    const scene = buildScene([
      makeNode('site_1', 'site', null),
      makeNode('building_1', 'building', null),
      makeNode('wall_user_1', 'wall', 'level_1'),
    ])
    expect(findGeneratedNodes(scene)).toEqual([])
  })

  it('finds tagged nodes', () => {
    const tagged = tagAsGenerated(
      makeNode('wall_gen_1', 'wall', 'level_1'),
      'gen-A',
    )
    const scene = buildScene([
      makeNode('site_1', 'site', null),
      makeNode('wall_user_1', 'wall', 'level_1'),
      tagged,
    ])
    expect(findGeneratedNodes(scene)).toEqual(['wall_gen_1'])
  })

  it('does NOT return user-drawn (untagged) nodes alongside generated ones', () => {
    const tagged1 = tagAsGenerated(
      makeNode('wall_gen_1', 'wall', 'level_1'),
      'gen-A',
    )
    const tagged2 = tagAsGenerated(
      makeNode('zone_gen_1', 'zone', 'level_1'),
      'gen-A',
    )
    const scene = buildScene([
      makeNode('wall_user_1', 'wall', 'level_1'),
      makeNode('wall_user_2', 'wall', 'level_1'),
      tagged1,
      tagged2,
    ])
    const found = findGeneratedNodes(scene).sort()
    expect(found).toEqual(['wall_gen_1', 'zone_gen_1'])
  })

  it('does not match nodes whose metadata.bimai lacks the tag', () => {
    // A user-drawn ZoneNode might have metadata.bimai with unitType/targetArea
    // (e.g. someone hand-tagged it). Without the procedural-v1 generatedBy
    // marker, it must NOT be cleaned up.
    const scene = buildScene([
      makeNode('zone_user_1', 'zone', 'level_1', {
        bimai: { unitType: '2BR', targetArea: 80 },
      }),
    ])
    expect(findGeneratedNodes(scene)).toEqual([])
  })

  describe('with parentId filter', () => {
    it('limits results to descendants of the given parent', () => {
      // Tree:
      //   building_A → level_A1 → wall_gen_a (tagged)
      //   building_B → level_B1 → wall_gen_b (tagged)
      // Filter on building_A should only return wall_gen_a.
      const scene = buildScene([
        makeNode('building_A', 'building', null),
        makeNode('level_A1', 'level', 'building_A'),
        tagAsGenerated(makeNode('wall_gen_a', 'wall', 'level_A1'), 'gen'),
        makeNode('building_B', 'building', null),
        makeNode('level_B1', 'level', 'building_B'),
        tagAsGenerated(makeNode('wall_gen_b', 'wall', 'level_B1'), 'gen'),
      ])
      expect(findGeneratedNodes(scene, 'building_A')).toEqual(['wall_gen_a'])
      expect(findGeneratedNodes(scene, 'building_B')).toEqual(['wall_gen_b'])
    })

    it('does not include the parent itself even when tagged', () => {
      const scene = buildScene([
        tagAsGenerated(makeNode('building_A', 'building', null), 'gen'),
        tagAsGenerated(makeNode('wall_a', 'wall', 'building_A'), 'gen'),
      ])
      expect(findGeneratedNodes(scene, 'building_A')).toEqual(['wall_a'])
    })

    it('terminates on cycles without infinite loop', () => {
      // Two nodes with parentId pointing at each other — malformed but must
      // not hang.
      const scene = buildScene([
        tagAsGenerated(
          makeNode('a', 'wall', 'b' as unknown as AnyNodeId),
          'gen',
        ),
        makeNode('b', 'wall', 'a' as unknown as AnyNodeId),
      ])
      const found = findGeneratedNodes(scene, 'nonexistent' as AnyNodeId)
      expect(found).toEqual([])
    })
  })
})

// ── Phase 3-6 Task 2: stale-level sweep ────────────────────────────────────

describe('findStaleLevelNodes', () => {
  it('returns every level node under a building, tagged or not', () => {
    // Pascal's `loadScene` seeds an untagged `Level 0` under the building;
    // a previous optimizer run leaves a tagged `Level 0` next to it. Both
    // must appear here so the cleanup phase can sweep them in one shot.
    const scene = buildScene([
      makeNode('site', 'site', null),
      makeNode('building', 'building', 'site'),
      // Pascal's default-scene Level 0 — no tag.
      makeNode('level_default', 'level', 'building'),
      // Previous optimizer run's Level 0 — tagged.
      tagAsGenerated(makeNode('level_gen', 'level', 'building'), 'gen-A'),
    ])
    expect(findStaleLevelNodes(scene, 'building' as AnyNodeId).sort()).toEqual([
      'level_default',
      'level_gen',
    ])
  })

  it('does not pick up levels under a sibling building', () => {
    const scene = buildScene([
      makeNode('building_A', 'building', null),
      makeNode('level_a0', 'level', 'building_A'),
      makeNode('building_B', 'building', null),
      makeNode('level_b0', 'level', 'building_B'),
    ])
    expect(findStaleLevelNodes(scene, 'building_A' as AnyNodeId)).toEqual([
      'level_a0',
    ])
    expect(findStaleLevelNodes(scene, 'building_B' as AnyNodeId)).toEqual([
      'level_b0',
    ])
  })

  it('returns empty when the building has no level children', () => {
    const scene = buildScene([
      makeNode('building', 'building', null),
      // Walls / slabs that aren't levels — the sweep ignores them. The
      // generated-tag sweep handles those via findGeneratedNodes.
      makeNode('wall', 'wall', 'building'),
    ])
    expect(findStaleLevelNodes(scene, 'building' as AnyNodeId)).toEqual([])
  })

  it('does not return levels with no parentId at all (defensive)', () => {
    // A floating level (no parent) shouldn't satisfy isDescendantOf for any
    // building — guard against accidentally sweeping unrelated nodes.
    const scene = buildScene([
      makeNode('building', 'building', null),
      makeNode('level_orphan', 'level', null),
    ])
    expect(findStaleLevelNodes(scene, 'building' as AnyNodeId)).toEqual([])
  })
})
