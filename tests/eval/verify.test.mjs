/**
 * tests/eval/verify.test.mjs
 *
 * CLI-level tests for scripts/eval-session.mjs (Epic #803, S3) driven via
 * spawnSync against a runtime-built fixture metrics tree:
 *   - evaluate → append → --json run_id capture
 *   - --verify <run-id> on an untouched journal → MATCH, exit 0
 *   - --verify after a tampered stored record → DRIFT, exit 1 + per-dimension diff
 *   - --verify unknown run-id → exit 1
 *   - session-not-found (abandoned-only tree) → exit 1
 *   - events-missing tree still exits 0 (FA3 Gherkin 2, non-blocking)
 *   - --no-write does not create the eval journal
 *
 * spawnSync (not execFileSync) so a non-zero exit is captured rather than
 * thrown. maxBuffer is raised (Learning 0.85: default execSync buffer can
 * overflow on verbose output). ANTHROPIC_MODEL is stripped from the child env
 * so the captured model source is deterministic.
 *
 * NOW-relativity: fixtures are built from Date.now() offsets; the engine's
 * scoring path is clock-free so re-verification reproduces byte-identically.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scenarioCleanCompleted,
  scenarioEventsMissing,
  scenarioAbandonedOnly,
  writeFixture,
  isoOffset,
} from '../fixtures/eval/metrics-tree/build.mjs';
import { mergeJudgeDimensions } from '@lib/eval/judge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../scripts/eval-session.mjs');

const dirsToClean = [];

afterEach(() => {
  while (dirsToClean.length) {
    const dir = dirsToClean.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function runCli(args) {
  const env = { ...process.env };
  delete env.ANTHROPIC_MODEL; // deterministic model source
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function evalPath(dir) {
  return path.join(dir, 'eval.jsonl');
}

describe('eval-session CLI — evaluate + write', () => {
  it('appends a JSON record and exits 0', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const r = runCli([
      '--metrics-dir', fx.dir,
      '--rubric', fx.rubricPath,
      '--model-id', 'test-model',
      '--model-source', 'self-report',
      '--json',
    ]);
    expect(r.status).toBe(0);
    const rec = JSON.parse(r.stdout);
    expect(rec.record_kind).toBe('session-eval');
    expect(rec.dimensions).toHaveLength(5);
    expect(existsSync(evalPath(fx.dir))).toBe(true);
  });

  it('--no-write evaluates without creating the journal', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const r = runCli([
      '--metrics-dir', fx.dir,
      '--rubric', fx.rubricPath,
      '--model-id', 'test-model',
      '--no-write',
      '--json',
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(evalPath(fx.dir))).toBe(false);
  });
});

describe('eval-session CLI — --verify', () => {
  it('re-verifies an untouched record as a MATCH (exit 0)', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const write = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    const runId = JSON.parse(write.stdout).run_id;

    const verify = runCli(['--verify', runId, '--metrics-dir', fx.dir, '--rubric', fx.rubricPath]);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('MATCH');
  });

  it('detects DRIFT (exit 1) when a stored dimension is tampered', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const write = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    const runId = JSON.parse(write.stdout).run_id;

    // Tamper: flip verification-evidence from pass → fail in the journal.
    const stored = JSON.parse(readFileSync(evalPath(fx.dir), 'utf8').trim());
    const dim = stored.dimensions.find((d) => d.id === 'verification-evidence');
    expect(dim.status).toBe('pass');
    dim.status = 'fail';
    writeFileSync(evalPath(fx.dir), `${JSON.stringify(stored)}\n`, 'utf8');

    const verify = runCli(['--verify', runId, '--metrics-dir', fx.dir, '--rubric', fx.rubricPath]);
    expect(verify.status).toBe(1);
    expect(verify.stdout).toContain('DRIFT');
    expect(verify.stdout).toContain('verification-evidence.status');
  });

  it('exits 1 on an unknown run-id', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    // create the journal so the reader has a file
    runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    const verify = runCli(['--verify', 'does-not-exist-eval-20260101T000000000Z', '--metrics-dir', fx.dir]);
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('run-id not found');
  });
});

describe('eval-session CLI — --verify with judge-merged records (Finding 1, qa-HIGH)', () => {
  // RED-FIRST (executed 2026-07-17 against the pre-fix engine): merging two judge
  // dimensions into a stored record made `--verify` exit 1 with
  // "instruction-adherence: present-in-stored-only" + "report-quality:
  // present-in-stored-only" — a FALSE drift. The verify re-eval NEVER dispatches
  // a judge, so `fresh.dimensions` always holds only the 5 deterministic dims,
  // while `stored.dimensions` carries 5 + 2 judge. The fix filters diffDimensions
  // to method==='deterministic' on BOTH sides (judge dims are advisory and
  // non-re-verifiable by contract), so a correctly judge-merged record re-verifies
  // as a MATCH (exit 0).
  it('re-verifies a judge-merged record as a MATCH (exit 0), not a false DRIFT', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const write = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    const runId = JSON.parse(write.stdout).run_id;

    // Append two advisory judge dims to the stored record and REPLACE the line.
    const stored = JSON.parse(readFileSync(evalPath(fx.dir), 'utf8').trim());
    const merged = mergeJudgeDimensions(stored, [
      { id: 'instruction-adherence', status: 'pass', evidence: 'followed the plan' },
      { id: 'report-quality', status: 'pass', evidence: 'evidence-anchored, no superlatives' },
    ]);
    // Sanity: the merge succeeded (validated + appended, not a no-op fallback).
    expect(merged.dimensions).toHaveLength(stored.dimensions.length + 2);
    writeFileSync(evalPath(fx.dir), `${JSON.stringify(merged)}\n`, 'utf8');

    const verify = runCli(['--verify', runId, '--metrics-dir', fx.dir, '--rubric', fx.rubricPath]);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('MATCH');
  });

  it('still detects DRIFT on a tampered DETERMINISTIC dim of a judge-merged record', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const write = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    const runId = JSON.parse(write.stdout).run_id;

    const stored = JSON.parse(readFileSync(evalPath(fx.dir), 'utf8').trim());
    const merged = mergeJudgeDimensions(stored, [
      { id: 'instruction-adherence', status: 'pass', evidence: 'followed the plan' },
      { id: 'report-quality', status: 'pass', evidence: 'evidence-anchored' },
    ]);
    // Tamper a DETERMINISTIC dim — the judge dims must NOT mask real drift.
    const det = merged.dimensions.find((d) => d.id === 'verification-evidence');
    expect(det.status).toBe('pass');
    det.status = 'fail';
    writeFileSync(evalPath(fx.dir), `${JSON.stringify(merged)}\n`, 'utf8');

    const verify = runCli(['--verify', runId, '--metrics-dir', fx.dir, '--rubric', fx.rubricPath]);
    expect(verify.status).toBe(1);
    expect(verify.stdout).toContain('DRIFT');
    expect(verify.stdout).toContain('verification-evidence.status');
  });
});

describe('eval-session CLI — argument + resolution edge cases (Finding 3)', () => {
  it('exits 1 with an argument error on an unknown flag', () => {
    const r = runCli(['--bogus']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Argument error');
  });

  it('exits 1 with a clear message when sessions.jsonl is empty', () => {
    // writeFixture with sessions:[] emits a sessions.jsonl containing only a
    // newline — parses to zero records, so resolution reports honestly.
    const fx = writeFixture({ sessionId: null, sessions: [] });
    dirsToClean.push(fx.dir);
    const r = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Cannot evaluate');
    expect(r.stderr).toContain('no session records found');
  });

  it('resolves the last valid session when a corrupt line sits between two valid ones (exit 0)', () => {
    const base = Date.now();
    const early = {
      schema_version: 1,
      session_id: 'sess-early',
      status: 'completed',
      started_at: isoOffset(base, 5),
      completed_at: isoOffset(base, 4.5),
      total_files_changed: 0,
      agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 },
      effectiveness: { planned_issues: 1, completed: 1, carryover: 0, completion_rate: 1 },
    };
    const later = {
      schema_version: 1,
      session_id: 'sess-later',
      status: 'completed',
      started_at: isoOffset(base, 3),
      completed_at: isoOffset(base, 2.5),
      total_files_changed: 0,
      agent_summary: { complete: 4, partial: 0, failed: 0, spiral: 0 },
      effectiveness: { planned_issues: 1, completed: 1, carryover: 0, completion_rate: 1 },
    };
    const fx = writeFixture({ sessionId: 'sess-later', sessions: [early, later] });
    dirsToClean.push(fx.dir);

    // Inject a corrupt JSONL line BETWEEN the two valid records; the engine reads
    // with skipInvalid, so it must skip the corrupt line and still resolve.
    const lines = readFileSync(path.join(fx.dir, 'sessions.jsonl'), 'utf8').trimEnd().split('\n');
    const withCorrupt = `${[lines[0], '{ this is : not valid json', lines[1]].join('\n')}\n`;
    writeFileSync(path.join(fx.dir, 'sessions.jsonl'), withCorrupt, 'utf8');

    const r = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).session_id).toBe('sess-later');
  });
});

describe('eval-session CLI — resolution + non-blocking behaviour', () => {
  it('exits 1 with a clear message when only abandoned sessions exist', () => {
    const fx = scenarioAbandonedOnly();
    dirsToClean.push(fx.dir);
    const r = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Cannot evaluate');
  });

  it('exits 0 even when events.jsonl is absent (FA3 Gherkin 2)', () => {
    const fx = scenarioEventsMissing();
    dirsToClean.push(fx.dir);
    const r = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    expect(r.status).toBe(0);
    const rec = JSON.parse(r.stdout);
    const cannotDetermine = rec.dimensions.filter((d) => d.status === 'cannot-determine').map((d) => d.id);
    expect(cannotDetermine).toEqual(
      expect.arrayContaining(['verification-evidence', 'gate-health', 'process-safety']),
    );
  });

  it('rejects an invalid --model-source with exit 1', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const r = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-source', 'bogus', '--no-write']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--model-source must be one of');
  });
});

describe('eval-session CLI — meta flags', () => {
  it('--version prints a semver-ish string', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help documents the exit codes', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('EXIT CODES');
    expect(r.stdout).toContain('--verify');
  });
});
