/**
 * tests/lib/echo-stub-detect.test.mjs
 *
 * Unit tests for scripts/lib/gates/echo-stub-detect.mjs — detectStubCommand()
 */

import { describe, it, expect } from 'vitest';
import { detectStubCommand } from '@lib/gates/echo-stub-detect.mjs';

// ---------------------------------------------------------------------------
// Group 1: Commands that ARE stubs (should detect)
// ---------------------------------------------------------------------------

describe('detectStubCommand — echo stubs (should detect)', () => {
  it.each([
    ['echo "no tests yet"', { isStub: true, kind: 'echo' }],
    ["echo 'no tests yet'", { isStub: true, kind: 'echo' }],
    ['echo TODO', { isStub: true, kind: 'echo' }],
    ['  echo "leading whitespace"  ', { isStub: true, kind: 'echo' }],
    ['echo placeholder', { isStub: true, kind: 'echo' }],
    ['echo skip-for-now', { isStub: true, kind: 'echo' }],
  ])('detects "%s" as an echo stub', (cmd, expected) => {
    expect(detectStubCommand(cmd)).toEqual(expected);
  });
});

describe('detectStubCommand — noop stubs (should detect)', () => {
  it('detects ":" as a noop stub', () => {
    expect(detectStubCommand(':')).toEqual({ isStub: true, kind: 'noop' });
  });

  it('detects "  :  " (whitespace around noop) as a noop stub', () => {
    expect(detectStubCommand('  :  ')).toEqual({ isStub: true, kind: 'noop' });
  });
});

// ---------------------------------------------------------------------------
// Group 2: Commands that are NOT stubs (must NOT detect)
// ---------------------------------------------------------------------------

describe('detectStubCommand — real commands (must NOT detect as stub)', () => {
  it.each([
    ['npm test'],
    ['pnpm test'],
    ['node -e "process.exit(0)"'],
    ['bash -c "echo x"'],
    ['true'],
    ['exit 0'],
  ])('does not detect "%s" as a stub', (cmd) => {
    expect(detectStubCommand(cmd)).toEqual({ isStub: false });
  });

  it('does not detect echo with pipe (echo "x" | grep y) as a stub', () => {
    expect(detectStubCommand('echo "x" | grep y')).toEqual({ isStub: false });
  });

  it('does not detect echo with compound && operator as a stub', () => {
    expect(detectStubCommand('echo "x" && echo "y"')).toEqual({ isStub: false });
  });

  it('does not detect echo with semicolon compound command as a stub', () => {
    expect(detectStubCommand('echo "x"; echo "y"')).toEqual({ isStub: false });
  });

  it('does not detect echo with command substitution $(date) as a stub', () => {
    expect(detectStubCommand('echo $(date)')).toEqual({ isStub: false });
  });

  it('does not detect echo with redirect (echo "x" > out) as a stub', () => {
    expect(detectStubCommand('echo "x" > out')).toEqual({ isStub: false });
  });

  it('does not detect bare "echo" (no argument) as a stub', () => {
    // Regex requires at least one argument after echo
    expect(detectStubCommand('echo')).toEqual({ isStub: false });
  });

  it('does not detect a bash -c wrapper (outer command is bash) as a stub', () => {
    expect(detectStubCommand("bash -c 'echo \"x\"'")).toEqual({ isStub: false });
  });
});

// ---------------------------------------------------------------------------
// Group 3: Skip-equivalent inputs (undefined / empty / "skip")
// ---------------------------------------------------------------------------

describe('detectStubCommand — skip-equivalent inputs (not stubs)', () => {
  it('returns { isStub: false } for undefined', () => {
    expect(detectStubCommand(undefined)).toEqual({ isStub: false });
  });

  it('returns { isStub: false } for empty string', () => {
    expect(detectStubCommand('')).toEqual({ isStub: false });
  });

  it('returns { isStub: false } for "skip"', () => {
    expect(detectStubCommand('skip')).toEqual({ isStub: false });
  });

  it('returns { isStub: false } for null', () => {
    expect(detectStubCommand(null)).toEqual({ isStub: false });
  });
});
