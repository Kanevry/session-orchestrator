import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureGitSpawn, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';
import { resolveSessionInvocation } from '@lib/session-invocation.mjs';

const cli = fileURLToPath(new URL('../../scripts/resolve-session-invocation.mjs', import.meta.url));

// Regression: the whole free-text argument used to be compared with the mode enum.
describe('session invocation resolution', () => {
  it.each(['', ' \n\t ', undefined])('uses deep only when no mode is supplied (%j)', (input) => {
    expect(resolveSessionInvocation(input)).toEqual({ sessionType: 'deep', context: '' });
  });

  it.each(['housekeeping', 'feature', 'deep'])(
    'keeps explicit %s with trailing task context',
    (mode) => {
      expect(resolveSessionInvocation(`${mode} mit parallelen Subagents und in Wellen`)).toEqual({
        sessionType: mode,
        context: 'mit parallelen Subagents und in Wellen',
      });
    },
  );

  it('resolves ultradeep with Unicode whitespace without dropping its profile or context', () => {
    expect(resolveSessionInvocation(' \tultradeep\u2003prüfe „Start“\nund Go/Close  ')).toEqual({
      sessionType: 'deep',
      profile: 'ultradeep',
      context: 'prüfe „Start“\nund Go/Close  ',
    });
  });

  it.each(['unknown', 'Deep', 'housekeeping-extra'])(
    'reports invalid first token %s and falls back',
    (mode) => {
      expect(resolveSessionInvocation(`${mode} deep text`)).toEqual({
        sessionType: 'deep',
        context: 'deep text',
        invalidMode: mode,
      });
    },
  );

  it('keeps quotes, shell syntax and mode-like text as inert task context over the real CLI', () => {
    const context =
      'prüfe "$HOME" $(printf injected) `printf injected`; ultradeep\n--profile ultradeep \t\n';
    const result = spawnSync(process.execPath, [cli, '--json'], {
      input: `housekeeping ${context}`,
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ sessionType: 'housekeeping', context });
  });

  it('returns the fallback as data and reports the invalid mode on stderr', () => {
    const result = spawnSync(process.execPath, [cli, '--json'], {
      input: 'invalid mit Kontext',
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sessionType: 'deep',
      context: 'mit Kontext',
      invalidMode: 'invalid',
    });
    expect(result.stderr).toContain("Invalid session type 'invalid'");
  });

  // #1561: a bare /session in a repo without its own history must not start deep silently.
  it.each([
    ['no ledger', null, { sessionType: 'deep', context: '', defaultReason: 'no-session-history' }],
    ['only abandoned records', '{"session_id":"s-1","status":"abandoned"}\n', {
      sessionType: 'deep',
      context: '',
      defaultReason: 'no-session-history',
    }],
    ['one real session', '{"session_id":"s-1","session_type":"deep"}\n', { sessionType: 'deep', context: '' }],
  ])('names the bare default when the repo has %s', (_label, ledger, expected) => {
    const repo = mkdtempSync(join(tmpdir(), 'so-invocation-'));
    try {
      if (ledger !== null) {
        mkdirSync(join(repo, '.orchestrator', 'metrics'), { recursive: true });
        writeFileSync(join(repo, '.orchestrator', 'metrics', 'sessions.jsonl'), ledger);
      }
      const result = spawnSync(process.execPath, [cli, '--json', '--repo-root', repo], {
        input: ' \n',
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // The ledger is gitignored, so a linked worktree has none of its own; an
  // unreadable ledger is not a measurement either. Neither may claim "no history".
  it('reads the main checkout ledger from a linked worktree and treats an unreadable ledger as unmeasured', () => {
    const base = makeTmpDir('so-invocation-wt-');
    const main = join(base, 'main');
    const git = (...args) => fixtureGitSpawn(args, main);
    const bare = (repoRoot) =>
      JSON.parse(
        spawnSync(process.execPath, [cli, '--json', '--repo-root', repoRoot], {
          input: '',
          encoding: 'utf8',
          timeout: 10000,
        }).stdout,
      );
    try {
      mkdirSync(main);
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '--allow-empty', '-m', 'init');
      expect(git('worktree', 'add', '-q', join(base, 'wt')).status).toBe(0);
      const ledger = join(main, '.orchestrator', 'metrics', 'sessions.jsonl');
      mkdirSync(join(main, '.orchestrator', 'metrics'), { recursive: true });
      writeFileSync(ledger, '{"session_id":"s-1","session_type":"deep"}\n');
      expect(bare(join(base, 'wt'))).toEqual({ sessionType: 'deep', context: '' });
      chmodSync(ledger, 0o000);
      expect(bare(main)).toEqual({ sessionType: 'deep', context: '' });
    } finally {
      removeTree(base);
    }
  });

  it('rejects positional arguments so task text cannot become CLI options', () => {
    const result = spawnSync(process.execPath, [cli, 'housekeeping'], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
