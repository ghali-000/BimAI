// Pure worker-side message handler. Lives apart from search.worker.ts
// so vitest can exercise it directly — vitest doesn't run real Web
// Workers, but it can call this function with a fake `post`.
//
// One responsibility: accept a StartMsg, run the search, post progress
// updates as samples land, post a final 'done' (or 'error') message.
// Catches any thrown error from runSearch and forwards it as an
// ErrorMsg so the main thread never has to wire onerror.

import { runSearch } from '../search/run'
import type {
  ClientToWorkerMsg,
  WorkerToClientMsg,
} from './protocol'

export type Post = (msg: WorkerToClientMsg) => void

/**
 * Handle one message from the main thread. Currently only StartMsg
 * exists, but we keep the discriminated-union switch so adding a
 * future message type (e.g. 'pause') is mechanical.
 */
export function handleMessage(msg: ClientToWorkerMsg, post: Post): void {
  switch (msg.type) {
    case 'start':
      return runStart(msg, post)
  }
}

function runStart(
  msg: Extract<ClientToWorkerMsg, { type: 'start' }>,
  post: Post,
): void {
  try {
    const result = runSearch({
      input: msg.input,
      count: msg.count,
      seed: msg.seed,
      weights: msg.weights,
      topK: msg.topK,
      progressEveryN: msg.progressEveryN,
      onProgress: (sampled, total, compliantSoFar) => {
        post({
          type: 'progress',
          jobId: msg.jobId,
          sampled,
          total,
          compliantSoFar,
        })
      },
    })
    post({ type: 'done', jobId: msg.jobId, result })
  } catch (err) {
    post({
      type: 'error',
      jobId: msg.jobId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
