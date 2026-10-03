/**
 * tests/lib/plugin-package-stage.test.mjs
 *
 * Pins the failure contract of the shared staging routine (#1518): a failed
 * stage leaves the previous stage dir intact and no `.stage-*` work dir behind.
 * `npm`/`tar` are mocked; nothing is packed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveStageDir, stagePackage } from '../../scripts/lib/plugin-package-stage.mjs';

describe('stagePackage failure cleanup', () => {
  let tmp;
  let soRoot;
  let stageDir;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'so-stage-'));
    soRoot = join(tmp, 'clone');
    stageDir = join(tmp, 'cache', 'plugin-package');
    mkdirSync(soRoot, { recursive: true });
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, 'marker'), 'previous');
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const leftovers = () => readdirSync(join(tmp, 'cache')).filter((n) => n.startsWith('.stage-'));

  it.each([
    ['tar fails', () => ({ ok: false, detail: 'tar exited 2' }), /tar exited 2/],
    // tar "extracts", but the clone has no package-lock.json: copyFileSync throws.
    ['a step throws', (args) => { mkdirSync(join(args.at(-1), 'package')); return { ok: true }; }, /staging .*ENOENT/],
  ])('keeps the previous stage and removes the work dir when %s', (_label, tar, detail) => {
    const run = (cmd, args) => (cmd === 'npm'
      ? { ok: true, stdout: JSON.stringify([{ filename: 'x-1.0.0.tgz' }]) }
      : tar(args));
    const r = stagePackage({ soRoot, stageDir, run });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(detail);
    expect(readFileSync(join(stageDir, 'marker'), 'utf8')).toBe('previous');
    expect(leftovers()).toEqual([]);
  });
});

describe('stagePackage swap failure', () => {
  let tmp;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('puts the previous stage back when the final rename fails', () => {
    tmp = mkdtempSync(join(tmpdir(), 'so-stage-swap-'));
    const soRoot = join(tmp, 'clone');
    const stageDir = join(tmp, 'cache', 'plugin-package');
    mkdirSync(soRoot, { recursive: true });
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(soRoot, 'package-lock.json'), '{}');
    writeFileSync(join(stageDir, 'marker'), 'previous');
    const run = (cmd, args) => {
      if (cmd === 'npm') return { ok: true, stdout: JSON.stringify([{ filename: 'x-1.0.0.tgz' }]) };
      mkdirSync(join(args.at(-1), 'package'));
      return { ok: true };
    };
    // validate runs right before the swap; removing the copy there makes the
    // second rename fail AFTER the previous stage was moved aside.
    const r = stagePackage({ soRoot, stageDir, run, validate: (dir) => { rmSync(dir, { recursive: true }); return { ok: true }; } });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(stageDir, 'marker'), 'utf8')).toBe('previous');
  });
});

describe('resolveStageDir', () => {
  it('ignores a relative XDG_CACHE_HOME', () => {
    expect(resolveStageDir({ XDG_CACHE_HOME: 'rel' }, '/h'))
      .toBe(join('/h', '.cache', 'session-orchestrator', 'plugin-package'));
    expect(resolveStageDir({ XDG_CACHE_HOME: '/x' }, '/h'))
      .toBe(join('/x', 'session-orchestrator', 'plugin-package'));
  });
});
