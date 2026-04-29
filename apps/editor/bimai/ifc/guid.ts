// Deterministic IFC GlobalId generation.
//
// Every owned IFC entity carries an `IfcGloballyUniqueId` — a 22-character
// base64-encoded 128-bit value. web-ifc only ships `CreateIFCGloballyUniqueId`
// which returns a *random* GUID; we need determinism so re-exporting the
// same Pascal scene produces a file with the same GUIDs (architects iterate
// in a downstream BIM tool that tracks elements by GlobalId — random GUIDs
// would make every export look like a brand-new building).
//
// Strategy:
//   1. Hash a stable input string (project salt + Pascal node id +
//      sub-entity discriminator) to 128 bits via cyrb128 — a small
//      non-cryptographic 128-bit hasher commonly used for seeding.
//   2. Encode those 128 bits into the IFC base64 alphabet (22 chars).
//
// cyrb128 is a synchronous, dependency-free, ~20-line hash with collision
// behaviour fine for the few thousand entities a single export produces.
// We don't need cryptographic strength — collision means two entities get
// the same GlobalId, and BIM tools surface that as a validation warning,
// not data loss. SHA-1 / SHA-256 via Web Crypto would be async, forcing
// every emitter into Promise plumbing for no real benefit at our scale.

import { cyrb128 } from '../lib/hash'

/** IFC's 64-symbol base64 alphabet (per ISO-10303 / buildingSMART spec). */
const IFC_BASE64 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'

/**
 * Encode a 128-bit value (4×uint32, MSB-first) as a 22-character IFC
 * GlobalId.
 *
 * Bit layout: 22 chars × 6 = 132 bits, but only 128 are used. The first
 * char encodes the top 2 bits; the remaining 21 chars encode 6 bits each.
 * (1 + 21 × 6 = 127… off-by-one? No: 2 + 21 × 6 = 128. The first char's
 * 6-bit slot holds only the top 2 meaningful bits; its other 4 bits are
 * always zero.)
 *
 * We build a 128-character bit string and then walk it. Slow per-call
 * relative to a hand-rolled bit shifter, but called O(few thousand) times
 * per export — well under any user-visible threshold.
 */
function encode128ToIfcGuid(parts: [number, number, number, number]): string {
  const bits = parts
    .map((n) => n.toString(2).padStart(32, '0'))
    .join('') // exactly 128 chars
  let out = IFC_BASE64[Number.parseInt(bits.slice(0, 2), 2)]!
  for (let i = 2; i < 128; i += 6) {
    out += IFC_BASE64[Number.parseInt(bits.slice(i, i + 6), 2)]!
  }
  return out
}

/**
 * Build a deterministic IFC GlobalId from a stable composite key.
 *
 * The `projectSalt` (from `WriteIFCOptions.projectSalt`) prevents cross-
 * project collisions when two unrelated scenes happen to use the same
 * Pascal node ids — without it, two architects' "wall_xyz" would map to
 * the same GUID, and any downstream BIM tool that aggregates models would
 * silently merge them.
 *
 * The `discriminator` lets one Pascal node back multiple IFC entities (a
 * door has both an `IfcDoor` and an `IfcOpeningElement`; both want unique
 * GUIDs but should be reproducible from the same node id).
 */
export function deterministicIfcGuid(
  projectSalt: string,
  nodeId: string,
  discriminator = '',
): string {
  return encode128ToIfcGuid(
    cyrb128(`${projectSalt}:${nodeId}:${discriminator}`),
  )
}
