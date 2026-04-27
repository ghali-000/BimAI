import type { ZoningRules } from '../../schemas/zoning'

export type IssueSeverity = 'error' | 'warning' | 'info'

export type IssueCode =
  | 'envelope_collapsed'
  | 'envelope_exceeds_coverage_cap'
  | 'plot_unusually_small'

export interface Issue {
  code: IssueCode
  severity: IssueSeverity
  message: string
}

export interface ZoningIssueInput {
  plotArea: number
  envelopeArea: number | null
  zoning: ZoningRules
}

const PLOT_SMALL_THRESHOLD = 50 // m²

export function computeZoningIssues({
  plotArea,
  envelopeArea,
  zoning,
}: ZoningIssueInput): Issue[] {
  const issues: Issue[] = []

  if (plotArea > 0 && plotArea < PLOT_SMALL_THRESHOLD) {
    issues.push({
      code: 'plot_unusually_small',
      severity: 'warning',
      message: `Plot area is ${plotArea.toFixed(1)} m² — below ${PLOT_SMALL_THRESHOLD} m². Setbacks may collapse the envelope.`,
    })
  }

  if (envelopeArea === null || envelopeArea <= 0) {
    issues.push({
      code: 'envelope_collapsed',
      severity: 'error',
      message:
        'Setbacks consume the entire plot — no buildable envelope remains. Reduce front/side/rear setbacks.',
    })
    return issues
  }

  if (plotArea > 0) {
    const coverageRatio = envelopeArea / plotArea
    if (coverageRatio > zoning.maxCoverage) {
      issues.push({
        code: 'envelope_exceeds_coverage_cap',
        severity: 'warning',
        message: `Envelope covers ${(coverageRatio * 100).toFixed(1)}% of the plot, above the ${(zoning.maxCoverage * 100).toFixed(0)}% coverage cap. Footprint will be clipped at generation time.`,
      })
    }
  }

  return issues
}
