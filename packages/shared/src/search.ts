/**
 * Forgiving text search shared by the command palette and list filters.
 *
 * Every word of the query must match some word of the text, in any order.
 * A word matches, best first, as the start of a word, anywhere inside the
 * text, or within a small typo budget ("clac" finds "calc"). Words shorter
 * than four letters get no typo budget: at that length almost everything is
 * one edit from something.
 */

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

const PREFIX = 3;
const SUBSTRING = 2;
const TYPO = 1;
/** Bonus when the whole query appears as typed, so exact phrases rank above scattered words. */
const PHRASE = 2;

function words(text: string): string[] {
  return text.toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

/** Typos a query word of this length may carry. */
function typoBudget(length: number): number {
  if (length < 4) return 0;
  return length < 8 ? 1 : 2;
}

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps, capped at `max + 1`. */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prevPrev[j - 2]! + 1);
      row.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length]!;
}

function wordScore(token: string, text: string, textWords: string[]): number {
  if (textWords.some((w) => w.startsWith(token))) return PREFIX;
  if (text.includes(token)) return SUBSTRING;
  const budget = typoBudget(token.length);
  if (budget === 0) return 0;
  // Compare against the whole word and against its start, so a typo in a partial word ("calcul" → "calculator") still counts.
  const near = textWords.some((w) => editDistance(token, w, budget) <= budget || (w.length > token.length && editDistance(token, w.slice(0, token.length), budget) <= budget));
  return near ? TYPO : 0;
}

/**
 * How well `query` matches `text`: null when it does not, otherwise a score
 * where higher is better. An empty query matches everything with score 0.
 */
export function searchScore(query: string, text: string): number | null {
  const tokens = words(query);
  if (tokens.length === 0) return 0;
  const haystack = text.toLowerCase();
  const textWords = words(text);
  let total = 0;
  for (const token of tokens) {
    const score = wordScore(token, haystack, textWords);
    if (score === 0) return null;
    total += score;
  }
  const phrase = query.trim().toLowerCase();
  return phrase && haystack.includes(phrase) ? total + PHRASE : total;
}

/** True when every word of `query` matches `text` (see {@link searchScore}). */
export function searchMatches(query: string, text: string): boolean {
  return searchScore(query, text) !== null;
}

/** What a repository is found by: its display name and its folder's name (not the whole path, whose shared parent folders would match every row). */
export function repositorySearchText(repo: { name: string; path: string }): string {
  const folder = repo.path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return folder && folder !== repo.name ? `${repo.name} ${folder}` : repo.name;
}
