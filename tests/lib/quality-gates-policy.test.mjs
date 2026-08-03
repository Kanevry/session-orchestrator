import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadQualityGatesPolicy,
  resolveCommand,
  configKeyToPolicyKey,
} from '@lib/quality-gates-policy.mjs';

let sandbox;

function writePolicy(contents) {
  const dir = join(sandbox, '.orchestrator', 'policy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'quality-gates.json'), contents);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'qgp-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('loadQualityGatesPolicy', () => {
  it('returns null when policy file is missing', () => {
    expect(loadQualityGatesPolicy(sandbox)).toBeNull();
  });

  it('loads a valid policy', () => {
    writePolicy(
      JSON.stringify({
        version: 1,
        commands: {
          test: { command: 'npm test', required: true },
          typecheck: { command: 'npm run typecheck', required: true },
          lint: { command: 'npm run lint', required: true },
        },
      })
    );
    const policy = loadQualityGatesPolicy(sandbox);
    expect(policy).toMatchObject({ version: 1 });
    expect(policy.commands.test.command).toBe('npm test');
  });

  // One rejection contract, five malformed inputs — the bodies were byte-identical
  // apart from the fixture, so they are a table rather than five copies (TV-004).
  it.each([
    ['malformed JSON', '{ not json'],
    ['unsupported version', JSON.stringify({
      version: 2,
      commands: { test: { command: 'x', required: true } },
    })],
    ['commands is missing', JSON.stringify({ version: 1 })],
    ['a required command key is missing', JSON.stringify({
      version: 1,
      commands: {
        test: { command: 'npm test', required: true },
        typecheck: { command: 'tsc', required: true },
      },
    })],
    ['a command string is empty', JSON.stringify({
      version: 1,
      commands: {
        test: { command: '', required: true },
        typecheck: { command: 'tsc', required: true },
        lint: { command: 'eslint', required: true },
      },
    })],
  ])('returns null when %s', (_name, contents) => {
    writePolicy(contents);
    expect(loadQualityGatesPolicy(sandbox)).toBeNull();
  });

  it('does not throw on filesystem edge cases', () => {
    expect(() => loadQualityGatesPolicy('/definitely/does/not/exist/xyz')).not.toThrow();
  });
});

describe('resolveCommand', () => {
  const policy = {
    version: 1,
    commands: {
      test: { command: 'custom test', required: true },
      typecheck: { command: 'custom tc', required: true },
      lint: { command: 'custom lint', required: true },
    },
  };

  it('returns policy command when policy exists', () => {
    expect(resolveCommand(policy, 'test', 'fallback')).toBe('custom test');
  });

  it('falls back when policy is null', () => {
    expect(resolveCommand(null, 'test', 'fallback')).toBe('fallback');
  });

  it('falls back when key is missing', () => {
    expect(resolveCommand({ version: 1, commands: {} }, 'test', 'fallback')).toBe('fallback');
  });
});

describe('configKeyToPolicyKey', () => {
  it.each([
    ['test-command', 'test'],
    ['typecheck-command', 'typecheck'],
    ['lint-command', 'lint'],
  ])('maps %s to %s', (input, expected) => {
    expect(configKeyToPolicyKey(input)).toBe(expected);
  });

  it('returns null for unknown keys', () => {
    expect(configKeyToPolicyKey('other-command')).toBeNull();
  });
});
