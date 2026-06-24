/**
 * relocate-vault-corpus.test.mjs — Integration tests for scripts/relocate-vault-corpus.mjs
 *
 * Exercises the CLI end-to-end via spawnSync (subprocess pattern).
 * Every test uses a mkdtemp throwaway fixture vault (git init + fake .md files).
 * The real ~/Projects/vault is NEVER touched.
 *
 * Covered behaviours:
 *   - --help exits 0 and prints usage
 *   - dry-run (default) plans moves without touching files
 *   - --apply performs git mv, creates manifest under .orchestrator/
 *   - --rollback reverses an --apply run
 *   - --derivable-only restricts moves to confident namespaces
 *   - Idempotency: second --apply produces 0 moves
 *   - dest-collision: pre-existing dest file is skipped, not clobbered
 *   - --mutex: --apply + --dry-run together → exit 1
 *   - D3 wikilink collision guard: no duplicate basenames across <repo>/ subfolders
 *   - --vault-dir required: missing flag → exit non-zero
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'relocate-vault-corpus.mjs');

// Resolve tmpdir to its real path (macOS /var → /private/var symlink).
const TMP_REAL = realpathSync(tmpdir());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanups = [];

function mkTmp(prefix = 'rvt-') {
  const tmp = mkdtempSync(join(TMP_REAL, prefix));
  cleanups.push(tmp);
  return tmp;
}

/**
 * Write a file, creating parent dirs as needed.
 * @param {string} base - directory root
 * @param {string} rel  - relative path
 * @param {string} content
 * @returns {string} absolute path
 */
function writeFile(base, rel, content) {
  const full = join(base, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

/**
 * Git-init the vault dir, create fixture files, and commit them so git mv works
 * on tracked files. Returns the vault directory path.
 *
 * Fixture layout:
 *   50-sessions/s1.md                          — type:session, repo:infrastructure/session-orchestrator
 *   50-sessions/s2.md                          — type:session, NO repo → _unsorted
 *   50-sessions/priv.md                        — type:session, repo:products/BuchhaltGenie → redacted-repo
 *   40-learnings/l1.md                         — type:learning, source_session:"[[s1]]" → transitive session-orchestrator
 *   40-learnings/l2.md                         — type:learning, NO source_session → _unsorted
 *   50-sessions/session-orchestrator/existing.md — already-namespaced (idempotency target)
 *
 * @returns {string} vault directory
 */
function createFixtureVault() {
  const vault = mkTmp('rvt-vault-');

  // s1: session with repo → should move to 50-sessions/session-orchestrator/s1.md
  writeFile(vault, '50-sessions/s1.md',
    '---\ntype: session\nrepo: infrastructure/session-orchestrator\n---\n# s1\n');

  // s2: session without repo → _unsorted
  writeFile(vault, '50-sessions/s2.md',
    '---\ntype: session\n---\n# s2\n');

  // priv: session with private repo → redacted-repo (CP6 leak guard)
  writeFile(vault, '50-sessions/priv.md',
    '---\ntype: session\nrepo: products/BuchhaltGenie\n---\n# priv\n');

  // l1: learning transitively linked to s1 → session-orchestrator
  writeFile(vault, '40-learnings/l1.md',
    '---\ntype: learning\nsource_session: "[[s1]]"\n---\n# l1\n');

  // l2: learning without source → _unsorted
  writeFile(vault, '40-learnings/l2.md',
    '---\ntype: learning\n---\n# l2\n');

  // already-namespaced file (must NOT be re-moved)
  writeFile(vault, '50-sessions/session-orchestrator/existing.md',
    '---\ntype: session\nrepo: infrastructure/session-orchestrator\n---\n# existing\n');

  // Git init + initial commit so git mv has tracked files to operate on
  spawnSync('git', ['init', vault], { encoding: 'utf8' });
  spawnSync('git', ['-C', vault, 'config', 'user.email', 'test@test.local'], { encoding: 'utf8' });
  spawnSync('git', ['-C', vault, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', vault, 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', vault, 'commit', '-m', 'init fixture'], { encoding: 'utf8' });

  return vault;
}

/**
 * Build a fixture for the --with-backfill cross-repo attribution path (#700).
 *
 * Lays out:
 *   <root>/vault/50-sessions/<sid>.md        — type:session, NO repo: → backfill candidate.
 *                                              frontmatter id == basename == a session_id
 *                                              listed in the sibling repo's sessions.jsonl.
 *   <root>/vault/40-learnings/bf-learn.md    — type:learning, source_session:"[[<sid>]]"
 *                                              → transitively lifts to the repo namespace.
 *   <root>/repos/<repoName>/.orchestrator/metrics/sessions.jsonl
 *                                            — authoritative sid→repo join (HIGH tier).
 *
 * The vault is git-init'd + committed so a hypothetical --apply could git mv; these
 * tests are dry-run only, but a clean tracked tree lets us assert nothing moved.
 *
 * The repos-root is a SIBLING of the vault (root/repos vs root/vault), so callers
 * must pass --repos-root explicitly unless they intentionally exercise the default.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoName='acme-app'] - sibling repo dir name (→ namespace slug)
 * @param {string} [opts.sid='feat-thing-2026-04-19-1515'] - session id == file basename
 * @param {string} [opts.branch='feat-thing'] - branch recorded in sessions.jsonl
 * @param {string} [opts.malformedJsonlLine] - if set, prepended as a bad line before the valid one
 * @returns {{ root: string, vault: string, repos: string, sid: string, repoName: string }}
 */
function createBackfillFixture(opts = {}) {
  const {
    repoName = 'acme-app',
    sid = 'feat-thing-2026-04-19-1515',
    branch = 'feat-thing',
    malformedJsonlLine = null,
  } = opts;

  const root = mkTmp('rvt-bf-');
  const vault = join(root, 'vault');
  const repos = join(root, 'repos');

  // repo:-less session note whose id == basename == the sessions.jsonl session_id
  writeFile(vault, `50-sessions/${sid}.md`,
    `---\ntype: session\nid: ${sid}\n---\n# bf session\n`);

  // learning whose source_session points at that session's BASENAME (the index key)
  writeFile(vault, '40-learnings/bf-learn.md',
    `---\ntype: learning\nsource_session: "[[${sid}]]"\n---\n# bf learning\n`);

  // sibling repo carrying the authoritative session_id in its metrics jsonl
  const validLine = JSON.stringify({
    session_id: sid,
    branch,
    started_at: '2026-04-19T15:15:00Z',
  });
  const jsonlBody = malformedJsonlLine
    ? `${malformedJsonlLine}\n${validLine}\n`
    : `${validLine}\n`;
  writeFile(repos, `${repoName}/.orchestrator/metrics/sessions.jsonl`, jsonlBody);

  // Git init + commit the vault so the tracked tree is clean (dry-run must not dirty it)
  spawnSync('git', ['init', vault], { encoding: 'utf8' });
  spawnSync('git', ['-C', vault, 'config', 'user.email', 'test@test.local'], { encoding: 'utf8' });
  spawnSync('git', ['-C', vault, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', vault, 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', vault, 'commit', '-m', 'init backfill fixture'], { encoding: 'utf8' });

  return { root, vault, repos, sid, repoName };
}

/**
 * Run the relocate-vault-corpus.mjs script.
 * @param {string[]} args
 * @param {{ timeout?: number }} [opts]
 */
function runScript(args = [], opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: opts.timeout ?? 20_000,
  });
}

/**
 * Parse JSONL stdout into an array of records.
 * @param {string} stdout
 * @returns {object[]}
 */
function parseJsonl(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Find all manifest files written under <vault>/.orchestrator/.
 * @param {string} vault
 * @returns {string[]} absolute paths
 */
function findManifests(vault) {
  const dir = join(vault, '.orchestrator');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('relocation-manifest-') && f.endsWith('.json'))
    .map((f) => join(dir, f));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Test 1: --help
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --help', () => {
  it('exits 0 and prints usage when --help is passed', { timeout: 20_000 }, () => {
    const result = runScript(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--vault-dir');
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('--apply');
  });

  it('-h alias also exits 0 and prints usage', { timeout: 20_000 }, () => {
    const result = runScript(['-h']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--vault-dir');
  });
});

// ---------------------------------------------------------------------------
// Test 2: dry-run (default) — plans moves, touches NO files
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — dry-run (default)', () => {
  it('plans s1.md move to session-orchestrator/ subdirectory without moving files', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const s1Plan = records.find(
      (r) => r.action === 'would-move' && r.from.endsWith('/s1.md'),
    );
    expect(s1Plan).toBeDefined();
    expect(s1Plan.to).toBe(join(vault, '50-sessions', 'session-orchestrator', 's1.md'));
    expect(s1Plan.namespace).toBe('session-orchestrator');
    expect(s1Plan.confident).toBe(true);

    // s1.md must still be at the original flat location
    expect(existsSync(join(vault, '50-sessions', 's1.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 'session-orchestrator', 's1.md'))).toBe(false);
  });

  it('plans l1.md transitive move to session-orchestrator/ via source_session index', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const l1Plan = records.find(
      (r) => r.action === 'would-move' && r.from.endsWith('/l1.md'),
    );
    expect(l1Plan).toBeDefined();
    expect(l1Plan.to).toBe(join(vault, '40-learnings', 'session-orchestrator', 'l1.md'));
    expect(l1Plan.namespace).toBe('session-orchestrator');

    // l1.md must still be at the original flat location
    expect(existsSync(join(vault, '40-learnings', 'l1.md'))).toBe(true);
  });

  it('plans s2.md and l2.md (no derivable repo) into _unsorted namespace', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const s2Plan = records.find(
      (r) => r.from.endsWith('/s2.md'),
    );
    const l2Plan = records.find(
      (r) => r.from.endsWith('/l2.md'),
    );

    expect(s2Plan).toBeDefined();
    expect(s2Plan.namespace).toBe('_unsorted');

    expect(l2Plan).toBeDefined();
    expect(l2Plan.namespace).toBe('_unsorted');
  });

  it('plans priv.md to redacted-repo namespace (CP6 leak guard)', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const privPlan = records.find(
      (r) => r.from.endsWith('/priv.md'),
    );
    expect(privPlan).toBeDefined();
    expect(privPlan.namespace).toBe('redacted-repo');
  });

  it('leaves all files unchanged on disk after a dry-run', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    runScript(['--vault-dir', vault, '--json']);

    // All original flat files must still exist
    expect(existsSync(join(vault, '50-sessions', 's1.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 's2.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 'priv.md'))).toBe(true);
    expect(existsSync(join(vault, '40-learnings', 'l1.md'))).toBe(true);
    expect(existsSync(join(vault, '40-learnings', 'l2.md'))).toBe(true);
    // Already-namespaced file untouched
    expect(existsSync(join(vault, '50-sessions', 'session-orchestrator', 'existing.md'))).toBe(true);
  });

  it('writes no manifest during dry-run', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    runScript(['--vault-dir', vault, '--json']);

    expect(findManifests(vault)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: --apply — moves files, writes manifest
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --apply', () => {
  it('moves s1.md to 50-sessions/session-orchestrator/s1.md and removes flat original', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--apply', '--json']);

    expect(result.status).toBe(0);

    expect(existsSync(join(vault, '50-sessions', 'session-orchestrator', 's1.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 's1.md'))).toBe(false);
  });

  it('moves l1.md to 40-learnings/session-orchestrator/l1.md transitively', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--apply', '--json']);

    expect(result.status).toBe(0);

    expect(existsSync(join(vault, '40-learnings', 'session-orchestrator', 'l1.md'))).toBe(true);
    expect(existsSync(join(vault, '40-learnings', 'l1.md'))).toBe(false);
  });

  it('emits moved records for relocated files', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--apply', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const movedS1 = records.find(
      (r) => r.action === 'moved' && r.from.endsWith('/s1.md'),
    );
    expect(movedS1).toBeDefined();
    expect(movedS1.to).toBe(join(vault, '50-sessions', 'session-orchestrator', 's1.md'));
    expect(movedS1.namespace).toBe('session-orchestrator');
    expect(movedS1.confident).toBe(true);
  });

  it('writes a manifest with correct from/to records under .orchestrator/', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    runScript(['--vault-dir', vault, '--apply', '--json']);

    const manifests = findManifests(vault);
    expect(manifests.length).toBeGreaterThanOrEqual(1);

    const manifest = JSON.parse(readFileSync(manifests[0], 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.vaultDir).toBe(vault);
    expect(Array.isArray(manifest.moves)).toBe(true);

    const s1Move = manifest.moves.find((m) => m.from.endsWith('/s1.md'));
    expect(s1Move).toBeDefined();
    expect(s1Move.to).toMatch(/50-sessions\/session-orchestrator\/s1\.md$/);
    expect(s1Move.namespace).toBe('session-orchestrator');
  });
});

// ---------------------------------------------------------------------------
// Test 4: --rollback — reverses an --apply run
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --rollback', () => {
  it('restores s1.md to its original flat location after --apply + --rollback', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    // Apply first
    runScript(['--vault-dir', vault, '--apply', '--json']);
    expect(existsSync(join(vault, '50-sessions', 'session-orchestrator', 's1.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 's1.md'))).toBe(false);

    // Get the manifest
    const manifests = findManifests(vault);
    expect(manifests.length).toBeGreaterThanOrEqual(1);

    // Rollback
    const rollbackResult = runScript(['--rollback', manifests[0], '--json']);
    expect(rollbackResult.status).toBe(0);

    // s1.md must be back at the flat location
    expect(existsSync(join(vault, '50-sessions', 's1.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 'session-orchestrator', 's1.md'))).toBe(false);
  });

  it('emits rolled-back records for each reversed move', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    runScript(['--vault-dir', vault, '--apply', '--json']);

    const manifests = findManifests(vault);
    const rollbackResult = runScript(['--rollback', manifests[0], '--json']);

    expect(rollbackResult.status).toBe(0);

    const records = parseJsonl(rollbackResult.stdout);
    const rolledBackS1 = records.find(
      (r) => r.action === 'rolled-back' && r.to.endsWith('/s1.md'),
    );
    expect(rolledBackS1).toBeDefined();
  });

  it('exits non-zero when rollback manifest does not exist', { timeout: 20_000 }, () => {
    const result = runScript(['--rollback', '/nonexistent/manifest.json', '--json']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed to read manifest');
  });
});

// ---------------------------------------------------------------------------
// Test 5: --derivable-only — only confident files move
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --derivable-only', () => {
  it('moves s1.md and l1.md (confident) but leaves s2.md, l2.md, priv.md flat', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--apply', '--derivable-only', '--json']);

    expect(result.status).toBe(0);

    // Confident files moved
    expect(existsSync(join(vault, '50-sessions', 'session-orchestrator', 's1.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 's1.md'))).toBe(false);
    expect(existsSync(join(vault, '40-learnings', 'session-orchestrator', 'l1.md'))).toBe(true);
    expect(existsSync(join(vault, '40-learnings', 'l1.md'))).toBe(false);

    // Non-confident files stay flat
    expect(existsSync(join(vault, '50-sessions', 's2.md'))).toBe(true);
    expect(existsSync(join(vault, '40-learnings', 'l2.md'))).toBe(true);
  });

  it('does NOT move priv.md under --derivable-only (redacted-repo is non-confident)', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    runScript(['--vault-dir', vault, '--apply', '--derivable-only', '--json']);

    // priv.md must remain flat; not moved to any redacted-repo/ folder
    expect(existsSync(join(vault, '50-sessions', 'priv.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 'redacted-repo', 'priv.md'))).toBe(false);
  });

  it('emits skipped/non-confident records for s2.md and l2.md', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--apply', '--derivable-only', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const s2Skipped = records.find(
      (r) => r.action === 'skipped' && r.from.endsWith('/s2.md'),
    );
    const l2Skipped = records.find(
      (r) => r.action === 'skipped' && r.from.endsWith('/l2.md'),
    );

    expect(s2Skipped).toBeDefined();
    expect(s2Skipped.reason).toBe('non-confident');

    expect(l2Skipped).toBeDefined();
    expect(l2Skipped.reason).toBe('non-confident');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Idempotency — second --apply is a no-op
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — idempotency', () => {
  it('second --apply run produces 0 moved files (already-namespaced guard)', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    // First apply
    const firstResult = runScript(['--vault-dir', vault, '--apply', '--json']);
    expect(firstResult.status).toBe(0);

    // Second apply — all flat files are already moved; flat root should be empty
    const secondResult = runScript(['--vault-dir', vault, '--apply', '--json']);
    expect(secondResult.status).toBe(0);

    const records = parseJsonl(secondResult.stdout || '');
    const movedRecords = records.filter((r) => r.action === 'moved');
    expect(movedRecords).toHaveLength(0);

    // Summary line should contain "0 moved"
    expect(secondResult.stderr).toContain('0 moved');
  });

  it('pre-existing already-namespaced file (existing.md) is never re-moved', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    // Run apply once — existing.md is already at depth 2 (in session-orchestrator/)
    const result = runScript(['--vault-dir', vault, '--apply', '--json']);
    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const existingMoved = records.find(
      (r) => r.action === 'moved' && r.from.endsWith('/existing.md'),
    );
    // existing.md must never appear as a moved record (it's already namespaced)
    expect(existingMoved).toBeUndefined();

    // File stays where it was
    expect(existsSync(join(vault, '50-sessions', 'session-orchestrator', 'existing.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 7: dest-collision — pre-existing dest file is skipped, not clobbered
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — dest-collision guard', () => {
  it('skips move when dest file already exists, emitting skipped/dest-exists', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    // Pre-create the destination file
    writeFile(
      vault,
      '50-sessions/session-orchestrator/s1.md',
      '---\ntype: session\n---\n# pre-existing dest\n',
    );
    // Stage and commit so git status is clean
    spawnSync('git', ['-C', vault, 'add', '-A'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'commit', '-m', 'add dest collision'], { encoding: 'utf8' });

    const result = runScript(['--vault-dir', vault, '--apply', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const collision = records.find(
      (r) => r.action === 'skipped' && r.from.endsWith('/s1.md'),
    );
    expect(collision).toBeDefined();
    expect(collision.reason).toBe('dest-exists');

    // Original s1.md must still be at the flat location (not moved)
    expect(existsSync(join(vault, '50-sessions', 's1.md'))).toBe(true);

    // Pre-existing dest content must be intact (not clobbered)
    const destContent = readFileSync(
      join(vault, '50-sessions', 'session-orchestrator', 's1.md'),
      'utf8',
    );
    expect(destContent).toContain('pre-existing dest');
  });
});

// ---------------------------------------------------------------------------
// Test 8: --mutex — --apply + --dry-run together → exit 1
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — mutex flags', () => {
  it('exits 1 with "mutually exclusive" message when --apply and --dry-run are both passed', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--apply', '--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });

  it('exits 1 regardless of flag order (--dry-run before --apply)', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--dry-run', '--apply']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });
});

// ---------------------------------------------------------------------------
// Test 9: D3 wikilink collision-guard — no duplicate basenames post-apply
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — D3 wikilink collision guard', () => {
  it('produces no duplicate basenames across repo/ subfolders after full --apply', { timeout: 20_000 }, () => {
    const vault = createFixtureVault();

    const result = runScript(['--vault-dir', vault, '--apply', '--json']);
    expect(result.status).toBe(0);

    // Collect all .md basenames from 40-learnings/<repo>/ and 50-sessions/<repo>/ sub-dirs
    const basenames = [];
    for (const topDir of ['40-learnings', '50-sessions']) {
      const topPath = join(vault, topDir);
      if (!existsSync(topPath)) continue;
      for (const entry of readdirSync(topPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const subPath = join(topPath, entry.name);
        for (const file of readdirSync(subPath)) {
          if (file.endsWith('.md')) {
            basenames.push(file);
          }
        }
      }
    }

    // Check for duplicates — bare Obsidian wikilinks must remain unique
    const seen = new Set();
    const duplicates = new Set();
    for (const b of basenames) {
      if (seen.has(b)) duplicates.add(b);
      seen.add(b);
    }

    expect([...duplicates]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 10: --vault-dir required — no default
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --vault-dir required', () => {
  it('exits non-zero with an error message when --vault-dir is omitted', { timeout: 20_000 }, () => {
    // Run with no --vault-dir at all — must refuse, NOT default to any real vault
    const result = runScript(['--json']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--vault-dir');
  });

  it('exits non-zero when the vault-dir path does not exist on disk', { timeout: 20_000 }, () => {
    const result = runScript(['--vault-dir', '/nonexistent/vault/that/cannot/exist', '--json']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('vault-dir');
  });
});

// ---------------------------------------------------------------------------
// Test 11: --with-backfill — cross-repo session→repo attribution (#700)
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --with-backfill (#700)', () => {
  it('attributes a repo:-less session to the repo namespace via authoritative sid-join (HIGH)', { timeout: 20_000 }, () => {
    const { vault, repos, sid } = createBackfillFixture();

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const sessionPlan = records.find(
      (r) => r.action === 'would-move' && r.from.endsWith(`/${sid}.md`),
    );
    expect(sessionPlan).toBeDefined();
    expect(sessionPlan.to).toBe(join(vault, '50-sessions', 'acme-app', `${sid}.md`));
    expect(sessionPlan.namespace).toBe('acme-app');
    expect(sessionPlan.source).toBe('backfill');
    expect(sessionPlan.confident).toBe(true);
  });

  it('transitively lifts the linked learning into the same repo namespace', { timeout: 20_000 }, () => {
    const { vault, repos } = createBackfillFixture();

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const learnPlan = records.find(
      (r) => r.action === 'would-move' && r.from.endsWith('/bf-learn.md'),
    );
    expect(learnPlan).toBeDefined();
    expect(learnPlan.to).toBe(join(vault, '40-learnings', 'acme-app', 'bf-learn.md'));
    expect(learnPlan.namespace).toBe('acme-app');
    expect(learnPlan.source).toBe('transitive');
    expect(learnPlan.confident).toBe(true);
  });

  it('does not move any file in dry-run — flat originals remain on disk', { timeout: 20_000 }, () => {
    const { vault, repos, sid } = createBackfillFixture();

    runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill', '--json']);

    // Flat originals untouched; namespaced dests never created
    expect(existsSync(join(vault, '50-sessions', `${sid}.md`))).toBe(true);
    expect(existsSync(join(vault, '40-learnings', 'bf-learn.md'))).toBe(true);
    expect(existsSync(join(vault, '50-sessions', 'acme-app', `${sid}.md`))).toBe(false);
    expect(existsSync(join(vault, '40-learnings', 'acme-app', 'bf-learn.md'))).toBe(false);
    expect(findManifests(vault)).toHaveLength(0);

    // The tracked vault tree must stay clean (dry-run wrote nothing)
    const status = spawnSync('git', ['-C', vault, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status.stdout.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Test 11b: canonical-learning — a remote-less repo dir whose CamelCase basename
// slugifies differently from its hyphenated canonical namespace must NOT split.
// The CLI learns `dir → canonical` from the vault's own repo:-carrying notes.
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --with-backfill canonical-learning (#700)', () => {
  it('backfills a repo:-less session into the canonical slug learned from a repo: note (not the CamelCase basename)', { timeout: 20_000 }, () => {
    const root = mkTmp('rvt-canon-');
    const vault = join(root, 'vault');
    const repos = join(root, 'repos');
    // The repo dir is CamelCase with NO git remote → repoCanonicalSlug falls back to
    // 'FooBar' → resolveRepoNamespace → 'foobar'. But the canonical (from repo:) is 'foo-bar'.
    const srcSid = 'canon-src-2026-04-19-1515';   // a repo:-carrying ground-truth note
    const bareSid = 'canon-bare-2026-04-19-1616';  // the repo:-less backfill candidate

    // Ground-truth repo: note → resolves to canonical 'foo-bar'
    writeFile(vault, `50-sessions/${srcSid}.md`,
      `---\ntype: session\nid: ${srcSid}\nrepo: org/foo-bar\n---\n# canon src\n`);
    // repo:-less note in the SAME remote-less dir → should learn 'foo-bar', not 'foobar'
    writeFile(vault, `50-sessions/${bareSid}.md`,
      `---\ntype: session\nid: ${bareSid}\n---\n# canon bare\n`);

    const jsonl =
      JSON.stringify({ session_id: srcSid, branch: 'canon-src', started_at: '2026-04-19T15:15:00Z' }) + '\n' +
      JSON.stringify({ session_id: bareSid, branch: 'canon-bare', started_at: '2026-04-19T16:16:00Z' }) + '\n';
    writeFile(repos, `FooBar/.orchestrator/metrics/sessions.jsonl`, jsonl);

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill', '--json']);
    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const barePlan = records.find((r) => r.action === 'would-move' && r.from.endsWith(`/${bareSid}.md`));
    expect(barePlan).toBeDefined();
    // The load-bearing assertion: canonical 'foo-bar', NOT the CamelCase-basename 'foobar'.
    expect(barePlan.namespace).toBe('foo-bar');
    expect(barePlan.to).toBe(join(vault, '50-sessions', 'foo-bar', `${bareSid}.md`));
    expect(barePlan.source).toBe('backfill');
  });
});

// ---------------------------------------------------------------------------
// Test 12: byte-identical default — without --with-backfill, no attribution
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — backfill gate (default off)', () => {
  it('leaves the repo:-less session in _unsorted (non-confident) without --with-backfill', { timeout: 20_000 }, () => {
    const { vault, repos, sid } = createBackfillFixture();

    // Same fixture, same repos-root, but the --with-backfill flag is ABSENT
    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const sessionPlan = records.find((r) => r.from.endsWith(`/${sid}.md`));
    expect(sessionPlan).toBeDefined();
    expect(sessionPlan.namespace).toBe('_unsorted');
    expect(sessionPlan.source).toBe('fallback');
    expect(sessionPlan.confident).toBe(false);
  });

  it('leaves the linked learning in _unsorted (non-confident) without --with-backfill', { timeout: 20_000 }, () => {
    const { vault, repos } = createBackfillFixture();

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const learnPlan = records.find((r) => r.from.endsWith('/bf-learn.md'));
    expect(learnPlan).toBeDefined();
    expect(learnPlan.namespace).toBe('_unsorted');
    expect(learnPlan.source).toBe('fallback');
    expect(learnPlan.confident).toBe(false);
  });

  it('reads no sessions.jsonl without the flag — neither session nor learning is confident', { timeout: 20_000 }, () => {
    const { vault, repos } = createBackfillFixture();

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--derivable-only', '--apply', '--json']);

    expect(result.status).toBe(0);

    // Under --derivable-only, non-confident files are skipped: nothing moves.
    const records = parseJsonl(result.stdout);
    const moved = records.filter((r) => r.action === 'moved');
    expect(moved).toHaveLength(0);
    expect(result.stderr).toContain('0 moved');
  });
});

// ---------------------------------------------------------------------------
// Test 13: --repos-root defaulting — parent of --vault-dir
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --repos-root defaulting', () => {
  it('defaults repos-root to the parent of --vault-dir (vault nested under repos-root)', { timeout: 20_000 }, () => {
    // Place the vault INSIDE the repos-root so the default (parent dir) finds the sibling repo.
    const reposRoot = mkTmp('rvt-default-root-');
    const vault = join(reposRoot, 'vault');
    const sid = 'feat-thing-2026-04-19-1515';

    writeFile(vault, `50-sessions/${sid}.md`,
      `---\ntype: session\nid: ${sid}\n---\n# s\n`);
    writeFile(reposRoot, `acme-app/.orchestrator/metrics/sessions.jsonl`,
      `${JSON.stringify({ session_id: sid, branch: 'feat-thing', started_at: '2026-04-19T15:15:00Z' })}\n`);

    spawnSync('git', ['init', vault], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'config', 'user.email', 'test@test.local'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'add', '-A'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'commit', '-m', 'init'], { encoding: 'utf8' });

    // NO --repos-root flag → default = parent of vault = reposRoot, which holds acme-app
    const result = runScript(['--vault-dir', vault, '--with-backfill', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const sessionPlan = records.find((r) => r.from.endsWith(`/${sid}.md`));
    expect(sessionPlan).toBeDefined();
    expect(sessionPlan.namespace).toBe('acme-app');
    expect(sessionPlan.source).toBe('backfill');
  });

  it('honours an explicit --repos-root distinct from the default', { timeout: 20_000 }, () => {
    // Sibling layout (root/vault vs root/repos): the default (root) holds NO repo,
    // so attribution only succeeds when --repos-root explicitly points at root/repos.
    const { vault, repos, sid } = createBackfillFixture();

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const sessionPlan = records.find((r) => r.from.endsWith(`/${sid}.md`));
    expect(sessionPlan.namespace).toBe('acme-app');
  });
});

// ---------------------------------------------------------------------------
// Test 14: Archiv exclusion — Archiv/ under repos-root is never scanned
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — Archiv exclusion', () => {
  it('does not scan an Archiv/ repo dir — a session matching only there stays _unsorted', { timeout: 20_000 }, () => {
    const root = mkTmp('rvt-archiv-');
    const vault = join(root, 'vault');
    const repos = join(root, 'repos');
    const sid = 'feat-thing-2026-04-19-1515';

    // Session whose sid is ONLY present in Archiv's sessions.jsonl
    writeFile(vault, `50-sessions/${sid}.md`,
      `---\ntype: session\nid: ${sid}\n---\n# s\n`);
    writeFile(repos, `Archiv/.orchestrator/metrics/sessions.jsonl`,
      `${JSON.stringify({ session_id: sid, branch: 'feat-thing', started_at: '2026-04-19T15:15:00Z' })}\n`);
    // A non-Archiv repo exists but does NOT carry this sid
    writeFile(repos, `other-repo/.orchestrator/metrics/sessions.jsonl`,
      `${JSON.stringify({ session_id: 'unrelated-2026-01-01-0000', branch: 'main', started_at: '2026-01-01T00:00:00Z' })}\n`);

    spawnSync('git', ['init', vault], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'config', 'user.email', 'test@test.local'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'add', '-A'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vault, 'commit', '-m', 'init'], { encoding: 'utf8' });

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const sessionPlan = records.find((r) => r.from.endsWith(`/${sid}.md`));
    expect(sessionPlan).toBeDefined();
    // Archiv was skipped → no sid match → falls back to _unsorted (NOT 'archiv')
    expect(sessionPlan.namespace).toBe('_unsorted');
    expect(sessionPlan.source).toBe('fallback');

    // Backfill scan reports exactly 1 repo (other-repo), proving Archiv was excluded
    expect(result.stderr).toMatch(/backfill: scanned 1 repos/);
  });
});

// ---------------------------------------------------------------------------
// Test 15: intra-batch collision detector — counter surfaced in summary
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — intra-batch collision detector', () => {
  it('reports 0 intra-batch-collisions on a clean backfill fixture', { timeout: 20_000 }, () => {
    const { vault, repos } = createBackfillFixture();

    // --with-backfill forces the intra-batch segment into the summary even at 0.
    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('0 intra-batch-collisions');
  });

  it('emits no intra-batch-collision records when no two sources share a destination', { timeout: 20_000 }, () => {
    const { vault, repos } = createBackfillFixture();

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill', '--json']);

    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const collisions = records.filter((r) => r.action === 'intra-batch-collision');
    expect(collisions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 16: --help lists both new backfill flags
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — --help backfill flags', () => {
  it('lists --with-backfill and --repos-root in the help output', { timeout: 20_000 }, () => {
    const result = runScript(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--with-backfill');
    expect(result.stdout).toContain('--repos-root');
  });
});

// ---------------------------------------------------------------------------
// Test 17: malformed JSONL tolerance — bad line skipped, valid line still wins
// ---------------------------------------------------------------------------

describe('relocate-vault-corpus — malformed JSONL tolerance', () => {
  it('skips a malformed sessions.jsonl line and still attributes via the valid line', { timeout: 20_000 }, () => {
    const { vault, repos, sid } = createBackfillFixture({
      malformedJsonlLine: 'this is not json {{{ broken',
    });

    const result = runScript(['--vault-dir', vault, '--repos-root', repos, '--with-backfill', '--json']);

    // Run must not throw — exit 0, attribution succeeds from the valid second line
    expect(result.status).toBe(0);

    const records = parseJsonl(result.stdout);
    const sessionPlan = records.find((r) => r.from.endsWith(`/${sid}.md`));
    expect(sessionPlan).toBeDefined();
    expect(sessionPlan.namespace).toBe('acme-app');
    expect(sessionPlan.source).toBe('backfill');
  });
});
