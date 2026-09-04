#!/usr/bin/env node
/**
 * config-protection.mjs — PreToolUse Edit|Write|MultiEdit guard (ecc-analysis / #622).
 *
 * The edit-tool analogue of the test-the-mock gate-cheating anti-pattern.
 * Intercepts Edit/Write on a small allow-list of quality-gate config files
 * (eslint / vitest / tsconfig / prettier / commitlint / gitleaks) and WARNs —
 * or, in `strict` mode, BLOCKS — when an edit LOOSENS a quality gate:
 *   1. a coverage/threshold number is lowered;
 *   2. a disable/ignore directive (eslint-disable, @ts-ignore, prettier-ignore,
 *      …) is ADDED (count increase, not mere presence);
 *   3. a lint rule is removed or turned off (error/warn → off/0/false);
 *   4. a `.gitleaks.toml` allowlist is widened (new allowlist/regex/path/stopword
 *      entries);
 *   5. tsconfig strictness is relaxed (strict flags flipped true→false, removed,
 *      or skipLibCheck added true).
 *
 * First-time creation (no prior file), tightening, neutral/comment-only edits,
 * non-config files, and unparseable content are ALWAYS allowed. The guard is
 * warn-by-default advisory — a low-false-positive line/regex heuristic, NOT an
 * exhaustive AST gate (YAGNI). Fail-open on any internal error: a legit edit is
 * never blocked by a guard bug.
 *
 * Edit/MultiEdit are compared WHOLE-FILE, not slice-only: the on-disk file
 * (still pre-edit at PreToolUse time) is read as old, the supplied slice
 * replacement(s) are applied in order to synthesise new, and detectLoosening
 * runs over the full contents. This defeats slice-boundary bypasses where the
 * key name / rule lives outside the caller-chosen old_string→new_string window
 * (e.g. `old_string:"90" new_string:"10"` or deleting a whole threshold line).
 *
 * Decision precedence:
 *   1. shouldRunHook('config-protection') gate — exit 0 when disabled.
 *   2. config-protection.enabled (false → allow silently).
 *   3. allow-config-weakening: true Session Config bypass → allow + ℹ note.
 *   4. heuristic → warn (stderr + event) | strict-block (event + deny envelope).
 *
 * Exit code is ALWAYS 0 (post-#906). A strict-mode block is signalled solely by
 * the nested PreToolUse deny envelope emitDeny() writes to stdout — the docs
 * forbid the old stdout-JSON + `exit 2` mixed form ("Exit 2 … Claude Code
 * ignores stdout and any JSON in it"), which discarded the reason and looked
 * like a crash to the operator. Do not reintroduce `exit 2` here.
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('config-protection')) process.exit(0);

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { emitAllow, emitDeny } from '../scripts/lib/io.mjs';
import { emitEvent } from '../scripts/lib/events.mjs';
import { getProjectDir } from '../scripts/lib/platform.mjs';
import {
  _parseConfigProtection,
  _isConfigWeakeningAllowed,
} from '../scripts/lib/config/config-protection.mjs';

// ---------------------------------------------------------------------------
// Protected-file allow-list (matched against path.basename(file_path))
// ---------------------------------------------------------------------------

/**
 * Exact basenames that are always protected.
 * package.json + pyproject.toml are deliberately EXCLUDED — they change for
 * many non-gate reasons and would be a false-positive magnet (#622 scope).
 */
const PROTECTED_EXACT = new Set([
  'vitest.config.base.ts',
  '.gitleaks.toml',
  'gitleaks.toml',
]);

/**
 * Regex matchers for the protected basenames with variant extensions.
 * Kept anchored + linear-time (no nested quantifiers) — ReDoS-safe.
 */
const PROTECTED_PATTERNS = [
  /^eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)$/,
  /^\.eslintrc(?:\..+)?$/, // .eslintrc, .eslintrc.json, .eslintrc.js, .eslintrc.cjs, …
  /^vitest\.config\.(?:ts|js|mjs)$/,
  /^tsconfig.*\.json$/, // tsconfig.json, tsconfig.base.json, tsconfig.build.json, …
  /^\.prettierrc(?:\..+)?$/, // .prettierrc, .prettierrc.json, .prettierrc.js, …
  /^prettier\.config\.(?:js|cjs|mjs)$/,
  /^commitlint\.config\.(?:js|cjs|mjs|ts)$/,
];

/**
 * Is the given file path a protected quality-gate config file?
 * @param {string} filePath
 * @returns {boolean}
 */
function isProtectedConfig(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  const base = path.basename(filePath);
  if (PROTECTED_EXACT.has(base)) return true;
  return PROTECTED_PATTERNS.some((re) => re.test(base));
}

// ---------------------------------------------------------------------------
// stdin reading (inline null-on-failure — never throw; mirrors the
// post-tool-batch-wave-signal.mjs:55 pattern so a malformed payload allows)
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * @returns {Promise<object|null>}
 */
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.closed) {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => { resolve(null); }, 5_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const raw = chunks.join('').trim();
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------------------
// Loosening heuristic
// ---------------------------------------------------------------------------

/**
 * Disable/ignore directive TOKENS. Counted (not merely presence-checked) so an
 * edit only flags when it ADDS more directives than the old content had — prose
 * mentioning the word "disable" cannot trip the guard because we match the
 * directive token itself.
 */
const DISABLE_DIRECTIVES = [
  'eslint-disable-next-line',
  'eslint-disable-line',
  'eslint-disable',
  '@ts-nocheck',
  '@ts-ignore',
  '@ts-expect-error',
  'prettier-ignore',
  'biome-ignore',
];

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Note: longer directives are checked before their substrings in the caller
 * (e.g. eslint-disable-next-line before eslint-disable) to avoid double-count
 * inflation; here we count the literal token globally.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Count total disable/ignore directives in a text blob. Longer tokens are
 * removed (masked) before shorter substrings are counted so a single
 * `eslint-disable-next-line` is not also counted as `eslint-disable`.
 * @param {string} text
 * @returns {number}
 */
function countDisableDirectives(text) {
  if (!text) return 0;
  let working = text;
  let total = 0;
  // DISABLE_DIRECTIVES is ordered longest-prefix-first for the eslint family.
  for (const token of DISABLE_DIRECTIVES) {
    const n = countOccurrences(working, token);
    if (n > 0) {
      total += n;
      // Mask matched tokens so shorter substrings (eslint-disable) don't
      // re-count a longer match (eslint-disable-next-line). NUL is the sentinel
      // because it cannot occur inside a directive token.
      //
      // KEEP THE ESCAPED FORM below — never paste a raw NUL byte into this
      // source. One raw NUL makes the whole file BINARY to the grep family:
      // ugrep / `grep -I` (Claude Code's Grep tool) then skips it SILENTLY,
      // returning exit 1 with NO output even where matches exist, so this
      // security hook goes invisible to every grep-based audit — a live
      // deny-path census already missed the emitDeny call below exactly that
      // way. The escape is byte-identical at runtime; only the on-disk file
      // stays text.
      working = working.split(token).join('\u0000'.repeat(token.length));
    }
  }
  return total;
}

/**
 * Extract numeric threshold/coverage assignments as a map of key → number.
 * Matches both the named coverage keys (statements|branches|functions|lines|
 * global) and a generic (threshold|coverage|min<Word>) family, in `key: 70`
 * or `key = 70` form. Returns the LOWEST value seen per key (conservative).
 * @param {string} text
 * @returns {Map<string, number>}
 */
function extractThresholds(text) {
  const map = new Map();
  if (!text) return map;
  // Named coverage keys + generic threshold/coverage/min* keys.
  const re = /\b(statements|branches|functions|lines|global|threshold|coverage|min[A-Za-z]*)\b\s*[:=]\s*(\d+(?:\.\d+)?)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    const val = Number.parseFloat(m[2]);
    if (!Number.isFinite(val)) continue;
    const prev = map.get(key);
    if (prev === undefined || val < prev) map.set(key, val);
  }
  return map;
}

/**
 * Count rule directives at a given "off" level vs "on" level. A net DECREASE in
 * the ON count (or net INCREASE in the OFF count) indicates a rule was removed
 * or downgraded. Returns { on, off }.
 *
 * Two token families are counted, both as ESLint rule *values*:
 *   1. Word severities (anywhere): 'error' | "error" | error | 'warn' | "warn"
 *      | warn → ON; 'off' | "off" | off → OFF.
 *   2. Numeric severities in VALUE position only (after a `:` or as the first
 *      element of a `[...]` rule-options array): 2 → ON (strong), 1 → ON (weak),
 *      0 → OFF. Restricting to value position (`: 0` / `[0`) avoids matching
 *      arbitrary digits elsewhere in the file (e.g. coverage thresholds, line
 *      numbers) as severities. This closes the 2→0 numeric-severity bypass that
 *      the word-only matcher missed.
 * This is a coarse line-level signal, not an AST parse.
 * @param {string} text
 * @returns {{ on: number, off: number }}
 */
function countRuleSeverities(text) {
  if (!text) return { on: 0, off: 0 };
  // Word severities (anywhere — quoted or bare).
  const wordOn =
    (text.match(/['"]?\berror\b['"]?/gi) || []).length +
    (text.match(/['"]?\bwarn\b['"]?/gi) || []).length;
  const wordOff =
    (text.match(/['"]?\boff\b['"]?/gi) || []).length;
  // Numeric severities in value position only: `: 2` / `: 0` (assignment) or
  // `[2` / `[ 0` (rule-options array head). `\b` after the digit prevents `10`
  // / `20` (coverage thresholds) from matching `1` / `2`.
  const numOn =
    (text.match(/[:[]\s*2\b/g) || []).length +
    (text.match(/[:[]\s*1\b/g) || []).length;
  const numOff =
    (text.match(/[:[]\s*0\b/g) || []).length;
  return { on: wordOn + numOn, off: wordOff + numOff };
}

/**
 * tsconfig strict-flag detector. Returns the set of strict flags currently set
 * to `true` and whether `skipLibCheck` is true.
 * @param {string} text
 * @returns {{ strictTrue: Set<string>, skipLibCheck: boolean }}
 */
const TSCONFIG_STRICT_FLAGS = [
  'strict',
  'noImplicitAny',
  'strictNullChecks',
  'noUnusedLocals',
  'noUnusedParameters',
  'noImplicitReturns',
];

function tsconfigStrictState(text) {
  const strictTrue = new Set();
  let skipLibCheck = false;
  if (!text) return { strictTrue, skipLibCheck };
  for (const flag of TSCONFIG_STRICT_FLAGS) {
    const re = new RegExp(`["']?\\b${flag}\\b["']?\\s*:\\s*(true|false)`, 'i');
    const m = text.match(re);
    if (m && m[1].toLowerCase() === 'true') strictTrue.add(flag);
  }
  const slc = text.match(/["']?\bskipLibCheck\b["']?\s*:\s*(true|false)/i);
  if (slc && slc[1].toLowerCase() === 'true') skipLibCheck = true;
  return { strictTrue, skipLibCheck };
}

/**
 * Extract gitleaks allowlist signal lines: count of [[allowlist]]/[allowlist]
 * headers + regexes/paths/stopwords entry lines.
 * @param {string} text
 * @returns {number}
 */
function gitleaksAllowlistSignal(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^\[\[?allowlist\]?\]/.test(t)) count += 1;
    else if (/^(regexes|paths|stopwords|commits)\b/.test(t)) count += 1;
  }
  return count;
}

/**
 * Compute the set of loosening reasons for an old→new content transition on a
 * protected config file. Returns an array of short reason codes (empty when
 * the edit is tightening / neutral). Fail-open: any internal error → [].
 *
 * @param {string} basename
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {string[]}
 */
function detectLoosening(basename, oldContent, newContent) {
  const reasons = [];
  try {
    // 1. threshold lowered OR removed: iterate keys present in OLD (not just
    //    NEW) so a threshold that was present in old and is gone in new (the
    //    delete-the-line bypass) is flagged as loosening, not just a numeric
    //    decrease. A key absent from new is treated as value 0.
    const oldT = extractThresholds(oldContent);
    const newT = extractThresholds(newContent);
    for (const [key, oldVal] of oldT) {
      const newVal = newT.has(key) ? newT.get(key) : 0;
      if (newVal < oldVal) {
        const shown = newT.has(key) ? newVal : 'removed';
        reasons.push(`threshold-lowered (${key}: ${oldVal}→${shown})`);
      }
    }

    // 2. added disable/ignore directive (count increase).
    const oldD = countDisableDirectives(oldContent);
    const newD = countDisableDirectives(newContent);
    if (newD > oldD) {
      reasons.push(`disable-directive-added (${oldD}→${newD})`);
    }

    // 3. rule removed / turned off: net decrease in ON severities or net
    //    increase in OFF severities.
    const oldS = countRuleSeverities(oldContent);
    const newS = countRuleSeverities(newContent);
    if (newS.on < oldS.on || newS.off > oldS.off) {
      reasons.push(`rule-relaxed (on ${oldS.on}→${newS.on}, off ${oldS.off}→${newS.off})`);
    }

    // 4. widened gitleaks allowlist (only for gitleaks files).
    if (basename === '.gitleaks.toml' || basename === 'gitleaks.toml') {
      const oldG = gitleaksAllowlistSignal(oldContent);
      const newG = gitleaksAllowlistSignal(newContent);
      if (newG > oldG) {
        reasons.push(`gitleaks-allowlist-widened (${oldG}→${newG})`);
      }
    }

    // 5. tsconfig strictness relaxed (only for tsconfig files).
    if (/^tsconfig.*\.json$/.test(basename)) {
      const oldTs = tsconfigStrictState(oldContent);
      const newTs = tsconfigStrictState(newContent);
      // A strict flag was true and is now NOT true (flipped false or removed).
      for (const flag of oldTs.strictTrue) {
        if (!newTs.strictTrue.has(flag)) {
          reasons.push(`tsconfig-strictness-relaxed (${flag})`);
        }
      }
      // skipLibCheck newly added as true.
      if (newTs.skipLibCheck && !oldTs.skipLibCheck) {
        reasons.push('tsconfig-skipLibCheck-added');
      }
    }
  } catch {
    // Fail-open — any parse error means we do NOT flag (no false block).
    return [];
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  // Malformed / empty payload → allow (never block a legit edit).
  if (!input) return emitAllow();

  const toolName = input.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
    return emitAllow();
  }

  const toolInput = input.tool_input;
  const filePath = toolInput?.file_path;
  if (typeof filePath !== 'string' || !filePath) return emitAllow();

  // Only scan protected quality-gate config files — everything else allows.
  if (!isProtectedConfig(filePath)) return emitAllow();
  const basename = path.basename(filePath);

  // Resolve old vs new content.
  //
  // For Write the new content is supplied verbatim; for Edit/MultiEdit the
  // caller supplies slices and we reconstruct the WHOLE post-edit file. The
  // PreToolUse hook runs BEFORE the edit is applied, so the on-disk file still
  // holds the pre-edit (old) content — we read it as `fullOld` and synthesise
  // `fullNew` by applying the slice replacement(s). Comparing whole files (not
  // just the caller-chosen slices) defeats the slice-boundary bypass: a key
  // name or rule that lives OUTSIDE the slice is still seen by detectLoosening.
  let oldContent;
  let newContent;
  if (toolName === 'Write') {
    newContent = typeof toolInput.content === 'string' ? toolInput.content : '';
    try {
      oldContent = await fs.readFile(filePath, 'utf8');
    } catch {
      // ENOENT (or unreadable) → FIRST-TIME CREATION. Nothing to loosen.
      return emitAllow();
    }
  } else {
    // Edit / MultiEdit: reconstruct whole-file old vs new from the on-disk file.
    let fullOld;
    try {
      fullOld = await fs.readFile(filePath, 'utf8');
    } catch {
      // File does not exist yet → not a real edit target (Edit/MultiEdit
      // against a missing file is a no-op for our purposes). Nothing to loosen.
      return emitAllow();
    }
    // Collect the sequential edits: Edit = one (old_string,new_string) pair;
    // MultiEdit = an ordered edits[] array of the same shape.
    const edits =
      toolName === 'MultiEdit'
        ? (Array.isArray(toolInput.edits) ? toolInput.edits : [])
        : [{ old_string: toolInput.old_string, new_string: toolInput.new_string }];

    let fullNew = fullOld;
    for (const e of edits) {
      const os = typeof e?.old_string === 'string' ? e.old_string : '';
      const ns = typeof e?.new_string === 'string' ? e.new_string : '';
      if (os === '') continue; // empty old_string has no defined anchor — skip.
      const at = fullNew.indexOf(os);
      if (at === -1) continue; // slice not present (already applied / stale) — skip.
      // Plain string replace of the FIRST occurrence (os may contain regex
      // metacharacters — never feed it to RegExp).
      fullNew = fullNew.slice(0, at) + ns + fullNew.slice(at + os.length);
    }
    oldContent = fullOld;
    newContent = fullNew;
  }

  // Read Session Config (enabled gate + bypass) from CLAUDE.md / AGENTS.md.
  // Default-on; any read failure resolves to the parser defaults (enabled:true).
  let cfgContent = '';
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      cfgContent = await fs.readFile(path.join(getProjectDir(), file), 'utf8');
      if (cfgContent) break;
    } catch { /* try next candidate */ }
  }

  const { enabled, mode } = _parseConfigProtection(cfgContent);
  if (!enabled) return emitAllow();

  // Per-session bypass (mirrors allow-destructive-ops) — allow + ℹ note, no event.
  if (_isConfigWeakeningAllowed(cfgContent)) {
    process.stderr.write('ℹ config-protection bypassed (allow-config-weakening: true)\n');
    return emitAllow();
  }

  // Heuristic.
  const reasons = detectLoosening(basename, oldContent, newContent);
  if (reasons.length === 0) return emitAllow(); // tightening / neutral

  const blocked = mode === 'strict';

  // Emit the event BEFORE any deny-exit (best-effort, try/catch).
  try {
    const sessionId =
      typeof input.session_id === 'string' && input.session_id ? input.session_id : null;
    await emitEvent('orchestrator.config.protection_warning', {
      ...(sessionId ? { session_id: sessionId } : {}),
      file: basename,
      reasons,
      action: blocked ? 'blocked' : 'warned',
    });
  } catch { /* best-effort — never let event emission block or crash the hook */ }

  const summary =
    `config-protection: edit to ${basename} appears to LOOSEN a quality gate ` +
    `[${reasons.join('; ')}]`;

  if (blocked) {
    // strict mode → block the edit via the deny envelope on stdout, exit 0
    // (never exit 2 — see the module docblock). Event already emitted above.
    return emitDeny(
      summary,
      'Tighten the gate, or set `allow-config-weakening: true` in Session Config to bypass.'
    );
  }

  // warn mode (default) → stderr warning + allow (exit 0). Event emitted above.
  process.stderr.write(`⚠ ${summary} (warn-only). See issue #622.\n`);
  return emitAllow();
}

// Fail-open on ANY uncaught error — a guard bug must never block a legit edit.
main().catch(() => { try { emitAllow(); } catch { process.exit(0); } });
