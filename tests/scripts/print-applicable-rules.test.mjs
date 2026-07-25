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
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
  statSync,
  readFileSync,
} from 'node:fs';
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

// ---------------------------------------------------------------------------
// Pipe delivery — payload exceeding the 64KiB OS pipe buffer (#876)
// ---------------------------------------------------------------------------
//
// process.stdout.write() to a pipe is ASYNCHRONOUS in Node. Calling
// process.exit() immediately after the write races the kernel pipe buffer
// (65536 bytes on macOS) — data beyond that threshold is silently discarded
// while the process still reports exit code 0. The fixtures used everywhere
// else in this file are ~38 bytes and can never exercise that race — a naive
// "swap spawnSync for a real pipe" regression test would stay green against
// the broken code for exactly that reason. These fixtures are built large
// enough (and their size is asserted, not assumed) to force the race every
// time, for BOTH the Markdown path (content-heavy: few files, large bodies)
// and the --json path (metadata-only: no rule `content` field, so it needs
// MANY files instead of large bodies to cross the same threshold).

const PIPE_BUFFER_BYTES = 65536;

/**
 * Runs the CLI with stdout redirected to a real on-disk file (not a pipe) —
 * this is the ground-truth "complete" byte count a correct pipe delivery
 * must match. A file descriptor is never subject to the OS pipe-buffer race
 * that affects a pipe/FIFO, so this measurement cannot itself be truncated.
 * @param {string} cwd - hermetic repo root to run the CLI against
 * @param {string[]} args
 * @returns {number} byte length of the captured output
 */
function fileRedirectByteLength(cwd, args) {
  const outPath = join(cwd, `complete-${Math.random().toString(36).slice(2)}.out`);
  const fd = openSync(outPath, 'w');
  try {
    const res = spawnSync('node', [CLI, ...args], {
      stdio: ['ignore', fd, 'ignore'],
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
    if (res.status !== 0) {
      throw new Error(`CLI exited ${res.status} while building the file-redirect baseline`);
    }
  } finally {
    closeSync(fd);
  }
  return statSync(outPath).size;
}

describe('pipe delivery exceeding the 64KiB pipe buffer', () => {
  // Content-heavy fixture for the Markdown path: few files, large bodies —
  // the Markdown block embeds each rule's full raw content.
  let markdownRepo;
  // Metadata-only fixture for the --json path: --json output carries only
  // {path, alwaysOn, matchedGlobs} per rule (no `content`), so reaching the
  // same byte threshold needs MANY small files instead of large bodies.
  let jsonRepo;

  beforeAll(() => {
    markdownRepo = mkdtempSync(join(tmpdir(), 'print-rules-pipe-md-'));
    mkdirSync(join(markdownRepo, '.claude', 'rules'), { recursive: true });
    mkdirSync(join(markdownRepo, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(markdownRepo, '.claude', 'wave-scope.json'),
      JSON.stringify({ allowedPaths: [] }),
    );
    // 40 always-on rules x ~2KB body each -> comfortably over 65536 bytes
    // once joined with the '\n\n---\n\n' separators and header.
    for (let i = 0; i < 40; i++) {
      const body = `# Rule ${i}\n\n${'x'.repeat(2000)}\n`;
      writeFileSync(
        join(markdownRepo, '.claude', 'rules', `rule-${String(i).padStart(2, '0')}.md`),
        body,
      );
    }

    jsonRepo = mkdtempSync(join(tmpdir(), 'print-rules-pipe-json-'));
    mkdirSync(join(jsonRepo, '.claude', 'rules'), { recursive: true });
    mkdirSync(join(jsonRepo, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(jsonRepo, '.claude', 'wave-scope.json'),
      JSON.stringify({ allowedPaths: [] }),
    );
    // 650 always-on rules (tiny bodies — content is irrelevant to --json
    // output) -> the per-rule {path, alwaysOn, matchedGlobs} JSON entries
    // alone exceed 65536 bytes (empirically ~125 bytes/entry).
    for (let i = 0; i < 650; i++) {
      writeFileSync(join(jsonRepo, '.claude', 'rules', `r${String(i).padStart(4, '0')}.md`), '# R\n');
    }
  });

  afterAll(() => {
    rmSync(markdownRepo, { recursive: true, force: true });
    rmSync(jsonRepo, { recursive: true, force: true });
  });

  it('Markdown output through a spawnSync pipe is byte-identical to the file-redirect baseline', () => {
    const completeLen = fileRedirectByteLength(markdownRepo, []);
    expect(completeLen).toBeGreaterThan(PIPE_BUFFER_BYTES); // fixture sanity

    const res = spawnSync('node', [CLI], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: markdownRepo },
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(res.status).toBe(0);
    expect(res.stdout.length).toBe(completeLen);
  });

  it('--json output through a spawnSync pipe is byte-identical to the file-redirect baseline', () => {
    const completeLen = fileRedirectByteLength(jsonRepo, ['--json']);
    expect(completeLen).toBeGreaterThan(PIPE_BUFFER_BYTES); // fixture sanity

    const res = spawnSync('node', [CLI, '--json'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: jsonRepo },
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(res.status).toBe(0);
    expect(res.stdout.length).toBe(completeLen);
    // Byte-count parity alone would pass even on a coincidental match; also
    // confirm the payload is a syntactically complete JSON document (a
    // truncated tail fails to parse).
    expect(() => JSON.parse(res.stdout.toString('utf8'))).not.toThrow();
  });

  it('Markdown output through execFileSync (a continuously-draining reader) is byte-identical to the file-redirect baseline', () => {
    // Guards against the issue's original claim that a continuously-draining
    // synchronous reader (execFileSync) is immune to the truncation — it is
    // not, because the race is on the WRITER side (process.exit before the
    // kernel pipe buffer drains), not on how fast the reader consumes. (The
    // disproof itself only holds counterfactually, against the pre-fix code;
    // run here against the fixed CLI, this test asserts completeness.)
    const completeLen = fileRedirectByteLength(markdownRepo, []);
    const stdout = execFileSync('node', [CLI], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: markdownRepo },
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(stdout.length).toBe(completeLen);
  });

  it('delivers the Markdown payload through an actual shell pipe (node ... | wc -c) byte-identical to the file-redirect baseline', () => {
    const completeLen = fileRedirectByteLength(markdownRepo, []);
    const res = spawnSync('sh', ['-c', `node "${CLI}" | wc -c`], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: markdownRepo },
    });
    expect(res.status).toBe(0);
    expect(parseInt(res.stdout.trim(), 10)).toBe(completeLen);
  });

  // -------------------------------------------------------------------------
  // EPIPE — an early-closing reader must not crash (regression follow-up on
  // #876). #876 fixed silent truncation by removing process.exit(0) after the
  // stdout writes, but did not handle the case where the READER closes the
  // pipe early ('| head', '| grep -q'): process.stdout.write() then fails
  // asynchronously with EPIPE, which — left unhandled — is an uncaught
  // exception (Node prints "Unhandled 'error' event" + a stack trace to
  // stderr and exits 1). Both assertions run through `bash -c` with
  // `set -o pipefail` so `$?` reflects the CLI's OWN exit status, not the
  // downstream reader's (mirrors the exact reproduction used to diagnose this
  // regression).
  //
  // Fixture-size gotcha (empirically probed, not assumed): the markdownRepo
  // fixture above (40 rules, ~80KB) is NOT reliably large enough to force
  // this race — a real `head`/`grep` implementation can drain that much in
  // its own read buffer(s) before it decides to close, so the writer can
  // finish successfully before the reader ever hangs up (probed 5/5 runs,
  // zero EPIPEs at ~80KB). At ~200KB the race reproduces 5/5. This nested
  // describe therefore builds its own larger, dedicated fixture rather than
  // reusing markdownRepo — the two fixtures serve different purposes
  // (byte-parity vs. forcing an early-close race) and conflating them would
  // make the EPIPE assertions flaky.
  // -------------------------------------------------------------------------

  describe('EPIPE — early-closing reader', () => {
    let epipeRepo;

    beforeAll(() => {
      epipeRepo = mkdtempSync(join(tmpdir(), 'print-rules-pipe-epipe-'));
      mkdirSync(join(epipeRepo, '.claude', 'rules'), { recursive: true });
      mkdirSync(join(epipeRepo, '.orchestrator'), { recursive: true });
      writeFileSync(
        join(epipeRepo, '.claude', 'wave-scope.json'),
        JSON.stringify({ allowedPaths: [] }),
      );
      // 120 always-on rules x ~2KB body each -> ~240KB, well past the ~200KB
      // empirically-observed threshold for reliably forcing an early-closing
      // reader to trigger EPIPE on the writer side.
      for (let i = 0; i < 120; i++) {
        const body = `# Rule ${i}\n\n${'x'.repeat(2000)}\n`;
        writeFileSync(
          join(epipeRepo, '.claude', 'rules', `rule-${String(i).padStart(3, '0')}.md`),
          body,
        );
      }
    });

    afterAll(() => {
      rmSync(epipeRepo, { recursive: true, force: true });
    });

    it('exits 0 (not 1) when piped through `head -c`, with a fully drained baseline available for comparison', () => {
      const completeLen = fileRedirectByteLength(epipeRepo, []);
      expect(completeLen).toBeGreaterThan(200_000); // fixture sanity — margin over the empirical threshold

      const stderrPath = join(epipeRepo, 'epipe-head-stderr.log');
      const res = spawnSync(
        'bash',
        [
          '-c',
          `set -o pipefail; node "${CLI}" 2>"${stderrPath}" | head -c 100 >/dev/null; echo "$?"`,
        ],
        { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: epipeRepo } },
      );

      expect(res.status).toBe(0); // the bash -c wrapper itself (the `echo` command) succeeds
      expect(res.stdout.trim()).toBe('0'); // the CLI's own exit code, captured via pipefail

      const stderrContent = readFileSync(stderrPath, 'utf8');
      expect(stderrContent).not.toContain("Unhandled 'error' event");
      expect(stderrContent).toBe('');
    });

    it('exits 0 (not 1) when piped through `grep -q`, with no stack trace on stderr', () => {
      const completeLen = fileRedirectByteLength(epipeRepo, []);
      expect(completeLen).toBeGreaterThan(200_000); // fixture sanity — margin over the empirical threshold

      const stderrPath = join(epipeRepo, 'epipe-grep-stderr.log');
      // "# Rule 0" is the first line of the first rule's body — grep matches
      // and closes its stdin almost immediately, long before the ~240KB
      // payload finishes writing.
      const res = spawnSync(
        'bash',
        ['-c', `set -o pipefail; node "${CLI}" 2>"${stderrPath}" | grep -q "# Rule 0"; echo "$?"`],
        { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: epipeRepo } },
      );

      expect(res.status).toBe(0); // the bash -c wrapper itself succeeds
      expect(res.stdout.trim()).toBe('0'); // the CLI's own exit code, captured via pipefail

      const stderrContent = readFileSync(stderrPath, 'utf8');
      expect(stderrContent).not.toContain("Unhandled 'error' event");
      expect(stderrContent).toBe('');
    });
  });
});
