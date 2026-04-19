import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectPackageManager,
  defaultQualityGateCommands,
} from '../../scripts/lib/package-manager.mjs';

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

  it('yarn wins over bun wins over npm', () => {
    writeFileSync(join(sandbox, 'yarn.lock'), '');
    writeFileSync(join(sandbox, 'bun.lockb'), '');
    writeFileSync(join(sandbox, 'package-lock.json'), '');
    expect(detectPackageManager(sandbox)).toBe('yarn');
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
