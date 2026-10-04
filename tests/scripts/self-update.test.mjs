/**
 * tests/scripts/self-update.test.mjs
 *
 * Pins the one decision self-update makes that the harness does not: noticing
 * a plugin cache whose runtime dependencies were never installed (Claude Code
 * 2.1.287 `dependencies-refused`, measured 2026-10-02).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findClaudeEntry, makeRunner, missingRuntimeDeps, resolveClaudeConfigDir, updateClaude,
} from '../../scripts/self-update.mjs';
import { packedFilename } from '../../scripts/lib/plugin-package-stage.mjs';

it('runs real npm through the self-update runner on Windows without a cmd shell', () => {
  const result = makeRunner({ dryRun: false, json: true }).run('npm', ['--version']);
  expect(result.ok).toBe(true);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

describe('missingRuntimeDeps', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'so-self-update-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { yaml: '^2', '@babel/parser': '^7' },
      devDependencies: { vitest: '^4' },
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports every runtime dep when the harness skipped the install', () => {
    expect(missingRuntimeDeps(dir).sort()).toEqual(['@babel/parser', 'yaml']);
  });

  it('ignores devDependencies and resolves scoped names', () => {
    mkdirSync(join(dir, 'node_modules', '@babel', 'parser'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'yaml'), { recursive: true });
    expect(missingRuntimeDeps(dir)).toEqual([]);
  });
});

describe('findClaudeEntry', () => {
  const ours = { id: 'session-orchestrator@kanevry', scope: 'user', version: '5.4.0' };
  const other = { id: 'other@kanevry', scope: 'user', version: '1.0.0' };

  it('reads both the bare-array and the {plugins} shape', () => {
    expect(findClaudeEntry([other, ours])).toBe(ours);
    expect(findClaudeEntry({ plugins: [other, ours] })).toBe(ours);
  });

  it('prefers the user-scope entry over a project-scope one', () => {
    const project = { ...ours, scope: 'project', version: '5.0.0' };
    expect(findClaudeEntry([project, ours])).toBe(ours);
  });

  it('returns null when the plugin is absent or the shape is unknown', () => {
    expect(findClaudeEntry([other])).toBeNull();
    expect(findClaudeEntry({ unexpected: true })).toBeNull();
  });
});

describe('packedFilename', () => {
  it('reads both the npm <= 11 array and the npm >= 12 keyed shape', () => {
    expect(packedFilename([{ filename: 'a-1.0.0.tgz' }])).toBe('a-1.0.0.tgz');
    expect(packedFilename({ a: { filename: 'a-1.0.0.tgz' } })).toBe('a-1.0.0.tgz');
  });

  it('returns null instead of guessing when no filename is reported', () => {
    expect(packedFilename([])).toBeNull();
    expect(packedFilename({ a: {} })).toBeNull();
  });
});

/**
 * #1515: a directory marketplace on the working checkout copied all of it —
 * `.env.local` included — into the plugin cache. Every path below runs against
 * a tmp config dir and a mocked `claude`; the real ~/.claude is never read.
 */
describe('updateClaude source guard', () => {
  let tmp;
  let calls;
  let ctx;
  const entry = (id, installPath, version) => JSON.stringify([{ id, scope: 'user', version, installPath }]);

  function setup(known, installedId) {
    const clone = join(tmp, 'clone');
    const install = join(tmp, 'cache', 'plugin');
    mkdirSync(join(clone, '.claude-plugin'), { recursive: true });
    mkdirSync(install, { recursive: true });
    writeFileSync(join(clone, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    writeFileSync(join(clone, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'kanevry' }));
    writeFileSync(join(install, 'package.json'), JSON.stringify({ dependencies: {} }));
    const file = join(tmp, 'known_marketplaces.json');
    writeFileSync(file, JSON.stringify(known(clone)));
    calls = [];
    const run = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (args.join(' ') === 'plugin list --json') {
        return { ok: true, stdout: installedId ? entry(installedId, install, '9.9.9') : '[]' };
      }
      return { ok: true, stdout: '' };
    };
    ctx = { soRoot: clone, stageDir: join(tmp, 'stage'), knownMarketplacesFile: file, hasClaude: () => true };
    return { run, log: () => {} };
  }

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'so-self-update-guard-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('refuses a directory marketplace on the clone under ANY name, reached via a symlink, and names it', () => {
    const io = setup((clone) => {
      symlinkSync(clone, join(tmp, 'alias'), 'junction');
      return { 'session-orchestrator': { source: { source: 'directory', path: join(tmp, 'alias') } } };
    }, 'session-orchestrator@session-orchestrator');
    const r = updateClaude(io, { dryRun: true }, ctx);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('claude plugin marketplace remove session-orchestrator');
    expect(r.detail).toContain(`claude plugin marketplace add ${ctx.stageDir}`);
    expect(calls.some((c) => c.startsWith('claude plugin update'))).toBe(false);
  });

  it('skips without staging when the plugin is not installed, even with a directory marketplace on the clone (#1519)', () => {
    const io = setup((clone) => ({ 'session-orchestrator': { source: { source: 'directory', path: clone } } }), null);
    const r = updateClaude(io, { dryRun: true }, ctx);
    expect(r.status).toBe('skipped');
    expect(calls.some((c) => c.startsWith('npm pack'))).toBe(false);
  });

  it('adds a same-named marketplace on another source to the remove list, so add <stage> cannot collide (#1519)', () => {
    const io = setup((clone) => ({
      'session-orchestrator': { source: { source: 'directory', path: clone } },
      kanevry: { source: { source: 'github', repo: 'Kanevry/session-orchestrator' } },
    }), 'session-orchestrator@kanevry');
    const r = updateClaude(io, { dryRun: true }, ctx);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('claude plugin marketplace remove session-orchestrator && claude plugin marketplace remove kanevry && ');
  });

  it('still updates a GitHub-sourced marketplace, using the installed plugin id', () => {
    const io = setup(() => ({ kanevry: { source: { source: 'github', repo: 'Kanevry/session-orchestrator' } } }),
      'session-orchestrator@kanevry');
    const r = updateClaude(io, { dryRun: true }, ctx);
    expect(r.status).toBe('ok');
    expect(calls).toContain('claude plugin marketplace update kanevry');
    expect(calls).toContain('claude plugin update session-orchestrator@kanevry');
    expect(calls.some((c) => c.startsWith('npm pack'))).toBe(false);
  });
});

describe('resolveClaudeConfigDir', () => {
  it('ignores a relative CLAUDE_CONFIG_DIR like a relative XDG_CACHE_HOME and reports it (#1519)', () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: 'rel/claude' }, '/home/u'))
      .toEqual({ dir: join('/home/u', '.claude'), ignored: 'rel/claude' });
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/abs/claude' }, '/home/u'))
      .toEqual({ dir: '/abs/claude', ignored: null });
  });
});
