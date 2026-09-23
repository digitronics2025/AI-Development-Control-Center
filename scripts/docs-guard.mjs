#!/usr/bin/env node
// docs-systems v1.0.0 — the guard. Vendored file; re-vendor with `/docs-systems adopt`.
//
// Per-system docs do not fail by being absent. They fail by ACCRETION: every
// agent that touches a subsystem appends a dated note, nobody deletes, and after
// a year most of the file is change history that every agent pays for and nobody
// reads. In the repo this was built from that produced a 2.1 MB instruction file
// and a 216 KB system doc whose first 92 KB were stacked verification stamps —
// the first thing an agent read, before a single useful fact.
//
// So this is not a linter. It is the immune system:
//
//   budgets      a doc over ~40 KB is too expensive to read whole
//   ratchet      shrink a doc and the guard DEMANDS you lower its allowance
//   one stamp    a second `Last verified:` is the append reflex, caught in the act
//   brief        an over-budget doc must open with a bounded summary
//   anchors      every Brief link must resolve, or the routing table is a lie
//   staleness    code moved and the doc did not — WARNS, never fails
//
// Staleness warns on purpose. A check that fails on staleness blocks unrelated
// work and trains people to bypass the whole guard.
//
// Usage:
//   node scripts/docs-guard.mjs            # full check (exit 1 on failure)
//   node scripts/docs-guard.mjs stale      # staleness report only
//   node scripts/docs-guard.mjs ratchet --write   # lower slack allowances
//   node scripts/docs-guard.mjs hook       # pre-commit path matching
//   node scripts/docs-guard.mjs --version

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  VERSION,
  bodyBytes,
  briefRange,
  commitWindow,
  countStamps,
  docPath,
  findRepoRoot,
  fmt,
  headSha,
  headings,
  isStrict,
  listDocs,
  loadConfig,
  matchesAny,
  parseFrontmatter,
  ratchetTarget,
  readDoc,
  readHead,
  setFrontmatterScalar,
  stagedFiles,
  writeDoc,
} from './docs-lib.mjs'

const repoRoot = findRepoRoot()
const config = loadConfig(repoRoot)

const failures = []
const warnings = []

function fail(scope, problem, fix) {
  failures.push({ scope, problem, fix })
}
function warn(scope, problem, fix) {
  warnings.push({ scope, problem, fix })
}

// ---------------------------------------------------------------------------
// 1. Frontmatter is present and well-formed
// ---------------------------------------------------------------------------

function loadDocs() {
  const docs = []
  for (const file of listDocs(config)) {
    const path = docPath(config, file)
    const { text } = readDoc(path)
    const fm = parseFrontmatter(text)
    docs.push({ file, path, text, fm: fm.data, fmEnd: fm.endLine })
  }
  return docs
}

function checkFrontmatter(docs) {
  const missing = docs.filter((d) => !d.fm)

  // An unadopted repo would otherwise emit one identical failure per doc and
  // bury every real finding underneath it. One line, one fix.
  if (missing.length > 3) {
    fail(
      config.docsDir,
      missing.length + ' of ' + docs.length + ' docs have no YAML frontmatter block',
      'This repo has the docs but not the guard state. Run `/docs-systems adopt` — it backfills system / sources / verified_at / byte_allowance for every doc from what is already on disk, and changes no prose.',
    )
    return false
  }

  for (const doc of docs) {
    if (!doc.fm) {
      fail(
        doc.file,
        'has no YAML frontmatter block',
        'Add one: system / sources / verified_at / byte_allowance. Run `/docs-systems adopt` to backfill every doc at once.',
      )
      continue
    }
    const stem = doc.file.replace(/\.md$/, '')
    if (doc.fm.system !== stem) {
      fail(
        doc.file,
        'frontmatter `system: ' + doc.fm.system + '` does not match the filename',
        'Set `system: ' + stem + '`. The two are how the hook maps a staged path back to a doc.',
      )
    }
    if (!Array.isArray(doc.fm.sources) || doc.fm.sources.length === 0) {
      fail(
        doc.file,
        'declares no `sources:` globs',
        'List the code paths this doc describes (e.g. `src/payments/**`). Without them nothing can tell you the doc went stale, and the pre-commit hook is blind to this subsystem.',
      )
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// 2. Budgets — bytes, not lines. Prose lines are long; a 500-line doc measured 216 KB.
// ---------------------------------------------------------------------------

function checkBudgets(docs) {
  for (const doc of docs) {
    const bytes = bodyBytes(doc.text)
    const allowance = doc.fm && typeof doc.fm.byte_allowance === 'number' ? doc.fm.byte_allowance : null
    const limit = allowance === null ? config.byteBudget : allowance

    if (bytes > limit) {
      fail(
        doc.file,
        'body is ' + fmt(bytes) + ', over its ' + (allowance === null ? 'budget' : 'ratchet allowance') + ' of ' + fmt(limit),
        allowance === null
          ? 'Merge your change into the section that already covers it, or split the doc into a map + children (`/docs-systems split ' + doc.file + '`). Do not add a byte_allowance to make this pass.'
          : 'You may NOT raise byte_allowance. Merge or split: `/docs-systems split ' + doc.file + '`.',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The self-tightening ratchet
//
// Not "don't exceed X" but "you shrank the doc, so lower X, and here is the
// number." This is the single most valuable check in the file: it caught its own
// slack three times in one session without anyone looking for it.
// ---------------------------------------------------------------------------

function checkRatchet(docs, { write = false } = {}) {
  const edits = []
  for (const doc of docs) {
    if (!doc.fm || typeof doc.fm.byte_allowance !== 'number') continue
    const bytes = bodyBytes(doc.text)
    const allowance = doc.fm.byte_allowance

    if (bytes <= config.byteBudget) {
      edits.push({ doc, action: 'remove' })
      fail(
        doc.file,
        'is now ' + fmt(bytes) + ', under the ' + fmt(config.byteBudget) + ' budget, but still carries byte_allowance: ' + allowance,
        'Delete the `byte_allowance:` line so the normal budget applies. Run `node ' + config.scriptsDir + '/docs-guard.mjs ratchet --write` to do it.',
      )
    } else if (bytes < allowance * 0.85) {
      const target = ratchetTarget(bytes)
      edits.push({ doc, action: 'lower', target })
      fail(
        doc.file,
        'shrank to ' + fmt(bytes) + ' but its allowance is still ' + fmt(allowance),
        'Set `byte_allowance: ' + target + '` — a ratchet only ratchets if you tighten it after each win. Run `node ' + config.scriptsDir + '/docs-guard.mjs ratchet --write` to do it.',
      )
    }
  }

  if (write && edits.length > 0) {
    for (const edit of edits) {
      const meta = readDoc(edit.doc.path)
      const lines = meta.text.split(/\r?\n/)
      if (edit.action === 'remove') {
        const at = lines.findIndex((l, i) => i > 0 && i < edit.doc.fmEnd && l.startsWith('byte_allowance:'))
        if (at !== -1) lines.splice(at, 1)
      } else {
        setFrontmatterScalar(lines, edit.doc.fmEnd, 'byte_allowance', String(edit.target))
      }
      writeDoc(edit.doc.path, lines, meta)
    }
    process.stdout.write('ratchet: tightened ' + edits.length + ' allowance(s).\n')
  }
  return edits.length
}

// ---------------------------------------------------------------------------
// 4. The instruction file (CLAUDE.md / AGENTS.md) stays cheap to inject
// ---------------------------------------------------------------------------

function checkInstructionFile() {
  const path = join(repoRoot, config.instructionFile)
  if (!existsSync(path)) return
  const bytes = statSync(path).size
  const cap = config.instructionByteCap

  if (bytes > cap) {
    fail(
      config.instructionFile,
      'is ' + fmt(bytes) + ', over the ' + fmt(cap) + ' cap',
      'It is injected into EVERY session, so this cost is paid on every task. Move the detail into the matching ' + config.docsDir + '/<system>.md (merged into the section that already covers it) and leave a one-line pointer. Change stories go to ' + config.historyDir + '/.',
    )
  } else if (bytes > config.byteBudget && bytes < cap * 0.85) {
    // Only ratchet a cap that is actually doing work. On a small instruction
    // file the cap is irrelevant and this would just be noise on every repo.
    fail(
      config.instructionFile,
      'shrank to ' + fmt(bytes) + ' but instructionByteCap is still ' + fmt(cap),
      'Lower it to ' + ratchetTarget(bytes) + ' in .docs-systems.json — a cap with that much headroom lets the file grow back without failing anything.',
    )
  }

  const stamps = countStamps(readFileSync(path, 'utf8'))
  if (stamps > 1) {
    fail(
      config.instructionFile,
      'carries ' + stamps + ' `Last verified:` stamps — a changelog has grown inside it',
      'Those are change stories: append them to ' + config.historyDir + '/YYYY-MM.md, and merge whatever they teach about CURRENT behaviour into ' + config.docsDir + '/.',
    )
  }
}

// ---------------------------------------------------------------------------
// 5. Exactly one stamp per doc — the append reflex, caught in the act
// ---------------------------------------------------------------------------

function checkStamps(docs) {
  for (const doc of docs) {
    const stamps = countStamps(doc.text)
    if (stamps === 0) {
      fail(doc.file, 'has no `Last verified:` stamp', 'Add one line under the title: `> Last verified: YYYY-MM-DD`.')
    } else if (stamps > 1) {
      fail(
        doc.file,
        'has ' + stamps + ' `Last verified:` stamps',
        'A doc has ONE stamp, at the top, and you bump it. Extra stamps mean a change was appended as its own dated block instead of merged. Collapse them: `/docs-systems archive ' + doc.file + '`.',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Agent Brief — present when needed, first, bounded, and its anchors resolve
// ---------------------------------------------------------------------------

function checkBrief(docs) {
  for (const doc of docs) {
    const lines = doc.text.split(/\r?\n/)
    const brief = briefRange(lines)
    const bytes = bodyBytes(doc.text)
    const overBudget = bytes > config.byteBudget

    if (!brief) {
      if (overBudget) {
        fail(
          doc.file,
          'is ' + fmt(bytes) + ' (over budget) but has no `## Agent Brief`',
          'A doc too expensive to read whole must open with a brief an agent can read instead: `/docs-systems brief ' + doc.file + '`.',
        )
      }
      continue
    }

    const firstSection = lines.findIndex((l) => /^##\s+/.test(l))
    if (firstSection !== brief.start) {
      fail(
        doc.file,
        '`## Agent Brief` is not the first ## section (found "' + (lines[firstSection] || '').trim() + '" above it)',
        'Move the Brief to the top. It is what an agent reads before deciding whether it needs the rest.',
      )
    }

    const briefLines = brief.end - brief.start
    if (briefLines > config.briefLineCap) {
      fail(
        doc.file,
        'the Agent Brief is ' + briefLines + ' lines, over the ' + config.briefLineCap + '-line cap',
        'A brief that needs scrolling is a second copy of the doc. Cut the narrative; keep scope, invariants, and the routing table.',
      )
    }

    // Anchors. A routing table that points at a heading which no longer exists
    // sends the agent to the wrong section — worse than having no table.
    const slugs = new Set(headings(lines).map((h) => h.slug))
    const briefText = lines.slice(brief.start, brief.end).join('\n')
    const anchorRe = /\]\(#([^)]+)\)/g
    let m
    while ((m = anchorRe.exec(briefText)) !== null) {
      if (!slugs.has(m[1])) {
        fail(
          doc.file,
          'the Agent Brief links to #' + m[1] + ', which is not a heading in this doc',
          'Regenerate the routing table: `node ' + config.scriptsDir + '/docs-brief.mjs ' + doc.file + '`. Hand-written links must be fixed by hand.',
        )
      }
    }

    // The routing table is generated. Markers missing means it is hand-maintained,
    // which means it WILL drift.
    if (overBudget && !/<!--\s*routing:start\s*-->/.test(briefText)) {
      warn(
        doc.file,
        'the Agent Brief has no generated routing table',
        'Run `node ' + config.scriptsDir + '/docs-brief.mjs ' + doc.file + '` — a hand-maintained table drifts; a generated one cannot.',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Staleness — measured against code, not against a self-reported date
// ---------------------------------------------------------------------------

function checkStale(docs, { quiet = false } = {}) {
  const window = commitWindow(repoRoot, config.historyWindow)
  if (window.length === 0) {
    if (!quiet) process.stdout.write('stale: no git history available; skipping.\n')
    return []
  }
  const results = []

  for (const doc of docs) {
    if (!doc.fm || !Array.isArray(doc.fm.sources) || doc.fm.sources.length === 0) continue
    const sha = doc.fm.verified_at ? String(doc.fm.verified_at) : null
    if (!sha) {
      warn(doc.file, 'has no `verified_at:` SHA', 'Set it to the current HEAD when you next verify the doc against the code.')
      continue
    }

    const idx = window.findIndex((entry) => entry.sha.startsWith(sha))
    if (idx === -1) {
      const count = window.filter((entry) => entry.files.some((f) => matchesAny(f, doc.fm.sources))).length
      // An old SHA with nothing touching its sources is not stale, just old.
      // Warning about it would be noise on every long-lived quiet subsystem.
      if (count === 0) continue
      results.push({ file: doc.file, count, beyondWindow: true })
      warn(
        doc.file,
        'verified_at ' + sha + ' is older than the last ' + config.historyWindow + ' commits; at least ' + count + ' since touched its sources',
        'Re-read the code against the doc, merge what changed, and bump `verified_at` to ' + (headSha(repoRoot) || 'HEAD') + '.',
      )
      continue
    }

    const touched = window.slice(0, idx).filter((entry) => entry.files.some((f) => matchesAny(f, doc.fm.sources)))
    if (touched.length > 0) {
      results.push({ file: doc.file, count: touched.length, beyondWindow: false })
      warn(
        doc.file,
        touched.length + ' commit(s) have touched its sources since ' + sha,
        'Re-read those paths against the doc, merge what changed into the section that covers it, and bump `verified_at` to ' + (headSha(repoRoot) || 'HEAD') + '.',
      )
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// 8. The hook — write-time enforcement
//
// Budget: under 200 ms, or it gets deleted. So: pure path matching against
// frontmatter read from the first 2 KB of each doc. It never parses code, never
// reads a doc body, and never runs a test.
// ---------------------------------------------------------------------------

function runHook() {
  const staged = stagedFiles(repoRoot)
  if (staged.length === 0) process.exit(0)

  const docsPrefix = config.docsDir.replace(/\/$/, '') + '/'
  const stagedDocs = new Set(staged.filter((p) => p.startsWith(docsPrefix)).map((p) => p.slice(docsPrefix.length)))
  const stagedCode = staged.filter((p) => !p.startsWith(docsPrefix) && !p.startsWith(config.historyDir.replace(/\/$/, '') + '/'))

  // Silent on doc-only commits.
  if (stagedCode.length === 0) process.exit(0)

  const misses = []
  for (const file of listDocs(config)) {
    if (stagedDocs.has(file)) continue // the doc IS in this commit
    const fm = parseFrontmatter(readHead(docPath(config, file))).data
    if (!fm || !Array.isArray(fm.sources) || fm.sources.length === 0) continue
    const hits = stagedCode.filter((p) => matchesAny(p, fm.sources))
    if (hits.length > 0) misses.push({ file, hits })
  }

  if (misses.length === 0) process.exit(0)

  const strict = isStrict(repoRoot)
  const label = strict ? 'docs-systems: BLOCKED' : 'docs-systems: heads up'
  process.stderr.write('\n' + label + '\n')
  for (const miss of misses) {
    const shown = miss.hits.slice(0, 3).join(', ')
    const more = miss.hits.length > 3 ? ' (+' + (miss.hits.length - 3) + ' more)' : ''
    process.stderr.write(
      '  ' + config.docsDir + '/' + miss.file + ' describes code you changed: ' + shown + more + '\n' +
      '    fix: merge the change into the section of that doc which already covers it, bump its `Last verified:` date, and stage it.\n',
    )
  }
  if (strict) {
    process.stderr.write('\n  .docs-systems-strict is present, so this blocks. Remove the file to downgrade to a warning.\n\n')
    process.exit(1)
  }
  process.stderr.write('\n  (warning only — delete .docs-systems-strict to keep it that way, create it to make this blocking)\n\n')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(docCount) {
  process.stdout.write('docs-systems guard v' + VERSION + ' — ' + docCount + ' docs in ' + config.docsDir + '\n\n')

  for (const f of failures) {
    process.stdout.write('FAIL  ' + f.scope + '\n        ' + f.problem + '\n        → ' + f.fix + '\n\n')
  }
  for (const w of warnings) {
    process.stdout.write('WARN  ' + w.scope + '\n        ' + w.problem + '\n        → ' + w.fix + '\n\n')
  }

  const summary = failures.length + ' failure(s), ' + warnings.length + ' warning(s)'
  const verdict =
    failures.length > 0
      ? ''
      : warnings.length > 0
        ? '  — nothing blocking. Warnings are docs drifting from the code; clear them when you next touch that area.\n'
        : '  — docs are healthy.\n'
  process.stdout.write(summary + (verdict || '\n'))
  return failures.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)

  if (argv.includes('--version') || argv[0] === 'version') {
    process.stdout.write(VERSION + '\n')
    return 0
  }
  if (argv[0] === 'hook') {
    runHook()
    return 0
  }

  if (!existsSync(join(repoRoot, config.docsDir))) {
    process.stdout.write(
      'docs-systems: no ' + config.docsDir + ' in this repo.\n' +
      'Run `/docs-systems adopt` to set the convention up.\n',
    )
    return 0
  }

  const docs = loadDocs()

  if (argv[0] === 'stale') {
    checkStale(docs)
    return report(docs.length)
  }
  if (argv[0] === 'ratchet') {
    checkRatchet(docs, { write: argv.includes('--write') })
    return report(docs.length)
  }

  const adopted = checkFrontmatter(docs)
  checkBudgets(docs)
  checkRatchet(docs)
  checkStamps(docs)
  checkBrief(docs)
  checkInstructionFile()
  // Staleness needs `sources` globs. On an unadopted repo it would emit one
  // "no verified_at" warning per doc on top of the adopt failure — pure noise.
  if (adopted && !argv.includes('--no-stale')) checkStale(docs, { quiet: true })

  return report(docs.length)
}

process.exitCode = main()
