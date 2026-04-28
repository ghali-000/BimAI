import { z } from 'zod'
import { TypologyOverride } from '../cost/typology'
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
    // Per-project overrides for typology cost baselines (mep / finishes /
    // generalConditions / contingencyPct / softCostsPct). Read-only in
    // Phase 3-4 — written via JSON for now; editing UI lands in 3-5+.
    typologyOverride: TypologyOverride.optional(),
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
