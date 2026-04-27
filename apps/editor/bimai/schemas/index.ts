import { z } from 'zod'
import { ProjectInfo } from './project-info'
import { Program } from './program'
import { ZoningRules } from './zoning'

export * from './program'
export * from './project-info'
export * from './zoning'

// For SiteNode.metadata.bimai
export const SiteBimAIMetadata = z
  .object({
    project: ProjectInfo.optional(),
    zoning: ZoningRules.optional(),
  })
  .default({})
export type SiteBimAIMetadata = z.infer<typeof SiteBimAIMetadata>

// For BuildingNode.metadata.bimai
export const BuildingBimAIMetadata = z
  .object({
    program: Program.optional(),
  })
  .default({})
export type BuildingBimAIMetadata = z.infer<typeof BuildingBimAIMetadata>
