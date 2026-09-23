// docs-systems v1.0.0 — shared primitives for the vendored docs scripts.
// Vendored file. Do not hand-edit: re-vendor with `/docs-systems adopt`.
//
// Everything here is mechanical: parsing, measuring, path matching, writing
// files without mangling their line endings. Judgement lives in the agent.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'

export const VERSION = '1.0.0'

// ---------------------------------------------------------------------------
// Repo + config
// ---------------------------------------------------------------------------

export function findRepoRoot(from = process.cwd()) {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return resolve(from)
    dir = up
  }
}

const CONFIG_DEFAULTS = {
  docsDir: 'docs/systems',
  historyDir: 'docs/history',
  systemsHistoryDir: 'docs/history/systems',
  scriptsDir: 'scripts',
  followUps: 'docs/follow-ups.md',
  /** ~40 KB is ~10k tokens — where reading a doc whole stops being affordable. */
  byteBudget: 40000,
  /** The Brief is capped in LINES, separately from the body's BYTES. One combined
   *  budget just lets growth hide in whichever half has slack. */
  briefLineCap: 80,
  instructionFile: 'CLAUDE.md',
  instructionByteCap: 100000,
  /** How far back `stale` walks the log looking for each doc's verified_at. */
  historyWindow: 1000,
}

export function loadConfig(repoRoot) {
  const path = join(repoRoot, '.docs-systems.json')
  if (!existsSync(path)) return { ...CONFIG_DEFAULTS, repoRoot }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { ...CONFIG_DEFAULTS, ...parsed, repoRoot }
  } catch (err) {
    throw new Error('.docs-systems.json is not valid JSON: ' + err.message)
  }
}

export function isStrict(repoRoot) {
  return existsSync(join(repoRoot, '.docs-systems-strict'))
}

// ---------------------------------------------------------------------------
// Reading and writing without mangling line endings
// ---------------------------------------------------------------------------

/**
 * Repos are routinely mixed LF/CRLF with no `.gitattributes`. Rewriting a CRLF
 * file with LF (or the reverse) turns a 3-line diff into a whole-file diff and
 * buries the actual change. Every write goes through `writeDoc`, which restores
 * whatever the file already used.
 */
export function readDoc(path) {
  const raw = readFileSync(path, 'utf8')
  const bom = raw.charCodeAt(0) === 0xfeff
  const text = bom ? raw.slice(1) : raw

  // DOMINANT ending, not "any CRLF present". A mostly-LF file containing one
  // stray CRLF — a pasted snippet, a half-applied editor conversion — would
  // otherwise be rewritten entirely as CRLF, which is the whole-file-diff bug
  // this function exists to prevent.
  let lf = 0
  let crlf = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    lf++
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++
  }

  return {
    text,
    eol: crlf * 2 > lf ? '\r\n' : '\n',
    bom,
    trailingNewline: /\n$/.test(text),
    mixed: crlf > 0 && crlf < lf,
  }
}

export function writeDoc(path, lines, meta) {
  let out = lines.join(meta.eol)
  if (meta.trailingNewline && !out.endsWith(meta.eol)) out += meta.eol
  writeFileSync(path, (meta.bom ? '﻿' : '') + out, 'utf8')
}

/** Read only the head of a file — enough for frontmatter, fast enough for a hook. */
export function readHead(path, bytes = 2048) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.slice(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Frontmatter — the per-doc source of truth
// ---------------------------------------------------------------------------

/**
 * Minimal YAML: `key: scalar` and `key:` followed by `  - item` lists. That is
 * the entire schema, deliberately. A real YAML parser would be a dependency,
 * and this file must stay zero-dependency so it can be vendored anywhere.
 */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0] === undefined || lines[0].trim() !== '---') return { data: null, bodyStart: 0, endLine: -1 }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end === -1) return { data: null, bodyStart: 0, endLine: -1 }

  const data = {}
  let listKey = null
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && listKey) {
      data[listKey].push(unquote(item[1].trim()))
      continue
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const value = kv[2].trim()
    if (value === '') {
      listKey = key
      data[key] = []
    } else {
      listKey = null
      data[key] = coerce(unquote(value))
    }
  }
  return { data, bodyStart: end + 1, endLine: end }
}

function unquote(value) {
  const m = /^(['"])(.*)\1$/.exec(value)
  return m ? m[2] : value
}

function coerce(value) {
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

/** Rewrite one scalar key inside an existing frontmatter block, in place. */
export function setFrontmatterScalar(lines, endLine, key, value) {
  const at = lines.findIndex((l, i) => i > 0 && i < endLine && l.startsWith(key + ':'))
  if (at === -1) {
    lines.splice(endLine, 0, key + ': ' + value)
    return lines
  }
  lines[at] = key + ': ' + value
  return lines
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

export function listDocs(config) {
  const dir = join(config.repoRoot, config.docsDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
}

export function docPath(config, file) {
  return join(config.repoRoot, config.docsDir, file)
}

/**
 * A doc carries exactly ONE of these, at the top.
 *
 * The date is required. Prose *about* the stamp rule (this convention's own
 * README explains it) says "Last verified:" without being a stamp, and a looser
 * pattern counted those as violations.
 */
export const STAMP_LINE = /Last verified:?\*{0,2}\s*\d{4}-\d{2}-\d{2}/

export function countStamps(text) {
  return text.split(/\r?\n/).filter((l) => STAMP_LINE.test(l)).length
}

export function briefRange(lines) {
  const start = lines.findIndex((l) => /^##\s+Agent Brief\s*$/.test(l))
  if (start === -1) return null
  const after = lines.findIndex((l, i) => i > start && /^##\s+/.test(l))
  return { start, end: after === -1 ? lines.length : after }
}

/**
 * Doc size EXCLUDING frontmatter and the Agent Brief.
 *
 * The byte ratchet exists to stop the body drifting upward. A Brief is the
 * opposite of drift — it is what makes a large doc usable — so charging it to
 * the same budget would either block Briefs on the docs that need them most, or
 * force the allowances up and hollow out the ratchet.
 */
export function bodyBytes(text) {
  const fm = parseFrontmatter(text)
  const lines = text.split(/\r?\n/).slice(fm.bodyStart)
  const brief = briefRange(lines)
  const kept = brief ? lines.slice(0, brief.start).concat(lines.slice(brief.end)) : lines
  return Buffer.byteLength(kept.join('\n'), 'utf8')
}

/** GitHub heading-anchor slug. */
export function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

export function headings(lines) {
  const out = []
  let fenced = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced
    if (fenced) continue
    const m = /^(#{2,6})\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2], slug: slugify(m[2]) })
  }
  return out
}

export function fmt(bytes) {
  return Math.round(bytes / 1000) + ' KB / ~' + Math.round(bytes / 4000) + 'k tokens'
}

/** The number a ratchet should be lowered to: current size plus 5%, rounded up. */
export function ratchetTarget(bytes) {
  return Math.ceil((bytes * 1.05) / 1000) * 1000
}

// ---------------------------------------------------------------------------
// Glob matching — path strings only. Never parse code; the hook has a budget.
// ---------------------------------------------------------------------------

export function globToRegExp(pattern) {
  let p = pattern.trim()
  const negated = p.startsWith('!')
  if (negated) p = p.slice(1)
  // A bare directory means everything under it.
  if (!/[*?]/.test(p) && !/\.[A-Za-z0-9]+$/.test(p)) p = p.replace(/\/$/, '') + '/**'

  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++
        if (p[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.indexOf(c) !== -1) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return { re: new RegExp('^' + re + '$'), negated }
}

export function matchesAny(path, patterns) {
  const norm = path.split(sep).join('/')
  let hit = false
  for (const pattern of patterns) {
    const compiled = globToRegExp(pattern)
    if (compiled.re.test(norm)) hit = !compiled.negated
  }
  return hit
}

// ---------------------------------------------------------------------------
// Identifiers — the unit `docs-gap` and `docs-verify-archive` count.
// ---------------------------------------------------------------------------

const METHOD_PATH = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+$/

/**
 * Backticked tokens that name something real: a symbol, a column, a path, a
 * route, an error code, an env var. Prose in backticks is discarded — a phrase
 * with spaces is not an identifier unless it is `METHOD /path`.
 */
export function extractIdentifiers(text) {
  const found = new Set()
  const re = /`([^`\n]{2,120})`/g
  let m
  while ((m = re.exec(text)) !== null) {
    const token = m[1].trim().replace(/\(\s*\)$/, '').replace(/[.,;:]+$/, '')
    if (token.length < 3 || token.length > 80) continue
    if (!/[A-Za-z]/.test(token)) continue
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) continue

    if (!/\s/.test(token) || METHOD_PATH.test(token)) {
      found.add(token)
      continue
    }
    // A backticked PHRASE is not an identifier, but it usually CONTAINS one —
    // `DELETE FROM payment_allocations` names a table that must not be lost.
    // Reach in for the parts that look like symbols and ignore the English.
    for (const part of token.split(/[\s,()]+/)) {
      const clean = part.replace(/[.,;:]+$/, '')
      if (clean.length < 4) continue
      if (!/_|\/|\.|[a-z][A-Z]/.test(clean)) continue
      if (!/[A-Za-z]/.test(clean)) continue
      found.add(clean)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// The stamp stack — the thing `archive` collapses.
// ---------------------------------------------------------------------------

function markBlockquote(lines, start, picked) {
  let j = start
  while (j < lines.length) {
    if (/^\s*>/.test(lines[j])) {
      picked[j] = true
      j++
      continue
    }
    if (lines[j].trim() === '' && /^\s*>/.test(lines[j + 1] || '')) {
      picked[j] = true
      j++
      continue
    }
    break
  }
  return j
}

/**
 * Everything AFTER the first `Last verified:` stamp that is itself a stamped
 * change note. Two shapes occur in the wild:
 *   1. stacked blockquotes — runs of `> Last verified: 2026-07-27 (…)`
 *   2. dated sections      — `### 2026-08-21 — Feature X`
 */
export function stampStack(text) {
  const lines = text.split(/\r?\n/)
  const picked = new Array(lines.length).fill(false)
  let seenFirst = false

  for (let i = 0; i < lines.length; i++) {
    if (!STAMP_LINE.test(lines[i])) continue
    if (!seenFirst) {
      seenFirst = true
      // The FIRST stamp stays in the doc. Advance past its whole blockquote so a
      // multi-line first stamp is not mistaken for the start of the stack.
      if (/^\s*>/.test(lines[i])) i = markBlockquote(lines, i, new Array(lines.length).fill(false)) - 1
      continue
    }
    if (/^\s*>/.test(lines[i])) {
      i = markBlockquote(lines, i, picked) - 1
    } else {
      picked[i] = true
    }
  }

  // Dated `### 2026-08-21 …` sections are the other shape of the same reflex.
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{2,6})\s+.*\d{4}-\d{2}-\d{2}/.exec(lines[i])
    if (!m) continue
    const level = m[1].length
    let j = i
    for (; j < lines.length; j++) {
      const h = /^(#{2,6})\s+/.exec(lines[j])
      if (h && j > i && h[1].length <= level) break
      picked[j] = true
    }
    i = j - 1
  }

  const stack = lines.filter((_, i) => picked[i])
  const body = lines.filter((_, i) => !picked[i])
  return { stack: stack.join('\n'), body: body.join('\n'), stackLineCount: stack.length }
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

export function headSha(repoRoot) {
  const out = git(['rev-parse', '--short=8', 'HEAD'], repoRoot)
  return out ? out.trim() : null
}

/**
 * One `git log` spawn for the whole repo, not one per doc. Sixty spawns is a
 * second and a half; this is a few milliseconds — and staleness is a WARNING,
 * so it must never be the reason a check feels slow enough to skip.
 */
export function commitWindow(repoRoot, limit) {
  const raw = git(['log', '--format=%x00%H', '--name-only', '-n', String(limit), 'HEAD'], repoRoot)
  if (!raw) return []
  return raw
    .split('\0')
    .slice(1)
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.length > 0)
      return { sha: lines[0], files: lines.slice(1) }
    })
    .filter((entry) => entry.sha)
}

export function stagedFiles(repoRoot) {
  const raw = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], repoRoot)
  if (!raw) return []
  return raw.split('\n').map((l) => l.trim()).filter(Boolean)
}

export function fileExists(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
