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
