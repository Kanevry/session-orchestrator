import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

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
  return spawnSync('node', [MIRROR, ...args], { encoding: 'utf8' });
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
    // Layer 2 rejection: existsSync gate at scripts/vault-mirror.mjs:166-169.
    // A literal reference to the sidecar path does not exist relative to the
    // tmp cwd, so the mirror refuses to read it and exits 2.
    const vaultDir = tmp();
    const result = runMirror([
      '--vault-dir', vaultDir,
      '--source', '.orchestrator/pending-dream.md',
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
    // protects both sidecars.
    const vaultDir = tmp();
    const result = runMirror([
      '--vault-dir', vaultDir,
      '--source', '.orchestrator/dialectic-pending.md',
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
