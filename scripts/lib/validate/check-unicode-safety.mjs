#!/usr/bin/env node
// check-unicode-safety.mjs — Scan tracked text files for dangerous / invisible
// Unicode and undeclared homoglyphs (#626).
//
// Rationale: a repo whose source, frontmatter, SKILL.md bodies, PR descriptions,
// and agent prompts are consumed by an LLM is a prime target for "ASCII /
// Tag smuggling" and bidi-override attacks — invisible code points (zero-width
// spaces, BOM, word-joiner, Unicode Tag block, bidi embed/override) that render
// as nothing to a human reviewer but carry instructions or reorder text for the
// model. This validator flags those code points everywhere, flags non-curated
// emoji in code/frontmatter (strict) while tolerating the repo's deliberate
// banner/status-symbol set in prose (lenient), and flags mixed-script homoglyphs
// inside a single identifier token in strict contexts.
//
// Usage: check-unicode-safety.mjs <plugin-root> [--write] [--json]
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..." plus a "Results: N
// passed, M failed" line so the validate-plugin orchestrator's PASS:/FAIL: tally
// counts it.
//
// Exit codes:
//   0 — clean (no violations)
//   1 — at least one violation
//   2 — tool error (missing arg / unreadable root)
//
// Contexts:
//   STRICT  — code files (.mjs/.js/.ts/.sh), .json, .yml/.yaml, AND the leading
//             frontmatter block (`---\n…\n---`) of .md files. Emoji + invisibles
//             + mixed-script homoglyphs are all flagged here, EXCEPT the curated
//             deliberate-symbol allow-list (banner/status emoji the repo ships).
//   LENIENT — markdown prose body (after frontmatter). Invisibles / bidi /
//             tag-block / zero-width are still flagged; the deliberate emoji set
//             passes. Mixed-script homoglyph detection is NOT applied (German
//             prose + intentional CJK fixtures must never be swept).

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// File enumeration — git ls-files primary, recursive fs walk fallback.
// (ported from check-owner-leakage.mjs, wrapped as pure exported helpers)
// ---------------------------------------------------------------------------

/** Text-scan extension allow-list. */
export const TEXT_EXTS = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.sh', '.txt']);

/** STRICT-context extensions (emoji + homoglyphs flagged, not just invisibles). */
const STRICT_EXTS = new Set(['.mjs', '.js', '.ts', '.sh', '.json', '.yml', '.yaml']);

/** Extensions whose files `--write` may rewrite (strip dangerous-invisibles). */
const WRITABLE_EXTS = new Set(['.md', '.txt']);

/**
 * Return true if a path is a scannable text file by extension.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isTextFile(filePath) {
  return TEXT_EXTS.has(extname(filePath));
}

function walkDir(root, dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walkDir(root, full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Enumerate tracked text files under `root`. Uses `git ls-files`; falls back to
 * a recursive fs walk when git is unavailable / `root` is not a repo.
 * @param {string} root absolute plugin root
 * @returns {string[]} absolute file paths
 */
export function getTrackedFiles(root) {
  let files;
  try {
    const output = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
    files = output.split('\n').filter(Boolean).map((f) => join(root, f));
  } catch {
    files = walkDir(root, root);
  }
  return files.filter(isTextFile);
}

// ---------------------------------------------------------------------------
// Dangerous-invisible code-point set (always flagged, every context).
// Ported from ecc check-unicode-safety.js isDangerousInvisibleCodePoint, with
// two deliberate differences:
//   - the variation-selector range (U+FE00–U+FE0F) is handled SEPARATELY (see
//     isOrphanVariationSelector) so legit emoji-presentation selectors don't
//     false-positive;
//   - U+00AD SOFT HYPHEN is ADDED (not in ecc) — an invisible discretionary
//     hyphen that smuggles into prose; the repo had exactly one stray instance.
// ---------------------------------------------------------------------------

/**
 * True when `codePoint` is an unconditionally dangerous invisible / format
 * control. Variation selectors are NOT decided here (orphan-only — see below).
 * @param {number} codePoint
 * @returns {boolean}
 */
export function isDangerousInvisibleCodePoint(codePoint) {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200d) || // ZWSP / ZWNJ / ZWJ
    codePoint === 0x2060 || // WORD JOINER
    codePoint === 0xfeff || // BOM / ZWNBSP
    (codePoint >= 0x202a && codePoint <= 0x202e) || // bidi embed / override
    (codePoint >= 0x2066 && codePoint <= 0x2069) || // bidi isolates
    (codePoint >= 0xe0000 && codePoint <= 0xe007f) || // Unicode Tag block (ASCII smuggling)
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) || // VS supplement
    codePoint === 0x180e || // MONGOLIAN VOWEL SEPARATOR
    codePoint === 0x115f || // HANGUL CHOSEONG FILLER
    codePoint === 0x1160 || // HANGUL JUNGSEONG FILLER
    (codePoint >= 0x2061 && codePoint <= 0x2064) || // invisible math operators
    codePoint === 0x3164 || // HANGUL FILLER
    codePoint === 0x00ad // SOFT HYPHEN (added beyond ecc)
  );
}

// Variation-selector range (U+FE00–U+FE0F). A VS-16 (U+FE0F) that immediately
// follows an Extended_Pictographic code point is the legitimate emoji-
// presentation selector and must NOT be flagged. Any other variation selector
// (orphan / standalone, or a VS not preceded by an emoji) is suspicious.
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * True when the variation selector at `prevChar`→`char` is an ORPHAN — i.e.
 * not a legitimate emoji-presentation selector following a pictographic base.
 * @param {number} codePoint code point of the variation selector
 * @param {string} prevChar the preceding code point (as a string), or ''
 * @returns {boolean}
 */
function isOrphanVariationSelector(codePoint, prevChar) {
  if (codePoint < 0xfe00 || codePoint > 0xfe0f) return false;
  if (codePoint === 0xfe0f && prevChar && EXTENDED_PICTOGRAPHIC.test(prevChar)) {
    return false; // legit emoji-presentation selector
  }
  return true; // orphan / standalone variation selector
}

// ---------------------------------------------------------------------------
// Emoji + deliberate-symbol allow-list.
// ---------------------------------------------------------------------------

/** Emoji / regional-indicator detection (non-global — safe for per-char .test). */
const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

// The repo deliberately ships a curated banner/status emoji set in CLI output
// strings, hooks, docs, and SKILL bodies. Every code point in this set is an
// intentional symbol, NOT a smuggling vector — it passes in BOTH strict and
// lenient contexts. The list was built from a full survey of the tracked tree
// (18 distinct emoji code points; see #626 Wave-1/Wave-2 discovery) plus the
// task-named allow-list. A NEW emoji outside this set is still flagged.
const ALLOWED_EMOJI_CODEPOINTS = new Set([
  0x1f3af, // 🎯
  0x1f465, // 👥
  0x1f4ca, // 📊
  0x1f4cb, // 📋
  0x1f4da, // 📚
  0x1f501, // 🔁
  0x1f50d, // 🔍
  0x1f527, // 🔧
  0x1f534, // 🔴
  0x1f5a5, // 🖥
  0x1f6a6, // 🚦
  0x1f6a8, // 🚨
  0x2139, //  ℹ
  0x2194, //  ↔
  0x26a0, //  ⚠
  0x2705, //  ✅
  0x274c, //  ❌
  0x2b50, //  ⭐
  0x00a9, //  © (copyright — defensive, ecc allow-list)
  0x00ae, //  ® (registered — defensive)
  0x2122, //  ™ (trademark — defensive)
]);

/**
 * True when `char` is a curated deliberate symbol that must never be flagged.
 * @param {string} char a single emoji match
 * @returns {boolean}
 */
function isAllowedEmojiSymbol(char) {
  return ALLOWED_EMOJI_CODEPOINTS.has(char.codePointAt(0));
}

// ---------------------------------------------------------------------------
// Mixed-script homoglyph detection (STRICT contexts only, conservative).
// Flags an identifier-like token that mixes Latin with Cyrillic — the classic
// homoglyph attack (e.g. Cyrillic U+0430 "а" inside an ASCII word; the Cyrillic
// glyph is visually identical to Latin "a").
//
// Greek is DELIBERATELY EXCLUDED (#626): Greek math letters (λ π Δ Σ θ µ) are
// visually distinct from Latin — they are NOT homoglyph-attack vectors — and are
// legitimately used as identifiers in code (`const λmax = 5`). Including Greek in
// the mixed-script trigger produced a CI-landmine false-positive. German umlauts
// (ä ö ü ß) are Latin script → never trigger. CJK is neither Latin/Cyrillic →
// never trigger. Prose is NOT scanned (lenient).
// ---------------------------------------------------------------------------

const IDENT_TOKEN_RE = /[\p{L}\p{M}\p{N}_]+/gu;
const SCRIPT_LATIN = /\p{Script=Latin}/u;
const SCRIPT_CYRILLIC = /\p{Script=Cyrillic}/u;

// ---------------------------------------------------------------------------
// Frontmatter extraction (a .md file's leading `---\n…\n---` block).
// ---------------------------------------------------------------------------

/**
 * Return the length (in chars) of the leading YAML frontmatter block, or 0 when
 * the file has none. The frontmatter region is treated as STRICT.
 *
 * A single leading U+FEFF BOM is tolerated before the opening `---\n` (#626):
 * without this carve-out, a BOM-prefixed `.md` file fails the `startsWith` test
 * and its frontmatter is silently treated as LENIENT prose. The BOM itself is
 * still flagged as dangerous-invisible by the code-point walk (which scans the
 * original, un-stripped text), so the carve-out only fixes detection. The
 * returned length is an offset into the ORIGINAL text, so the +1 for the
 * stripped BOM is added back.
 * @param {string} text
 * @returns {number} number of leading characters that are frontmatter
 */
function frontmatterLength(text) {
  // Strip a single leading BOM for the detection test only; track the offset so
  // the returned length still indexes into the original `text`.
  const bomOffset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const body = bomOffset ? text.slice(1) : text;
  if (!body.startsWith('---\n')) return 0;
  const end = body.indexOf('\n---', 4);
  if (end === -1) return 0;
  return bomOffset + end + 4; // include the closing `---`, offset by the BOM
}

// ---------------------------------------------------------------------------
// Per-line / column helpers.
// ---------------------------------------------------------------------------

/**
 * 1-based line + column for a character index into `text`.
 * @param {string} text
 * @param {number} index char index of the code unit
 * @returns {{line: number, column: number}}
 */
function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lastNewline = before.lastIndexOf('\n');
  const column = index - lastNewline; // 1-based column
  return { line, column };
}

// ---------------------------------------------------------------------------
// Core collector (pure).
// ---------------------------------------------------------------------------

/**
 * Collect every Unicode-safety violation across `rootOrFiles`.
 *
 * Pure + import-safe: no process.exit, no console. Returns the violation list so
 * callers and tests can assert against it directly.
 *
 * @param {string} rootOrFiles absolute plugin root (files are enumerated via git)
 * @returns {Array<{file: string, line: number, column: number, kind: string, codePoint: string}>}
 *   `file` is RELATIVE to the root. `kind` ∈
 *   {'dangerous-invisible','orphan-variation-selector','emoji','mixed-script'}.
 */
export function collectUnicodeViolations(rootOrFiles) {
  const root = rootOrFiles;
  const files = getTrackedFiles(root);

  // Exclude this validator's own source + test file (the dangerous-invisible
  // doc-comments and the test fixtures would otherwise self-trip the scanner).
  const SELF_EXCLUSIONS = new Set([
    'scripts/lib/validate/check-unicode-safety.mjs',
    'tests/lib/validate/check-unicode-safety.test.mjs',
  ]);

  /** @type {Array<{file: string, line: number, column: number, kind: string, codePoint: string}>} */
  const violations = [];

  for (const filePath of files) {
    const rel = relative(root, filePath).split(sep).join('/');
    if (SELF_EXCLUSIONS.has(rel)) continue;

    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue; // unreadable — skip
    }

    const ext = extname(filePath);
    const fmLen = ext === '.md' ? frontmatterLength(text) : 0;
    const fileIsStrict = STRICT_EXTS.has(ext);

    // STRICT region of a char index: whole file when extension is strict, OR
    // the frontmatter prefix of a .md file.
    const indexIsStrict = (idx) => fileIsStrict || (fmLen > 0 && idx < fmLen);

    // Walk code points once for invisibles / variation selectors / emoji.
    let index = 0;
    let prevChar = '';
    for (const char of text) {
      const cp = char.codePointAt(0);

      if (isDangerousInvisibleCodePoint(cp)) {
        const { line, column } = lineAndColumn(text, index);
        violations.push({
          file: rel,
          line,
          column,
          kind: 'dangerous-invisible',
          codePoint: `U+${cp.toString(16).toUpperCase()}`,
        });
      } else if (isOrphanVariationSelector(cp, prevChar)) {
        const { line, column } = lineAndColumn(text, index);
        violations.push({
          file: rel,
          line,
          column,
          kind: 'orphan-variation-selector',
          codePoint: `U+${cp.toString(16).toUpperCase()}`,
        });
      } else if (EMOJI_RE.test(char) && !isAllowedEmojiSymbol(char) && indexIsStrict(index)) {
        // Non-curated emoji in a STRICT context (code file / .json / .yml /
        // .md frontmatter). In LENIENT prose, non-curated emoji are tolerated;
        // the curated deliberate set (isAllowedEmojiSymbol) passes everywhere.
        const { line, column } = lineAndColumn(text, index);
        violations.push({
          file: rel,
          line,
          column,
          kind: 'emoji',
          codePoint: `U+${cp.toString(16).toUpperCase()}`,
        });
      }

      prevChar = char;
      index += char.length;
    }

    // Mixed-script homoglyph detection — STRICT context only, conservative.
    if (fileIsStrict || fmLen > 0) {
      // Scan only the strict region. For strict-ext files that is the whole
      // file; for .md it is the frontmatter prefix.
      const region = fileIsStrict ? text : text.slice(0, fmLen);
      IDENT_TOKEN_RE.lastIndex = 0;
      let m;
      while ((m = IDENT_TOKEN_RE.exec(region)) !== null) {
        const token = m[0];
        const hasLatin = SCRIPT_LATIN.test(token);
        const hasCyrillic = SCRIPT_CYRILLIC.test(token);
        // Greek is excluded by design (#626) — Latin+Greek is NOT a homoglyph
        // attack and legit Greek-letter identifiers must not be swept.
        if (hasLatin && hasCyrillic) {
          const { line, column } = lineAndColumn(text, m.index);
          // Report the code point of the first Cyrillic char in the token for
          // a precise pointer.
          let offending = token.codePointAt(0);
          for (const c of token) {
            const ccp = c.codePointAt(0);
            if (SCRIPT_CYRILLIC.test(c)) {
              offending = ccp;
              break;
            }
          }
          violations.push({
            file: rel,
            line,
            column,
            kind: 'mixed-script',
            codePoint: `U+${offending.toString(16).toUpperCase()}`,
          });
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// --write: strip ONLY the unambiguous dangerous-invisible chars from writable
// files. (We deliberately do NOT port ecc's markdown-whitespace-collapse — it
// is out of scope and would churn unrelated formatting.)
// ---------------------------------------------------------------------------

/**
 * Strip every dangerous-invisible code point (and orphan variation selector)
 * from `text`. Curated emoji and legit emoji-presentation selectors are kept.
 * @param {string} text
 * @returns {string}
 */
export function stripDangerousInvisibles(text) {
  let out = '';
  let prevChar = '';
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (isDangerousInvisibleCodePoint(cp)) {
      // drop
    } else if (isOrphanVariationSelector(cp, prevChar)) {
      // drop orphan VS
    } else {
      out += char;
    }
    prevChar = char;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/**
 * Run the validator against a plugin root. Prints PASS/FAIL lines and a Results
 * summary (unless `json` is set, in which case the violation array is emitted as
 * JSON to stdout). Returns the process exit code: 0 clean, 1 violations, 2 tool
 * error.
 *
 * @param {string} pluginRoot
 * @param {{write?: boolean, json?: boolean}} [opts]
 * @returns {number}
 */
export function runCheckUnicodeSafety(pluginRoot, opts = {}) {
  const { write = false, json = false } = opts;

  if (!json) {
    console.log('--- Check: Unicode safety (invisible / bidi / tag-block / homoglyph) ---');
  }

  // Tool-error gate: root must exist and be a directory.
  try {
    if (!pluginRoot || !existsSync(pluginRoot) || !statSync(pluginRoot).isDirectory()) {
      console.error(`  tool-error: plugin root not found or not a directory: ${pluginRoot}`);
      return 2;
    }
  } catch (/** @type {unknown} */ e) {
    console.error(`  tool-error: cannot stat plugin root: ${(/** @type {Error} */ (e)).message}`);
    return 2;
  }

  // Optional --write: strip dangerous-invisibles from writable files first, so
  // the subsequent scan reflects the cleaned tree.
  if (write) {
    for (const filePath of getTrackedFiles(pluginRoot)) {
      const ext = extname(filePath);
      if (!WRITABLE_EXTS.has(ext)) continue;
      const rel = relative(pluginRoot, filePath).split(sep).join('/');
      if (rel === 'scripts/lib/validate/check-unicode-safety.mjs') continue;
      if (rel === 'tests/lib/validate/check-unicode-safety.test.mjs') continue;
      let text;
      try {
        text = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const stripped = stripDangerousInvisibles(text);
      if (stripped !== text) {
        try {
          writeFileSync(filePath, stripped, 'utf8');
          if (!json) console.log(`  stripped dangerous-invisibles from ${rel}`);
        } catch {
          // ignore write failure — the scan below will still report the leak
        }
      }
    }
  }

  const violations = collectUnicodeViolations(pluginRoot);

  if (json) {
    process.stdout.write(JSON.stringify(violations) + '\n');
    return violations.length > 0 ? 1 : 0;
  }

  let passed = 0;
  let failed = 0;
  const pass = (msg) => { console.log(`  PASS: ${msg}`); passed++; };
  const fail = (msg) => { console.log(`  FAIL: ${msg}`); failed++; };

  if (violations.length === 0) {
    pass('no dangerous / invisible Unicode or homoglyphs found');
  } else {
    for (const v of violations) {
      fail(`${v.file}:${v.line}:${v.column} — ${v.kind} ${v.codePoint}`);
    }
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

// CLI entry — only when executed directly, never on import (keeps the exports
// safe to import from tests without triggering process.exit).
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const pluginRoot = positional[0];
  if (!pluginRoot) {
    console.error('Usage: check-unicode-safety.mjs <plugin-root> [--write] [--json]');
    process.exit(2);
  }
  process.exit(
    runCheckUnicodeSafety(pluginRoot, {
      write: flags.has('--write'),
      json: flags.has('--json'),
    }),
  );
}
