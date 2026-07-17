/**
 * tests/eval/e2e.test.mjs
 *
 * End-to-end CLI-chain tests for the aiat-llm-eval standard (Epic #803, S8 /
 * issue #811): evaluate → journal-persist → HTML-report render → offline
 * re-verify. Each existing suite (schema.test.mjs, engine.test.mjs,
 * report.test.mjs, verify.test.mjs) already covers its own module in
 * isolation — this file is the one place that drives the FULL chain
 * (scripts/eval-session.mjs CLI + scripts/lib/eval/{schema,sink,engine,
 * session-resolve,report}.mjs) against a single fixture tree per scenario,
 * proving the modules compose, not just that each works alone.
 *
 * Isolation pattern: the runCli/evalPath helpers below are copied verbatim
 * from tests/eval/verify.test.mjs (spawnSync + ANTHROPIC_MODEL stripped from
 * the child env + a raised maxBuffer + NOW-relative fixtures built by
 * tests/fixtures/eval/metrics-tree/build.mjs) — no new isolation mechanism is
 * invented here.
 *
 * Report rendering is driven IN-PROCESS via writeEvalReport (scripts/lib/eval
 * /report.mjs) on the record the CLI just returned — the CLI itself has no
 * --report flag; a downstream caller (e.g. a future session-end eval phase)
 * would invoke the renderer the same way, off the record it just got back.
 *
 * NOW-relativity: build.mjs generates every fixture at test runtime from
 * Date.now() offsets (Zeitbomben-Learning, conf 0.9); the engine's scoring
 * path is clock-free so a same-tree re-verify reproduces byte-identically
 * regardless of when this suite runs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scenarioCleanCompleted, scenarioEventsMissing } from '../fixtures/eval/metrics-tree/build.mjs';
import { validateEvalRecord } from '@lib/eval/schema.mjs';
import { writeEvalReport } from '@lib/eval/report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../scripts/eval-session.mjs');
const FIXED_GENERATED_AT = '2026-07-16T12:00:00.000Z';

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

function readEvalLines(dir) {
  return readFileSync(evalPath(dir), 'utf8').trim().split('\n').filter(Boolean);
}

function makeReportDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-e2e-report-'));
  dirsToClean.push(dir);
  return dir;
}

describe('eval E2E chain — evaluate → persist → report → offline re-verify', () => {
  it('full happy path: run persists a schema-valid record, one journal line, a rendered report, and re-verifies MATCH', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);

    // (a)+(b) evaluate + write, capture the record via --json
    const write = runCli([
      '--metrics-dir', fx.dir,
      '--rubric', fx.rubricPath,
      '--model-id', 'test-model',
      '--model-source', 'self-report',
      '--json',
    ]);
    expect(write.status).toBe(0);
    const record = JSON.parse(write.stdout);
    expect(() => validateEvalRecord(record)).not.toThrow();
    expect(record.session_id).toBe('sess-clean');

    // (c) exactly one journal line, carrying the same run_id
    const lines = readEvalLines(fx.dir);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).run_id).toBe(record.run_id);

    // (d) render + write the HTML report from the record the CLI returned
    const reportDir = makeReportDir();
    const reportResult = writeEvalReport(record, { dir: reportDir, generatedAt: FIXED_GENERATED_AT });
    expect(reportResult.ok).toBe(true);
    expect(reportResult.path).toBe(path.join(reportDir, `${record.run_id}.html`));
    expect(existsSync(reportResult.path)).toBe(true);

    // (e) HTML carries the run_id, the exact --verify command, and the limits
    // section. FAKE-REGRESSION (executed 2026-07-17): temporarily changed the
    // 3 expectations below to a wrong run_id / a "--reverify" typo / a
    // "What this repo does not prove" typo and re-ran this single test with
    // `npx vitest run tests/eval/e2e.test.mjs -t "full happy path"` → all 3
    // went RED against the real (correct) HTML; reverted to the values below
    // → GREEN again. Proves the containment checks are exact-string
    // sensitive, not vacuously true.
    const html = readFileSync(reportResult.path, 'utf8');
    expect(html).toContain(record.run_id);
    expect(html).toContain(`node scripts/eval-session.mjs --verify ${record.run_id}`);
    expect(html).toContain('What this report does not prove');

    // (f) offline re-verify against the same tree + sink — reproducibility proof
    const verify = runCli(['--verify', record.run_id, '--metrics-dir', fx.dir, '--rubric', fx.rubricPath]);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('MATCH');
  });

  it('drift E2E: a tampered journal entry fails --verify with a per-dimension diff', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);

    const write = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    expect(write.status).toBe(0);
    const record = JSON.parse(write.stdout);

    // Tamper: flip one stored dimension's status in the journal after the fact
    // (mirrors tests/eval/verify.test.mjs's DRIFT test, applied here as one
    // link in the full evaluate→persist→verify chain rather than standalone).
    const stored = JSON.parse(readEvalLines(fx.dir)[0]);
    const dim = stored.dimensions.find((d) => d.id === 'gate-health');
    expect(dim.status).toBe('pass');
    dim.status = 'fail';
    writeFileSync(evalPath(fx.dir), `${JSON.stringify(stored)}\n`, 'utf8');

    const verify = runCli(['--verify', record.run_id, '--metrics-dir', fx.dir, '--rubric', fx.rubricPath]);
    expect(verify.status).toBe(1);
    expect(verify.stdout).toContain('DRIFT');
    // FAKE-REGRESSION (executed 2026-07-17): temporarily asserted
    // "verification-evidence.status" (a dimension NOT tampered in this test)
    // via `npx vitest run tests/eval/e2e.test.mjs -t "drift E2E"` → went RED
    // (that dimension is untouched, so no diff line names it); reverted to
    // the value below → GREEN again. Confirms the diff assertion is bound to
    // the specific dimension that was actually tampered.
    expect(verify.stdout).toContain('gate-health.status');
  });

  it('abstention E2E: a session with no events.jsonl records cannot-determine dimensions and the report renders the triage block', () => {
    const fx = scenarioEventsMissing();
    dirsToClean.push(fx.dir);

    const write = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);
    expect(write.status).toBe(0);
    const record = JSON.parse(write.stdout);
    expect(() => validateEvalRecord(record)).not.toThrow();

    const cannotDetermineIds = record.dimensions
      .filter((d) => d.status === 'cannot-determine')
      .map((d) => d.id);
    expect(cannotDetermineIds).toEqual(['verification-evidence', 'gate-health', 'process-safety']);

    const reportDir = makeReportDir();
    const reportResult = writeEvalReport(record, { dir: reportDir, generatedAt: FIXED_GENERATED_AT });
    expect(reportResult.ok).toBe(true);
    const html = readFileSync(reportResult.path, 'utf8');
    // FAKE-REGRESSION (executed 2026-07-17): temporarily asserted
    // "2 of 5 (60.0%)" (wrong count) and separately "3 of 5 (59.9%)" (wrong
    // percentage) via `npx vitest run tests/eval/e2e.test.mjs -t "abstention E2E"`
    // → both went RED against the real triage-block output; reverted to the
    // value below → GREEN again. Confirms the triage count/percentage is
    // read from the actual rendered HTML, not hardcoded independently of it.
    expect(html).toContain('<strong>cannot-determine dimensions:</strong> 3 of 5 (60.0%)');
  });
});
