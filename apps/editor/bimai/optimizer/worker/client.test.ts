// Client orchestrator tests. We inject a fake WorkerLike that records
// postMessage calls and replays scripted WorkerToClientMsg events into
// the registered listener. This exercises the orchestration layer
// without needing a real Web Worker.

import type { AnyNodeId } from '@pascal-app/core'
import { describe, expect, it } from 'vitest'
import type { GeneratorInput } from '../../generator/types'
import type { Program, ZoningRules } from '../../schemas'
import {
  CanceledError,
  runSearchInWorker,
  type WorkerLike,
} from './client'
import { handleMessage } from './handle-message'
import type {
  ClientToWorkerMsg,
  StartMsg,
  WorkerToClientMsg,
} from './protocol'

const SITE_ID = 'site_client_test' as AnyNodeId
const BUILDING_ID = 'building_client_test' as AnyNodeId

const ZONING: ZoningRules = {
  setbacks: { front: 5, side: 3, rear: 4 },
  maxHeight: 24,
  maxFAR: 2,
  maxCoverage: 0.6,
  minOpenSpace: 0.3,
}
const PROGRAM: Program = {
  unitMix: [{ type: '1BR', count: 4, targetArea: 50 }],
  floorToFloorHeight: 3,
}
const PLOT: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 30],
  [0, 30],
]
const INPUT: Omit<GeneratorInput, 'params'> = {
  siteId: SITE_ID,
  buildingId: BUILDING_ID,
  plotPolygon: PLOT,
  zoning: ZONING,
  program: PROGRAM,
}

// ── fake worker harness ─────────────────────────────────────────────────────

interface FakeWorker extends WorkerLike {
  /** Messages the client has posted to the worker. */
  posted: ClientToWorkerMsg[]
  /** Send a message back to the client (worker → main direction). */
  emit(msg: WorkerToClientMsg): void
  /** Trigger an `error` event on the client. */
  emitError(msg: string): void
  terminated: boolean
}

function makeFakeWorker(): FakeWorker {
  const messageListeners: Array<(e: MessageEvent<WorkerToClientMsg>) => void> =
    []
  const errorListeners: Array<(e: ErrorEvent) => void> = []
  const fake: FakeWorker = {
    posted: [],
    terminated: false,
    postMessage(msg) {
      this.posted.push(msg)
    },
    addEventListener(type: string, listener: unknown) {
      if (type === 'message')
        messageListeners.push(
          listener as (e: MessageEvent<WorkerToClientMsg>) => void,
        )
      else if (type === 'error')
        errorListeners.push(listener as (e: ErrorEvent) => void)
    },
    removeEventListener(type, listener) {
      const arr =
        type === 'message'
          ? (messageListeners as unknown[])
          : (errorListeners as unknown[])
      const i = arr.indexOf(listener)
      if (i >= 0) arr.splice(i, 1)
    },
    terminate() {
      this.terminated = true
    },
    emit(msg) {
      const evt = { data: msg } as MessageEvent<WorkerToClientMsg>
      // Slice so a listener that removes itself mid-iteration is fine.
      for (const l of [...messageListeners]) l(evt)
    },
    emitError(message: string) {
      const evt = { message } as ErrorEvent
      for (const l of [...errorListeners]) l(evt)
    },
  }
  return fake
}

/** Drive the fake worker by feeding the start message into the real
 *  handleMessage and emitting the resulting messages back. This is
 *  what gives us an integration-flavored client test without a real
 *  Worker thread. */
function driveWithRealHandler(fake: FakeWorker) {
  const start = fake.posted[0] as StartMsg
  handleMessage(start, (m) => fake.emit(m))
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('runSearchInWorker — happy path', () => {
  it('resolves with the result and forwards progress events', async () => {
    const fake = makeFakeWorker()
    const progressEvents: Array<{
      sampled: number
      total: number
      compliantSoFar: number
    }> = []
    const handle = runSearchInWorker({
      input: INPUT,
      count: 6,
      seed: 13,
      progressEveryN: 2,
      workerFactory: () => fake,
      onProgress: (p) => progressEvents.push(p),
    })
    driveWithRealHandler(fake)
    const result = await handle.result
    expect(result.candidates).toHaveLength(6)
    expect(result.stats.sampled).toBe(6)
    // count=6, progressEveryN=2 → 3 events at 2/4/6
    expect(progressEvents).toHaveLength(3)
    expect(progressEvents.map((p) => p.sampled)).toEqual([2, 4, 6])
    expect(fake.terminated).toBe(true)
  })

  it('posts a start message containing all forwarded fields', () => {
    const fake = makeFakeWorker()
    runSearchInWorker({
      input: INPUT,
      count: 5,
      seed: 99,
      topK: 3,
      progressEveryN: 1,
      workerFactory: () => fake,
    })
    const start = fake.posted[0] as StartMsg
    expect(start.type).toBe('start')
    expect(start.count).toBe(5)
    expect(start.seed).toBe(99)
    expect(start.topK).toBe(3)
    expect(start.progressEveryN).toBe(1)
    expect(start.jobId).toBeTruthy()
  })
})

describe('runSearchInWorker — error path', () => {
  it('rejects when the worker emits an error message', async () => {
    const fake = makeFakeWorker()
    const handle = runSearchInWorker({
      input: INPUT,
      count: 4,
      seed: 1,
      workerFactory: () => fake,
    })
    const start = fake.posted[0] as StartMsg
    fake.emit({
      type: 'error',
      jobId: start.jobId,
      message: 'boom',
    })
    await expect(handle.result).rejects.toThrow('boom')
    expect(fake.terminated).toBe(true)
  })

  it('rejects when the worker fires an error event (parse / load failure)', async () => {
    const fake = makeFakeWorker()
    const handle = runSearchInWorker({
      input: INPUT,
      count: 4,
      seed: 1,
      workerFactory: () => fake,
    })
    fake.emitError('module not found')
    await expect(handle.result).rejects.toThrow('module not found')
    expect(fake.terminated).toBe(true)
  })
})

describe('runSearchInWorker — cancellation', () => {
  it('cancel() rejects with CanceledError and terminates the worker', async () => {
    const fake = makeFakeWorker()
    const handle = runSearchInWorker({
      input: INPUT,
      count: 100,
      seed: 1,
      workerFactory: () => fake,
    })
    handle.cancel()
    await expect(handle.result).rejects.toBeInstanceOf(CanceledError)
    expect(fake.terminated).toBe(true)
  })

  it('cancel after settle is a no-op', async () => {
    const fake = makeFakeWorker()
    const handle = runSearchInWorker({
      input: INPUT,
      count: 3,
      seed: 1,
      workerFactory: () => fake,
    })
    driveWithRealHandler(fake)
    await handle.result
    // Already settled; cancel should not throw, should not double-terminate.
    expect(() => handle.cancel()).not.toThrow()
  })
})

describe('runSearchInWorker — jobId filtering', () => {
  it('ignores messages with a stale jobId', async () => {
    const fake = makeFakeWorker()
    const progressEvents: Array<{ sampled: number }> = []
    const handle = runSearchInWorker({
      input: INPUT,
      count: 5,
      seed: 1,
      progressEveryN: 1,
      workerFactory: () => fake,
      onProgress: (p) => progressEvents.push(p),
    })
    const start = fake.posted[0] as StartMsg
    // Stale progress (different jobId) — must be ignored.
    fake.emit({
      type: 'progress',
      jobId: 'stale_job',
      sampled: 999,
      total: 5,
      compliantSoFar: 0,
    })
    expect(progressEvents).toHaveLength(0)
    // Real done with the correct jobId resolves.
    const fakeResult = {
      candidates: [],
      topK: [],
      stats: {
        sampled: 0,
        compliant: 0,
        failures: {},
        durationMs: 0,
        bestScore: 0,
      },
    }
    fake.emit({ type: 'done', jobId: start.jobId, result: fakeResult })
    const result = await handle.result
    expect(result).toBe(fakeResult)
  })
})
