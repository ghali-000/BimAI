// Tests for the user-facing export wrapper.
//
// Two layers:
//   • `buildFilename` is pure and synchronous — tested directly.
//   • `exportToIFC` exercises the dynamic-import path, the status
//     callback, and the byte-shape contract. We don't re-test the IFC
//     content here (write.test.ts owns that surface) — only that the
//     wrapper composes correctly.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SceneSnapshot } from '../generator/cleanup'
import { __resetIfcApiForTests } from './init'
import { buildFilename, exportToIFC, type ExportStatus } from './export'

afterEach(() => {
  __resetIfcApiForTests()
  vi.useRealTimers()
})

describe('buildFilename', () => {
  it('uses bimai_export when project name is missing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-28T12:00:00Z'))
    expect(buildFilename(undefined)).toBe('bimai_export_20260428.ifc')
    expect(buildFilename('')).toBe('bimai_export_20260428.ifc')
  })

  it('slugifies the project name', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-28T00:00:00Z'))
    expect(buildFilename('Acme Tower v2!')).toBe(
      'bimai_acme_tower_v2_20260428.ifc',
    )
  })

  it('always includes the date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    expect(buildFilename('Demo')).toBe('bimai_demo_20261201.ifc')
  })
})

describe('exportToIFC', () => {
  // Minimal but well-formed scene: a project / site / building / level
  // pair so the writer has a complete spatial spine.
  function emptyScene(): SceneSnapshot {
    return {
      nodes: {
        // biome-ignore lint/suspicious/noExplicitAny: test-fixture cast
        site_test1: {
          id: 'site_test1',
          type: 'site',
          name: 'Site',
          parentId: null,
        } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test-fixture cast
        building_test1: {
          id: 'building_test1',
          type: 'building',
          name: 'Building',
          parentId: 'site_test1',
          position: [0, 0, 0],
        } as any,
      },
    }
  }

  it('returns Uint8Array bytes and a slugified filename', async () => {
    const result = await exportToIFC(emptyScene(), {
      projectName: 'Acme Tower',
    })
    expect(result.bytes).toBeInstanceOf(Uint8Array)
    expect(result.bytes.length).toBeGreaterThan(0)
    expect(result.filename).toMatch(/^bimai_acme_tower_\d{8}\.ifc$/)
  })

  it('falls back to bimai_export_<date>.ifc when projectName is absent', async () => {
    const result = await exportToIFC(emptyScene())
    expect(result.filename).toMatch(/^bimai_export_\d{8}\.ifc$/)
  })

  it('fires status callbacks in order: loading-engine → exporting → done', async () => {
    const events: ExportStatus[] = []
    await exportToIFC(emptyScene(), {
      projectName: 'X',
      onStatus: (s) => events.push(s),
    })
    expect(events).toEqual(['loading-engine', 'exporting', 'done'])
  })
})
