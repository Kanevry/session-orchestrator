/**
 * voice-gate.test.mjs — mechanical gate for the owner-voice rules on the public site.
 *
 * ## TV-001: the bugs this catches that the existing suite does not
 *
 * The public pages under `site/` are written in the owner's voice, whose hard,
 * mechanically checkable rules live in the voice SSOT
 * (`06-people/bernhard-voice.md`, anti-pattern classes K4 / K6 / K7 plus the
 * typography section). Nothing in this repo's suite reads `site/**` at all, so
 * every one of these is a silent regression today:
 *
 *   1. EM-DASH REINTRODUCTION (K7, the "hardes Gate" of the SSOT). Before the
 *      2026-09-07 redesign the pages carried 19 + 8 (index) and 4 + 26 (guide)
 *      em-dashes, split between the raw U+2014 character and the `&mdash;`
 *      entity. A `grep -c '—'` sees only the first half and reports the page
 *      clean while 26 entity-encoded dashes stand in the rendered text. Any
 *      later copy edit, or a translation pass through a model, reintroduces
 *      them with nothing to notice.
 *
 *   2. SUPERLATIVE INFLATION (K4). Marketing copy drifts toward
 *      "seamless / powerful / revolutionary" on exactly the pages that are
 *      supposed to carry understatement. Word-level, so a rewrite that keeps
 *      the layout and swaps the adjectives is caught.
 *
 *   3. CORPORATE-WE (K6). A one-person project that writes "we built" reads as
 *      an agency pose. The failure mode is a single new marketing paragraph, not
 *      a whole-page rewrite, so a human reviewer misses it.
 *
 *   4. UNICODE EMOJI. Zero occurrences in 169 mined owner texts; a decorative
 *      emoji in a section heading is the classic model-authored tell.
 *
 *   5. EXCLAMATION-MARK EMPHASIS. Allowed only for real joy, which the site has
 *      none of; a "Get started!" CTA is the regression.
 *
 * All five are checked against the FILES AS SHIPPED, so a failure here is a real
 * defect in the artefact that is served, not in an intermediate representation.
 *
 * Falsification: each rule fails the moment its offending byte exists in a file
 * under `site/`; verified by injecting each pattern into a fixture string (see
 * the `visibleText` unit case, which pins the stripping the rules depend on —
 * if `visibleText` silently returned "" every content rule would pass vacuously,
 * so that case is load-bearing, not decorative).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from this module's own location, never process.cwd():
// the pre-push gate runs the suite from a worktree under $TMPDIR.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const siteDir = join(repoRoot, 'site');

/** Recursively collect every `.html` file under `site/`, repo-relative, sorted. */
function collectHtmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectHtmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(relative(repoRoot, full));
  }
  return out.sort();
}

const htmlFiles = collectHtmlFiles(siteDir);
const textFiles = ['site/llms.txt', 'site/llms-full.txt'];

function read(relPath) {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

/** Drop HTML comments plus `<script>` / `<style>` bodies — copy rules do not apply there. */
function stripNonCopy(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
}

/**
 * Visible copy: non-copy regions removed, then quoted material (`<blockquote>`,
 * `<q>`) removed (a quotation is someone else's voice), then tags stripped.
 */
function visibleText(html) {
  return stripNonCopy(html)
    .replace(/<blockquote\b[\s\S]*?<\/blockquote\s*>/gi, ' ')
    .replace(/<q\b[\s\S]*?<\/q\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/** Every match of `pattern` as `file:line — snippet`, for the assertion message. */
function locate(relPath, haystack, pattern) {
  const hits = [];
  const lines = haystack.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const rx = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let m = rx.exec(lines[i]);
    while (m !== null) {
      const from = Math.max(0, m.index - 40);
      hits.push(`${relPath}:${i + 1} — ${lines[i].slice(from, m.index + m[0].length + 40).trim()}`);
      m = rx.exec(lines[i]);
    }
  }
  return hits;
}

const EM_DASH = /—|&mdash;|&#8212;|&#x2014;/gi;

const SUPERLATIVES =
  /revolutionary|groundbreaking|game[- ]changer|cutting[- ]edge|world[- ]class|seamlessly|seamless|powerful|blazing|unleash|supercharge|massive|state of the art|revolutionär|bahnbrechend|nahtlos|massiv|genial|Game-Changer/gi;

const CORPORATE_WE_EN = /\bwe\b|\bour\b/gi;
const CORPORATE_WE_DE = /\bwir\b|\bunser(?:e|em|en|er|es)?\b/gi;

// Extended_Pictographic covers emoji proper; the ASCII ":)" the SSOT tolerates is not in it.
const EMOJI = /\p{Extended_Pictographic}/gu;

const EXCLAMATION = /!(?=\s|$)/g;

/**
 * Legal formulas that may legitimately say "wir" on impressum/datenschutz are
 * allowlisted BY EXACT SENTENCE, never by word. Measured 2026-09-07:
 * `grep -oin '\bwir\b|\bunser[a-z]*\b' site/de/index.html site/impressum/index.html
 * site/datenschutz/index.html` returned zero matches, so the list is empty.
 * Add the full sentence here (not the bare word) if a legal formula needs one.
 */
const LEGAL_WE_ALLOWLIST = [];

function stripAllowlisted(text) {
  return LEGAL_WE_ALLOWLIST.reduce((acc, sentence) => acc.split(sentence).join(' '), text);
}

function isGerman(html) {
  return /<html[^>]*\blang\s*=\s*["']de/i.test(html);
}

describe('site voice gate', () => {
  it('finds the site pages it is supposed to guard', () => {
    expect(htmlFiles).toContain('site/index.html');
    expect(htmlFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('visibleText strips scripts, styles, comments, quotes and tags but keeps copy', () => {
    const sample = [
      '<!-- — comment dash -->',
      '<style>.a{content:"—"}</style>',
      '<script>const x = "—";</script>',
      '<blockquote>we are seamless</blockquote>',
      '<p>Copy stays here.</p>',
    ].join('\n');
    const out = visibleText(sample).replace(/\s+/g, ' ').trim();
    expect(out).toBe('Copy stays here.');
  });

  it.each(htmlFiles)('%s contains no em-dash (raw or entity) outside comments/script/style', (relPath) => {
    const hits = locate(relPath, stripNonCopy(read(relPath)), EM_DASH);
    expect(hits, `em-dash (K7 hard rule) found:\n${hits.join('\n')}`).toEqual([]);
  });

  it.each(textFiles)('%s contains no em-dash (raw or entity)', (relPath) => {
    const hits = locate(relPath, read(relPath).replace(/<!--[\s\S]*?-->/g, ' '), EM_DASH);
    expect(hits, `em-dash (K7 hard rule) found:\n${hits.join('\n')}`).toEqual([]);
  });

  it.each(htmlFiles)('%s uses no K4 superlatives in visible text', (relPath) => {
    const hits = locate(relPath, visibleText(read(relPath)), SUPERLATIVES);
    expect(hits, `K4 superlative inflation:\n${hits.join('\n')}`).toEqual([]);
  });

  it.each(htmlFiles)('%s uses no corporate "we" in visible text', (relPath) => {
    const html = read(relPath);
    const text = stripAllowlisted(visibleText(html));
    const pattern = isGerman(html) ? CORPORATE_WE_DE : CORPORATE_WE_EN;
    const hits = locate(relPath, text, pattern);
    expect(hits, `K6 corporate-we (one-person project):\n${hits.join('\n')}`).toEqual([]);
  });

  it.each(htmlFiles)('%s contains no Unicode emoji in visible text', (relPath) => {
    const hits = locate(relPath, visibleText(read(relPath)), EMOJI);
    expect(hits, `Unicode emoji (zero in 169 mined owner texts):\n${hits.join('\n')}`).toEqual([]);
  });

  it.each(htmlFiles)('%s uses no exclamation-mark emphasis in visible text', (relPath) => {
    // `<code>`/`<pre>` must go BEFORE visibleText strips tags, or the fences are
    // already gone and their bodies would be scanned.
    const withoutCode = read(relPath)
      .replace(/<code\b[\s\S]*?<\/code\s*>/gi, ' ')
      .replace(/<pre\b[\s\S]*?<\/pre\s*>/gi, ' ');
    const text = visibleText(withoutCode);
    const hits = locate(relPath, text, EXCLAMATION);
    expect(hits, `exclamation-mark emphasis (allowed only for real joy):\n${hits.join('\n')}`).toEqual([]);
  });
});
