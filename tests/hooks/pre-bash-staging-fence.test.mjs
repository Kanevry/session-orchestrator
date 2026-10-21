/**
 * tests/hooks/pre-bash-staging-fence.test.mjs
 *
 * Tests for hooks/pre-bash-staging-fence.mjs — PSA-004 sub-mode C staging-
 * fence intent logger.
 *
 * Strategy: spawn the hook as a subprocess with JSON stdin matching the
 * harness PreToolUse contract. Assert exit code, stderr, and fence file
 * presence / shape.
 *
 * Issue: #557
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { expectAllow } from '../_helpers/hook-decision.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = resolve(import.meta.dirname, '../..', 'hooks/pre-bash-staging-fence.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook with a JSON PreToolUse payload on stdin.
 * Env-vars in `env` override process.env. Passes CLAUDE_PROJECT_DIR from the
 * test's projectDir unless overridden.
 */
function runHook({ toolName = 'Bash', command = '', env = {}, projectDir }) {
  const input = JSON.stringify({
    tool_name: toolName,
    tool_input: { command },
  });
  return spawnSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      // Strip variables that would bypass the hook during tests unless the
      // caller explicitly sets them.
      SO_DISABLED_HOOKS: '',
      SO_HOOK_PROFILE: '',
      SO_WAVE_AGENT: '',
      ...env,
    },
  });
}

/**
 * Return all .json files (excluding dot-files) written inside the fence dir.
 */
function fenceFiles(projectDir) {
  const fenceDir = join(projectDir, '.orchestrator', 'staging-fence');
  if (!existsSync(fenceDir)) return [];
  return readdirSync(fenceDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let projectDir;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'staging-fence-test-'));
  mkdirSync(join(projectDir, '.orchestrator', 'staging-fence'), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pre-bash-staging-fence — gate ladder G1-G6', { timeout: 15000 }, () => {
  // G1 — non-Bash tool is allowed unconditionally; no fence file written.
  it('G1: non-Bash tool exits 0 and writes no fence file', () => {
    const result = runHook({
      toolName: 'Read',
      command: 'git add foo.ts',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G2 — empty command is allowed; no fence file written.
  it('G2: empty command exits 0 and writes no fence file', () => {
    const result = runHook({
      command: '',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  it.each([
    'git add foo.ts',
    'git add -A',
    'git add --all',
    'git add -- foo.ts',
    'cd subdir && git add foo.ts',
    'GIT_COMMITTER_NAME=foo git add .',
    // 2026-09-20 regression: a staging command nested in `bash -c` is never
    // fenced, so a cross-agent collision goes undetected. The #1404 tokenizer
    // resolves the SEGMENT verb (`bash`/`sh`/`xargs`), found no `git add`
    // statement, and wrote NO FILE AT ALL — and the reader has no entry to
    // fall back to, so the miss is silent in both directions.
    'bash -c "git add foo.ts"',
    "sh -c 'git add foo.ts'",
    'xargs -I{} sh -c "git add foo.ts"',
    // #1667: the shared lexer glued `(` onto the verb, so `(git` never resolved.
    'true && (git add foo.ts)',
    // #1670 item 6: the pre-filter looked only 120 characters past `git` and
    // stopped at any `;`/`&`/`|`/newline, even quoted — each shape below went
    // through UNFENCED (fail-open), though the tokenizer resolves it.
    `git -C /${'a'.repeat(130)} -c user.name=x add foo.ts`,
    "git -c 'alias.x=!a;b' add foo.ts",
    'git \\\n  add foo.ts',
  ])('G3 match: %s writes a fence file', (command) => {
    const result = runHook({
      command,
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    expect(fenceFiles(projectDir)).toHaveLength(1);
  });

  // G3 — regex negative match: `git addremote` must NOT match (word boundary).
  it('G3 non-match: "git addremote" exits 0 and writes NO fence file', () => {
    const result = runHook({
      command: 'git addremote origin https://example.com',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G4 — context gate: SO_WAVE_AGENT unset → coordinator context → no fence.
  it('G4: SO_WAVE_AGENT unset exits 0 and writes no fence file', () => {
    const result = runHook({
      command: 'git add foo.ts',
      env: { SO_WAVE_AGENT: '' }, // unset / empty = not a wave-agent
      projectDir,
    });
    expectAllow(result);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G5+G6 — fence file schema check: correct JSON shape written.
  it('G5+G6: fence file has correct JSON shape with required fields', () => {
    const result = runHook({
      command: 'git add src/foo.ts',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    const files = fenceFiles(projectDir);
    expect(files).toHaveLength(1);

    const fenceDir = join(projectDir, '.orchestrator', 'staging-fence');
    const body = JSON.parse(readFileSync(join(fenceDir, files[0]), 'utf8'));

    expect(typeof body.agent_id).toBe('string');
    expect(body.agent_id.length).toBeGreaterThan(0);
    expect(typeof body.pid).toBe('number');
    expect(typeof body.host).toBe('string');
    // #1072: the raw `host` is not comparable across writes (os.hostname()
    // flips spelling on one machine), so the fence carries a normalised twin.
    expect(typeof body.host_id).toBe('string');
    expect(body.host_id).toBe(body.host.toLowerCase().replace(/\.(local|home|lan|localdomain)$/, ''));
    expect(typeof body.started_at).toBe('string');
    expect(Array.isArray(body.staged_paths)).toBe(true);
    expect(body.staged_paths).toHaveLength(1);
    // #1404: path operands + a command hash, never the command text.
    expect(body.staged_paths[0].paths).toEqual(['src/foo.ts']);
    expect(body.staged_paths[0].command_hash).toBe('76102da17af8b17d');
    expect(body.staged_paths[0].command).toBeUndefined();
    expect(typeof body.staged_paths[0].timestamp).toBe('string');
  });

  // G6 append — two separate invocations for the same agent each write their
  // own fence file (fresh Node process each time → unique random suffix).
  it('G6 append: two git-add invocations write two separate fence files', () => {
    runHook({ command: 'git add foo.ts', env: { SO_WAVE_AGENT: '1' }, projectDir });
    runHook({ command: 'git add bar.ts', env: { SO_WAVE_AGENT: '1' }, projectDir });
    // Each subprocess is a fresh Node process → unique random suffix → 2 files.
    expect(fenceFiles(projectDir)).toHaveLength(2);
  });

  it.each([
    { name: 'SO_DISABLED_HOOKS', env: { SO_DISABLED_HOOKS: 'pre-bash-staging-fence' } },
    { name: 'SO_HOOK_PROFILE=off', env: { SO_HOOK_PROFILE: 'off' } },
  ])('bypass: $name writes no fence file', ({ env }) => {
    const result = runHook({
      command: 'git add foo.ts',
      env: { SO_WAVE_AGENT: '1', ...env },
      projectDir,
    });
    expectAllow(result);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #1404 — the fence records PATH OPERANDS, not command text
// ---------------------------------------------------------------------------

describe('pre-bash-staging-fence — #1404 path operands instead of raw command', { timeout: 15000 }, () => {
  /** Read the single fence file's first staged_paths entry. */
  function onlyEntry() {
    const files = fenceFiles(projectDir);
    expect(files).toHaveLength(1);
    const raw = readFileSync(
      join(projectDir, '.orchestrator', 'staging-fence', files[0]),
      'utf8',
    );
    return { raw, entry: JSON.parse(raw).staged_paths[0] };
  }

  // Bug the suite missed: the fence persisted `command.slice(0, 512)`, so a
  // secret carried in a leading env assignment landed verbatim on disk.
  it('a secret in the staging command never reaches the fence file', () => {
    const result = runHook({
      command: 'GIT_TOKEN=abc123fake git add src/secret-path.mjs',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    const { raw, entry } = onlyEntry();
    expect(raw).not.toContain('abc123fake');
    expect(raw).not.toContain('GIT_TOKEN');
    expect(entry.paths).toEqual(['src/secret-path.mjs']);
    expect(entry.command_hash).toBe('772e78debf64e10a');
  });

  // Bug: `git add -A` carries NO path text, so the reader's raw-command regex
  // could never match it — the widest staging command of all fenced nothing.
  it.each(['git add -A', 'git add --all', 'git add .', 'git add -u'])(
    '%s records the overlaps-everything marker',
    (command) => {
      const result = runHook({ command, env: { SO_WAVE_AGENT: '1' }, projectDir });
      expectAllow(result);
      expect(onlyEntry().entry.paths).toEqual(['*']);
    },
  );

  // Bug: the old `\bgit\s+add\b` pre-filter never matched a global flag
  // between `git` and `add`, so this staging command was not fenced at all.
  it('git -C <dir> add <path> is fenced, with the operand anchored on -C', () => {
    const result = runHook({
      command: 'git -C sub add x.mjs',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    const { entry } = onlyEntry();
    expect(entry.paths).toEqual(['sub/x.mjs']);
    expect(entry.command_hash).toBe('9f7aa35a3c0dfc04');
  });

  // #1671 item 5 — `git stage` is git's built-in synonym for `git add`; the
  // pre-filter (`\badd\b`) and the subcommand check both missed it, so the
  // staging went unrecorded and a sibling's collision check saw nothing.
  it('git stage <path> is fenced like git add', () => {
    const result = runHook({
      command: 'git stage src/staged-via-synonym.mjs',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    expect(onlyEntry().entry.paths).toEqual(['src/staged-via-synonym.mjs']);
  });

  // Bug: a quoted operand containing a space was one blob of command text; a
  // regex reader split it on whitespace and matched neither half.
  it('a quoted operand with a space is recorded as one path', () => {
    const result = runHook({
      command: 'git add -- "my file.ts" b.ts',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    expect(onlyEntry().entry.paths).toEqual(['my file.ts', 'b.ts']);
  });

  // Bug: the pre-filter's own false positives used to be logged with their
  // raw text. The tokenizer, not the regex, decides — so they write nothing.
  it('a nested staging command records its OPERANDS, and composes with a top-level one', () => {
    // A fence file with the WRONG paths is as silent a miss as no file at all,
    // so the file-exists table above is not enough: assert the operands.
    const result = runHook({
      command: 'git add top.ts && bash -c "git add nested.ts"',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expectAllow(result);
    expect([...onlyEntry().entry.paths].sort()).toEqual(['nested.ts', 'top.ts']);
  });

  it.each([
    'git commit -m "add feature"',
    'echo "git add not-a-real-stage"',
  ])('pre-filter false positive %s writes no fence file', (command) => {
    const result = runHook({ command, env: { SO_WAVE_AGENT: '1' }, projectDir });
    expectAllow(result);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });
});

describe('fence root — written where the commit guard reads it (#1504 point 4)', () => {
  it('writes the fence at the git toplevel when the launch dir is a repo SUBDIRECTORY', () => {
    // Bug caught: the fence was written at $CLAUDE_PROJECT_DIR. The only reader,
    // wave-scope-commit-guard, walks `<git rev-parse --show-toplevel>/.orchestrator/staging-fence/`,
    // so a session launched in `<repo>/pkg` (or working in an entered worktree)
    // fenced into a directory no commit ever read.
    const repo = mkdtempSync(join(tmpdir(), 'fence-root-'));
    try {
      const pkg = join(repo, 'pkg');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(pkg, { recursive: true });
      const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git add a.txt' }, cwd: pkg }),
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: pkg, SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', SO_WAVE_AGENT: '1' },
      });
      expect(r.status).toBe(0);
      expect(fenceFiles(repo)).toHaveLength(1);
      expect(existsSync(join(pkg, '.orchestrator', 'staging-fence'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// #1659 — the work-tree recorder rides on this hook. Named bug: the recorder
// changing the hook's decision (or blocking) for a commit command. Same command,
// recorder active (session id + real repo) vs inactive (no session id): the
// stdout must be byte-identical, and only the active run writes a record.
describe('pre-bash-staging-fence — work-tree recorder (#1659)', { timeout: 15000 }, () => {
  it('leaves the decision byte-identical and records one work_tree event for a commit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'staging-fence-wt-'));
    try {
      const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      git('init', '-q');
      git('-c', 'user.name=T', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--allow-empty', '-m', 'base');
      const spawnWith = (extra) => spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git commit -m x' }, ...extra }),
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', SO_WAVE_AGENT: '' },
      });
      const ledger = join(projectDir, '.orchestrator', 'metrics', 'events.jsonl');

      const without = spawnWith({});
      expect(existsSync(ledger)).toBe(false);
      const withRec = spawnWith({ session_id: 'sess-1659' });

      expectAllow(withRec);
      expect(withRec.stdout).toBe(without.stdout);
      const records = readFileSync(ledger, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(records.map((r) => [r.event, r.session_id])).toEqual([['orchestrator.session.work_tree', 'sess-1659']]);
      expect(records[0].start_ref).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // #1669 — named bug: Codex sessions recorded no work tree. The payload below
  // is the golden record a logging PreToolUse hook captured from codex-cli
  // 0.160.1 on 2026-10-20 (only cwd and command swapped): `tool_name` is
  // "Bash", `transcript_path` is null, and the hook runs under the Codex env —
  // SO_PLATFORM=codex, no CLAUDE_PROJECT_DIR, ledger root from the process cwd.
  it('records a work_tree event from a real Codex PreToolUse shell payload', () => {
    const repo = mkdtempSync(join(tmpdir(), 'staging-fence-wt-codex-'));
    try {
      const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      git('init', '-q');
      git('-c', 'user.name=T', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--allow-empty', '-m', 'base');
      const payload = {
        session_id: '01a15812-1881-7722-b715-b5705009c4aa',
        turn_id: '01a15812-18df-7cd2-88c8-54219a7d26f0',
        transcript_path: null,
        cwd: repo,
        hook_event_name: 'PreToolUse',
        model: 'gpt-6.1-sol',
        permission_mode: 'bypassPermissions',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m x' },
        tool_use_id: 'exec-49d9fef3-4baf-472f-bdaf-305ac6878d15',
      };
      const env = { ...process.env, SO_PLATFORM: 'codex', SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', SO_WAVE_AGENT: '' };
      for (const key of ['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'PI_PROJECT_DIR']) delete env[key];
      const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf-8', cwd: repo, env });

      expectAllow(r);
      const ledger = join(repo, '.orchestrator', 'metrics', 'events.jsonl');
      const records = readFileSync(ledger, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(records.map((rec) => [rec.event, rec.session_id])).toEqual([
        ['orchestrator.session.work_tree', '01a15812-1881-7722-b715-b5705009c4aa'],
      ]);
      expect(records[0].start_ref).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Named bug: `pushd <other> && git commit` was attributed to the START tree,
  // because only `cd` moved the tracked directory. A directory change the
  // walker does not model must make the directory unknown → nothing recorded.
  it('records nothing for a commit after pushd/builtin cd (directory unknown)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'staging-fence-wt-pushd-'));
    try {
      const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      git('init', '-q');
      git('-c', 'user.name=T', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--allow-empty', '-m', 'base');
      const ledger = join(projectDir, '.orchestrator', 'metrics', 'events.jsonl');
      for (const command of ['pushd /nonexistent-1659 && git commit -m x', 'builtin cd /nonexistent-1659 && git commit -m x']) {
        const r = spawnSync('node', [HOOK], {
          input: JSON.stringify({ tool_name: 'Bash', cwd: repo, session_id: 'sess-1659', tool_input: { command } }),
          encoding: 'utf-8',
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', SO_WAVE_AGENT: '' },
        });
        expectAllow(r);
      }
      expect(existsSync(ledger)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Named bugs (#1670): (a) item 6 — the pre-filter looked only 120 characters
  // past `git`, so a long `git -C <repo> -c … commit` recorded nothing; (b) the
  // hand paren strip turned `((git … commit))` — arithmetic, never a commit —
  // into a recorded commit. The subshell/substitution rows pin that dropping
  // that strip changed nothing for real commits: the shared tokenizer splits them.
  describe('#1670 shapes (start dir holds the repo as ./sub)', () => {
    let base;
    beforeAll(() => {
      base = mkdtempSync(join(tmpdir(), 'staging-fence-wt-1670-'));
      const repo = join(base, 'sub');
      mkdirSync(repo);
      const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      git('init', '-q');
      git('-c', 'user.name=T', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--allow-empty', '-m', 'base');
    });
    afterAll(() => rmSync(base, { recursive: true, force: true }));

    // No `commit` word inside the flags: `commit.gpgsign` alone satisfied the
    // old bounded regex and masked the bug this row exists for.
    const flags = '-c user.name=T -c user.email=t@example.org -c gc.auto=0 -c core.quotepath=off'
      + ' -c core.autocrlf=false -c core.fsync=none -c a.b=c';

    it.each([
      [`git -C sub ${flags} commit -m y`, 1],
      ['(cd sub && git commit -m y)', 1],
      ['true && (git -C sub commit -m y)', 1],
      ['echo $(git -C sub commit -m y)', 1],
      ['((git -C sub commit -m y))', 0],
      // The hoisted body runs where the substitution stands (base, no repo),
      // not after the trailing `cd sub` — recording `sub` would misattribute.
      ['echo $(git commit -m y) && cd sub', 0],
    ])('%s → %i work_tree record(s)', (command, expected) => {
      const ledger = join(projectDir, '.orchestrator', 'metrics', 'events.jsonl');
      const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', cwd: base, session_id: 'sess-1670', tool_input: { command } }),
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', SO_WAVE_AGENT: '' },
      });
      expectAllow(r);
      const lines = existsSync(ledger) ? readFileSync(ledger, 'utf-8').trim().split('\n') : [];
      expect(lines).toHaveLength(expected);
    });
  });
});
