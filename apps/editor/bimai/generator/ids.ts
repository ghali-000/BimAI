// Local ID minting for the generator.
//
// Pascal's `generateId` from `@pascal-app/core/schema/base` produces IDs in the
// form `<prefix>_<16 alphanumeric>` using nanoid with the alphabet
// 0-9a-z. We re-implement here so the generator (and its test runner) doesn't
// pull the `@pascal-app/core` barrel — that barrel transitively imports
// three-mesh-bvh which won't load under vitest's node environment. Same trick
// the structural test fixtures use.
//
// Output format must stay byte-compatible with Pascal's because:
//   • Pascal's discriminated-union ID types (`wall_${string}` etc.) are
//     template literals — any string with the right prefix passes type-wise.
//   • The store's `createNodes` uses the ID as a dictionary key, no parsing.

import { customAlphabet } from 'nanoid'

const customId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16)

export function generateId<T extends string>(prefix: T): `${T}_${string}` {
  return `${prefix}_${customId()}` as `${T}_${string}`
}
