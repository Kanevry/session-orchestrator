/**
 * tests/scripts/print-applicable-rules.test.mjs
 *
 * Behavioural tests for scripts/print-applicable-rules.mjs — the CLI bridge
 * (#694 / FA1) that wires loadApplicableRules() into the wave-executor's
 * per-wave agent-prompt assembly.
 *
 * Strategy: drive the CLI as a REAL subprocess against a hermetic temp repo.
 * findProjectRoot() honours CLAUDE_PROJECT_DIR when that directory contains a
 * `.claude` dir, so each test points the CLI at a temp repo whose
 * `.claude/rules`, `.claude/wave-scope.json`, `.claude/STATE.md`, and
 * `.orchestrator/host.json` are fully controlled — no dependency on the real
 * repo's rule set.
 *
 * Child-process discipline (recent learning: don't re-spawn the same heavy
 * child in every it()): the hermetic temp repo is built ONCE in beforeAll, and
 * each test spawns the (light) CLI a single time with the env it needs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'scripts', 'print-applicable-rules.mjs');

// ---------------------------------------------------------------------------
// Hermetic temp repo — built once, reused across all spawns.
// ---------------------------------------------------------------------------

let repoRoot;

/**
 * Run the CLI against the hermetic temp repo (or a caller-supplied env).
 * @param {string[]} args
 * @param {Record<string,string>} [extraEnv]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(args, extraEnv = {}) {
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot, ...extraEnv },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'print-rules-repo-'));
  const rulesDir = join(repoRoot, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });

  // Always-on rule (no frontmatter).
  writeFileSync(join(rulesDir, 'always.md'), '# Always On Rule\n\nApplies every wave.\n');
  // Glob-scoped rule matching scripts/**.
  writeFileSync(
    join(rulesDir, 'scripts.md'),
    '---\nglobs:\n  - scripts/**\n---\n\n# Scripts Rule\n',
  );

  // Default wave-scope.json — scope includes a scripts/ path so the glob rule
  // matches.
  writeFileSync(
    join(repoRoot, '.claude', 'wave-scope.json'),
    JSON.stringify({ allowedPaths: ['scripts/foo.ts'] }),
  );
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

describe('--help', () => {
  it('prints usage and exits 0', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage');
  });
});

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

describe('--json output', () => {
  it('returns count + rules array with always-on and glob-matched entries', () => {
    const { status, stdout } = runCli(['--json']);
    expect(status).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(2);
    expect(Array.isArray(parsed.rules)).toBe(true);

    const alwaysOn = parsed.rules.find((r) => r.alwaysOn === true);
    const scoped = parsed.rules.find((r) => r.alwaysOn === false);
    expect(alwaysOn.matchedGlobs).toEqual([]);
    expect(scoped.matchedGlobs).toEqual(['scripts/**']);
  });

  it('each JSON rule carries exactly path, alwaysOn, matchedGlobs', () => {
    const { stdout } = runCli(['--json']);
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed.rules[0]).sort()).toEqual(['alwaysOn', 'matchedGlobs', 'path']);
  });

  it('drops the glob-scoped rule when the wave scope does not match it', () => {
    const noMatchScope = join(repoRoot, 'no-match-scope.json');
    writeFileSync(noMatchScope, JSON.stringify({ allowedPaths: ['docs/readme.md'] }));

    const { status, stdout } = runCli(['--json', '--wave-scope', noMatchScope]);
    expect(status).toBe(0);

    const parsed = JSON.parse(stdout);
    // Only the always-on rule survives.
    expect(parsed.count).toBe(1);
    expect(parsed.rules[0].alwaysOn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Markdown (default) output
// ---------------------------------------------------------------------------

describe('Markdown output', () => {
  it('emits the header block when at least one rule matches', () => {
    const { status, stdout } = runCli([]);
    expect(status).toBe(0);
    expect(stdout).toContain('## Applicable Rules (scoped to this wave)');
  });

  it('includes the always-on rule content in the Markdown body', () => {
    const { stdout } = runCli([]);
    expect(stdout).toContain('# Always On Rule');
  });

  it('joins multiple rule contents with a horizontal-rule separator', () => {
    const { stdout } = runCli([]);
    expect(stdout).toContain('\n\n---\n\n');
  });
});

// ---------------------------------------------------------------------------
// --mode override gating (end-to-end through the CLI)
// ---------------------------------------------------------------------------

describe('--mode override', () => {
  it('excludes a mode-tagged rule whose mode differs from --mode', () => {
    // A dedicated repo with a deep-only rule, no scope file (always-on only).
    const modeRepo = mkdtempSync(join(tmpdir(), 'print-rules-mode-'));
    const modeRules = join(modeRepo, '.claude', 'rules');
    mkdirSync(modeRules, { recursive: true });
    writeFileSync(join(modeRules, 'deep-only.md'), '---\nmode: deep\n---\n\n# Deep Only\n');

    const res = spawnSync('node', [CLI, '--json', '--mode', 'feature'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: modeRepo },
    });
    rmSync(modeRepo, { recursive: true, force: true });

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --context tier gating (issue #692)
// ---------------------------------------------------------------------------

describe('--context wave tier gating', () => {
  // A dedicated repo with three always-on rules covering all tier variants:
  //   coordinator-only.md  → tier: coordinator-only  (must be EXCLUDED for wave context)
  //   wave-only.md         → tier: wave-only          (must be INCLUDED for wave context)
  //   always-tier.md       → tier: always             (must be INCLUDED for wave context)
  let contextRepo;

  beforeAll(() => {
    contextRepo = mkdtempSync(join(tmpdir(), 'print-rules-ctx-'));
    const rules = join(contextRepo, '.claude', 'rules');
    mkdirSync(rules, { recursive: true });
    mkdirSync(join(contextRepo, '.orchestrator'), { recursive: true });

    writeFileSync(
      join(rules, 'coordinator-only.md'),
      '---\ntier: coordinator-only\n---\n\n# Coordinator Only Rule\n',
    );
    writeFileSync(
      join(rules, 'wave-only.md'),
      '---\ntier: wave-only\n---\n\n# Wave Only Rule\n',
    );
    writeFileSync(
      join(rules, 'always-tier.md'),
      '---\ntier: always\n---\n\n# Always Tier Rule\n',
    );
  });

  afterAll(() => {
    rmSync(contextRepo, { recursive: true, force: true });
  });

  it('excludes tier:coordinator-only rule when --context wave is passed', () => {
    const res = spawnSync('node', [CLI, '--json', '--context', 'wave'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: contextRepo },
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    const paths = parsed.rules.map((r) => r.path);
    expect(paths.some((p) => p.endsWith('coordinator-only.md'))).toBe(false);
  });

  it('includes tier:wave-only and tier:always rules when --context wave is passed', () => {
    const res = spawnSync('node', [CLI, '--json', '--context', 'wave'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: contextRepo },
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.count).toBe(2);
    const paths = parsed.rules.map((r) => r.path);
    expect(paths.some((p) => p.endsWith('wave-only.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('always-tier.md'))).toBe(true);
  });
});

describe('--context coordinator tier gating', () => {
  // Same fixture shape, driven with --context coordinator.
  //   wave-only.md         → tier: wave-only          (must be EXCLUDED for coordinator context)
  //   coordinator-only.md  → tier: coordinator-only  (must be INCLUDED for coordinator context)
  //   always-tier.md       → tier: always             (must be INCLUDED for coordinator context)
  let contextRepo;

  beforeAll(() => {
    contextRepo = mkdtempSync(join(tmpdir(), 'print-rules-ctx-coord-'));
    const rules = join(contextRepo, '.claude', 'rules');
    mkdirSync(rules, { recursive: true });
    mkdirSync(join(contextRepo, '.orchestrator'), { recursive: true });

    writeFileSync(
      join(rules, 'coordinator-only.md'),
      '---\ntier: coordinator-only\n---\n\n# Coordinator Only Rule\n',
    );
    writeFileSync(
      join(rules, 'wave-only.md'),
      '---\ntier: wave-only\n---\n\n# Wave Only Rule\n',
    );
    writeFileSync(
      join(rules, 'always-tier.md'),
      '---\ntier: always\n---\n\n# Always Tier Rule\n',
    );
  });

  afterAll(() => {
    rmSync(contextRepo, { recursive: true, force: true });
  });

  it('excludes tier:wave-only rule when --context coordinator is passed', () => {
    const res = spawnSync('node', [CLI, '--json', '--context', 'coordinator'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: contextRepo },
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    const paths = parsed.rules.map((r) => r.path);
    expect(paths.some((p) => p.endsWith('wave-only.md'))).toBe(false);
  });

  it('includes tier:coordinator-only and tier:always rules when --context coordinator is passed', () => {
    const res = spawnSync('node', [CLI, '--json', '--context', 'coordinator'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: contextRepo },
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.count).toBe(2);
    const paths = parsed.rules.map((r) => r.path);
    expect(paths.some((p) => p.endsWith('coordinator-only.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('always-tier.md'))).toBe(true);
  });
});

describe('no --context flag (backward-compat: tier gating disabled)', () => {
  it('includes tier:coordinator-only rule when no --context flag is supplied', () => {
    // Uses an inline temp repo to avoid coupling to the shared fixture counts.
    const bcRepo = mkdtempSync(join(tmpdir(), 'print-rules-ctx-bc-'));
    const rules = join(bcRepo, '.claude', 'rules');
    mkdirSync(rules, { recursive: true });
    mkdirSync(join(bcRepo, '.orchestrator'), { recursive: true });

    writeFileSync(
      join(rules, 'coordinator-only.md'),
      '---\ntier: coordinator-only\n---\n\n# Coordinator Only Rule\n',
    );

    const res = spawnSync('node', [CLI, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: bcRepo },
    });
    rmSync(bcRepo, { recursive: true, force: true });

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.count).toBe(1);
    expect(parsed.rules[0].path).toContain('coordinator-only.md');
  });
});

// ---------------------------------------------------------------------------
// Error path — bad --wave-scope
// ---------------------------------------------------------------------------

describe('bad --wave-scope path', () => {
  it('exits 1 on a nonexistent explicit wave-scope path', () => {
    const { status, stderr } = runCli(['--wave-scope', '/nonexistent/path-xyz.json']);
    expect(status).toBe(1);
    expect(stderr).toContain('Cannot read --wave-scope');
  });

  it('exits 1 on malformed JSON in the wave-scope file', () => {
    const badJson = join(repoRoot, 'malformed-scope.json');
    writeFileSync(badJson, '{ not valid json');

    const { status, stderr } = runCli(['--wave-scope', badJson]);
    expect(status).toBe(1);
    expect(stderr).toContain('Malformed JSON');
  });
});
