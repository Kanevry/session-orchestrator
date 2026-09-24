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
 * `>` / `>>` does none of that. Measured at ebf63bd1 over 334 tracked `.md`
 * files: the one live producer was session-end Phase 3.6 step 4g ("atomic
 * rewrite with `>`") — the path that wrote a file PATH into `scope` (GH#69).
 *
 * ## Rules (only lines that mention `learnings.jsonl`)
 *
 *   R1 shell redirect  — `>`/`>>` directly in front of a `…learnings.jsonl`
 *                        target. The leading boundary (start, whitespace, `|`,
 *                        `;`, `&`, `(`) is load-bearing: without it 9 of 12
 *                        hits were `<state-dir>/…` placeholders.
 *   R2 prose operator  — a backticked `` `>` `` / `` `>>` `` on the line.
 *
 * Exempt: the line or the one above states a prohibition (NEVER / do not /
 * FORBIDDEN / verboten …), an empty-file create (`: > file`), or the marker
 * `<!-- learnings-write-check: prohibition -->` on the line or the one above.
 * Fenced blocks ARE scanned — a fenced shell snippet is exactly a shell write.
 *
 * @module scripts/lib/validate/check-learnings-shell-writes
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { enumerateRepoFiles } from './enumerate-repo-files.mjs';
import { isMainModule } from '../is-main-module.mjs';

/** Instruction corpora that tell an agent what to run. */
export const SCAN_DIRS = Object.freeze(['skills', 'commands', 'agents', 'docs', '.claude/rules', '.cursor/rules']);

const MENTION_RE = /learnings\.jsonl/;
const SHELL_REDIRECT_RE = /(?:^|[\s|;&(])(>{1,2})[ \t]*["'`]?[^\s"'`<>]*learnings\.jsonl\b/;
const PROSE_OPERATOR_RE = /`>{1,2}`/;
const PROHIBITION_RE = /\b(NEVER|[Nn]ever|DO NOT|[Dd]o not|[Dd]on't|FORBIDDEN|forbidden|verboten)\b/;
const EMPTY_CREATE_RE = /^\s*:\s*>/;
const MARKER = '<!-- learnings-write-check: prohibition -->';

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
    lines.forEach((text, i) => {
      if (!MENTION_RE.test(text)) return;
      mentions += 1;
      const rule = SHELL_REDIRECT_RE.test(text) ? 'R1' : PROSE_OPERATOR_RE.test(text) ? 'R2' : null;
      if (rule === null) return;
      const prev = i > 0 ? lines[i - 1] : '';
      if (
        PROHIBITION_RE.test(text) ||
        PROHIBITION_RE.test(prev) ||
        EMPTY_CREATE_RE.test(text) ||
        text.includes(MARKER) ||
        prev.includes(MARKER)
      ) {
        exempt += 1;
        return;
      }
      findings.push({ file: rel, line: i + 1, rule, text: text.trim() });
    });
  }
  return { ok: findings.length === 0, findings, summary: { filesScanned: files.length, mentions, exempt } };
}

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
    const what = f.rule === 'R1' ? 'shell redirect into learnings.jsonl' : 'redirect operator on a learnings.jsonl line';
    console.log(
      `  FAIL: [${f.rule}] ${f.file}:${f.line} ${what} — route the write through ` +
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
