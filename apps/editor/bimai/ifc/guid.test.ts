// Pure tests for deterministic IFC GlobalId generation.
//
// We rely on these GUIDs being stable across re-exports so downstream BIM
// tools can track building elements by GlobalId — random GUIDs would make
// every export look like a brand-new building.

import { describe, expect, it } from 'vitest'
import { deterministicIfcGuid } from './guid'

const IFC_BASE64_RE = /^[0-9A-Za-z_$]+$/

describe('deterministicIfcGuid', () => {
  it('produces a 22-character GUID', () => {
    expect(deterministicIfcGuid('salt', 'node-1', '')).toHaveLength(22)
  })

  it('uses only the IFC base64 alphabet', () => {
    const g = deterministicIfcGuid('project-salt', 'wall_abcdef0123456789', 'door')
    expect(g).toMatch(IFC_BASE64_RE)
  })

  it('is deterministic for the same inputs', () => {
    const a = deterministicIfcGuid('salt', 'node-1', 'opening')
    const b = deterministicIfcGuid('salt', 'node-1', 'opening')
    expect(a).toBe(b)
  })

  it('produces different GUIDs for different node ids', () => {
    const a = deterministicIfcGuid('salt', 'node-1', '')
    const b = deterministicIfcGuid('salt', 'node-2', '')
    expect(a).not.toBe(b)
  })

  it('produces different GUIDs for different salts', () => {
    const a = deterministicIfcGuid('salt-a', 'node-1', '')
    const b = deterministicIfcGuid('salt-b', 'node-1', '')
    expect(a).not.toBe(b)
  })

  it('treats the discriminator as part of the key (door vs opening)', () => {
    const empty = deterministicIfcGuid('salt', 'node-1', '')
    const door = deterministicIfcGuid('salt', 'node-1', 'door')
    const opening = deterministicIfcGuid('salt', 'node-1', 'opening')
    expect(empty).not.toBe(door)
    expect(door).not.toBe(opening)
    expect(empty).not.toBe(opening)
  })

  it('handles empty-string node ids and still emits a valid 22-char GUID', () => {
    const g = deterministicIfcGuid('salt', '', 'disc')
    expect(g).toHaveLength(22)
    expect(g).toMatch(IFC_BASE64_RE)
  })
})
