// Optimizer UI state. Two surfaces consume it: the optimizer panel
// (writer side — owns the run lifecycle) and downstream surfaces
// (reader side — gallery, candidate-loader). Keeping the result on a
// zustand store rather than in panel state means Task 9's gallery and
// Task 11's "load candidate to scene" can each subscribe without
// prop-drilling through the panel.
//
// Not persisted: results are heavy (BuildingPlan + snapshot per top-K
// candidate) and only meaningful for the current scene. Reload =
// re-run the search.

import { create } from 'zustand'
import type { OptimizationResult } from './search/run'

export type OptimizerStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'error'
  | 'canceled'

export interface OptimizerProgress {
  sampled: number
  total: number
  compliantSoFar: number
}

interface OptimizerState {
  status: OptimizerStatus
  progress: OptimizerProgress | null
  result: OptimizationResult | null
  error: string | null
  /** Index (in OptimizationResult.candidates) of the candidate the
   *  gallery has highlighted. Lifts naturally to "candidate to load
   *  into the scene" in Task 11. Stays null until the user picks one. */
  selectedCandidateIndex: number | null

  start: () => void
  setProgress: (p: OptimizerProgress) => void
  setResult: (r: OptimizationResult) => void
  setError: (msg: string) => void
  setCanceled: () => void
  selectCandidate: (index: number | null) => void
  reset: () => void
}

export const useOptimizer = create<OptimizerState>((set) => ({
  status: 'idle',
  progress: null,
  result: null,
  error: null,
  selectedCandidateIndex: null,

  start: () =>
    set({
      status: 'running',
      progress: null,
      result: null,
      error: null,
      selectedCandidateIndex: null,
    }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) =>
    set({
      status: 'done',
      result,
      // Auto-select the top-ranked compliant candidate if there is
      // one. Gallery surfaces a focused card without an extra click;
      // the user can change it.
      selectedCandidateIndex:
        result.topK.length > 0 ? result.topK[0]!.candidateIndex : null,
    }),
  setError: (error) => set({ status: 'error', error }),
  setCanceled: () => set({ status: 'canceled' }),
  selectCandidate: (selectedCandidateIndex) => set({ selectedCandidateIndex }),
  reset: () =>
    set({
      status: 'idle',
      progress: null,
      result: null,
      error: null,
      selectedCandidateIndex: null,
    }),
}))
