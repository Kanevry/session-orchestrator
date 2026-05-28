import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execSync } from 'node:child_process';

// Entry-point invariant guard for #536 — `.orchestrator/pending-dream.md` and
// `.orchestrator/dialectic-pending.md` cross-session sidecars MUST NEVER be
// mirrored into the vault. The docblock at scripts/vault-mirror.mjs:36-48
// documents this; this test makes the invariant mechanically verifiable by
// exercising the 3-layer rejection structure of the CLI:
//
//   1. --kind whitelist at scripts/vault-mirror.mjs:153-156 → exit 1
//   2. --source existsSync at scripts/vault-mirror.mjs:166-169 → exit 2
//   3. JSON.parse at scripts/vault-mirror.mjs:199-204 → exit 1
//
// `runVaultMirror` is NOT exported by scripts/vault-mirror.mjs — main() runs
// unconditionally on import — so this suite uses the same spawnSync pattern
// as tests/unit/vault-mirror.test.mjs.

const MIRROR = resolve(process.cwd(), 'scripts/vault-mirror.mjs');

// Mirror the canonical fixtures used by tests/unit/vault-mirror.test.mjs so
// schema requirements (e.g. `insight` for v1 learnings, `agent_summary` for v1
// sessions) stay in lockstep with the rest of the suite.
const VALID_LEARNING = JSON.stringify({
  id: 'a1b2c3d4-0001-4000-8000-000000000001',
  type: 'architectural',
  subject: 'entry-point-invariant-probe',
  insight: 'Prefer explicit contracts over implicit coupling',
  evidence: 'Sidecar markdown must never reach the vault',
  confidence: 0.9,
  source_session: 'session-2026-05-23',
  created_at: '2026-05-23T10:00:00Z',
  expires_at: '2027-05-23T10:00:00Z',
});

const VALID_SESSION = JSON.stringify({
  session_id: 'session-2026-05-23-entry-point',
  session_type: 'feature',
  platform: 'claude-code',
  started_at: '2026-05-23T08:00:00Z',
  completed_at: '2026-05-23T10:00:00Z',
  duration_seconds: 7200,
  total_waves: 3,
  total_agents: 6,
  total_files_changed: 12,
  agent_summary: { complete: 5, partial: 1, failed: 0, spiral: 0 },
  waves: [
    { wave: 1, role: 'Planning', agent_count: 1, files_changed: 2, quality: 'ok' },
    { wave: 2, role: 'Implementation', agent_count: 3, files_changed: 8, quality: 'ok' },
    { wave: 3, role: 'QA', agent_count: 2, files_changed: 2, quality: 'ok' },
  ],
  effectiveness: { planned_issues: 3, completed: 3, carryover: 0, emergent: 1, completion_rate: 1.0 },
});

function runMirror(args) {
  // VAULT_MIRROR_SKIP_CANONICAL_CHECK=1 bypasses the #600 canonical-vault guard
  // so the existing #536 invariant tests (which mirror into non-git tmp dirs)
  // keep exercising the --kind/--source/JSON.parse rejection layers. The guard
  // itself is covered by the `runMirrorGuarded` suite below.
  return spawnSync('node', [MIRROR, ...args], {
    encoding: 'utf8',
    env: { ...process.env, VAULT_MIRROR_SKIP_CANONICAL_CHECK: '1' },
  });
}

// Runs the mirror WITHOUT the bypass so the #600 canonical-vault guard is live.
// Strips VAULT_MIRROR_SKIP_CANONICAL_CHECK from the inherited env in case the
// test runner itself sets it.
function runMirrorGuarded(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (extraEnv.VAULT_MIRROR_SKIP_CANONICAL_CHECK === undefined) {
    delete env.VAULT_MIRROR_SKIP_CANONICAL_CHECK;
  }
  return spawnSync('node', [MIRROR, ...args], { encoding: 'utf8', env });
}

describe('vault-mirror entry-point invariant (#536)', () => {
  let dirs = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    dirs = [];
  });

  function tmp() {
    const d = mkdtempSync(join(tmpdir(), 'vault-mirror-entry-test-'));
    dirs.push(d);
    return d;
  }

  function writeJsonl(dir, content) {
    const p = join(dir, 'source.jsonl');
    writeFileSync(p, content + '\n', 'utf8');
    return p;
  }

  it('positive control: valid JSONL with kind=learning mirrors successfully (exit 0)', () => {
    // Anchors the negative cases below: confirms the spawnSync wiring + fixture
    // are well-formed so failures in the invariant tests cannot be blamed on
    // setup drift.
    const vaultDir = tmp();
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirror([
      '--vault-dir', vaultDir,
      '--source', sourceFile,
      '--kind', 'learning',
      '--dry-run',
    ]);
    expect(result.status).toBe(0);
    const action = JSON.parse(result.stdout.trim());
    expect(action.action).toBe('created');
    expect(action.kind).toBe('learning');
  });

  it('invariant: pending-dream.md as --source fails when file missing (exit 2)', () => {
    // Layer 2 rejection: existsSync gate at scripts/vault-mirror.mjs:204-207.
    // #597: the --source path MUST resolve to a guaranteed-nonexistent location.
    // A relative path like '.orchestrator/pending-dream.md' resolves against the
    // subprocess cwd (the runner's repo root), so it would FIND a real sidecar
    // mid-consolidation and fall through to exit 1 (markdown != JSONL) — a
    // cwd-dependent flake invisible in clean-checkout CI. Anchoring at an
    // absolute path inside a fresh tmp dir we never create makes exit 2
    // deterministic regardless of cwd or whether real sidecars exist.
    const vaultDir = tmp();
    const missingSidecar = join(tmp(), '.orchestrator', 'pending-dream.md');
    const result = runMirror([
      '--vault-dir', vaultDir,
      '--source', missingSidecar,
      '--kind', 'learning',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('source file not found');
  });

  it('invariant: pending-dream.md as --source fails because Markdown is not JSONL (exit 1, fixture-based)', () => {
    // Layer 3 rejection: even when the file exists and the operator
    // intentionally points --source at the sidecar, JSON.parse on the first
    // markdown line throws "malformed JSON" and the mirror exits 1.
    const sourceDir = tmp();
    const fakeSidecar = join(sourceDir, 'pending-dream.md');
    writeFileSync(
      fakeSidecar,
      '# Pending Dream\n\nSome markdown body explaining a pending consolidation.\n',
      'utf8',
    );
    const vaultDir = tmp();
    const result = runMirror([
      '--vault-dir', vaultDir,
      '--source', fakeSidecar,
      '--kind', 'learning',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('malformed JSON');
  });

  it('invariant: dialectic-pending.md as --source fails when file missing (exit 2)', () => {
    // Layer 2 rejection for the second sidecar (PRD F2.5 / #506). Same shape
    // as the pending-dream existsSync case; documents that the same guard
    // protects both sidecars. #597: absolute path inside a fresh, never-created
    // tmp dir keeps exit 2 deterministic — a relative '.orchestrator/...' path
    // would resolve against the runner cwd and find a real sidecar mid-
    // consolidation, flaking to exit 1 (markdown != JSONL).
    const vaultDir = tmp();
    const missingSidecar = join(tmp(), '.orchestrator', 'dialectic-pending.md');
    const result = runMirror([
      '--vault-dir', vaultDir,
      '--source', missingSidecar,
      '--kind', 'session',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('source file not found');
  });

  it('invariant: dialectic-pending.md as --source fails because Markdown is not JSONL (exit 1, fixture-based)', () => {
    // Layer 3 rejection for the second sidecar. Mirrors the pending-dream
    // markdown case but uses the dialectic-pending body shape to make the
    // intent explicit at the call site.
    const sourceDir = tmp();
    const fakeSidecar = join(sourceDir, 'dialectic-pending.md');
    writeFileSync(
      fakeSidecar,
      '# Dialectic Pending\n\nProposed change: prefer explicit contracts.\n',
      'utf8',
    );
    const vaultDir = tmp();
    const result = runMirror([
      '--vault-dir', vaultDir,
      '--source', fakeSidecar,
      '--kind', 'session',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('malformed JSON');
  });

  it('invariant: --kind only accepts learning or session (sidecar cannot smuggle third kind)', () => {
    // Layer 1 rejection at scripts/vault-mirror.mjs:153-156. Even with a
    // valid JSONL source, a third --kind value (e.g. "pending-dream" or
    // "dialectic") is rejected before any processing runs. This prevents a
    // future caller from inventing a sidecar-shaped kind to smuggle non-vault
    // artifacts into the mirror pipeline.
    const vaultDir = tmp();
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirror([
      '--vault-dir', vaultDir,
      '--source', sourceFile,
      '--kind', 'pending-dream',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid --kind');
    // The session fixture is referenced so the lint/typecheck does not flag
    // it as dead, and to anchor that the rejection is on --kind, not on the
    // JSONL contents.
    expect(VALID_SESSION.length).toBeGreaterThan(0);
  });
});

// ── Canonical Meta-Vault guard (#600 D2) ───────────────────────────────────────
//
// vault-dir-drift proximate cause: scripts/vault-mirror.mjs only checked that the
// vault-dir EXISTED on disk, so a stray wrong-target path silently absorbed mirror
// writes. The guard probes `git remote get-url origin` and refuses to mirror unless
// the origin resolves to the canonical Meta-Vault (.../agents/vault). These tests
// run the entry-point WITHOUT the VAULT_MIRROR_SKIP_CANONICAL_CHECK bypass (via
// runMirrorGuarded) so the guard is live, and build real tmp git repos with
// `git init` + `git remote add origin <url>`.
describe('vault-mirror canonical-vault guard (#600)', () => {
  let dirs = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    dirs = [];
  });

  function tmp() {
    const d = mkdtempSync(join(tmpdir(), 'vault-mirror-canon-test-'));
    dirs.push(d);
    return d;
  }

  function writeJsonl(dir, content) {
    const p = join(dir, 'source.jsonl');
    writeFileSync(p, content + '\n', 'utf8');
    return p;
  }

  function gitInitWithOrigin(dir, originUrl) {
    execSync('git init -q', { cwd: dir });
    execSync(`git remote add origin ${originUrl}`, { cwd: dir });
  }

  it('canonical OK: vault with git origin .../agents/vault mirrors successfully (exit 0)', () => {
    // Positive control: the guard must let the REAL Meta-Vault through. A vault
    // whose origin is git@gitlab.example.com:agents/vault.git passes the
    // canonical check and the mirror proceeds to emit a normal action line.
    const vaultDir = tmp();
    gitInitWithOrigin(vaultDir, 'git@gitlab.example.com:agents/vault.git');
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirrorGuarded([
      '--vault-dir', vaultDir,
      '--source', sourceFile,
      '--kind', 'learning',
      '--dry-run',
    ]);
    expect(result.status).toBe(0);
    const action = JSON.parse(result.stdout.trim());
    expect(action.action).toBe('created');
    expect(action.kind).toBe('learning');
  });

  it('non-git rejected: vault dir without a git repo exits 2 with no-git-origin stderr', () => {
    // The drift proximate cause: a directory that exists but is NOT the vault.
    // `git remote get-url origin` exits 128 (not a git repo) → guard fails closed.
    const vaultDir = tmp(); // exists, but NO git init
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirrorGuarded([
      '--vault-dir', vaultDir,
      '--source', sourceFile,
      '--kind', 'learning',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not the canonical Meta-Vault/);
    expect(result.stderr).toMatch(/no git origin/);
  });

  it('wrong-remote rejected: vault with a non-canonical git origin exits 2 and names the bad origin', () => {
    // A git repo whose origin points somewhere else entirely must be rejected —
    // this is the "typo'd / wrong vault that happens to be a git checkout" case.
    const vaultDir = tmp();
    gitInitWithOrigin(vaultDir, 'git@example.com:foo/bar.git');
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirrorGuarded([
      '--vault-dir', vaultDir,
      '--source', sourceFile,
      '--kind', 'learning',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not the canonical Meta-Vault/);
    expect(result.stderr).toContain('example.com');
  });

  it('bypass honored: VAULT_MIRROR_SKIP_CANONICAL_CHECK=1 skips the guard for a non-git vault (exit 0)', () => {
    // The escape hatch the test suite depends on: with the env-var set, a non-git
    // tmp dir is accepted and the mirror runs normally. This is the mechanism that
    // keeps every other vault-mirror test green.
    const vaultDir = tmp(); // NO git init
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirrorGuarded(
      [
        '--vault-dir', vaultDir,
        '--source', sourceFile,
        '--kind', 'learning',
        '--dry-run',
      ],
      { VAULT_MIRROR_SKIP_CANONICAL_CHECK: '1' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).action).toBe('created');
  });

  // ── normalizeRemote round-trip — HTTPS form + env-override (#600 D5) ─────────
  //
  // The guard accepts ANY remote URL form whose normalised tail matches the
  // canonical suffix. These edge cases exercise the normalizeRemote() transforms:
  //   - https://host/path.git → host/path  (scheme strip + .git strip)
  //   - trailing slashes → trimmed
  //   - VAULT_MIRROR_CANONICAL_SUFFIX env override → tightens the contract.
  //
  // Without these, a refactor of normalizeRemote could silently break HTTPS or
  // env-override cases while the existing SSH-form test still passes.

  it('canonical OK: HTTPS-form origin (https://.../agents/vault.git) is accepted', () => {
    // Demonstrates the https:// + .git strip path of normalizeRemote.
    const vaultDir = tmp();
    gitInitWithOrigin(vaultDir, 'https://gitlab.example.com/agents/vault.git');
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirrorGuarded([
      '--vault-dir', vaultDir,
      '--source', sourceFile,
      '--kind', 'learning',
      '--dry-run',
    ]);
    expect(result.status).toBe(0);
    const action = JSON.parse(result.stdout.trim());
    expect(action.action).toBe('created');
    expect(action.kind).toBe('learning');
  });

  it('VAULT_MIRROR_CANONICAL_SUFFIX env override accepts a host-qualified canonical', () => {
    // Stricter env override: `gitlab.example.com/agents/vault` matches the
    // host-qualified origin URL after normalizeRemote strips git@ + .git.
    // git@gitlab.example.com:agents/vault.git → gitlab.example.com/agents/vault
    const vaultDir = tmp();
    gitInitWithOrigin(vaultDir, 'git@gitlab.example.com:agents/vault.git');
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirrorGuarded(
      [
        '--vault-dir', vaultDir,
        '--source', sourceFile,
        '--kind', 'learning',
        '--dry-run',
      ],
      { VAULT_MIRROR_CANONICAL_SUFFIX: 'gitlab.example.com/agents/vault' },
    );
    expect(result.status).toBe(0);
    const action = JSON.parse(result.stdout.trim());
    expect(action.action).toBe('created');
  });

  it('VAULT_MIRROR_CANONICAL_SUFFIX env override rejects a wrong-host vault (exit 2)', () => {
    // Counterpart to the host-qualified accept case. With the env override
    // tightened to `gitlab.example.com/agents/vault`, a vault whose origin
    // lives at `other.example.com:agents/vault.git` no longer matches and the
    // guard fails closed — even though the path tail (`/agents/vault`) would
    // pass the DEFAULT (un-host-qualified) suffix.
    const vaultDir = tmp();
    gitInitWithOrigin(vaultDir, 'git@other.example.com:agents/vault.git');
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirrorGuarded(
      [
        '--vault-dir', vaultDir,
        '--source', sourceFile,
        '--kind', 'learning',
      ],
      { VAULT_MIRROR_CANONICAL_SUFFIX: 'gitlab.example.com/agents/vault' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not the canonical Meta-Vault/);
    expect(result.stderr).toContain('other.example.com');
  });

  it('VAULT_MIRROR_CANONICAL_SUFFIX="   " (whitespace-only) falls back to the default suffix', () => {
    // Recurrence-guard for the same `||`-truthy-whitespace anti-pattern that
    // #601 fixed in getConfinementRoot. A whitespace-only env value must NOT
    // short-circuit `||` and yield a meaningless suffix; it must trim-fall
    // back to the default `/agents/vault`. Verified by the canonical-OK
    // acceptance under a whitespace env value (default suffix still applies).
    const vaultDir = tmp();
    gitInitWithOrigin(vaultDir, 'git@gitlab.example.com:agents/vault.git');
    const sourceFile = writeJsonl(tmp(), VALID_LEARNING);
    const result = runMirrorGuarded(
      [
        '--vault-dir', vaultDir,
        '--source', sourceFile,
        '--kind', 'learning',
        '--dry-run',
      ],
      { VAULT_MIRROR_CANONICAL_SUFFIX: '   ' },
    );
    expect(result.status).toBe(0);
    const action = JSON.parse(result.stdout.trim());
    expect(action.action).toBe('created');
  });
});
