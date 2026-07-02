import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectPackageManager,
  defaultQualityGateCommands,
  isIgnoredRootFile,
} from '@lib/package-manager.mjs';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pm-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('detectPackageManager', () => {
  it('returns null when no lockfile is present', () => {
    expect(detectPackageManager(sandbox)).toBeNull();
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ])('detects %s as %s', (lockfile, expected) => {
    writeFileSync(join(sandbox, lockfile), '');
    expect(detectPackageManager(sandbox)).toBe(expected);
  });

  it('pnpm wins over npm when both lockfiles exist', () => {
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), '');
    writeFileSync(join(sandbox, 'package-lock.json'), '');
    expect(detectPackageManager(sandbox)).toBe('pnpm');
  });

  it('package.json packageManager wins over lockfile detection', () => {
    writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ packageManager: 'npm@10.9.0' }));
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(sandbox)).toBe('npm');
  });

  it('ignores root lockfiles explicitly ignored by .gitignore', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'pnpm-lock.yaml\n');
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), '');
    writeFileSync(join(sandbox, 'package-lock.json'), '');
    expect(detectPackageManager(sandbox)).toBe('npm');
  });

  it('returns null when the only lockfile is explicitly ignored', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'pnpm-lock.yaml\n');
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(sandbox)).toBeNull();
  });

  it('yarn wins over bun wins over npm', () => {
    writeFileSync(join(sandbox, 'yarn.lock'), '');
    writeFileSync(join(sandbox, 'bun.lockb'), '');
    writeFileSync(join(sandbox, 'package-lock.json'), '');
    expect(detectPackageManager(sandbox)).toBe('yarn');
  });

  it('a glob-ignored pnpm-lock.yaml falls back to npm (detection flips)', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'pnpm-lock.*\n');
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), '');
    writeFileSync(join(sandbox, 'package-lock.json'), '');
    expect(detectPackageManager(sandbox)).toBe('npm');
  });

  it('a negation pattern after a broad glob keeps pnpm-lock.yaml active (detection flips back)', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'pnpm-lock.*\n!pnpm-lock.yaml\n');
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), '');
    writeFileSync(join(sandbox, 'package-lock.json'), '');
    expect(detectPackageManager(sandbox)).toBe('pnpm');
  });
});

// ---------------------------------------------------------------------------
// isIgnoredRootFile — .gitignore glob-parser branch coverage (R4 gap)
// ---------------------------------------------------------------------------

describe('isIgnoredRootFile', () => {
  it('returns false when no .gitignore exists', () => {
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(false);
  });

  it('matches a plain filename pattern', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'pnpm-lock.yaml\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(true);
  });

  it('matches a leading-slash-anchored pattern', () => {
    writeFileSync(join(sandbox, '.gitignore'), '/pnpm-lock.yaml\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(true);
  });

  it('matches a glob pattern (pnpm-lock.*)', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'pnpm-lock.*\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(true);
  });

  it('does not match a glob pattern with a different prefix', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'yarn.*\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(false);
  });

  it('a later negation line un-ignores an earlier glob match', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'pnpm-lock.*\n!pnpm-lock.yaml\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(false);
  });

  it('a later non-negated line re-ignores after an earlier negation (last-match-wins)', () => {
    writeFileSync(join(sandbox, '.gitignore'), '!pnpm-lock.yaml\npnpm-lock.yaml\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(true);
  });

  it('does not match a path-containing pattern against a root file', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'subdir/pnpm-lock.yaml\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(false);
  });

  it('does not match a directory-trailing-slash pattern', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'pnpm-lock.yaml/\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(false);
  });

  it('skips comment and blank lines', () => {
    writeFileSync(join(sandbox, '.gitignore'), '# comment\n\npnpm-lock.yaml\n');
    expect(isIgnoredRootFile(sandbox, 'pnpm-lock.yaml')).toBe(true);
  });
});

describe('defaultQualityGateCommands', () => {
  it.each(['pnpm', 'npm', 'yarn', 'bun'])('returns triad for %s', (pm) => {
    const cmds = defaultQualityGateCommands(pm);
    expect(cmds.test.command).toMatch(new RegExp(`^${pm}`));
    expect(cmds.typecheck.command).toMatch(new RegExp(`^${pm}`));
    expect(cmds.lint.command).toMatch(new RegExp(`^${pm}`));
    expect(cmds.test.required).toBe(true);
  });

  it('falls back to npm defaults for null/undefined', () => {
    expect(defaultQualityGateCommands(null).test.command).toBe('npm test');
    expect(defaultQualityGateCommands(undefined).test.command).toBe('npm test');
  });

  it('falls back to npm defaults for unknown package manager', () => {
    expect(defaultQualityGateCommands('unknown').typecheck.command).toBe('npm run typecheck');
  });
});
