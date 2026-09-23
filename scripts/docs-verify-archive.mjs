#!/usr/bin/env node
// docs-systems v1.0.0 — proves an archive lost nothing.
//
// This is what turns "move 92 KB of change history out of the doc" from a scary
// irreversible edit into a routine one. It compares the working tree against the
// committed version and asserts the only invariant that matters:
//
//   every identifier that lived in the old stamp stack still exists in either
//   the doc (it was merged) or the history file (it was archived).
//
// 1,029 identifiers were verified this way across ten docs. Without it, nobody
// archives — they hoard, and the doc keeps growing.
//
// Run it AFTER merging and moving, BEFORE committing. Exits non-zero on loss.
//
// Usage:
//   node scripts/docs-verify-archive.mjs payments
//   node scripts/docs-verify-archive.mjs payments --against HEAD~3

import { basename, join } from 'node:path'

import {
  docPath,
  extractIdentifiers,
  fileExists,
  findRepoRoot,
  git,
  listDocs,
  loadConfig,
  readDoc,
  stampStack,
} from './docs-lib.mjs'

const repoRoot = findRepoRoot()
const config = loadConfig(repoRoot)

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

function main() {
  const argv = process.argv.slice(2)
  const againstAt = argv.indexOf('--against')
  const rev = againstAt !== -1 ? argv[againstAt + 1] : 'HEAD'
  const target = argv.find((a, i) => !a.startsWith('-') && !(againstAt !== -1 && i === againstAt + 1))
  if (!target) {
    process.stdout.write('Usage: node scripts/docs-verify-archive.mjs <doc> [--against <rev>]\n')
    return 0
  }

  const doc = resolveDoc(target)
  const relPath = config.docsDir.replace(/\/$/, '') + '/' + doc.file

  const committed = git(['show', rev + ':' + relPath], repoRoot)
  if (committed === null) {
    process.stderr.write(
      'Cannot read ' + relPath + ' at ' + rev + '.\n' +
      'This script compares against the committed version — it cannot verify an archive\n' +
      'of a doc that was never committed. Commit the pre-archive state first.\n',
    )
    return 1
  }

  const before = stampStack(committed)
  if (before.stackLineCount === 0) {
    process.stdout.write(doc.file + ': the committed version has no stamp stack — nothing was archived.\n')
    return 0
  }
  const wasInStack = extractIdentifiers(before.stack)

  // Everything the identifier could legitimately have moved into.
  const nowInDoc = extractIdentifiers(readDoc(doc.path).text)
  const historyCandidates = [
    join(repoRoot, config.systemsHistoryDir, doc.file),
    join(repoRoot, config.historyDir, doc.file),
  ]
  const nowInHistory = new Set()
  let historyFile = null
  for (const candidate of historyCandidates) {
    if (!fileExists(candidate)) continue
    historyFile = candidate
    for (const id of extractIdentifiers(readDoc(candidate).text)) nowInHistory.add(id)
    break
  }

  const lost = [...wasInStack].filter((id) => !nowInDoc.has(id) && !nowInHistory.has(id)).sort()
  const merged = [...wasInStack].filter((id) => nowInDoc.has(id)).length
  const archived = [...wasInStack].filter((id) => !nowInDoc.has(id) && nowInHistory.has(id)).length

  process.stdout.write(
    doc.file + ' vs ' + rev + '\n' +
    '  stamp stack held      ' + wasInStack.size + ' identifiers\n' +
    '  still in the doc      ' + merged + '  (merged, or already there)\n' +
    '  in the history file   ' + archived + (historyFile ? '  (' + historyFile.replace(repoRoot, '').replace(/^[\\/]/, '') + ')' : '  (no history file found)') + '\n' +
    '  LOST                  ' + lost.length + '\n\n',
  )

  if (lost.length === 0) {
    process.stdout.write('OK — nothing was lost. Safe to commit.\n')
    return 0
  }

  process.stdout.write('LOSS DETECTED. These identifiers existed before the archive and now exist nowhere:\n')
  for (const id of lost) process.stdout.write('  · ' + id + '\n')
  process.stdout.write(
    '\nDo not commit. Recover each one:\n' +
    '  git show ' + rev + ':' + relPath + ' | grep -n "<identifier>"\n' +
    'then either merge it into the section of the doc that covers it (if it describes\n' +
    'current behaviour) or append the stamp block that mentions it to the history file.\n',
  )
  return 1
}

try {
  process.exitCode = main()
} catch (err) {
  process.stderr.write(String(err.message || err) + '\n')
  process.exitCode = 1
}
