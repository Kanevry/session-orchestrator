#!/usr/bin/env node
/**
 * Check: every line under `scripts/`, `hooks/` and `skills/` that builds a path
 * into `.orchestrator/metrics` routes it through a ledger resolver (GitLab
 * #1722). BLOCKING.
 *
 * ## Why
 *
 * The ledgers under `.orchestrator/metrics/` are gitignored in this repo
 * (`.gitignore:57`). A writer that joins the path to the cwd, `getProjectDir()`
 * or an unmapped repo root writes, from a linked worktree, a copy that is lost
 * with the worktree, and a reader built the same way sees an empty ledger.
 * Measured 2026-10-22 before #1722: 43 of 62 sites in 54 unrouted modules,
 * two stranded ledgers in live worktrees (`eval.jsonl`, `skill-invocations.jsonl`).
 * A first, per-FILE version of this check passed while five readers in
 * resolver-calling modules still read the worktree copy (review of the same
 * day) — hence the per-LINE rule below.
 *
 * The resolvers that answer correctly:
 *   - `resolveLedgerPath()` / `resolveLedgerRoot()` (`scripts/lib/ledger-path.mjs`)
 *     for every ledger except events and sessions — main checkout only when
 *     the ledger is gitignored in the worktree, so repos that version it keep
 *     it on the branch;
 *   - `resolveEventsLedgerRoot()` / `explainEventsLedgerRoot()` /
 *     `eventsFilePath()` (`scripts/lib/platform.mjs`, `scripts/lib/events.mjs`)
 *     for `events.jsonl` and `sessions.jsonl` (#1514, #1584);
 *   - helpers built on them (`resolveLearningsPaths`, `defaultSkillInvocationsPath`).
 *
 * ## Rule
 *
 * A HIT is a non-comment line with a `.orchestrator/metrics` string literal or
 * the segment pair `'.orchestrator', 'metrics'` (also split over two lines,
 * reported on the `'.orchestrator',` line). It passes when
 *   (a) a resolver is called on that line or on one of the {@link LOOKBACK}
 *       lines above it that belong to the same statement (a multi-line
 *       `path.join(` whose root argument comes first),
 *   (b) it declares an UPPER_CASE relative constant (string, `path.join(…)` or
 *       array of segments) — the join site of the constant is checked by (2), or
 *   (c) it, or the line above, carries the marker `ledger-root: <reason>` —
 *       for a line that is no ledger access or whose root is already resolved.
 * (2) A line that passes such a constant to `join(`/`resolve(` follows the same
 *     (a)/(c) rule.
 * A file on {@link ALLOWLIST} is skipped whole; an allowlisted file without a
 * HIT fails, so the list cannot rot.
 *
 * Ceiling: (2) sees constants declared in the same file only, and (a) trusts
 * any resolver within the lookback window. Revisit if a stranded ledger is
 * traced to an imported constant or to a line the window wrongly covered.
 *
 * @module scripts/lib/validate/check-metrics-ledger-root
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { enumerateRepoFiles } from './enumerate-repo-files.mjs';
import { isMainModule } from '../is-main-module.mjs';

export const SCAN_DIRS = Object.freeze(['scripts', 'hooks', 'skills']);

/** Lines above a HIT in which a resolver call still counts (multi-line joins). */
export const LOOKBACK = 3;

/** A string literal starting with the metrics dir, or the two-segment join. */
const METRICS_PATH_RE = /['"`]\.orchestrator\/metrics|['"]\.orchestrator['"]\s*,\s*['"]metrics['"]/;

/** The two-segment join split over two lines: `'.orchestrator',` ⏎ `'metrics'`. */
const SPLIT_HEAD_RE = /['"]\.orchestrator['"]\s*,\s*$/;
const SPLIT_TAIL_RE = /^\s*['"]metrics['"]/;

function isHit(lines, i) {
  return METRICS_PATH_RE.test(lines[i]) || (SPLIT_HEAD_RE.test(lines[i]) && SPLIT_TAIL_RE.test(lines[i + 1] ?? ''));
}

const RESOLVER_CALL_RE =
  /\b(?:resolveLedgerPath|resolveLedgerRoot|resolveEventsLedgerRoot|explainEventsLedgerRoot|eventsFilePath|resolveLearningsPaths|defaultSkillInvocationsPath)\s*\(/;

const MARKER_RE = /ledger-root:/;

/** `const NAME = '…'`, `= path.join('…'`, `= join('…'`, `= ['…'`, optionally inside Object.freeze( */
const CONST_DECL_RE =
  /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:Object\.freeze\(\s*)?(?:(?:path\.)?join\(\s*|\[\s*)?['"`]\.orchestrator/;

const PATH_FN_RE = /\b(?:join|resolve)\s*\(/;

/**
 * Files that build a metrics path on purpose without a resolver. Each reason
 * is the census verdict (2026-10-22): INTENDED-LOCAL (the data belongs to this
 * working tree), NOT-A-SINK (the string is no ledger path being opened) or
 * ROUTED-DOWNSTREAM (the path is handed to a callee that resolves each ledger).
 * Prefer the line marker `ledger-root: <reason>` for a single line in a file
 * that otherwise reads ledgers.
 */
export const ALLOWLIST = Object.freeze({
  'hooks/on-session-end.mjs':
    'ROUTED-DOWNSTREAM: hands the launch dir\'s metrics dir to the telemetry flush; buildBatch resolves each ledger in it (scripts/lib/telemetry/sync.mjs)',
  'hooks/pre-bash-sessions-ledger-guard.mjs':
    'NOT-A-SINK/INTENDED-LOCAL: matches command text, and probes the exact --repo-root the repair CLI is given',
  'scripts/lib/autopilot/flags.mjs': 'constant only: the relative DEFAULT_JSONL_PATH; the loop resolves it',
  'scripts/lib/convergence-monitor.mjs': 'NOT-A-SINK: a label and help text; the read goes through the events ledger root',
  'scripts/lib/playwright-driver/runner.mjs':
    'INTENDED-LOCAL: guards the per-run artifact dir, which the artifact builder roots in this tree',
  'scripts/lib/project-hygiene.mjs': 'NOT-A-SINK: a git ls-files pathspec over this tree\'s own index',
  'scripts/lib/quality-gate.mjs':
    'INTENDED-LOCAL: verification-failure bundles of this tree\'s gate run, which can carry secrets',
  'scripts/lib/quality-gates-cache.mjs':
    'INTENDED-LOCAL: cache keyed to this tree\'s session start ref and dependency hash',
  'scripts/lib/scope-baseline.mjs': 'NOT-A-SINK: an exclusion glob for drift counting',
  'scripts/lib/ux-grill/manifest.mjs': 'NOT-A-SINK: a .gitignore line for the run-artifact dir',
  'scripts/lib/vault-mirror/retention.mjs': 'NOT-A-SINK: text inside a generated note body',
  'scripts/lib/wave-transcript-tail.mjs': 'NOT-A-SINK: help text',
  'scripts/relocate-vault-corpus.mjs':
    'INTENDED-LOCAL: reads each child of --repos-root as named; mapping a worktree child would count its main twice',
  'scripts/run-migrate-v2-cross-repo.mjs': 'INTENDED-LOCAL: migrates the repos the operator names, as named',
});

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Line `i` plus up to {@link LOOKBACK} lines above it that belong to the SAME
 * statement — the walk stops at a line ending in `;`, `{` or `}`, or at a blank
 * line, so a resolver call in the previous statement does not cover this one.
 */
function statementWindow(lines, i) {
  const window = [lines[i]];
  for (let j = i - 1; j >= 0 && window.length <= LOOKBACK; j -= 1) {
    const prev = lines[j];
    if (prev.trim() === '' || /[;{}]\s*$/.test(prev)) break;
    window.unshift(prev);
  }
  return window.join('\n');
}

/** (a) or (c) for line `i`. */
function covered(lines, i) {
  if (RESOLVER_CALL_RE.test(statementWindow(lines, i))) return true;
  return MARKER_RE.test(lines[i]) || (i > 0 && MARKER_RE.test(lines[i - 1]));
}

/**
 * @param {{ pluginRoot: string, dirs?: readonly string[], allowlist?: Record<string, string> }} opts
 * @returns {{ ok: boolean, findings: Array<{ file: string, line: number, kind: 'unrouted'|'unrouted-constant'|'stale-allowlist', text?: string }>, summary: { filesScanned: number, hits: number, resolved: number, constants: number, marked: number, allowlisted: number } }}
 */
export function scanMetricsLedgerRoot({ pluginRoot, dirs = SCAN_DIRS, allowlist = ALLOWLIST }) {
  const files = enumerateRepoFiles({ repoRoot: pluginRoot, dirs: [...dirs], exts: ['.mjs'] });
  const findings = [];
  const seenAllowlisted = new Set();
  const summary = { filesScanned: files.length, hits: 0, resolved: 0, constants: 0, marked: 0, allowlisted: 0 };
  for (const abs of files) {
    const rel = path.relative(pluginRoot, abs).split(path.sep).join('/');
    if (/\.(test|spec)\.mjs$/.test(rel)) continue;
    const lines = readFileSync(abs, 'utf8').split('\n');
    const constNames = [];
    const fileFindings = [];
    let fileHits = 0;
    lines.forEach((line, i) => {
      if (isCommentLine(line) || !isHit(lines, i)) return;
      fileHits += 1;
      const decl = CONST_DECL_RE.exec(line);
      if (decl) {
        constNames.push(decl[1]);
        summary.constants += 1;
      } else if (covered(lines, i)) {
        summary[RESOLVER_CALL_RE.test(statementWindow(lines, i)) ? 'resolved' : 'marked'] += 1;
      } else {
        fileFindings.push({ file: rel, line: i + 1, kind: 'unrouted', text: line.trim().slice(0, 160) });
      }
    });
    if (constNames.length > 0) {
      const uses = new RegExp(`\\b(?:${constNames.join('|')})\\b`);
      lines.forEach((line, i) => {
        if (isCommentLine(line) || CONST_DECL_RE.test(line)) return;
        if (!uses.test(line) || !PATH_FN_RE.test(line) || covered(lines, i)) return;
        fileFindings.push({ file: rel, line: i + 1, kind: 'unrouted-constant', text: line.trim().slice(0, 160) });
      });
    }
    if (fileHits === 0) continue;
    summary.hits += fileHits;
    if (Object.hasOwn(allowlist, rel)) {
      seenAllowlisted.add(rel);
      continue;
    }
    findings.push(...fileFindings);
  }
  for (const rel of Object.keys(allowlist)) {
    if (!seenAllowlisted.has(rel)) findings.push({ file: rel, line: 0, kind: 'stale-allowlist' });
  }
  summary.allowlisted = seenAllowlisted.size;
  return { ok: findings.length === 0, findings, summary };
}

/**
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = clean, 1 = findings
 */
export function runCheckMetricsLedgerRoot(pluginRoot) {
  console.log('--- Check: .orchestrator/metrics paths go through a ledger resolver (#1722) ---');
  const inspection = scanMetricsLedgerRoot({ pluginRoot });
  for (const f of inspection.findings) {
    if (f.kind === 'stale-allowlist') {
      console.log(`  FAIL: ${f.file} is on the ALLOWLIST but builds no .orchestrator/metrics path any more — drop the entry`);
    } else {
      console.log(
        `  FAIL: ${f.file}:${f.line} builds a .orchestrator/metrics path without resolveLedgerPath() ` +
          '(events/sessions: resolveEventsLedgerRoot()) — from a linked worktree it reads or writes a copy ' +
          `lost with the worktree; route it, or mark a non-ledger line with \`// ledger-root: <reason>\`: ${f.text}`,
      );
    }
  }
  const s = inspection.summary;
  if (inspection.ok) {
    console.log(
      `  PASS: ${s.hits} metrics path line(s) in ${s.filesScanned} module(s): ${s.resolved} resolved, ` +
        `${s.constants} relative constant(s), ${s.marked} marked, ${s.allowlisted} allowlisted module(s)`,
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
    const inspection = scanMetricsLedgerRoot({ pluginRoot: root });
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    process.exitCode = inspection.ok ? 0 : 1;
  } else {
    process.exitCode = runCheckMetricsLedgerRoot(root);
  }
}
