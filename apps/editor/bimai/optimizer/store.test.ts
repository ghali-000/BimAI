// Optimizer store — covers the lifecycle transitions the panel relies
// on (start → progress → done, start → error, start → canceled), and
// the auto-select behaviour when result.topK is non-empty.

import { beforeEach, describe, expect, it } from 'vitest'
import type { OptimizationResult } from './search/run'
import { useOptimizer } from './store'

function reset() {
  useOptimizer.getState().reset()
}

function makeResult(topKCount: number): OptimizationResult {
  // Minimum-viable OptimizationResult — only the fields the store
  // touches need to be real.
  const candidates = Array.from({ length: topKCount }, (_, i) => ({
    candidateIndex: i + 100,
    params: {} as never,
    composedScore: 0.9 - i * 0.05,
    breakdown: null,
    compliant: true,
    failure: null,
  }))
  return {
    candidates,
    topK: candidates,
    stats: {
      sampled: topKCount,
      compliant: topKCount,
      failures: {},
      durationMs: 1,
      bestScore: 0.9,
    },
  } as unknown as OptimizationResult
}

describe('optimizer store', () => {
  beforeEach(() => reset())

  it('starts in idle state with no progress, result, or error', () => {
    const s = useOptimizer.getState()
    expect(s.status).toBe('idle')
    expect(s.progress).toBeNull()
    expect(s.result).toBeNull()
    expect(s.error).toBeNull()
    expect(s.selectedCandidateIndex).toBeNull()
  })

  it('start() flips to running and clears stale result/error', () => {
    useOptimizer.getState().setError('previous')
    useOptimizer.getState().start()
    const s = useOptimizer.getState()
    expect(s.status).toBe('running')
    expect(s.error).toBeNull()
    expect(s.result).toBeNull()
    expect(s.progress).toBeNull()
  })

  it('setProgress threads through without changing status', () => {
    useOptimizer.getState().start()
    useOptimizer
      .getState()
      .setProgress({ sampled: 5, total: 10, compliantSoFar: 2 })
    const s = useOptimizer.getState()
    expect(s.status).toBe('running')
    expect(s.progress).toEqual({ sampled: 5, total: 10, compliantSoFar: 2 })
  })

  it('setResult moves to done and auto-selects the top-ranked compliant candidate', () => {
    useOptimizer.getState().start()
    const r = makeResult(3)
    useOptimizer.getState().setResult(r)
    const s = useOptimizer.getState()
    expect(s.status).toBe('done')
    expect(s.result).toBe(r)
    // First topK candidate has candidateIndex=100 (per makeResult).
    expect(s.selectedCandidateIndex).toBe(100)
  })

  it('setResult with empty topK leaves selection null', () => {
    useOptimizer.getState().start()
    const r = makeResult(0)
    useOptimizer.getState().setResult(r)
    expect(useOptimizer.getState().selectedCandidateIndex).toBeNull()
  })

  it('setError moves to error and exposes the message', () => {
    useOptimizer.getState().start()
    useOptimizer.getState().setError('boom')
    const s = useOptimizer.getState()
    expect(s.status).toBe('error')
    expect(s.error).toBe('boom')
  })

  it('setCanceled moves to canceled', () => {
    useOptimizer.getState().start()
    useOptimizer.getState().setCanceled()
    expect(useOptimizer.getState().status).toBe('canceled')
  })

  it('selectCandidate updates the index without changing status or result', () => {
    useOptimizer.getState().start()
    useOptimizer.getState().setResult(makeResult(3))
    useOptimizer.getState().selectCandidate(102)
    const s = useOptimizer.getState()
    expect(s.selectedCandidateIndex).toBe(102)
    expect(s.status).toBe('done')
  })

  it('loadSelectedToScene increments loadRequestSeq monotonically', () => {
    expect(useOptimizer.getState().loadRequestSeq).toBe(0)
    useOptimizer.getState().loadSelectedToScene()
    expect(useOptimizer.getState().loadRequestSeq).toBe(1)
    useOptimizer.getState().loadSelectedToScene()
    expect(useOptimizer.getState().loadRequestSeq).toBe(2)
  })

  it('reset returns the store to idle from any state', () => {
    useOptimizer.getState().setError('x')
    useOptimizer.getState().reset()
    const s = useOptimizer.getState()
    expect(s.status).toBe('idle')
    expect(s.error).toBeNull()
    expect(s.result).toBeNull()
    expect(s.progress).toBeNull()
    expect(s.selectedCandidateIndex).toBeNull()
  })
})
