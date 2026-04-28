// Main-thread orchestrator for the search worker.
//
// The optimizer panel calls `runSearchInWorker(args)` and gets back a
// SearchHandle: a promise of the final OptimizationResult plus a
// `cancel()` button that terminates the worker mid-search. Progress
// updates flow through the `onProgress` callback the caller passes in.
//
// Two construction modes:
//
//   1. **Default**: spawn a real Web Worker via `new Worker(new URL(
//      './search.worker.ts', import.meta.url), { type: 'module' })`.
//      Bundler (Next.js / Vite / webpack 5) recognizes the URL pattern
//      and emits a separate worker chunk. Runs in actual workers in
//      browser; runs as Node Worker Threads in Bun if/when we add a
//      Node CLI search runner.
//
//   2. **Injected** (`workerFactory`): pass a function that returns a
//      Worker-shaped object. Tests use this with a fake worker so we
//      can assert orchestration without spinning up a real thread.
//      It's also useful for any future wrapper that swaps the
//      transport (e.g. SharedWorker for cross-tab sharing).
//
// One job per handle. Calling `cancel()` after the promise has settled
// is a no-op; calling it during the run rejects the promise with a
// CanceledError.

import { nanoid } from 'nanoid'
import type {
  ClientToWorkerMsg,
  ProgressMsg,
  StartMsg,
  WorkerToClientMsg,
} from './protocol'
import type { OptimizationResult } from '../search/run'
import type { GeneratorInput } from '../../generator/types'
import type { ObjectiveWeights } from '../objectives'

// ── public types ────────────────────────────────────────────────────────────

/** Minimum surface of a Worker we depend on. Lets tests inject a fake
 *  without pulling in the full DOM lib types. */
export interface WorkerLike {
  postMessage(msg: ClientToWorkerMsg): void
  addEventListener(
    type: 'message',
    listener: (e: MessageEvent<WorkerToClientMsg>) => void,
  ): void
  addEventListener(
    type: 'error',
    listener: (e: ErrorEvent) => void,
  ): void
  removeEventListener(type: 'message' | 'error', listener: unknown): void
  terminate(): void
}

export interface RunSearchInWorkerArgs {
  input: Omit<GeneratorInput, 'params'>
  count: number
  seed: number
  weights?: ObjectiveWeights
  topK?: number
  progressEveryN?: number
  onProgress?: (p: Omit<ProgressMsg, 'type' | 'jobId'>) => void
  /** Inject a fake Worker for tests. When omitted, a real Web Worker
   *  is constructed via `new Worker(new URL('./search.worker.ts',
   *  import.meta.url), { type: 'module' })`. */
  workerFactory?: () => WorkerLike
}

export interface SearchHandle {
  /** Resolves with the final OptimizationResult. Rejects if the
   *  worker reports an error or if `cancel()` was called. */
  result: Promise<OptimizationResult>
  /** Stop the search. Terminates the worker; rejects `result` with a
   *  CanceledError. No-op after the promise has settled. */
  cancel: () => void
}

export class CanceledError extends Error {
  constructor() {
    super('Search canceled')
    this.name = 'CanceledError'
  }
}

// ── implementation ──────────────────────────────────────────────────────────

/**
 * Run a search inside a Web Worker, returning a handle whose
 * `.result` promise resolves with the OptimizationResult.
 */
export function runSearchInWorker(args: RunSearchInWorkerArgs): SearchHandle {
  const factory = args.workerFactory ?? defaultWorkerFactory
  const worker = factory()
  const jobId = nanoid()
  let settled = false

  let resolveResult!: (r: OptimizationResult) => void
  let rejectResult!: (err: Error) => void
  const result = new Promise<OptimizationResult>((res, rej) => {
    resolveResult = res
    rejectResult = rej
  })

  const onMessage = (e: MessageEvent<WorkerToClientMsg>) => {
    const msg = e.data
    // Filter by jobId — defensive against stale messages from a
    // previous run if a worker ever gets reused.
    if (msg.jobId !== jobId) return
    switch (msg.type) {
      case 'progress':
        args.onProgress?.({
          sampled: msg.sampled,
          total: msg.total,
          compliantSoFar: msg.compliantSoFar,
        })
        return
      case 'done':
        settle(() => resolveResult(msg.result))
        return
      case 'error':
        settle(() => rejectResult(new Error(msg.message)))
        return
    }
  }

  const onError = (e: ErrorEvent) => {
    // Worker threw before we could marshal an ErrorMsg (parse error,
    // module load failure, …). Reject with whatever we have.
    settle(() => rejectResult(new Error(e.message || 'Worker errored')))
  }

  function settle(action: () => void) {
    if (settled) return
    settled = true
    worker.removeEventListener('message', onMessage)
    worker.removeEventListener('error', onError)
    action()
    worker.terminate()
  }

  worker.addEventListener('message', onMessage)
  worker.addEventListener('error', onError)

  const start: StartMsg = {
    type: 'start',
    jobId,
    input: args.input,
    count: args.count,
    seed: args.seed,
    weights: args.weights,
    topK: args.topK,
    progressEveryN: args.progressEveryN,
  }
  worker.postMessage(start)

  return {
    result,
    cancel: () => {
      settle(() => rejectResult(new CanceledError()))
    },
  }
}

// ── default factory ─────────────────────────────────────────────────────────

/** Spawn a real Web Worker. Bundler-aware; Next.js + Turbopack and
 *  Vite both recognize the `new URL(..., import.meta.url)` pattern
 *  and emit the worker chunk separately. */
function defaultWorkerFactory(): WorkerLike {
  const url = new URL('./search.worker.ts', import.meta.url)
  return new Worker(url, { type: 'module' }) as unknown as WorkerLike
}
