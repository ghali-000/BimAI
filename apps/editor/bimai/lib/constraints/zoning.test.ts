import { describe, expect, it } from 'vitest'
import { ZoningRules } from '../../schemas/zoning'
import { computeZoningIssues } from './zoning'

const zoning = ZoningRules.parse({})

describe('computeZoningIssues', () => {
  it('returns no issues for a healthy plot', () => {
    const issues = computeZoningIssues({
      plotArea: 900,
      envelopeArea: 484,
      zoning,
    })
    expect(issues).toEqual([])
  })

  it('flags envelope_collapsed when envelope is null or zero', () => {
    const a = computeZoningIssues({ plotArea: 900, envelopeArea: null, zoning })
    expect(a.some((i) => i.code === 'envelope_collapsed')).toBe(true)

    const b = computeZoningIssues({ plotArea: 900, envelopeArea: 0, zoning })
    expect(b.some((i) => i.code === 'envelope_collapsed')).toBe(true)
  })

  it('short-circuits coverage check when envelope is collapsed', () => {
    const issues = computeZoningIssues({
      plotArea: 900,
      envelopeArea: null,
      zoning,
    })
    expect(issues.some((i) => i.code === 'envelope_exceeds_coverage_cap')).toBe(
      false,
    )
  })

  it('flags envelope_exceeds_coverage_cap when ratio > maxCoverage', () => {
    // maxCoverage default is 0.6 → envelope/plot = 0.8 should trip it.
    const issues = computeZoningIssues({
      plotArea: 100,
      envelopeArea: 80,
      zoning,
    })
    expect(
      issues.some((i) => i.code === 'envelope_exceeds_coverage_cap'),
    ).toBe(true)
  })

  it('flags plot_unusually_small for plots below 50 m²', () => {
    const issues = computeZoningIssues({
      plotArea: 30,
      envelopeArea: 10,
      zoning,
    })
    expect(issues.some((i) => i.code === 'plot_unusually_small')).toBe(true)
  })

  it('marks envelope_collapsed as error severity', () => {
    const issues = computeZoningIssues({
      plotArea: 900,
      envelopeArea: null,
      zoning,
    })
    const collapsed = issues.find((i) => i.code === 'envelope_collapsed')
    expect(collapsed?.severity).toBe('error')
  })
})
