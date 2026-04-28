#!/usr/bin/env node
/**
 * measure-policy-cache-effectiveness.mjs
 *
 * Validates whether the quality-gates baseline cache (#258) is effective under
 * Claude Code's subprocess-per-call hook model, where each hook invocation
 * spawns a fresh Node.js process (erasing all in-process state).
 *
 * Two cache layers are measured:
 *
 *   1. quality-gates-cache.mjs  — JSONL file-based baseline-result cache.
 *      Persists to .orchestrator/metrics/baseline-results.jsonl. Survives
 *      subprocess boundaries because it reads/writes disk on every call.
 *
 *   2. quality-gates-policy.mjs — policy file loader. Reads
 *      .orchestrator/policy/quality-gates.json synchronously. No in-process
 *      memoisation — every call re-reads the file.
 *
 * Measurement model:
 *   - "subprocess-per-call" = spawn N child Node processes, each importing the
 *     module and calling the lookup once (simulates hook model).
 *   - "multi-call-in-process" = call the lookup M times in a single process
 *     (simulates repeated invocations in a long-running worker).
 *
 * Exit codes:
 *   0  Measurement complete (JSON written to stdout).
 *   1  Fatal setup error.
 *
 * Flags:
 *   --subprocess-count N   Number of subprocesses to spawn (default 8).
 *   --inprocess-count M    Calls per single-process warm test (default 5).
 *   --repo-root PATH       Repo root to measure against (default: cwd).
 *   --json                 Machine-readable JSON output (default: human).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flagValue(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx === -1) return defaultVal;
  return args[idx + 1] ?? defaultVal;
}
const flagBool = (name) => args.includes(name);

const SUBPROCESS_COUNT = parseInt(flagValue('--subprocess-count', '8'), 10);
const INPROCESS_COUNT = parseInt(flagValue('--inprocess-count', '5'), 10);
const _REPO_ROOT = resolve(flagValue('--repo-root', process.cwd()));
const JSON_MODE = flagBool('--json');

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const CACHE_MODULE = join(SCRIPT_DIR, 'lib', 'quality-gates-cache.mjs');
const POLICY_MODULE = join(SCRIPT_DIR, 'lib', 'quality-gates-policy.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hrMs(hrStart) {
  const [s, ns] = process.hrtime(hrStart);
  return s * 1000 + ns / 1e6;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// Subprocess runner — each child does ONE cache/policy lookup and prints timing
// ---------------------------------------------------------------------------

/**
 * Build a one-shot child script that imports the module and times the call.
 * The child prints a single JSON line to stdout: { callMs: number, hit: boolean }
 */
function buildChildScript_cache(repoRoot, sessionStartRef, _sessionId) {
  return `
import { loadLatestBaselineResult, isCacheValid, shouldSkipIncremental } from ${JSON.stringify(CACHE_MODULE)};
const start = process.hrtime();
const record = loadLatestBaselineResult({ repoRoot: ${JSON.stringify(repoRoot)} });
const validity = isCacheValid({ repoRoot: ${JSON.stringify(repoRoot)}, latestRecord: record, currentSessionStartRef: ${JSON.stringify(sessionStartRef)} });
const [s, ns] = process.hrtime(start);
const callMs = s * 1000 + ns / 1e6;
console.log(JSON.stringify({ callMs, hit: validity.valid, reason: validity.reason }));
`;
}

function buildChildScript_policy(repoRoot) {
  return `
import { loadQualityGatesPolicy } from ${JSON.stringify(POLICY_MODULE)};
const start = process.hrtime();
const policy = loadQualityGatesPolicy(${JSON.stringify(repoRoot)});
const [s, ns] = process.hrtime(start);
const callMs = s * 1000 + ns / 1e6;
console.log(JSON.stringify({ callMs, found: policy !== null }));
`;
}

function runChildScript(scriptSrc) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pce-'));
  const scriptPath = join(tmpDir, 'child.mjs');
  try {
    writeFileSync(scriptPath, scriptSrc, 'utf8');
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: scriptSrc,
      encoding: 'utf8',
      timeout: 10_000,
    });
    return result;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Setup: create a tmpdir repo with a seeded cache record
// ---------------------------------------------------------------------------

function setupTmpRepo() {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'pce-repo-'));
  // Minimal package.json so computeDependencyHash has something to hash
  writeFileSync(join(tmpRepo, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }), 'utf8');
  // Minimal .orchestrator/policy directory (empty — no quality-gates.json)
  mkdirSync(join(tmpRepo, '.orchestrator', 'policy'), { recursive: true });
  return tmpRepo;
}

function teardownTmpRepo(tmpRepo) {
  rmSync(tmpRepo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Seed a valid baseline-results.jsonl into the tmp repo
// ---------------------------------------------------------------------------

async function seedCacheRecord(tmpRepo, sessionStartRef, sessionId) {
  const { saveBaselineResult } = await import(CACHE_MODULE);
  saveBaselineResult({
    repoRoot: tmpRepo,
    sessionId,
    sessionStartRef,
    results: {
      typecheck: { status: 'pass', error_count: 0 },
      test: { status: 'pass' },
      lint: { status: 'pass' },
    },
  });
}

// ---------------------------------------------------------------------------
// Measurement A: cache reads across N subprocesses (subprocess-per-call model)
// ---------------------------------------------------------------------------

async function measureCacheSubprocessModel(tmpRepo, sessionStartRef, sessionId) {
  const timings = [];
  const hits = [];

  for (let i = 0; i < SUBPROCESS_COUNT; i++) {
    const script = buildChildScript_cache(tmpRepo, sessionStartRef, sessionId);
    const wallStart = process.hrtime();
    const result = runChildScript(script);
    const wallMs = hrMs(wallStart);

    if (result.status !== 0 || !result.stdout.trim()) {
      timings.push(wallMs);
      hits.push(false);
      continue;
    }
    try {
      const parsed = JSON.parse(result.stdout.trim());
      // Use the child's self-reported timing (excludes Node.js startup overhead)
      timings.push(parsed.callMs);
      hits.push(parsed.hit);
    } catch {
      timings.push(wallMs);
      hits.push(false);
    }
  }

  return {
    model: 'subprocess-per-call',
    n: SUBPROCESS_COUNT,
    timingsMs: timings,
    meanMs: mean(timings),
    medianMs: median(timings),
    hitCount: hits.filter(Boolean).length,
    hitRate: hits.filter(Boolean).length / SUBPROCESS_COUNT,
  };
}

// ---------------------------------------------------------------------------
// Measurement B: cache reads in a single process (multi-call-in-process model)
// ---------------------------------------------------------------------------

async function measureCacheInProcessModel(tmpRepo, sessionStartRef) {
  const { loadLatestBaselineResult, isCacheValid } = await import(CACHE_MODULE + '?bust=' + Date.now());
  const timings = [];
  const hits = [];

  for (let i = 0; i < INPROCESS_COUNT; i++) {
    const start = process.hrtime();
    const record = loadLatestBaselineResult({ repoRoot: tmpRepo });
    const validity = isCacheValid({ repoRoot: tmpRepo, latestRecord: record, currentSessionStartRef: sessionStartRef });
    timings.push(hrMs(start));
    hits.push(validity.valid);
  }

  return {
    model: 'multi-call-in-process',
    n: INPROCESS_COUNT,
    timingsMs: timings,
    coldMs: timings[0],
    warmMs: timings.slice(1),
    warmMeanMs: timings.length > 1 ? mean(timings.slice(1)) : null,
    hitCount: hits.filter(Boolean).length,
    hitRate: hits.filter(Boolean).length / INPROCESS_COUNT,
  };
}

// ---------------------------------------------------------------------------
// Measurement C: policy file reads across N subprocesses
// ---------------------------------------------------------------------------

async function measurePolicySubprocessModel(tmpRepo) {
  const timings = [];
  const found = [];

  for (let i = 0; i < SUBPROCESS_COUNT; i++) {
    const script = buildChildScript_policy(tmpRepo);
    const result = runChildScript(script);
    if (result.status !== 0 || !result.stdout.trim()) {
      timings.push(0);
      found.push(false);
      continue;
    }
    try {
      const parsed = JSON.parse(result.stdout.trim());
      timings.push(parsed.callMs);
      found.push(parsed.found);
    } catch {
      timings.push(0);
      found.push(false);
    }
  }

  return {
    model: 'policy-subprocess-per-call',
    n: SUBPROCESS_COUNT,
    timingsMs: timings,
    meanMs: mean(timings),
    medianMs: median(timings),
    foundCount: found.filter(Boolean).length,
  };
}

// ---------------------------------------------------------------------------
// Measurement D: policy file reads in a single process
// ---------------------------------------------------------------------------

async function measurePolicyInProcessModel(tmpRepo) {
  // Dynamic import with cache-bust forces module re-evaluation for fresh measurement
  const { loadQualityGatesPolicy } = await import(POLICY_MODULE + '?bust2=' + Date.now());
  const timings = [];

  for (let i = 0; i < INPROCESS_COUNT; i++) {
    const start = process.hrtime();
    loadQualityGatesPolicy(tmpRepo);
    timings.push(hrMs(start));
  }

  return {
    model: 'policy-multi-call-in-process',
    n: INPROCESS_COUNT,
    timingsMs: timings,
    coldMs: timings[0],
    warmMs: timings.slice(1),
    warmMeanMs: timings.length > 1 ? mean(timings.slice(1)) : null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const SESSION_START_REF = 'abc1234def5678';
  const SESSION_ID = 'measure-pce-test-session';

  const tmpRepo = setupTmpRepo();

  try {
    // Seed the JSONL cache with a valid record
    await seedCacheRecord(tmpRepo, SESSION_START_REF, SESSION_ID);

    // Run all four measurements
    const [cacheSubprocess, cacheInProcess, policySubprocess, policyInProcess] = await Promise.all([
      measureCacheSubprocessModel(tmpRepo, SESSION_START_REF, SESSION_ID),
      measureCacheInProcessModel(tmpRepo, SESSION_START_REF),
      measurePolicySubprocessModel(tmpRepo),
      measurePolicyInProcessModel(tmpRepo),
    ]);

    const report = {
      measured_at: new Date().toISOString(),
      config: { subprocessCount: SUBPROCESS_COUNT, inprocessCount: INPROCESS_COUNT },
      findings: {
        cache: {
          subprocess_model: cacheSubprocess,
          inprocess_model: cacheInProcess,
          // Key insight: cache survives subprocess boundaries (JSONL on disk)
          // Hit rate across subprocesses is expected to be 1.0 when record is valid
          persists_across_subprocesses: cacheSubprocess.hitRate === 1.0,
        },
        policy: {
          subprocess_model: policySubprocess,
          inprocess_model: policyInProcess,
          // Policy loader has NO in-process memoisation — every call reads disk
          // "warm" calls in-process are only marginally faster (OS page cache)
        },
      },
      recommendation: deriveRecommendation(cacheSubprocess, cacheInProcess, policySubprocess, policyInProcess),
    };

    if (JSON_MODE) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printHumanReport(report);
    }

    process.exit(0);
  } finally {
    teardownTmpRepo(tmpRepo);
  }
}

function deriveRecommendation(cacheSubprocess, cacheInProcess, policySubprocess, _policyInProcess) {
  const cacheHitsOk = cacheSubprocess.hitRate === 1.0;
  const cacheFastEnough = cacheSubprocess.medianMs < 5; // 5ms threshold
  const _policyFastEnough = policySubprocess.medianMs < 2; // 2ms threshold

  if (cacheHitsOk && cacheFastEnough) {
    return {
      verdict: 'KEEP',
      summary:
        'quality-gates-cache is effective under the subprocess-per-call model. ' +
        'The JSONL file-based persistence survives process boundaries. ' +
        'Call latency is within acceptable bounds.',
    };
  }
  if (!cacheHitsOk) {
    return {
      verdict: 'INVESTIGATE',
      summary:
        'Cache misses detected across subprocesses. The JSONL record may be ' +
        'invalid (session-ref-mismatch, dependency-changed, or ttl-expired). ' +
        'This is expected behaviour — the cache is correctly validating staleness.',
    };
  }
  return {
    verdict: 'KEEP_WITH_NOTE',
    summary:
      'Cache is structurally effective (hits across processes) but call latency ' +
      'is above threshold. Consider OS page-cache warm-up or mtime shortcut.',
  };
}

function printHumanReport(report) {
  const { findings, recommendation } = report;
  const cs = findings.cache.subprocess_model;
  const ci = findings.cache.inprocess_model;
  const ps = findings.policy.subprocess_model;
  const pi = findings.policy.inprocess_model;

  process.stdout.write('\n=== Policy-Cache Effectiveness Report ===\n\n');
  process.stdout.write(`Measured at: ${report.measured_at}\n`);
  process.stdout.write(`Config: ${report.config.subprocessCount} subprocesses × ${report.config.inprocessCount} in-process calls\n\n`);

  process.stdout.write('--- Baseline-Result Cache (quality-gates-cache.mjs) ---\n');
  process.stdout.write(`  Model: subprocess-per-call\n`);
  process.stdout.write(`  Hit rate across ${cs.n} subprocesses : ${(cs.hitRate * 100).toFixed(0)}%\n`);
  process.stdout.write(`  Mean call time (self-reported)    : ${cs.meanMs.toFixed(3)} ms\n`);
  process.stdout.write(`  Median call time                  : ${cs.medianMs.toFixed(3)} ms\n`);
  process.stdout.write(`  Persists across subprocess bounds : ${findings.cache.persists_across_subprocesses}\n\n`);

  process.stdout.write(`  Model: multi-call-in-process\n`);
  process.stdout.write(`  Cold call (call #1)               : ${ci.coldMs.toFixed(3)} ms\n`);
  if (ci.warmMeanMs !== null) {
    process.stdout.write(`  Warm mean (calls #2–${ci.n})           : ${ci.warmMeanMs.toFixed(3)} ms\n`);
  }
  process.stdout.write(`  Hit rate                          : ${(ci.hitRate * 100).toFixed(0)}%\n\n`);

  process.stdout.write('--- Policy File Loader (quality-gates-policy.mjs) ---\n');
  process.stdout.write(`  Model: subprocess-per-call\n`);
  process.stdout.write(`  Policy files found                : ${ps.foundCount}/${ps.n}\n`);
  process.stdout.write(`  Mean call time (self-reported)    : ${ps.meanMs.toFixed(3)} ms\n`);
  process.stdout.write(`  Median call time                  : ${ps.medianMs.toFixed(3)} ms\n\n`);

  process.stdout.write(`  Model: multi-call-in-process\n`);
  process.stdout.write(`  Cold call (call #1)               : ${pi.coldMs.toFixed(3)} ms\n`);
  if (pi.warmMeanMs !== null) {
    process.stdout.write(`  Warm mean (calls #2–${pi.n})           : ${pi.warmMeanMs.toFixed(3)} ms\n`);
  }
  process.stdout.write('\n');

  process.stdout.write(`--- Recommendation ---\n`);
  process.stdout.write(`  Verdict : ${recommendation.verdict}\n`);
  process.stdout.write(`  Summary : ${recommendation.summary}\n\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
