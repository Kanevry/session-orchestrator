/**
 * tests/hooks/profile-gate.test.mjs
 *
 * Tests for hooks/_lib/profile-gate.mjs — runtime hook control (#211).
 *
 * Strategy: import the module with env vars controlled via process.env stubs.
 * Each test saves/restores env vars in beforeEach/afterEach so there is no
 * cross-test leakage. We re-import (or re-exercise) the exported function
 * with different env combinations rather than spawning subprocesses.
 *
 * Covered cases:
 *   1. Full profile (default / SO_HOOK_PROFILE unset) — all hooks return true
 *   2. Full profile explicit — same result
 *   3. Minimal profile — only on-session-start + pre-bash-destructive-guard return true
 *   4. Off profile — no hooks return true
 *   5. SO_DISABLED_HOOKS overrides profile (disables a hook that full profile would enable)
 *   6. SO_DISABLED_HOOKS + minimal profile disables a minimal hook
 *   7. Unknown profile defaults to full + emits a stderr warning
 *   8. defaultEnabled=false is respected by full profile
 *   9. Whitespace + case normalisation in SO_DISABLED_HOOKS
 *  10. Empty SO_DISABLED_HOOKS string is treated as no disabled hooks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helper: isolate env and re-evaluate shouldRunHook in a fresh module context
// ---------------------------------------------------------------------------

/**
 * Import profile-gate with controlled env vars.
 * Vitest module caching would re-use the same module across tests, but since
 * shouldRunHook reads process.env directly on each call (not at import time),
 * we only need to set env vars before calling shouldRunHook.
 *
 * We do a single static import below and call the function directly.
 */
import { shouldRunHook } from '../../hooks/_lib/profile-gate.mjs';

const ALL_HOOKS = [
  'on-session-start',
  'pre-bash-destructive-guard',
  'enforce-scope',
  'enforce-commands',
  'post-edit-validate',
  'on-stop',
];

const MINIMAL_ONLY = new Set(['on-session-start', 'pre-bash-destructive-guard']);

// ---------------------------------------------------------------------------
// Env guard helpers
// ---------------------------------------------------------------------------

let savedProfile;
let savedDisabled;

beforeEach(() => {
  savedProfile = process.env.SO_HOOK_PROFILE;
  savedDisabled = process.env.SO_DISABLED_HOOKS;
  delete process.env.SO_HOOK_PROFILE;
  delete process.env.SO_DISABLED_HOOKS;
});

afterEach(() => {
  if (savedProfile === undefined) delete process.env.SO_HOOK_PROFILE;
  else process.env.SO_HOOK_PROFILE = savedProfile;

  if (savedDisabled === undefined) delete process.env.SO_DISABLED_HOOKS;
  else process.env.SO_DISABLED_HOOKS = savedDisabled;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('profile-gate — shouldRunHook', () => {
  it('full profile (env unset) — all hooks return true', () => {
    // No env vars set → full profile → every hook runs
    for (const hook of ALL_HOOKS) {
      expect(shouldRunHook(hook), `hook "${hook}" should run on full profile`).toBe(true);
    }
  });

  it('full profile (explicit SO_HOOK_PROFILE=full) — all hooks return true', () => {
    process.env.SO_HOOK_PROFILE = 'full';
    for (const hook of ALL_HOOKS) {
      expect(shouldRunHook(hook), `hook "${hook}" should run on full profile`).toBe(true);
    }
  });

  it('minimal profile — only allowed hooks return true', () => {
    process.env.SO_HOOK_PROFILE = 'minimal';
    for (const hook of ALL_HOOKS) {
      const expected = MINIMAL_ONLY.has(hook);
      expect(
        shouldRunHook(hook),
        `hook "${hook}" expected ${expected} on minimal profile`
      ).toBe(expected);
    }
  });

  it('off profile — no hooks return true', () => {
    process.env.SO_HOOK_PROFILE = 'off';
    for (const hook of ALL_HOOKS) {
      expect(shouldRunHook(hook), `hook "${hook}" should NOT run on off profile`).toBe(false);
    }
  });

  it('SO_DISABLED_HOOKS overrides full profile for listed names', () => {
    process.env.SO_HOOK_PROFILE = 'full';
    process.env.SO_DISABLED_HOOKS = 'enforce-scope,enforce-commands';

    expect(shouldRunHook('enforce-scope')).toBe(false);
    expect(shouldRunHook('enforce-commands')).toBe(false);
    // Other hooks unaffected
    expect(shouldRunHook('on-session-start')).toBe(true);
    expect(shouldRunHook('post-edit-validate')).toBe(true);
    expect(shouldRunHook('on-stop')).toBe(true);
    expect(shouldRunHook('pre-bash-destructive-guard')).toBe(true);
  });

  it('SO_DISABLED_HOOKS overrides minimal profile — disables a minimal hook', () => {
    process.env.SO_HOOK_PROFILE = 'minimal';
    process.env.SO_DISABLED_HOOKS = 'on-session-start';

    // on-session-start is in minimal but explicitly disabled
    expect(shouldRunHook('on-session-start')).toBe(false);
    // pre-bash-destructive-guard still in minimal and not disabled
    expect(shouldRunHook('pre-bash-destructive-guard')).toBe(true);
  });

  it('unknown profile emits stderr warning and defaults to full behaviour', () => {
    process.env.SO_HOOK_PROFILE = 'turbo-mode';

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // Should still return true (defaulting to full)
      const result = shouldRunHook('enforce-scope');
      expect(result).toBe(true);
      // At least one warning mentioning the unknown value must have been written
      const allWrites = stderrSpy.mock.calls.map((args) => String(args[0]));
      const hasWarning = allWrites.some(
        (msg) => msg.includes('SO_HOOK_PROFILE') && msg.includes('turbo-mode')
      );
      expect(hasWarning, 'expected a stderr warning about unknown profile').toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('defaultEnabled=false is respected on full profile', () => {
    // full profile uses defaultEnabled; false means disabled by default
    expect(shouldRunHook('some-optional-hook', false)).toBe(false);
  });

  it('SO_DISABLED_HOOKS with surrounding whitespace and mixed case', () => {
    process.env.SO_DISABLED_HOOKS = '  Enforce-Scope , ON-STOP  ';
    // Names normalised to lowercase before comparison
    expect(shouldRunHook('enforce-scope')).toBe(false);
    expect(shouldRunHook('on-stop')).toBe(false);
    expect(shouldRunHook('enforce-commands')).toBe(true);
  });

  it('empty SO_DISABLED_HOOKS string is a no-op', () => {
    process.env.SO_DISABLED_HOOKS = '';
    expect(shouldRunHook('enforce-scope')).toBe(true);
    expect(shouldRunHook('on-stop')).toBe(true);
  });
});
