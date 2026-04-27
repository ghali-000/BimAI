import { z } from 'zod'

export const ProjectInfo = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().default('Untitled Project'),
  createdAt: z.string().default(() => new Date().toISOString()),
})

export type ProjectInfo = z.infer<typeof ProjectInfo>
