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
})

export type Program = z.infer<typeof Program>
