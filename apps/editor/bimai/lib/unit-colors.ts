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

// ── Room zones (Phase 3-7) ─────────────────────────────────────────────────
//
// Room zones use a different lightness band so they read as "inside a unit"
// when stacked in the 3D viewer with their parent unit zone — slightly
// brighter / more saturated than the unit colour, which sits at 60/70%.
// We don't reuse `unitHue(kind)` because the same six RoomKinds repeat in
// every unit; instead we hand-pick a small, semantically-meaningful palette
// (cool blue for water-rooms, warm yellow for living, neutral for hallway,
// etc.) so a designer scanning a generated floor can read "bedroom" /
// "kitchen" without a legend.

const ROOM_PALETTE: Record<string, string> = {
  bedroom: 'hsl(220, 55%, 78%)', // soft blue
  bathroom: 'hsl(190, 50%, 75%)', // teal
  kitchen: 'hsl(30, 60%, 78%)', // warm orange-cream
  living: 'hsl(50, 60%, 80%)', // pale yellow
  hallway: 'hsl(0, 0%, 85%)', // neutral grey
  'unit-shell': 'hsl(0, 0%, 80%)', // grey, slightly darker than hallway
}

const ROOM_FALLBACK = 'hsl(0, 0%, 75%)'

/**
 * Deterministic colour for a room kind. Designed for the Pascal ZoneNode
 * `color` field (an `hsl(...)` CSS string). Returns a sensible neutral grey
 * for any unrecognised kind so a future RoomKind addition doesn't crash
 * the renderer — it just paints grey until the palette is updated here.
 */
export function roomColor(kind: string): string {
  return ROOM_PALETTE[kind] ?? ROOM_FALLBACK
}
