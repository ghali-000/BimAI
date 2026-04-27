#!/usr/bin/env bun
// BimAI procedural generator — Node CLI.
//
// Runs the same pipeline the Generation panel runs, against an in-memory
// scene rather than Pascal's zustand store. Reads JSON config from stdin or
// a file, emits the generated nodes as a flat list (single mode) or one
// result per input line (batch / JSONL mode).
//
// Why this exists. Phase 3-3's brief calls for a headless surface so we can
// (a) regression-test the full pipeline against a corpus of plot/program
// inputs without spinning up the browser, and (b) use the generator as a
// building block in larger automation later. The CLI is deliberately thin:
// arg parsing, IO, then `runGenerator(input, MemoryWriter)`.
//
// Usage:
//   bun run generate -- --input config.json --output building.json
//   bun run generate -- --batch in.jsonl --batch-out out.jsonl
//   cat config.json | bun run generate -- --output building.json
//
// Exit codes (per the brief):
//   0 — pipeline succeeded for every input
//   1 — bad CLI args, IO error, or input failed Zod validation
//   2 — pipeline ran but returned a typed failure (envelope_collapsed, …);
//       in batch mode this fires if ANY input fails
//
// Schemas are reused from `bimai/schemas` (the same file the Zoning and
// Program panels parse against), so a config that round-trips through the
// UI is automatically valid here too.

import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { runGenerator } from '../generator/pipeline'
import { createMemoryWriter } from '../generator/scene-writer'
import type { GeneratorInput, GeneratorOutput } from '../generator/types'
import { Program, ZoningRules } from '../schemas'

// ── Config schema ────────────────────────────────────────────────────────────

const Point2D = z.tuple([z.number(), z.number()])

const GenerateConfig = z.object({
  // Optional — synthesised when omitted so a minimal config (just polygon +
  // zoning + program) Just Works. The generated nodes are tagged with these
  // ids only via parentage, so the values matter mostly for downstream tools
  // that want to correlate runs.
  siteId: z.string().default('site_cli'),
  buildingId: z.string().default('building_cli'),
  plotPolygon: z.array(Point2D).min(3),
  zoning: ZoningRules,
  program: Program,
  seed: z.number().int().optional(),
})
type GenerateConfig = z.infer<typeof GenerateConfig>

// ── Arg parsing ──────────────────────────────────────────────────────────────

interface Args {
  input?: string
  output?: string
  batch?: string
  batchOut?: string
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--input':
        a.input = argv[++i]
        break
      case '--output':
        a.output = argv[++i]
        break
      case '--batch':
        a.batch = argv[++i]
        break
      case '--batch-out':
        a.batchOut = argv[++i]
        break
      case '-h':
      case '--help':
        a.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return a
}

const HELP = `bimai generate — procedural building generator

Usage:
  bun run generate -- --input <file> --output <file>
  bun run generate -- --batch <jsonl> --batch-out <jsonl>
  cat config.json | bun run generate -- --output <file>

Modes:
  single  one config in, one result out (JSON)
  batch   one config per line in, one result per line out (JSONL)

Exit codes:
  0 success
  1 IO / argument / validation error
  2 pipeline returned a typed failure
`

// ── Driver ───────────────────────────────────────────────────────────────────

interface RunArtifact {
  ok: boolean
  reason?: string
  issues?: string[]
  warnings?: string[]
  opsApplied?: number
  generationId?: string
  floorCount?: number
  /** Flat list of every node the writer ended up holding (excluding the
   *  pre-existing building stub we seeded). */
  nodes?: unknown[]
}

function runOne(config: GenerateConfig): RunArtifact {
  // Seed the writer with a minimal building so the generator has somewhere
  // to parent its level nodes. Mirrors the runtime seam — Pascal's store
  // already holds the building when the panel runs the pipeline.
  const buildingStub = {
    object: 'node',
    id: config.buildingId,
    type: 'building',
    parentId: null,
    visible: true,
    metadata: {},
    children: [] as string[],
  }
  const writer = createMemoryWriter({
    nodes: { [config.buildingId]: buildingStub as never },
  })

  const input: GeneratorInput = {
    siteId: config.siteId as GeneratorInput['siteId'],
    buildingId: config.buildingId as GeneratorInput['buildingId'],
    plotPolygon: config.plotPolygon,
    zoning: config.zoning,
    program: config.program,
    seed: config.seed,
  }

  const out: GeneratorOutput = runGenerator(input, writer)

  if (!out.ok) {
    return { ok: false, reason: out.reason, issues: out.issues }
  }

  // Drop the seeded building from the output — callers want the *generated*
  // nodes, not the stub we needed to wire parentage. Keep everything else.
  const all = writer.getSnapshot().nodes
  const nodes = Object.values(all).filter((n) => n.id !== config.buildingId)

  return {
    ok: true,
    opsApplied: out.opsApplied,
    generationId: out.plan.generationId,
    floorCount: out.plan.floorCount,
    warnings: out.warnings,
    nodes,
  }
}

function readJson(path?: string): unknown {
  const raw =
    path !== undefined ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8')
  return JSON.parse(raw)
}

function writeJson(path: string | undefined, value: unknown): void {
  const out = `${JSON.stringify(value, null, 2)}\n`
  if (path === undefined) process.stdout.write(out)
  else writeFileSync(path, out, 'utf8')
}

function parseConfig(raw: unknown): GenerateConfig {
  const r = GenerateConfig.safeParse(raw)
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new Error(`invalid config — ${issues}`)
  }
  return r.data
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${HELP}`)
    return 1
  }
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }

  // ── Batch mode ─────────────────────────────────────────────────────────────
  if (args.batch !== undefined || args.batchOut !== undefined) {
    if (args.batch === undefined || args.batchOut === undefined) {
      process.stderr.write('--batch and --batch-out must be used together\n')
      return 1
    }
    let raw: string
    try {
      raw = readFileSync(args.batch, 'utf8')
    } catch (err) {
      process.stderr.write(`failed to read ${args.batch}: ${(err as Error).message}\n`)
      return 1
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    const results: RunArtifact[] = []
    let anyFailed = false
    for (let i = 0; i < lines.length; i++) {
      let config: GenerateConfig
      try {
        config = parseConfig(JSON.parse(lines[i]!))
      } catch (err) {
        process.stderr.write(`line ${i + 1}: ${(err as Error).message}\n`)
        return 1
      }
      const r = runOne(config)
      if (!r.ok) anyFailed = true
      results.push(r)
    }
    const outBody = `${results.map((r) => JSON.stringify(r)).join('\n')}\n`
    try {
      writeFileSync(args.batchOut, outBody, 'utf8')
    } catch (err) {
      process.stderr.write(`failed to write ${args.batchOut}: ${(err as Error).message}\n`)
      return 1
    }
    return anyFailed ? 2 : 0
  }

  // ── Single mode ────────────────────────────────────────────────────────────
  let raw: unknown
  try {
    raw = readJson(args.input)
  } catch (err) {
    process.stderr.write(`failed to read input: ${(err as Error).message}\n`)
    return 1
  }
  let config: GenerateConfig
  try {
    config = parseConfig(raw)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  const result = runOne(config)
  try {
    writeJson(args.output, result)
  } catch (err) {
    process.stderr.write(`failed to write output: ${(err as Error).message}\n`)
    return 1
  }
  return result.ok ? 0 : 2
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`unhandled: ${(err as Error).stack ?? err}\n`)
    process.exit(1)
  },
)
