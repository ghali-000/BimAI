// Architecture test — enforces the type-only-import rule for "pure"
// modules in bimai/.
//
// Background: importing any runtime symbol from `@pascal-app/core` (the
// bare barrel) crashes vitest's collection because the barrel eagerly
// loads three-mesh-bvh, which extends an undefined class under
// vitest's resolver. We hit this in Phase 3-3 (writer split), Phase 3-4
// (cost/compute → readSiteMetadata), and would hit it again every time
// a "pure" compute or schema module sneaks in a runtime import.
//
// Rule: every module in the patterns below must use *type-only* imports
// of `@pascal-app/core`. Two forms are allowed:
//   - `import type { Foo } from '@pascal-app/core'`
//   - `import { type Foo } from '@pascal-app/core'`  (every specifier
//     marked `type`)
//
// The subpath `@pascal-app/core/schema` is allowed unconditionally —
// that's the workaround we land for runtime schema needs (see Phase 3-3
// PROGRESS notes), and it's exempt from the eager-barrel bug.

import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname) // apps/editor/bimai
const REPO_ROOT = join(__dirname, '..') // apps/editor

// Glob equivalents (we don't depend on fast-glob; the patterns below are
// hand-evaluated by walkDir + the matcher).
const PURE_PATTERNS: ReadonlyArray<(rel: string) => boolean> = [
  // bimai/**/compute.ts
  (r) => r.endsWith(`${sep}compute.ts`) || r === 'compute.ts',
  // bimai/**/types.ts
  (r) => r.endsWith(`${sep}types.ts`) || r === 'types.ts',
  // bimai/lib/component-bim.ts
  (r) => r === join('lib', 'component-bim.ts'),
  // bimai/schedule/**/*.ts
  (r) => r.startsWith(`schedule${sep}`) && r.endsWith('.ts'),
  // bimai/cost/**/*.ts
  (r) => r.startsWith(`cost${sep}`) && r.endsWith('.ts'),
  // bimai/bim/schemas/**/*.ts
  (r) => r.startsWith(join('bim', 'schemas') + sep) && r.endsWith('.ts'),
]

// Tests are excluded — they're allowed runtime imports because vitest
// collects them in isolation and our test files are written to navigate
// the barrel pitfall (cf. emit.guardrail.test.ts comments).
function isTestFile(rel: string): boolean {
  return rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')
}

function walkDir(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip node_modules just in case the tree ever has nested ones.
      if (entry.name === 'node_modules') continue
      walkDir(abs, acc)
    } else if (entry.isFile()) {
      acc.push(abs)
    }
  }
  return acc
}

function isPure(relFromBimai: string): boolean {
  if (isTestFile(relFromBimai)) return false
  return PURE_PATTERNS.some((p) => p(relFromBimai))
}

interface Violation {
  file: string
  line: number
  reason: string
}

function checkFile(absPath: string): Violation[] {
  const text = ts.sys.readFile(absPath)
  if (text === undefined) return []
  const src = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
  const violations: Violation[] = []
  ts.forEachChild(src, (node) => {
    if (!ts.isImportDeclaration(node)) return
    const spec = node.moduleSpecifier
    if (!ts.isStringLiteral(spec)) return
    if (spec.text !== '@pascal-app/core') return // exact match only
    const clause = node.importClause
    // `import '@pascal-app/core'` (side-effect only) — there's no clause.
    // Treat as a runtime import; flag it.
    if (!clause) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart())
      violations.push({
        file: absPath,
        line: line + 1,
        reason: 'side-effect import',
      })
      return
    }
    if (clause.isTypeOnly) return // `import type { ... }` — fine
    // Default import (no `type`) is a runtime import.
    if (clause.name) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart())
      violations.push({
        file: absPath,
        line: line + 1,
        reason: 'default import is not type-only',
      })
      return
    }
    // Named bindings: every specifier must be `type`.
    const bindings = clause.namedBindings
    if (!bindings) return
    if (ts.isNamespaceImport(bindings)) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart())
      violations.push({
        file: absPath,
        line: line + 1,
        reason: 'namespace import (`import * as`) is not type-only',
      })
      return
    }
    if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (!el.isTypeOnly) {
          const { line } = src.getLineAndCharacterOfPosition(el.getStart())
          violations.push({
            file: absPath,
            line: line + 1,
            reason: `named import \`${el.name.text}\` is not marked \`type\``,
          })
        }
      }
    }
  })
  return violations
}

const allFiles = walkDir(ROOT)
const pureFiles = allFiles.filter((abs) => {
  const rel = relative(ROOT, abs)
  return isPure(rel)
})

describe('architecture: type-only imports of @pascal-app/core in pure modules', () => {
  // Sanity: the matcher should pick up the canonical examples. If this
  // ever drops to zero we've regressed the discovery logic, not the
  // codebase.
  it('discovers at least the known pure modules', () => {
    const rels = pureFiles.map((f) => relative(ROOT, f))
    expect(rels).toContain(join('lib', 'component-bim.ts'))
    expect(rels).toContain(join('cost', 'compute.ts'))
    expect(rels).toContain(join('schedule', 'compute.ts'))
    expect(rels).toContain(join('bim', 'schemas', 'component-bim.ts'))
  })

  // One dynamically-named test per file — keeps the failure message
  // pointed at the exact module that regressed. Future violations read
  // as e.g. "bimai/cost/compute.ts: non-type-only import of
  // @pascal-app/core (line 12) — pure compute modules must use
  // type-only imports to avoid the three-mesh-bvh barrel crash".
  for (const file of pureFiles) {
    const rel = relative(REPO_ROOT, file)
    it(`${rel.replaceAll('\\', '/')}: only type-only imports of @pascal-app/core`, () => {
      const violations = checkFile(file)
      if (violations.length === 0) return
      const summary = violations
        .map(
          (v) =>
            `${rel.replaceAll('\\', '/')}: non-type-only import of @pascal-app/core (line ${v.line}) — ${v.reason}; pure compute modules must use type-only imports to avoid the three-mesh-bvh barrel crash`,
        )
        .join('\n')
      throw new Error(summary)
    })
  }
})
