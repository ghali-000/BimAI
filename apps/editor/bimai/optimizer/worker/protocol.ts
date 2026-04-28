// Worker protocol — message shapes between the optimizer panel (main
// thread) and the search worker.
//
// One job per worker. Cancellation is "main calls worker.terminate()" —
// we don't bother with an in-loop check, because terminating cuts off
// any pending work in O(ms) and keeps the search loop branch-free. The
// client wrapper enforces the one-job invariant.
//
// We tag every message with a `jobId` even though there's only ever one
// in flight, so a future "queue jobs" mode (or a stale-message arriving
// after restart) can be filtered without false matches.

import type { GeneratorInput } from '../../generator/types'
import type { ObjectiveWeights } from '../objectives'
import type { OptimizationResult } from '../search/run'

// ── main → worker ───────────────────────────────────────────────────────────

export interface StartMsg {
  type: 'start'
  jobId: string
  /** Generator input minus `params` — those are sampled per candidate. */
  input: Omit<GeneratorInput, 'params'>
  count: number
  seed: number
  weights?: ObjectiveWeights
  topK?: number
  /** Override progressEveryN. The default in run.ts (~20 events over
   *  the run) is fine for most uses; the panel can crank it up for
   *  small counts where /20 rounds to 0 then floors to 1 anyway. */
  progressEveryN?: number
}

export type ClientToWorkerMsg = StartMsg

// ── worker → main ───────────────────────────────────────────────────────────

export interface ProgressMsg {
  type: 'progress'
  jobId: string
  sampled: number
  total: number
  compliantSoFar: number
}

export interface DoneMsg {
  type: 'done'
  jobId: string
  result: OptimizationResult
}

export interface ErrorMsg {
  type: 'error'
  jobId: string
  /** Human-readable error message. Stack trace is dropped — postMessage
   *  can't transfer Error instances cleanly across all environments. */
  message: string
}

export type WorkerToClientMsg = ProgressMsg | DoneMsg | ErrorMsg
