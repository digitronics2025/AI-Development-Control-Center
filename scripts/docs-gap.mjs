#!/usr/bin/env node
// docs-systems v1.0.0 — merge-before-archive gap finder.
//
// Blind archiving is lossy. In the repo this was built from, ~30% of the
// backticked identifiers inside the stacked changelogs described CURRENT
// behaviour and existed NOWHERE ELSE in the docs — moving the stack to history
// would have silently deleted them from the only place an agent looks.
//
// This script finds exactly that set. It extracts every identifier from the
// stamp stack, subtracts everything already present in the doc body, then
// subtracts everything present in any sibling doc. What is left is the list of
// facts that must be MERGED into a section before the stack can be moved.
//
// It measures. It does not decide: whether an identifier describes current
// behaviour or is just part of a story is the agent's call, and which existing
// section owns it is a judgement no script can make.
//
// Usage:
//   node scripts/docs-gap.mjs payments
//   node scripts/docs-gap.mjs docs/systems/payments.md
//   node scripts/docs-gap.mjs payments --json

import { basename } from 'node:path'

import {
  docPath,
  extractIdentifiers,
  fileExists,
  findRepoRoot,
  listDocs,
  loadConfig,
  parseFrontmatter,
  readDoc,
  stampStack,
} from './docs-lib.mjs'

const repoRoot = findRepoRoot()
const config = loadConfig(repoRoot)

/** Accept a bare name, a filename, or a full path — an agent should not have to guess. */
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

function stripFrontmatter(text) {
  const fm = parseFrontmatter(text)
  return text.split(/\r?\n/).slice(fm.bodyStart).join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const target = argv.find((a) => !a.startsWith('-'))
  if (!target) {
    process.stdout.write('Usage: node scripts/docs-gap.mjs <doc> [--json]\n')
    return 0
  }

  const doc = resolveDoc(target)
  const text = stripFrontmatter(readDoc(doc.path).text)
  const split = stampStack(text)

  if (split.stackLineCount === 0) {
    process.stdout.write(doc.file + ': no stamp stack — nothing to archive.\n')
    return 0
  }

  const inStack = extractIdentifiers(split.stack)
  const inBody = extractIdentifiers(split.body)

  const inSiblings = new Set()
  for (const file of listDocs(config)) {
    if (file === doc.file) continue
    for (const id of extractIdentifiers(readDoc(docPath(config, file)).text)) inSiblings.add(id)
  }

  const exclusive = [...inStack].filter((id) => !inBody.has(id) && !inSiblings.has(id)).sort()
  const covered = [...inStack].filter((id) => inBody.has(id)).length
  const elsewhere = [...inStack].filter((id) => !inBody.has(id) && inSiblings.has(id)).sort()

  if (asJson) {
    process.stdout.write(JSON.stringify({ doc: doc.file, stackLines: split.stackLineCount, total: inStack.size, covered, elsewhere, exclusive }, null, 2) + '\n')
    return 0
  }

  process.stdout.write(
    doc.file + ': stamp stack is ' + split.stackLineCount + ' lines, ' + inStack.size + ' identifiers.\n' +
    '  ' + covered + ' already in the doc body        — safe to archive as-is\n' +
    '  ' + elsewhere.length + ' documented in a sibling doc     — safe, but check the sibling is the right owner\n' +
    '  ' + exclusive.length + ' EXCLUSIVE to the stack          — these are the ones to merge before archiving\n\n',
  )

  if (elsewhere.length > 0) {
    process.stdout.write('Documented elsewhere (verify the sibling really owns it):\n')
    for (const id of elsewhere) process.stdout.write('  · ' + id + '\n')
    process.stdout.write('\n')
  }

  if (exclusive.length === 0) {
    process.stdout.write('Nothing exclusive. The stack can be archived without merging first.\n')
    return 0
  }

  process.stdout.write('MERGE THESE FIRST — each one exists only in the stack:\n')
  for (const id of exclusive) {
    process.stdout.write('  · ' + id + '\n')
  }
  process.stdout.write(
    '\nFor each: read its surrounding sentence in the stack, decide whether it\n' +
    'describes how the system works NOW (merge it) or is only the story of a past\n' +
    'change (let it go to history), and merge into the section that ALREADY covers\n' +
    'that area — never as a new dated block.\n' +
    'Then archive, then prove nothing was lost:\n' +
    '  node ' + config.scriptsDir + '/docs-verify-archive.mjs ' + doc.file + '\n',
  )
  return 0
}

try {
  process.exitCode = main()
} catch (err) {
  process.stderr.write(String(err.message || err) + '\n')
  process.exitCode = 1
}
