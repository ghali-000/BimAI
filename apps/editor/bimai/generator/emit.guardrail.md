# Emit drift guardrail

## Status

**Live as of 2026-04-28** — see `emit.guardrail.test.ts`. The notes below
capture the historical context (why this took an upstream PR to unblock)
and stay relevant until the local pick of that PR can be reverted in
favour of the upstream version.

## What was missing

A vitest spec that runs the full pipeline against a realistic input and
validates every emitted node with the corresponding Pascal Zod schema:

```ts
import {
  DoorNode, WindowNode, WallNode, SlabNode, ZoneNode, LevelNode,
} from '@pascal-app/core'

const SCHEMAS = { door: DoorNode, window: WindowNode, wall: WallNode,
                  slab: SlabNode, zone: ZoneNode, level: LevelNode }

it('every emitted node passes Pascal schema validation', () => {
  const writer = createMemoryWriter({ /* building stub */ })
  const out = runGenerator(realisticInput, writer)
  expect(out.ok).toBe(true)
  for (const node of Object.values(writer.getSnapshot().nodes)) {
    const schema = SCHEMAS[node.type as keyof typeof SCHEMAS]
    if (!schema) continue
    const r = schema.safeParse(node)
    expect(r.success, `${node.type} ${node.id}: ${JSON.stringify(r.error?.issues)}`)
      .toBe(true)
  }
})
```

This would catch any future drift between our emitter (`emit.ts`, which
builds nodes via `{...} as unknown as Foo` casts) and Pascal's schemas — so
e.g. if Pascal adds a new required field to `DoorNode`, the spec fails at
test time rather than waiting for someone to render the building and watch
the camera die.

## Why it isn't here

`@pascal-app/core` ships a single barrel export (no subpath exports — see
`packages/core/package.json`). Importing any symbol — even a pure Zod
schema — pulls the whole barrel, which evaluates `DoorSystem`, `WallSystem`,
etc. Those systems eagerly import `three-mesh-bvh`, whose UMD entry point
fails to evaluate under vitest's node runner:

```
TypeError: Class extends value undefined is not a constructor or null
  three-mesh-bvh/src/core/ObjectBVH.js:14:32
```

That's the same crash that forced the SceneWriter seam (MemoryWriter for
tests, PascalSceneWriter for the browser) in the first place. Confirmed
again on 2026-04-27 with a throwaway probe that imported only `DoorNode`.

## Mitigation in place

The boundary parse in `pascal-writer.ts` (`applyDefaults`) means every node
goes through Zod at the moment it enters the store in the browser. That
catches drift the first time a developer hits Generate after a schema
change — so the signal exists, it's just slower than a vitest run.

## How to actually fix this

Two viable paths:

1. **Subpath export from core.** Add `"./schema"` to
   `packages/core/package.json`'s `exports` field, pointing at
   `dist/schema/index.js`. The schema barrel doesn't import any system
   code, so it would evaluate cleanly under vitest. Smallest diff but
   touches Pascal.
2. **Vendor a `schemas-only.ts` re-export inside `bimai/`** that imports
   schema files via a relative path through `node_modules`
   (`@pascal-app/core/dist/schema/...`). Brittle and
   layout-dependent — only worth it if option 1 is rejected upstream.

Either path unlocks the test above unchanged. Until then, treat the
boundary parse as the single line of defence.
