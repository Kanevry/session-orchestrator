/**
 * tests/setup/scrub-git-env.test.mjs
 *
 * THE BUG THIS CATCHES (TV-001): a git config channel that reaches a fixture's
 * git call because the scrub enumerated a SIBLING name instead of the namespace.
 *
 * The concrete instance these tests were written against: `scrub-git-env.mjs`
 * removed `GIT_CONFIG_PARAMETERS` (the `-c key=value` channel) but not
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, its ENUMERATED
 * form. Neither variable gates the other, so `core.hooksPath` reached every
 * throwaway fixture repo through the second name after the first was closed —
 * the 2026-08-19 incident mechanism, one handle over.
 *
 * `hooks/_lib/guard-source-loader.mjs` had already recorded this exact class
 * (its old denylist named GIT_CONFIG_COUNT but not GIT_CONFIG_PARAMETERS — the
 * mirror image) and closed it with an allowlist child env. See the module header
 * of scrub-git-env.mjs for why that form is unavailable for a worker-wide scrub
 * and why the namespace sweep is what replaced it here.
 *
 * The last test is the one that matters: it does not assert on a variable, it
 * asserts that a foreign hook does not FIRE. Its own control case (the same
 * commit with the unscrubbed environment) fires it, so the assertion is proven
 * to discriminate rather than merely to pass.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scrubGitEnv, GIT_ENV_KEEP } from './scrub-git-env.mjs';

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A minimal env a spawned git actually needs, with nothing git-pointing in it. */
const baseEnv = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
});

describe('scrubGitEnv — sweeps the GIT_ namespace, not a list of names', () => {
  it('removes the ENUMERATED config channel, not just GIT_CONFIG_PARAMETERS', () => {
    // bug_caught: the shipped hole. GIT_CONFIG_COUNT / KEY_n / VALUE_n is an
    // independent channel with no GIT_CONFIG_PARAMETERS gate, so a scrub that
    // stopped at the latter left `core.hooksPath` injectable through the former.
    const env = {
      ...baseEnv(),
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/tmp/foreign'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/foreign',
    };

    scrubGitEnv(env);

    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it('removes config-FILE redirections and discovery channels the old list never named', () => {
    // bug_caught: the next name over. GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM point
    // config resolution at attacker- or accident-chosen files (read-only, so a
    // smaller blast radius than the enumerated channel — but the same class), and
    // GIT_CEILING_DIRECTORIES / GIT_TRACE were the two the guard-source-loader
    // comment names as escapees of ITS denylist. A namespace sweep owes no
    // enumeration to close them; a name list owes one per name, forever.
    const env = {
      ...baseEnv(),
      GIT_CONFIG_GLOBAL: '/tmp/foreign/gitconfig',
      GIT_CONFIG_SYSTEM: '/tmp/foreign/gitconfig',
      GIT_CONFIG: '/tmp/foreign/gitconfig',
      GIT_CEILING_DIRECTORIES: '/tmp',
      GIT_TRACE: '1',
      GIT_TEMPLATE_DIR: '/tmp/foreign/templates',
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    };

    const removed = scrubGitEnv(env);

    expect(Object.keys(env).filter((k) => k.startsWith('GIT_'))).toEqual([]);
    expect(removed).toContain('GIT_CONFIG_GLOBAL');
    expect(removed).toContain('GIT_CEILING_DIRECTORIES');
    expect(removed).toContain('GIT_TEMPLATE_DIR');
  });

  it('keeps identity, editor and transport — they answer WHO/HOW, never WHICH repo', () => {
    // bug_caught: an over-broad sweep, which is the failure mode on the other
    // side. GIT_EDITOR is the measured one: Claude Code exports GIT_EDITOR=true
    // so git never blocks, with EDITOR empty — sweep it and git falls back to
    // `vi`, turning any editor-opening git call into a worker hang.
    const env = { ...baseEnv() };
    for (const name of GIT_ENV_KEEP) env[name] = 'kept';
    env.GIT_DIR = '/tmp/foreign/.git';

    const removed = scrubGitEnv(env);

    expect(removed).toEqual(['GIT_DIR']);
    for (const name of GIT_ENV_KEEP) expect(env[name]).toBe('kept');
  });

  it('a scrubbed env does not fire a FOREIGN hook in a throwaway repo', () => {
    // bug_caught: the end state rather than the variable. This is the 2026-08-19
    // mechanism reproduced whole — `core.hooksPath` injected through the
    // enumerated channel makes a fixture commit execute hooks from a directory
    // the fixture never chose. The A/B is the proof the assertion discriminates:
    // the SAME commit with the unscrubbed env fires the hook.
    const root = mkTmp('so-scrub-git-env-');
    const hooks = join(root, 'foreignhooks');
    const evidence = join(root, 'evidence.txt');
    const repo = join(root, 'repo');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\necho FIRED >> ${JSON.stringify(evidence)}\nexit 0\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);

    execFileSync('git', ['init', '-q', repo], { env: baseEnv() });
    for (const [k, v] of [['user.email', 't@e.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) {
      execFileSync('git', ['-C', repo, 'config', k, v], { env: baseEnv() });
    }

    const injected = {
      ...baseEnv(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooks,
    };

    // Control: the unscrubbed environment DOES reach git.
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', repo, 'add', 'a.txt'], { env: baseEnv() });
    spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'control'], { env: { ...injected } });
    expect(existsSync(evidence)).toBe(true);
    expect(readFileSync(evidence, 'utf8')).toContain('FIRED');
    rmSync(evidence);

    // The same commit, with the same variables, after the scrub.
    const scrubbed = { ...injected };
    scrubGitEnv(scrubbed);
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    execFileSync('git', ['-C', repo, 'add', 'b.txt'], { env: baseEnv() });
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'scrubbed'], { env: scrubbed });

    expect(existsSync(evidence)).toBe(false);
  });
});
