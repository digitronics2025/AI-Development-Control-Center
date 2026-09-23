#!/usr/bin/env node
// docs-systems v1.0.0 — targeted retrieval over the system docs.
//
// The point is token cost. A large system doc is 30k+ tokens; an agent that
// greps gets line noise, an agent that opens the file pays for all of it. This
// returns the two or three ~900-char sections that actually answer the question,
// with the exact `doc#section` anchor to open if it needs more.
//
// It SCANS AT QUERY TIME. No generated index, no prebuild step, no committed
// artifact to go stale — scanning a megabyte of markdown is milliseconds, and a
// committed index is one more thing that silently rots.
//
// It searches history too (--history). Archived content that cannot be found is
// why people hoard instead of archiving.
//
// Usage:
//   node scripts/docs-find.mjs "cheque friday cap"
//   node scripts/docs-find.mjs "recorded_at" --history
//   node scripts/docs-find.mjs --full payments
//   node scripts/docs-find.mjs --full payments#gotchas
//   node scripts/docs-find.mjs "bank balance" -n 5

import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { findRepoRoot, loadConfig, parseFrontmatter, readDoc, slugify } from './docs-lib.mjs'

const repoRoot = findRepoRoot()
const config = loadConfig(repoRoot)

const MAX_TEXT_CHARS = 900

const STOPWORDS = new Set([
  'how', 'do', 'does', 'the', 'to', 'of', 'is', 'are', 'what', 'where', 'when',
  'why', 'which', 'can', 'you', 'we', 'our', 'my', 'in', 'on', 'for', 'and',
  'with', 'work', 'works', 'find', 'show', 'me', 'it', 'this', 'that', 'about',
])

function normalize(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function cleanText(raw) {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s>*-]+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Windows a long section into sequential slices.
 *
 * There is deliberately NO window cap. An archived change log is one enormous
 * unheaded section; a per-section cap silently drops most of it, which would
 * make archiving genuinely lossy from the retrieval side — the exact fear that
 * stops people archiving at all.
 */
function windowText(text, max) {
  if (text.length <= max) return [text]
  const out = []
  let rest = text
  while (rest.length > 0) {
    if (rest.length <= max) {
      out.push(rest)
      break
    }
    const slice = rest.slice(0, max)
    const lastSpace = slice.lastIndexOf(' ')
    const end = lastSpace > max * 0.6 ? lastSpace : max
    out.push(rest.slice(0, end).trim())
    rest = rest.slice(end).trim()
  }
  return out
}

function chunkDoc(slug, content) {
  const fm = parseFrontmatter(content)
  const lines = content.split(/\r?\n/).slice(fm.bodyStart)
  let title = ''
  const sections = []
  let current = { heading: 'Overview', body: [] }

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line)
    const h2 = /^##\s+(.+)$/.exec(line)
    if (h1 && !title) {
      title = h1[1].trim()
      continue
    }
    if (h2) {
      if (current.body.join('\n').trim()) sections.push(current)
      current = { heading: h2[1].trim(), body: [] }
      continue
    }
    current.body.push(line)
  }
  if (current.body.join('\n').trim()) sections.push(current)

  const chunks = []
  for (const section of sections) {
    const clean = cleanText(section.body.join('\n'))
    if (clean.length < 24) continue
    for (const text of windowText(clean, MAX_TEXT_CHARS)) {
      if (text.length < 24) continue
      chunks.push({ doc: slug, title: title || slug, heading: section.heading, text })
    }
  }
  return chunks
}

function score(chunk, tokens, phrase) {
  const titleHay = normalize(chunk.title + ' ' + chunk.heading + ' ' + chunk.doc.replace(/-/g, ' '))
  const bodyHay = normalize(chunk.text)
  const all = titleHay + ' ' + bodyHay

  for (const token of tokens) {
    if (!all.includes(token)) return 0
  }

  let s = 0
  if (titleHay === phrase) s += 400
  else if (titleHay.startsWith(phrase)) s += 280
  else if (titleHay.includes(phrase)) s += 180

  for (const token of tokens) {
    if (titleHay.includes(token)) s += 30
    else s += 8
  }
  if (tokens.length >= 2) {
    if ((' ' + titleHay + ' ').includes(' ' + phrase + ' ')) s += 80
    else if ((' ' + bodyHay + ' ').includes(' ' + phrase + ' ')) s += 50
  }
  return s
}

function listMarkdown(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listMarkdown(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

/** A slug an agent can act on: `payments`, or `history/systems/payments`. */
function slugFor(path) {
  const rel = relative(repoRoot, path).split(sep).join('/')
  return rel.replace(/^docs\//, '').replace(/^systems\//, '').replace(/\.md$/, '')
}

function loadCorpus(includeHistory) {
  const files = listMarkdown(join(repoRoot, config.docsDir))
  if (includeHistory) files.push(...listMarkdown(join(repoRoot, config.historyDir)))

  const chunks = []
  const paths = new Map()
  for (const file of files) {
    const slug = slugFor(file)
    paths.set(slug, file)
    chunks.push(...chunkDoc(slug, readDoc(file).text))
  }
  return { chunks, paths }
}

function printHits(hits, query, includeHistory) {
  if (hits.length === 0) {
    process.stdout.write(
      'No section matched "' + query + '".\n' +
      'Every query word must appear in the section. Try fewer or broader words' +
      (includeHistory ? '.\n' : ', or add --history to search the archived change notes.\n'),
    )
    return
  }
  process.stdout.write(hits.length + ' section(s) for "' + query + '":\n')
  for (const hit of hits) {
    const anchor = hit.doc + '#' + slugify(hit.heading)
    process.stdout.write(
      '\n── ' + anchor + '  (' + hit.title + ' → ' + hit.heading + ', score ' + hit.score + ')\n' +
      '   open: docs-find --full ' + anchor + '\n\n' + hit.text + '\n',
    )
  }
}

function printFull(target, paths) {
  const parts = String(target).split('#')
  const docSlug = parts[0]
  const sectionSlug = parts[1]
  const path = paths.get(docSlug)
  if (!path) {
    const near = [...paths.keys()].filter((k) => k.includes(docSlug)).slice(0, 8)
    process.stderr.write(
      'No doc named "' + docSlug + '".\n' +
      (near.length ? 'Did you mean: ' + near.join(', ') + '\n' : 'Known docs: ' + [...paths.keys()].slice(0, 20).join(', ') + '…\n'),
    )
    return 1
  }
  const content = readDoc(path).text
  if (!sectionSlug) {
    const bytes = statSync(path).size
    if (bytes > config.byteBudget) {
      process.stderr.write(
        'warning: ' + docSlug + ' is ' + Math.round(bytes / 1000) + ' KB (~' + Math.round(bytes / 4000) + 'k tokens). ' +
        'Read its "Agent Brief" section or search a phrase instead.\n\n',
      )
    }
    process.stdout.write(content)
    return 0
  }

  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+/.test(l) && slugify(l.replace(/^##\s+/, '').trim()) === sectionSlug)
  if (start === -1) {
    const list = lines.filter((l) => /^##\s+/.test(l)).map((l) => slugify(l.replace(/^##\s+/, '').trim()))
    process.stderr.write('No "## ' + sectionSlug + '" in ' + docSlug + '.\nSections: ' + list.join(', ') + '\n')
    return 1
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l))
  if (end === -1) end = lines.length
  process.stdout.write(lines.slice(start, end).join('\n') + '\n')
  return 0
}

const USAGE = [
  'Usage:',
  '  node scripts/docs-find.mjs "<query>" [--history] [-n <count>]',
  '  node scripts/docs-find.mjs --full <doc>[#<section>]',
  '',
  'Searches the system docs section by section and prints the matching excerpts',
  'instead of the whole file.',
  '',
  '  --history     also search the archived change notes',
  '  -n <count>    sections to return (default 3)',
  '  --full        print a whole doc, or one ## section of it',
  '',
].join('\n')

function main() {
  const argv = process.argv.slice(2)
  const includeHistory = argv.includes('--history')
  const nAt = argv.findIndex((a) => a === '-n' || a === '--top')
  const topN = nAt !== -1 ? Math.max(1, Number.parseInt(argv[nAt + 1], 10) || 3) : 3
  const fullAt = argv.indexOf('--full')

  const positional = argv.filter((a, i) => {
    if (a.startsWith('-')) return false
    if (nAt !== -1 && i === nAt + 1) return false
    if (fullAt !== -1 && i === fullAt + 1) return false
    return true
  })

  if (argv.includes('--help') || argv.includes('-h') || (fullAt === -1 && positional.length === 0)) {
    process.stdout.write(USAGE)
    return 0
  }

  const corpus = loadCorpus(includeHistory || fullAt !== -1)

  if (fullAt !== -1) {
    const target = argv[fullAt + 1]
    if (!target) {
      process.stderr.write('--full needs a doc name, e.g. --full payments\n')
      return 1
    }
    return printFull(target, corpus.paths)
  }

  const query = positional.join(' ')
  const phrase = normalize(query)
  const allTokens = phrase.split(' ').filter((t) => t.length > 1)
  const content = allTokens.filter((t) => !STOPWORDS.has(t))
  const tokens = content.length > 0 ? content : allTokens

  const hits = corpus.chunks
    .map((chunk, index) => ({ chunk, index, score: score(chunk, tokens, phrase) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  // Diversify so one huge doc cannot monopolise every slot.
  const perDocCap = Math.max(1, Math.ceil(topN / 2))
  const picked = []
  const seen = new Map()
  for (const h of hits) {
    if (picked.length >= topN) break
    const n = seen.get(h.chunk.doc) || 0
    if (n >= perDocCap) continue
    picked.push({ ...h.chunk, score: h.score })
    seen.set(h.chunk.doc, n + 1)
  }
  for (const h of hits) {
    if (picked.length >= topN) break
    if (picked.some((p) => p.text === h.chunk.text)) continue
    picked.push({ ...h.chunk, score: h.score })
  }

  printHits(picked, query, includeHistory)
  return 0
}

try {
  process.exitCode = main()
} catch (err) {
  process.stderr.write('docs-find failed: ' + (err.stack || err) + '\n')
  process.exitCode = 1
}
