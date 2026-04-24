#!/usr/bin/env node
/**
 * harness-audit.mjs — Deterministic harness-audit scorecard script.
 *
 * Runs 27 checks across 7 categories against a target repo. Emits a single
 * JSON record to stdout (schema defined in issue #210) and appends the same
 * record (with session_id) to .orchestrator/metrics/audit.jsonl.
 * Writes a human-readable summary to stderr.
 * Always exits 0 — audit never blocks.
 *
 * Usage: node scripts/harness-audit.mjs
 *
 * Stdlib only: node:fs, node:path, node:child_process, node:url.
 * Rubric version: 2026-05
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  runCategory1,
  runCategory2,
  runCategory3,
  runCategory4,
  runCategory5,
  runCategory6,
  runCategory7,
} from './lib/harness-audit/categories.mjs';

const RUBRIC_VERSION = '2026-05';

// ---------------------------------------------------------------------------
// Audit root resolution
// ---------------------------------------------------------------------------

function resolveAuditRoot() {
  const cwd = process.cwd();
  if (existsSync(join(cwd, '.git')) || existsSync(join(cwd, 'CLAUDE.md')) || existsSync(join(cwd, 'AGENTS.md'))) {
    return cwd;
  }
  try {
    const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const top = result.trim();
    if (top) return top;
  } catch { /* fall through */ }
  return cwd;
}

// ---------------------------------------------------------------------------
// Git metadata
// ---------------------------------------------------------------------------

function getGitMeta(root) {
  let branch = null;
  let headSha = null;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
  } catch { /* ignore */ }
  try {
    headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
  } catch { /* ignore */ }
  return { branch: branch || null, head_sha: headSha || null };
}

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

function getHarnessVersion(root) {
  try {
    const text = readFileSync(join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(text);
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Session ID derivation
// ---------------------------------------------------------------------------

function getSessionId(root, branch) {
  const now = new Date();
  const utcDate = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const utcHHmm = now.toISOString().slice(11, 16).replace(':', ''); // HHmm

  // Try reading STATE.md for active session_id
  const candidates = [
    join(root, '.claude/STATE.md'),
    join(root, '.codex/STATE.md'),
    join(root, '.cursor/STATE.md'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8');
      const fm = parseFrontmatter(text);
      if (fm && fm['status'] === 'active' && fm['session_id']) {
        return fm['session_id'];
      }
      // Build session-id from branch + date if status is active but no session_id key
      if (fm && fm['status'] === 'active') {
        const sessionBranch = fm['branch'] || branch || 'unknown';
        return `${sessionBranch}-${utcDate}-${utcHHmm}`;
      }
    } catch { /* ignore */ }
  }

  return `standalone-${utcDate}-${utcHHmm}`;
}

// ---------------------------------------------------------------------------
// Minimal frontmatter parser (duplicated here to avoid lib dependency in main)
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) { start = i; }
      else { end = i; break; }
    }
  }
  if (start === -1 || end === -1) return null;
  const fm = {};
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    fm[key] = val;
  }
  return fm;
}

// ---------------------------------------------------------------------------
// Score a category from its checks
// ---------------------------------------------------------------------------

function scoreCategory(name, weight, checks) {
  const maxPoints = checks.reduce((s, c) => s + c.max_points, 0);
  const earnedPoints = checks.reduce((s, c) => s + c.points, 0);
  const score010 = maxPoints > 0 ? parseFloat(((earnedPoints / maxPoints) * 10).toFixed(2)) : 0;
  return { name, weight, score_0_10: score010, earned_points: earnedPoints, max_points: maxPoints, checks };
}

// ---------------------------------------------------------------------------
// Overall band
// ---------------------------------------------------------------------------

function computeBand(score) {
  if (score >= 8.5) return 'healthy';
  if (score >= 6.0) return 'warn';
  return 'critical';
}

// ---------------------------------------------------------------------------
// stderr summary
// ---------------------------------------------------------------------------

function writeSummary(categories, summary) {
  const bandSymbol = { healthy: '[OK]', warn: '[WARN]', critical: '[CRIT]' };
  process.stderr.write('\n--- harness-audit summary ---\n');
  for (const cat of categories) {
    const band = computeBand(cat.score_0_10);
    process.stderr.write(
      `  ${cat.name.padEnd(32)} score=${cat.score_0_10.toFixed(2)}/10  ${bandSymbol[band]}\n`
    );
  }
  process.stderr.write(
    `  ${'OVERALL'.padEnd(32)} score=${summary.overall_mean_0_10.toFixed(2)}/10  ${bandSymbol[summary.overall_band]}  ` +
    `checks=${summary.checks_passed}/${summary.checks_total}\n`
  );
  process.stderr.write('-----------------------------\n\n');
}

// ---------------------------------------------------------------------------
// Append to audit.jsonl
// ---------------------------------------------------------------------------

function appendAuditRecord(root, record) {
  const metricsDir = join(root, '.orchestrator/metrics');
  try {
    mkdirSync(metricsDir, { recursive: true });
    const line = JSON.stringify(record) + '\n';
    appendFileSync(join(metricsDir, 'audit.jsonl'), line, 'utf8');
  } catch (err) {
    process.stderr.write(`harness-audit: Failed to append audit.jsonl: ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const startedAt = new Date().toISOString();
const startMs = Date.now();

const auditRoot = resolveAuditRoot();
const gitMeta = getGitMeta(auditRoot);
const harnessVersion = getHarnessVersion(auditRoot);
const sessionId = getSessionId(auditRoot, gitMeta.branch);

// Run all 7 categories
const categoryResults = [
  scoreCategory('Session Discipline',       10, runCategory1(auditRoot)),
  scoreCategory('Quality Gate Coverage',    10, runCategory2(auditRoot)),
  scoreCategory('Hook Integrity',           10, runCategory3(auditRoot)),
  scoreCategory('Persistence Health',       10, runCategory4(auditRoot)),
  scoreCategory('Plugin-Root Resolution',    9, runCategory5(auditRoot)),
  scoreCategory('Config Hygiene',            8, runCategory6(auditRoot)),
  scoreCategory('Policy Freshness',         10, runCategory7(auditRoot)),
];

const durationMs = Date.now() - startMs;

// Compute weighted mean
const totalWeight = categoryResults.reduce((s, c) => s + c.weight, 0);
const weightedSum = categoryResults.reduce((s, c) => s + c.weight * c.score_0_10, 0);
const overallMean = parseFloat((weightedSum / totalWeight).toFixed(2));

const checksPassed = categoryResults.reduce((s, c) => s + c.checks.filter((ch) => ch.status === 'pass').length, 0);
const checksTotal = categoryResults.reduce((s, c) => s + c.checks.length, 0);

const summary = {
  overall_mean_0_10: overallMean,
  overall_band: computeBand(overallMean),
  checks_passed: checksPassed,
  checks_total: checksTotal,
};

const output = {
  rubric_version: RUBRIC_VERSION,
  started_at: startedAt,
  duration_ms: durationMs,
  audit_root: auditRoot,
  harness_version: harnessVersion,
  categories: categoryResults,
  summary,
  repository: gitMeta,
};

// Write stdout (without session_id — session_id only in audit.jsonl)
process.stdout.write(JSON.stringify(output, null, 2) + '\n');

// Append to audit.jsonl (with session_id)
appendAuditRecord(auditRoot, { session_id: sessionId, ...output });

// Write stderr summary
writeSummary(categoryResults, summary);

// Always exit 0
process.exit(0);
