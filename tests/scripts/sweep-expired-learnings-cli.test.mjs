/**
 * tests/scripts/sweep-expired-learnings-cli.test.mjs
 *
 * Vitest suite for scripts/sweep-expired-learnings.mjs (Epic #723 B4 sweep +
 * issue #1017 `--prune`).
 *
 * Covers: default dry-run no-op, --apply archives + rewrites + backs up,
 * --json summary shape, human-readable default output, --grace-days
 * override, --file/--archive path overrides, missing-store graceful exit,
 * --help, and usage errors (unknown flag, bad --grace-days value).
 *
 * The `--prune` blocks below test the CLI SURFACE only — mode gating, the
 * fail-closed `--entries` guards, the dry-run byte guarantee, the JSON shape,
 * and that the two modes do not share a predicate. Partition semantics
 * (reason routing, tombstones, the closed enum) belong to
 * `tests/lib/learnings-expiry-sweep.test.mjs` and are NOT re-tested here.
 *
 * Each test creates its own tempdir; never touches the real
 * .orchestrator/metrics/learnings.jsonl.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(process.cwd(), 'scripts/sweep-expired-learnings.mjs');
const DAY_MS = 86_400_000;

function learning(overrides = {}) {
  return {
    id: 'id-1',
    type: 'recurring-issue',
    subject: 'subject',
    insight: 'insight text',
    evidence: 'evidence text',
    confidence: 0.6,
    source_session: 'sess-1',
    created_at: new Date(Date.now() - 100 * DAY_MS).toISOString(),
    expires_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    schema_version: 1,
    ...overrides,
  };
}

function writeJsonl(filePath, entries) {
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Byte-hash of a file. The dry-run guarantee is asserted against THIS, never
 * against a record count: consolidation replaces two records with one, so a
 * count that "looks plausible" survives a write that rewrote the corpus.
 */
function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Run the CLI. Returns { stdout, stderr, status } (never throws on non-zero exit). */
function runSweep(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString?.() ?? ''),
      stderr: typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString?.() ?? ''),
      status: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

let workdir;
let learningsPath;
let archivePath;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), 'sweep-cli-'));
  learningsPath = path.join(workdir, 'learnings.jsonl');
  archivePath = path.join(workdir, 'learnings-archive.jsonl');
});

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Default (dry-run)
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — default dry-run', () => {
  it('with no flags, writes nothing and reports human-readable dry_run=true', () => {
    const oldExpired = learning({ expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString() });
    writeJsonl(learningsPath, [oldExpired]);
    const before = readFileSync(learningsPath, 'utf8');

    const result = runSweep(['--file', learningsPath, '--archive', archivePath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry_run=true');
    expect(result.stdout).toContain('archived=1');

    expect(readFileSync(learningsPath, 'utf8')).toBe(before);
    expect(existsSync(archivePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --apply
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — --apply', () => {
  it('archives stale-expired entries, rewrites the store, and creates a .bak backup', () => {
    const keep = learning({ id: 'keep-me', expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString() });
    const archive = learning({
      id: 'archive-me',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });
    writeJsonl(learningsPath, [keep, archive]);

    const result = runSweep(['--file', learningsPath, '--archive', archivePath, '--apply']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry_run=false');

    const remaining = readJsonl(learningsPath);
    expect(remaining.map((e) => e.id)).toEqual(['keep-me']);

    const archived = readJsonl(archivePath);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('archive-me');
    expect(archived[0]._archive_reason).toBe('expired');

    const backups = readdirSync(workdir).filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// --json summary shape
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — --json', () => {
  it('emits a single JSON summary line with the documented field shape', () => {
    const oldExpired = learning({ expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString() });
    writeJsonl(learningsPath, [oldExpired]);

    const result = runSweep(['--file', learningsPath, '--archive', archivePath, '--json']);
    expect(result.status).toBe(0);

    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const summary = JSON.parse(lines[0]);
    expect(summary).toEqual({
      file: learningsPath,
      grace_days: 14,
      scanned: 1,
      kept: 0,
      archived: 1,
      dryRun: true,
      archivePath,
    });
  });
});

// ---------------------------------------------------------------------------
// --grace-days override
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — --grace-days', () => {
  it('--grace-days 0 archives an entry that just barely expired', () => {
    const justExpired = learning({ expires_at: new Date(Date.now() - 1000).toISOString() }); // 1s ago
    writeJsonl(learningsPath, [justExpired]);

    const result = runSweep([
      '--file',
      learningsPath,
      '--archive',
      archivePath,
      '--grace-days',
      '0',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.grace_days).toBe(0);
    expect(summary.archived).toBe(1);
  });

  it('rejects a negative --grace-days value with exit code 1', () => {
    writeJsonl(learningsPath, [learning()]);
    const result = runSweep(['--file', learningsPath, '--archive', archivePath, '--grace-days', '-5']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--grace-days');
  });
});

// ---------------------------------------------------------------------------
// Missing store
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — missing store', () => {
  it('exits 0 with zeroed counts when the store file does not exist', () => {
    const missing = path.join(workdir, 'does-not-exist.jsonl');
    const result = runSweep(['--file', missing, '--archive', archivePath, '--apply', '--json']);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.scanned).toBe(0);
    expect(summary.kept).toBe(0);
    expect(summary.archived).toBe(0);
    expect(existsSync(archivePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — usage', () => {
  it('--help prints usage and exits 0', () => {
    const result = runSweep(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: node scripts/sweep-expired-learnings.mjs');
  });

  it('an unknown flag exits with status 1', () => {
    const result = runSweep(['--bogus-flag']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });
});

// ---------------------------------------------------------------------------
// --prune (issue #1017)
// ---------------------------------------------------------------------------

/** A record the prune path always keeps: unexpired and positive-confidence. */
function liveLearning(overrides = {}) {
  return learning({ expires_at: new Date(Date.now() + 60 * DAY_MS).toISOString(), ...overrides });
}

describe('sweep-expired-learnings.mjs — --prune dry-run', () => {
  // TV-001 — the bug: a prune path that computes the right partition but leaks
  // a write on the dry-run branch destroys the live corpus. That is the #1017
  // data-loss class verbatim, and it is invisible to a count assertion because
  // consolidation legitimately reduces the record count.
  it('leaves the store byte-identical and creates no archive while reporting archived>0', () => {
    writeJsonl(learningsPath, [
      liveLearning({ id: 'dup-low', subject: 'shared', confidence: 0.4 }),
      liveLearning({ id: 'dup-high', subject: 'shared', confidence: 0.9 }),
      learning({ id: 'gone', subject: 'stale', expires_at: new Date(Date.now() - DAY_MS).toISOString() }),
    ]);
    const before = sha256(learningsPath);

    const result = runSweep(['--prune', '--file', learningsPath, '--archive', archivePath, '--json']);
    expect(result.status).toBe(0);

    // Disk facts first — they are the guarantee. The reported counts are only
    // corroboration, and a run that WROTE would still report plausible ones.
    expect(sha256(learningsPath)).toBe(before);
    expect(existsSync(archivePath)).toBe(false);
    expect(readdirSync(workdir).filter((f) => f.includes('.bak-'))).toHaveLength(0);

    const summary = JSON.parse(result.stdout.trim());
    expect(summary.archived).toBe(2); // 1 expired + 1 consolidation loser
    expect(summary.dryRun).toBe(true);
  });
});

describe('sweep-expired-learnings.mjs — --prune --entries fail-closed guards', () => {
  // TV-001 — the bug: readLearnings() returns `{entries: [], malformed: []}` for
  // a MISSING path, and pruneLearnings treats an empty next generation as "the
  // caller dropped everything". One mistyped --entries path would therefore
  // archive the entire active store while exiting 0.
  it('exits 1 and touches nothing when the --entries sidecar does not exist', () => {
    writeJsonl(learningsPath, [liveLearning({ id: 'survivor' })]);
    const before = sha256(learningsPath);

    const result = runSweep([
      '--prune', '--apply',
      '--file', learningsPath,
      '--archive', archivePath,
      '--entries', path.join(workdir, 'typo-next.jsonl'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--entries sidecar not found');
    expect(sha256(learningsPath)).toBe(before);
    expect(existsSync(archivePath)).toBe(false);
  });

  // TV-001 — the bug: the malformed-line guard used to live in the inline
  // `node --input-type=module -e` block in skills/evolve/SKILL.md. If it did not
  // survive the move into the CLI, a half-written sidecar would read as a
  // shorter next generation and prune every record the truncated tail omitted.
  it('exits 1 and touches nothing when the --entries sidecar has a malformed line', () => {
    writeJsonl(learningsPath, [liveLearning({ id: 'survivor' })]);
    const before = sha256(learningsPath);
    const nextPath = path.join(workdir, 'next.jsonl');
    writeFileSync(nextPath, JSON.stringify(liveLearning({ id: 'survivor' })) + '\n{ truncated\n', 'utf8');

    const result = runSweep([
      '--prune', '--apply',
      '--file', learningsPath,
      '--archive', archivePath,
      '--entries', nextPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('malformed line');
    expect(sha256(learningsPath)).toBe(before);
    expect(existsSync(archivePath)).toBe(false);
  });
});

describe('sweep-expired-learnings.mjs — --prune --apply', () => {
  // TV-001 — the bug: a CLI that parses --apply/--entries but never threads them
  // into pruneLearnings() reports success while the store is untouched (or,
  // inverted, writes on the dry-run path). This is the wiring proof for the one
  // call shape /evolve actually invokes.
  it('archives an id the --entries sidecar omits and rewrites the store to the sidecar set', () => {
    const keep = liveLearning({ id: 'keep-me', subject: 'kept' });
    const drop = liveLearning({ id: 'drop-me', subject: 'dropped' });
    writeJsonl(learningsPath, [keep, drop]);
    const nextPath = path.join(workdir, 'next.jsonl');
    writeJsonl(nextPath, [keep]);

    const result = runSweep([
      '--prune', '--apply',
      '--file', learningsPath,
      '--archive', archivePath,
      '--entries', nextPath,
      '--json',
    ]);
    expect(result.status).toBe(0);

    const summary = JSON.parse(result.stdout.trim());
    expect(summary.dryRun).toBe(false);
    expect(summary.entries_from).toBe(nextPath);

    expect(readJsonl(learningsPath).map((e) => e.id)).toEqual(['keep-me']);
    const archived = readJsonl(archivePath);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('drop-me');
    expect(archived[0]._archive_reason).toBe('pruned');
  });
});

describe('sweep-expired-learnings.mjs — --prune --json', () => {
  // TV-001 — the bug: /evolve and the session-end report parse this line. A
  // renamed or dropped key (byReason especially, the only field that says WHY
  // records left) degrades the operator report to a bare number with no error.
  it('emits exactly one JSON line with the documented prune field shape', () => {
    writeJsonl(learningsPath, [
      liveLearning({ id: 'alive' }),
      learning({ id: 'dead', subject: 'stale', expires_at: new Date(Date.now() - DAY_MS).toISOString() }),
    ]);

    const result = runSweep(['--prune', '--file', learningsPath, '--archive', archivePath, '--json']);
    expect(result.status).toBe(0);

    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      file: learningsPath,
      entries_from: null,
      scanned: 2,
      kept: 1,
      archived: 1,
      byReason: { expired: 1 },
      dryRun: true,
      archivePath,
    });
  });
});

describe('sweep-expired-learnings.mjs — mode gating', () => {
  // TV-001 — the bug: silently ignoring --grace-days under --prune. The prune
  // path has no grace window by design, so a transcript showing
  // `--prune --grace-days 30` would read as "30 days of protection applied"
  // while entries expired 1 second ago were archived.
  it('--grace-days with --prune exits 1 rather than silently ignoring the window', () => {
    writeJsonl(learningsPath, [liveLearning()]);
    const before = sha256(learningsPath);

    const result = runSweep([
      '--prune', '--file', learningsPath, '--archive', archivePath, '--grace-days', '30',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--grace-days is not valid with --prune');
    expect(sha256(learningsPath)).toBe(before);
  });

  // TV-001 — the bug: the sweep has no next-generation concept, so an --entries
  // it silently ignores would read as "my next generation was applied" while the
  // sweep did an unrelated time-driven job.
  it('--entries without --prune exits 1 rather than silently ignoring the sidecar', () => {
    const nextPath = path.join(workdir, 'next.jsonl');
    writeJsonl(learningsPath, [liveLearning()]);
    writeJsonl(nextPath, []);

    const result = runSweep([
      '--file', learningsPath, '--archive', archivePath, '--entries', nextPath,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--entries is only valid with --prune');
  });
});

describe('sweep-expired-learnings.mjs — --prune and the expiry sweep do not interfere', () => {
  // TV-001 — the bug: the two modes share one file, one module, and one CLI, but
  // NOT one predicate. If prune inherited the sweep's grace window (or the sweep
  // inherited prune's grace-free rule), a record expired inside the grace window
  // would be handled identically by both — and one of the two would be wrong.
  it('a within-grace expired entry survives the sweep and is archived by the very next prune', () => {
    const justExpired = learning({
      id: 'within-grace',
      expires_at: new Date(Date.now() - DAY_MS).toISOString(), // 1d < default 14d grace
    });
    writeJsonl(learningsPath, [justExpired]);

    const swept = runSweep(['--file', learningsPath, '--archive', archivePath, '--apply', '--json']);
    expect(swept.status).toBe(0);
    expect(JSON.parse(swept.stdout.trim()).archived).toBe(0);
    // Still resident, and nothing left the corpus. (An --apply sweep re-serializes
    // the store through rewriteLearnings even at archived=0, so the claim here is
    // the PARTITION, not byte-identity — that guarantee belongs to --dry-run.)
    expect(readJsonl(learningsPath).map((e) => e.id)).toEqual(['within-grace']);
    expect(existsSync(archivePath)).toBe(false);

    const pruned = runSweep([
      '--prune', '--file', learningsPath, '--archive', archivePath, '--apply', '--json',
    ]);
    expect(pruned.status).toBe(0);
    const summary = JSON.parse(pruned.stdout.trim());
    expect(summary.archived).toBe(1);
    expect(summary.byReason).toEqual({ expired: 1 });

    expect(readJsonl(learningsPath)).toEqual([]);
    expect(readJsonl(archivePath).map((e) => e.id)).toEqual(['within-grace']);
  });
});
