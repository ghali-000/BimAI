import { z } from 'zod'

export const ZoningRules = z.object({
  setbacks: z
    .object({
      front: z.number().min(0).default(5),
      side: z.number().min(0).default(3),
      rear: z.number().min(0).default(4),
    })
    .default({ front: 5, side: 3, rear: 4 }),
  maxHeight: z.number().min(0).default(24), // metres
  maxFAR: z.number().min(0).default(2), // floor area ratio
  maxCoverage: z.number().min(0).max(1).default(0.6),
  minOpenSpace: z.number().min(0).max(1).default(0.3),
})

export type ZoningRules = z.infer<typeof ZoningRules>
