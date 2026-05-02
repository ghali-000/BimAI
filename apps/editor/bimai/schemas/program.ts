import { z } from 'zod'

export const UnitMixEntry = z.object({
  type: z.string(), // "Studio", "1BR", "2BR", "3BR", "4BR"
  count: z.number().int().min(0).default(0),
  targetArea: z.number().min(0).default(50), // m² per unit
})

export type UnitMixEntry = z.infer<typeof UnitMixEntry>

export const Program = z.object({
  unitMix: z.array(UnitMixEntry).default([]),
  floorToFloorHeight: z.number().min(2).default(3),
  // Phase 3-9: opt-in balcony emission. User-controlled (lives on Program,
  // not GenerationParams) — flipping it doesn't auto-regenerate; user
  // clicks Generate again to apply. Default false keeps Phase 3-8
  // behavior intact; persisted scenes (schemaVersion 1) without this
  // field parse as `false` via Zod's `.default(false)`, so no migration
  // is needed and schemaVersion stays at 1.
  generateBalconies: z.boolean().default(false),
})

export type Program = z.infer<typeof Program>
