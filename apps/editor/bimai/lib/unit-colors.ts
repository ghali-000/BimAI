// Centralized unit-type → fill colour map.
//
// One source of truth for the colour any "unit zone" surface paints
// itself. Both the generator (which stamps `node.color` on emitted
// ZoneNodes the 3D viewer reads) and the optimizer gallery's SVG
// thumbnail import from here. If a future BIM viewer adds a 2D plan
// view, it imports from here too — keeps the visual identity of a
// "Studio" or "2BR" stable across surfaces.
//
// Algorithm: stable string-hash → HSL hue. Same input → same output,
// no palette commitment, visually distinct for the common unitMix
// names ("Studio" / "1BR" / "2BR" / "3BR" all hash to well-separated
// hues). Saturation and lightness are fixed at 60% / 70% so colours
// stay legible on both light and dark UI backgrounds.
//
// IMPORTANT: the formula here is byte-for-byte identical to the
// previous inlined `unitColor()` in generator/emit.ts. Changing the
// constants would break snapshot tests and visually drift existing
// generations. If you need a new palette, add a *new* function and
// migrate callers gradually.

const HUE_STEPS = 360
const SATURATION_PCT = 60
const LIGHTNESS_PCT = 70

/**
 * Deterministic colour for a unit type. Returns an `hsl(...)` string
 * suitable for SVG fill, CSS, or Pascal's ZoneNode `color` field.
 */
export function unitColor(type: string): string {
  const hue = unitHue(type)
  return `hsl(${hue}, ${SATURATION_PCT}%, ${LIGHTNESS_PCT}%)`
}

/**
 * Just the hue, in [0, 360). Exposed so callers that want to vary
 * saturation / lightness (e.g. a faded "selected sibling" treatment
 * in the gallery) can derive a sister colour without a second hash.
 */
export function unitHue(type: string): number {
  let h = 0
  for (let i = 0; i < type.length; i++) {
    h = (h * 31 + type.charCodeAt(i)) | 0
  }
  return ((h % HUE_STEPS) + HUE_STEPS) % HUE_STEPS
}
