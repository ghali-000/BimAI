// Web Worker entry. Boots a single search-handler that listens for
// StartMsg and forwards postMessage. All logic lives in
// handle-message.ts so vitest can exercise it without spinning up a
// real Worker.
//
// This file is NOT directly imported by the optimizer panel; the
// client (./client.ts) is. The bundler (webpack/turbopack/Vite) wires
// this file as the Worker payload via `new Worker(new URL(...))`.

/// <reference lib="webworker" />

import { handleMessage } from './handle-message'
import type { ClientToWorkerMsg, WorkerToClientMsg } from './protocol'

// `self` is the DedicatedWorkerGlobalScope inside a worker. Cast so
// TypeScript doesn't complain when this file gets typechecked against
// the browser/node lib mix the rest of the bimai workspace uses.
const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.addEventListener('message', (e: MessageEvent<ClientToWorkerMsg>) => {
  handleMessage(e.data, (msg: WorkerToClientMsg) => {
    ctx.postMessage(msg)
  })
})
