#!/usr/bin/env node
/**
 * Check: no instruction prose tells an agent to write `learnings.jsonl` with a
 * shell redirect (GitLab #1446 / GitHub #69). BLOCKING.
 *
 * ## Why
 *
 * The store is gitignored, so a bad write has no VCS restore. The sanctioned
 * write paths — `scripts/apply-session-learnings.mjs` (session-end, retro) and
 * `scripts/sweep-expired-learnings.mjs --prune` (`/evolve`) — validate every
 * record, snapshot `.bak-<ISO>`, and archive what leaves the store. A shell
 * `>` / `>>` does none of that. The prose producers this change closed, all
 * measured at ebf63bd1:
 *
 *   - `skills/session-end/learning-patterns.md` Phase 3.6 step 4g ("atomic
 *     rewrite with `>`") — the path that wrote a file PATH into `scope` (GH#69);
 *   - `skills/plan/mode-retro.md` § 3.3 — an unnamed "Append new patterns to
 *     `learnings.jsonl`" with no mechanism at all;
 *   - `.cursor/rules/060-evolve.mdc` — three sites ("Write entire result back
 *     with `>`", "write all with `>`" twice). None of the three names
 *     `learnings.jsonl` on its own line, which is why R2 is windowed.
 *
 * ## Rules
 *
 *   R1 shell redirect  — `>`/`>>` directly in front of a `…learnings.jsonl`
 *                        target on the same line. The leading boundary (start,
 *                        whitespace, `|`, `;`, `&`, `(`) is load-bearing:
 *                        without it 9 of 12 hits were `<state-dir>/…`
 *                        placeholders. A Markdown blockquote marker (`> ` at
 *                        line start, outside a fence) is not a redirect and is
 *                        stripped first; inside a fence it IS a truncation.
 *   R3 tee             — `tee [-a] …learnings.jsonl` on the same line.
 *   R2 prose operator  — a backticked `` `>` `` / `` `>>` `` within ±3 lines
 *                        (WINDOW) of an anchor: `learnings.jsonl`, "the store",
 *                        "learnings store", "result back", "atomic rewrite".
 *                        The last two are the retired producers' own wording.
 *                        An operator inside an ASCII double-quoted span is a
 *                        quotation of former prose, not an instruction.
 *
 * Exempt (per operator): a prohibition keyword (NEVER / do not / FORBIDDEN /
 * verboten …) BEFORE the operator in the same sentence — a keyword after it
 * (`… > learnings.jsonl # never run this twice`) or in an earlier sentence
 * (`Never skip review. Then run: … >> learnings.jsonl`) does not count.
 * Exempt (whole line): the last sentence of the previous non-empty line states
 * a prohibition before any operator, an empty-file create (`: > file`), or the
 * marker `<!-- learnings-write-check: prohibition -->` on the line or the
 * previous non-empty line. Fenced blocks ARE scanned — a fenced shell snippet
 * is exactly a shell write.
 *
 * @module scripts/lib/validate/check-learnings-shell-writes
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { enumerateRepoFiles } from './enumerate-repo-files.mjs';
import { isMainModule } from '../is-main-module.mjs';

/** Instruction corpora that tell an agent what to run. */
export const SCAN_DIRS = Object.freeze(['skills', 'commands', 'agents', 'docs', '.claude/rules', '.cursor/rules']);

/** Lines on either side of an R2 operator searched for an anchor. */
const WINDOW = 3;

const MENTION_RE = /learnings\.jsonl/;
const ANCHOR_RE = /learnings\.jsonl|\b(?:the|learnings) store\b|\bresult back\b|\batomic rewrite\b/i;
const SHELL_REDIRECT_RE = /(?:^|[\s|;&(])(>{1,2})[ \t]*["'`]?[^\s"'`<>]*learnings\.jsonl\b/dg;
const TEE_RE = /\btee\b(?:[ \t]+-{1,2}[\w-]+)*[ \t]+["'`]?[^\s"'`|]*learnings\.jsonl\b/g;
const PROSE_OPERATOR_RE = /`>{1,2}`/g;
const ANY_OPERATOR_RE = /`>{1,2}`|(?:^|[\s|;&(])>{1,2}|\btee\b/;
const PROHIBITION_RE = /\b(NEVER|[Nn]ever|DO NOT|[Dd]o not|[Dd]on't|FORBIDDEN|forbidden|verboten)\b/;
// A sentence ends at `.`/`!`/`?` + whitespace + a capital (markup allowed):
// `jq . next` and `jq | ... >` are not sentence breaks.
const SENTENCE_BREAK_RE = /[.!?]\s+(?=[*_`"']*[A-Z])/;
const EMPTY_CREATE_RE = /^\s*:\s*>/;
const BLOCKQUOTE_RE = /^\s*(?:>[ \t])+/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const MARKER = '<!-- learnings-write-check: prohibition -->';

/** The sentence a position sits in, cut off at that position. */
function clauseBefore(text, pos) {
  return text.slice(0, pos).split(SENTENCE_BREAK_RE).pop();
}

/** True when a prohibition keyword precedes `pos` within its own sentence. */
function prohibitedBefore(text, pos) {
  return PROHIBITION_RE.test(clauseBefore(text, pos));
}

/** True when the last sentence of `line` states a prohibition before any operator. */
function isProhibitionSentence(line) {
  const last = line.replace(BLOCKQUOTE_RE, '').trimEnd().split(SENTENCE_BREAK_RE).pop();
  const k = last.search(PROHIBITION_RE);
  if (k < 0) return false;
  const o = last.search(ANY_OPERATOR_RE);
  return o < 0 || k < o;
}

/** True when `pos` sits inside an ASCII double-quoted span of `text`. */
function insideDoubleQuotes(text, pos) {
  return (text.slice(0, pos).match(/"/g) ?? []).length % 2 === 1;
}

/**
 * Every operator on the line as `{rule, pos}`, positions relative to `body`.
 * R2 candidates are returned only when the ±WINDOW neighbourhood holds an anchor.
 */
function operatorsOf(body, lines, i) {
  const ops = [];
  if (MENTION_RE.test(body)) {
    for (const m of body.matchAll(SHELL_REDIRECT_RE)) ops.push({ rule: 'R1', pos: m.indices[1][0] });
    for (const m of body.matchAll(TEE_RE)) ops.push({ rule: 'R3', pos: m.index });
  }
  const prose = [...body.matchAll(PROSE_OPERATOR_RE)];
  if (prose.length > 0) {
    const from = Math.max(0, i - WINDOW);
    const anchored = lines.slice(from, i + WINDOW + 1).some((l) => ANCHOR_RE.test(l));
    if (anchored) {
      for (const m of prose) {
        if (!insideDoubleQuotes(body, m.index)) ops.push({ rule: 'R2', pos: m.index });
      }
    }
  }
  return ops;
}

/**
 * Scan the instruction corpora for shell writes to `learnings.jsonl`.
 *
 * @param {{ pluginRoot: string, dirs?: readonly string[] }} opts
 * @returns {{ ok: boolean, findings: {file: string, line: number, rule: string, text: string}[],
 *   summary: { filesScanned: number, mentions: number, exempt: number } }}
 */
export function scanLearningsShellWrites({ pluginRoot, dirs = SCAN_DIRS }) {
  const files = enumerateRepoFiles({ repoRoot: pluginRoot, dirs: [...dirs], exts: ['.md', '.mdc'] });
  const findings = [];
  let mentions = 0;
  let exempt = 0;
  for (const abs of files) {
    const lines = readFileSync(abs, 'utf8').split('\n');
    const rel = path.relative(pluginRoot, abs);
    let inFence = false;
    let prev = '';
    lines.forEach((text, i) => {
      const prevNonEmpty = prev;
      if (text.trim().length > 0) prev = text;
      if (FENCE_RE.test(text)) {
        inFence = !inFence;
        return;
      }
      if (MENTION_RE.test(text)) mentions += 1;
      const body = inFence ? text : text.replace(BLOCKQUOTE_RE, '');
      const ops = operatorsOf(body, lines, i);
      if (ops.length === 0) return;
      const lineExempt =
        EMPTY_CREATE_RE.test(body) ||
        text.includes(MARKER) ||
        prevNonEmpty.includes(MARKER) ||
        isProhibitionSentence(prevNonEmpty);
      const failing = lineExempt ? [] : ops.filter((op) => !prohibitedBefore(body, op.pos));
      if (failing.length === 0) {
        exempt += 1;
        return;
      }
      const rule = ['R1', 'R3', 'R2'].find((r) => failing.some((op) => op.rule === r));
      findings.push({ file: rel, line: i + 1, rule, text: text.trim() });
    });
  }
  return { ok: findings.length === 0, findings, summary: { filesScanned: files.length, mentions, exempt } };
}

const RULE_TEXT = Object.freeze({
  R1: 'shell redirect into learnings.jsonl',
  R2: 'redirect operator near a learnings.jsonl / store-write mention',
  R3: 'tee into learnings.jsonl',
});

/**
 * Run the human-readable validator CLI.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = clean, 1 = findings
 */
export function runCheckLearningsShellWrites(pluginRoot) {
  console.log('--- Check: no shell-redirect writes to learnings.jsonl in instruction prose ---');
  const inspection = scanLearningsShellWrites({ pluginRoot });
  for (const f of inspection.findings) {
    console.log(
      `  FAIL: [${f.rule}] ${f.file}:${f.line} ${RULE_TEXT[f.rule]} — route the write through ` +
        '`scripts/apply-session-learnings.mjs` or `sweep-expired-learnings.mjs --prune`',
    );
  }
  const s = inspection.summary;
  if (inspection.ok) {
    console.log(
      `  PASS: ${s.mentions} learnings.jsonl mention(s) in ${s.filesScanned} file(s), ` +
        `${s.exempt} exempt as prohibition`,
    );
  }
  console.log('');
  console.log(`Results: ${inspection.ok ? 1 : 0} passed, ${inspection.findings.length} failed`);
  return inspection.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--json');
  const root = path.resolve(args[0] || process.cwd());
  if (process.argv.includes('--json')) {
    const inspection = scanLearningsShellWrites({ pluginRoot: root });
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    process.exitCode = inspection.ok ? 0 : 1;
  } else {
    process.exitCode = runCheckLearningsShellWrites(root);
  }
}
