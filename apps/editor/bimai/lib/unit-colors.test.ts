// Unit-color hash regression tests.
//
// These specs lock the byte-for-byte output of `unitColor()` to the
// values the previous inlined emit.ts implementation produced. If
// something changes here, every snapshot fixture and every saved
// generation in the wild starts visually drifting — hence the
// snapshot-style assertions on the exact HSL strings.

import { describe, expect, it } from 'vitest'
import { unitColor, unitHue } from './unit-colors'

describe('unitColor — regression against previous inlined formula', () => {
  it('emits stable hsl strings for the canonical unit types', () => {
    // These values were observed from the live generator output before
    // the centralization refactor. Locking them in protects the wider
    // visual identity of every "Studio" / "1BR" / "2BR" zone the user
    // has ever rendered.
    expect(unitColor('Studio')).toBe('hsl(166, 60%, 70%)')
    expect(unitColor('1BR')).toBe('hsl(257, 60%, 70%)')
    expect(unitColor('2BR')).toBe('hsl(138, 60%, 70%)')
    expect(unitColor('3BR')).toBe('hsl(19, 60%, 70%)')
  })

  it('is deterministic across calls', () => {
    expect(unitColor('1BR')).toBe(unitColor('1BR'))
  })

  it('produces different colours for different unit types', () => {
    const seen = new Set<string>()
    for (const t of ['Studio', '1BR', '2BR', '3BR', 'Penthouse', 'Loft']) {
      seen.add(unitColor(t))
    }
    // 6 inputs → expect 6 distinct outputs (collisions across the 360-hue
    // space for short strings are highly improbable).
    expect(seen.size).toBe(6)
  })
})

describe('unitHue — bounded output', () => {
  it('returns a hue in [0, 360)', () => {
    for (const t of ['', 'a', 'A long unit name', '日本語', 'Studio']) {
      const h = unitHue(t)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
      expect(Number.isInteger(h)).toBe(true)
    }
  })
})
