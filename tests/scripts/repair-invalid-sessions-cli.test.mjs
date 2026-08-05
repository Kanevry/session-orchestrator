/**
 * tests/scripts/repair-invalid-sessions-cli.test.mjs
 *
 * Vitest suite for scripts/repair-invalid-sessions.mjs (GitLab #1004). Drives
 * the REAL CLI subprocess against an isolated tmp repo-root seeded with the
 * golden fixture (provenance documented in
 * tests/lib/session-record-repair.test.mjs), and asserts on the JSON summary,
 * the on-disk ledger bytes, sibling-file residue, and exit codes.
 *
 * The live `.orchestrator/metrics/sessions.jsonl` is NEVER touched: every run
 * targets a tmp `--repo-root`.
 *
 * Testing-rule compliance (testing.md · cli-design.md):
 *   - Behaviour over implementation: summary + on-disk bytes + exit codes.
 *   - Hardcoded expected values.
 *   - Error paths prove the exit-code contract (0/1/2; 3 is unit-tested via the
 *     write seam in the module suite, since a corrupt write cannot be induced
 *     through the process boundary).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'repair-invalid-sessions.mjs');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'sessions-invalid-golden.jsonl');
const LEDGER_REL = path.join('.orchestrator', 'metrics', 'sessions.jsonl');

const GOLDEN_RAW = readFileSync(FIXTURE, 'utf8');

/** Total invalid records in the golden fixture (10 of 13 lines). */
const FIXTURE_INVALID = 10;

let tmp;
let repoRoot;
let ledger;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'repair-invalid-sessions-cli-'));
  repoRoot = path.join(tmp, 'repo');
  ledger = path.join(repoRoot, LEDGER_REL);
  mkdirSync(path.dirname(ledger), { recursive: true });
  writeFileSync(ledger, GOLDEN_RAW, 'utf8');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function metricsDirEntries() {
  return readdirSync(path.dirname(ledger));
}

// ---------------------------------------------------------------------------
// 6. Dry-run (default AND explicit) writes nothing
// ---------------------------------------------------------------------------

describe('dry-run is the default and writes nothing', () => {
  // Bug caught: a CLI whose default path mutates the production ledger. The
  // whole safety posture rests on --apply being an explicit opt-in.
  for (const args of [[], ['--dry-run']]) {
    it(`leaves the ledger and its directory untouched (${args.join(' ') || 'no flags'})`, () => {
      const res = run(['--repo-root', repoRoot, '--json', ...args]);

      expect(res.code).toBe(0);
      const summary = JSON.parse(res.stdout);
      expect(summary.mode).toBe('dry-run');
      expect(summary.repaired).toBe(FIXTURE_INVALID);
      expect(summary.backup_path).toBeNull();

      expect(readFileSync(ledger, 'utf8')).toBe(GOLDEN_RAW);
      expect(metricsDirEntries()).toEqual(['sessions.jsonl']);
    });
  }

  it('--dry-run overrides --apply (belt and braces)', () => {
    const res = run(['--repo-root', repoRoot, '--json', '--apply', '--dry-run']);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).mode).toBe('dry-run');
    expect(readFileSync(ledger, 'utf8')).toBe(GOLDEN_RAW);
  });
});

// ---------------------------------------------------------------------------
// 4. --apply: repairs, backs up, and is idempotent
// ---------------------------------------------------------------------------

describe('--apply', () => {
  it('repairs every invalid record and leaves a backup of the original', () => {
    const res = run(['--repo-root', repoRoot, '--json', '--apply']);

    expect(res.code).toBe(0);
    const summary = JSON.parse(res.stdout);
    expect(summary.mode).toBe('apply');
    expect(summary.invalid_before).toBe(FIXTURE_INVALID);
    expect(summary.repaired).toBe(FIXTURE_INVALID);
    expect(summary.invalid_after).toBe(0);
    expect(summary.unparseable).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.post_verify.integrity).toBe('clean');

    // The backup is the pre-run ledger, byte-for-byte.
    expect(readFileSync(summary.backup_path, 'utf8')).toBe(GOLDEN_RAW);
    // No .tmp-<pid> residue survives the atomic rename.
    expect(metricsDirEntries().filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('is idempotent: a second --apply produces a byte-identical file and repairs 0', () => {
    // Bug caught: a repair that re-writes on every run (key-order churn,
    // provenance appended repeatedly), which would make each session-close a
    // spurious diff on the ledger.
    run(['--repo-root', repoRoot, '--apply']);
    const afterRun1 = readFileSync(ledger, 'utf8');

    const res = run(['--repo-root', repoRoot, '--json', '--apply', '--no-backup']);

    expect(res.code).toBe(0);
    const summary = JSON.parse(res.stdout);
    expect(summary.invalid_before).toBe(0);
    expect(summary.repaired).toBe(0);
    expect(summary.backup_path).toBeNull();
    expect(readFileSync(ledger, 'utf8')).toBe(afterRun1);
  });

  it('preserves line count, order and duplicate ids on disk', () => {
    run(['--repo-root', repoRoot, '--apply']);

    const before = GOLDEN_RAW.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l).session_id);
    const after = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l).session_id);

    expect(after).toEqual(before);
    expect(after.filter((id) => id === 'main-2026-05-11-deep-1')).toHaveLength(3);
  });

  it('--no-backup skips the .bak copy', () => {
    const res = run(['--repo-root', repoRoot, '--json', '--apply', '--no-backup']);

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).backup_path).toBeNull();
    expect(metricsDirEntries().filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Exit-code contract (cli-design.md)
// ---------------------------------------------------------------------------

describe('exit-code contract', () => {
  it('exits 1 on an unknown flag and prints usage to stderr', () => {
    const res = run(['--repo-root', repoRoot, '--nope']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Usage:');
    expect(res.stdout).toBe('');
  });

  it('exits 2 when the ledger cannot be read', () => {
    const res = run(['--file', path.join(tmp, 'does-not-exist.jsonl'), '--repo-root', repoRoot]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('repair-invalid-sessions:');
  });

  it('--help exits 0 and documents all four exit codes', () => {
    const res = run(['--help']);
    expect(res.code).toBe(0);
    for (const code of ['0 completed', '1 arg error', '2 system error', '3 post-verification failed']) {
      expect(res.stdout).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Output surfaces
// ---------------------------------------------------------------------------

describe('output', () => {
  it('emits every documented --json summary key', () => {
    const res = run(['--repo-root', repoRoot, '--json']);
    const summary = JSON.parse(res.stdout);

    expect(Object.keys(summary)).toEqual(
      expect.arrayContaining([
        'mode',
        'file',
        'total',
        'invalid_before',
        'repaired',
        'invalid_after',
        'unparseable',
        'duplicate_ids_observed',
        'backup_path',
        'defects_by_class',
        'errors',
      ])
    );
    expect(summary.total).toBe(13);
    expect(summary.duplicate_ids_observed).toEqual([{ session_id: 'main-2026-05-11-deep-1', count: 3 }]);
  });

  it('human output names the mode, the counts and the duplicate-id preservation', () => {
    const res = run(['--repo-root', repoRoot]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Repair invalid session records — dry-run');
    expect(res.stdout).toContain('invalid before:  10');
    expect(res.stdout).toContain('never deduped');
  });

  it('reports defect classes with their counts', () => {
    const res = run(['--repo-root', repoRoot, '--json']);
    const { defects_by_class: classes } = JSON.parse(res.stdout);

    // live 85, 87, 88 — the three records with no `waves` key at all.
    expect(classes.waves_absent).toBe(3);
    expect(classes.waves_number).toBe(1);
    expect(classes.agent_summary_spiral_missing).toBe(1);
    expect(classes.wave_index_invalid).toBe(3);
    expect(classes.completed_at_missing).toBe(2);
  });
});
