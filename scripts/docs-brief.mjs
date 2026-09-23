#!/usr/bin/env node
// docs-systems v1.0.0 — regenerates the Agent Brief's routing table.
//
// The Brief has two halves with different rules, and mixing them is how briefs
// rot:
//
//   GENERATED — the task-to-section routing table, derived from the doc's own
//               headings, between <!-- routing:start --> / <!-- routing:end -->.
//               Generated content cannot drift. This is the half that actually
//               saves tokens: it turns "read 130 KB" into "read one section".
//
//   HAND-WRITTEN — scope (including what the doc does NOT cover) and the
//               invariants a change can break. No script can write those.
//
// This script owns the generated half ONLY. It never touches a line outside the
// markers, and it preserves the cue text you wrote for each row, so regenerating
// after adding a heading costs you nothing.
//
// Usage:
//   node scripts/docs-brief.mjs payments          # rewrite the table
//   node scripts/docs-brief.mjs payments --check   # report drift, write nothing
//   node scripts/docs-brief.mjs --all

import { basename } from 'node:path'

import {
  briefRange,
  docPath,
  fileExists,
  findRepoRoot,
  headings,
  listDocs,
  loadConfig,
  parseFrontmatter,
  readDoc,
  slugify,
  writeDoc,
} from './docs-lib.mjs'

const repoRoot = findRepoRoot()
const config = loadConfig(repoRoot)

const START = '<!-- routing:start -->'
const END = '<!-- routing:end -->'

/** Headings the router should never offer: the Brief itself, and pure narrative. */
const SKIP = new Set(['agent brief', 'overview', 'related systems'])

function resolveDoc(arg) {
  const name = basename(String(arg)).replace(/\.md$/, '') + '.md'
  const path = docPath(config, name)
  if (fileExists(path)) return { file: name, path }
  const known = listDocs(config)
  const near = known.filter((f) => f.includes(name.replace(/\.md$/, '')))
  throw new Error(
    'No doc "' + arg + '" in ' + config.docsDir + '.\n' +
      (near.length ? 'Did you mean: ' + near.join(', ') : 'Known docs: ' + known.slice(0, 20).join(', ')),
  )
}

/** Cue text an agent wrote previously, keyed by section slug, so it survives. */
function existingCues(lines, from, to) {
  const cues = new Map()
  for (let i = from; i < to; i++) {
    const m = /^\|\s*(.+?)\s*\|\s*\[(.+?)\]\(#([^)]+)\)\s*\|\s*$/.exec(lines[i])
    if (m) cues.set(m[3], m[1])
  }
  return cues
}

function buildTable(doc, cues) {
  const lines = doc.text.split(/\r?\n/)
  const all = headings(lines).filter((h) => h.level === 2 && !SKIP.has(h.text.toLowerCase()))

  const rows = all.map((h) => ({
    slug: h.slug,
    heading: h.text,
    cue: cues.get(h.slug) || h.text.toLowerCase(),
    isNew: !cues.has(h.slug),
  }))

  const table = [
    START,
    '',
    '| You are changing… | Section |',
    '| --- | --- |',
    ...rows.map((r) => '| ' + r.cue + ' | [' + r.heading + '](#' + r.slug + ') |'),
    '',
    END,
  ]
  return { table, rows }
}

function process1(file, { check }) {
  const doc = resolveDoc(file)
  const meta = readDoc(doc.path)
  doc.text = meta.text
  const lines = meta.text.split(/\r?\n/)

  const brief = briefRange(lines)
  if (!brief) {
    process.stdout.write(
      doc.file + ': no `## Agent Brief` section yet.\n' +
      '  Add one first (scope + invariants are hand-written — see the skill\'s doc-template),\n' +
      '  put ' + START + ' / ' + END + ' where the routing table belongs, then re-run.\n',
    )
    return 0
  }

  const startAt = lines.findIndex((l, i) => i >= brief.start && i < brief.end && l.trim() === START)
  const endAt = lines.findIndex((l, i) => i > startAt && i < brief.end && l.trim() === END)

  const cues = startAt !== -1 && endAt !== -1 ? existingCues(lines, startAt, endAt) : new Map()
  const built = buildTable(doc, cues)

  if (startAt === -1 || endAt === -1) {
    if (check) {
      process.stdout.write(doc.file + ': DRIFT — no routing markers in the Brief.\n')
      return 1
    }
    // Insert at the end of the Brief so hand-written scope/invariants stay on top.
    lines.splice(brief.end, 0, ...['', ...built.table])
  } else {
    const current = lines.slice(startAt, endAt + 1).join('\n')
    if (current === built.table.join('\n')) {
      process.stdout.write(doc.file + ': routing table already current (' + built.rows.length + ' sections).\n')
      return 0
    }
    if (check) {
      process.stdout.write(doc.file + ': DRIFT — routing table does not match the doc\'s headings.\n')
      return 1
    }
    lines.splice(startAt, endAt - startAt + 1, ...built.table)
  }

  writeDoc(doc.path, lines, meta)

  const fresh = built.rows.filter((r) => r.isNew)
  process.stdout.write(doc.file + ': routing table written, ' + built.rows.length + ' sections.\n')
  if (fresh.length > 0) {
    process.stdout.write(
      '  ' + fresh.length + ' new row(s) got a placeholder cue (the heading text). Rewrite each left cell\n' +
      '  as the TASK that lands there — "a column, index or FK on the three tables", not "Database Tables":\n',
    )
    for (const r of fresh) process.stdout.write('    · ' + r.heading + '\n')
  }
  return 0
}

function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const targets = argv.includes('--all') ? listDocs(config) : argv.filter((a) => !a.startsWith('-'))

  if (targets.length === 0) {
    process.stdout.write('Usage: node scripts/docs-brief.mjs <doc>|--all [--check]\n')
    return 0
  }

  let bad = 0
  for (const target of targets) {
    const doc = resolveDoc(target)
    const text = readDoc(doc.path).text
    if (!briefRange(text.split(/\r?\n/)) && argv.includes('--all')) continue // only docs that have a Brief
    bad += process1(target, { check })
  }
  return bad === 0 ? 0 : 1
}

try {
  process.exitCode = main()
} catch (err) {
  process.stderr.write(String(err.message || err) + '\n')
  process.exitCode = 1
}
