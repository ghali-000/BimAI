// Smoke test for web-ifc wasm initialization.
//
// Phase 3-6 Task 3: confirm the dependency installs cleanly, wasm boots, and
// the API can produce a valid IFC4 STEP physical file. The fuller
// scene-conversion tests live next to the writer in `write.test.ts`.

import { afterEach, describe, expect, it } from 'vitest'
import { __resetIfcApiForTests, initIfcApi } from './init'

describe('initIfcApi', () => {
  afterEach(() => {
    __resetIfcApiForTests()
  })

  it('initializes the wasm runtime and produces a valid IFC4 STEP file', async () => {
    const api = await initIfcApi()
    const modelId = api.CreateModel({ schema: 'IFC4', name: 'init-probe' })
    const bytes = api.SaveModel(modelId)
    api.CloseModel(modelId)

    expect(bytes.length).toBeGreaterThan(0)
    const text = new TextDecoder().decode(bytes)
    // STEP physical-file header — every valid IFC file starts with this
    // exact prelude.
    expect(text.startsWith('ISO-10303-21;')).toBe(true)
    expect(text).toContain('HEADER;')
    expect(text).toContain('FILE_DESCRIPTION')
    expect(text).toContain('FILE_SCHEMA')
    // The empty-model output should declare the IFC4 schema.
    expect(text).toContain('IFC4')
    // STEP bodies always close with ENDSEC + END-ISO-10303-21.
    expect(text).toContain('END-ISO-10303-21;')
  })

  it('returns the same instance across calls (singleton)', async () => {
    const a = await initIfcApi()
    const b = await initIfcApi()
    expect(a).toBe(b)
  })
})
