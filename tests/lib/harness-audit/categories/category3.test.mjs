/**
 * tests/lib/harness-audit/categories/category3.test.mjs
 *
 * Unit tests for scripts/lib/harness-audit/categories/category3.mjs
 * Category 3: Hook Integrity
 *
 * Checks exercised:
 *   c3.1 hooks-json-valid
 *   c3.2 hook-files-exist
 *   c3.3 hook-mjs-syntax  (uses execFileSync internally — covered via real files)
 *   c3.4 destructive-guard-loads-policy
 *
 * Strategy for c3.3: write syntactically valid / invalid .mjs files in the temp
 * fixture and let `node --check` run for real. This avoids mocking execFileSync
 * while still exercising the PASS and FAIL paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory3 } from '../../../../scripts/lib/harness-audit/categories/category3.mjs';
import { _resetWarnFlags } from '../../../../scripts/lib/harness-audit/categories/helpers.mjs';

/**
 * Write a file, creating intermediate directories as needed.
 */
function scaffold(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Minimal valid hooks.json with one matcher referencing a hook file. */
function minimalHooksJson(hookFile = 'pre-bash-destructive-guard.mjs') {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `node $CLAUDE_PLUGIN_ROOT/hooks/${hookFile}`,
            },
          ],
        },
      ],
    },
  }, null, 2);
}

describe('category3 — Hook Integrity', () => {
  let d;

  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'cat3-'));
    _resetWarnFlags();
  });

  afterEach(() => {
    rmSync(d, { recursive: true, force: true });
  });

  it('returns an array of checks (floor: at least 3)', () => {
    const checks = runCategory3(d);
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(3);
    expect(checks.length).toBeLessThanOrEqual(20);
  });

  describe('happy path — all checks PASS', () => {
    it('all checks pass when a well-formed hooks fixture is provided', () => {
      const hookName = 'pre-bash-destructive-guard.mjs';

      // c3.1 + c3.2: valid hooks.json referencing a real file
      scaffold(d, 'hooks/hooks.json', minimalHooksJson(hookName));

      // c3.3: syntactically valid .mjs file
      scaffold(d, `hooks/${hookName}`, [
        '// minimal hook',
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        '// references blocked-commands.json to satisfy c3.4',
        "const policy = JSON.parse(readFileSync(join('.orchestrator', 'policy', 'blocked-commands.json'), 'utf8'));",
        'export default policy;',
      ].join('\n'));

      const checks = runCategory3(d);
      const failed = checks.filter((c) => c.status === 'fail');
      expect(failed).toHaveLength(0);

      const passed = checks.filter((c) => c.status === 'pass');
      expect(passed.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('c3.1 hooks-json-valid', () => {
    it('fails when hooks/hooks.json is missing', () => {
      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hooks-json-valid');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.matcherCount).toBe(0);
    });

    it('fails when hooks/hooks.json is invalid JSON', () => {
      scaffold(d, 'hooks/hooks.json', '{ not valid json ');

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hooks-json-valid');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
    });

    it('fails when hooks.json is valid JSON but has no matcher blocks', () => {
      scaffold(d, 'hooks/hooks.json', JSON.stringify({ hooks: {} }));

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hooks-json-valid');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.matcherCount).toBe(0);
    });

    it('passes when hooks.json has at least one matcher block', () => {
      scaffold(d, 'hooks/hooks.json', minimalHooksJson());
      // create the referenced file so hook-files-exist does not mask a different failure
      scaffold(d, 'hooks/pre-bash-destructive-guard.mjs',
        '// stub\nexport default {};\n');

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hooks-json-valid');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.matcherCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('c3.2 hook-files-exist', () => {
    it('fails when a referenced hook file is missing', () => {
      // hooks.json references a file we do NOT create
      scaffold(d, 'hooks/hooks.json', minimalHooksJson('missing-hook.mjs'));

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hook-files-exist');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.missing).toContain('hooks/missing-hook.mjs');
    });

    it('passes when all referenced hook files exist on disk', () => {
      const hookName = 'pre-bash-destructive-guard.mjs';
      scaffold(d, 'hooks/hooks.json', minimalHooksJson(hookName));
      scaffold(d, `hooks/${hookName}`, '// stub\nexport default {};\n');

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hook-files-exist');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.missing).toHaveLength(0);
      expect(check.evidence.referenced.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('c3.3 hook-mjs-syntax', () => {
    it('passes when the hooks dir has no .mjs files', () => {
      // No hooks dir created — should silently pass with 0 files checked
      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hook-mjs-syntax');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.filesChecked).toBe(0);
      expect(check.evidence.syntaxErrors).toHaveLength(0);
    });

    it('passes when every .mjs file in hooks/ has valid syntax', () => {
      scaffold(d, 'hooks/valid-hook.mjs', [
        '// valid ESM module',
        "const x = 42;",
        'export default x;',
      ].join('\n'));

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hook-mjs-syntax');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.filesChecked).toBeGreaterThanOrEqual(1);
      expect(check.evidence.syntaxErrors).toHaveLength(0);
    });

    it('fails when a .mjs file in hooks/ has a syntax error', () => {
      scaffold(d, 'hooks/broken-hook.mjs', [
        '// intentionally broken',
        'const = ;',   // syntax error
      ].join('\n'));

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'hook-mjs-syntax');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.syntaxErrors.length).toBeGreaterThanOrEqual(1);
      expect(check.evidence.syntaxErrors[0].file).toBe('hooks/broken-hook.mjs');
    });
  });

  describe('c3.4 destructive-guard-loads-policy', () => {
    it('fails when pre-bash-destructive-guard.mjs is missing', () => {
      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'destructive-guard-loads-policy');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.loadsPolicy).toBe(false);
    });

    it('fails when the guard file does not reference blocked-commands.json or .orchestrator/policy', () => {
      scaffold(d, 'hooks/pre-bash-destructive-guard.mjs', [
        '// guard with no policy reference',
        'export default function guard() { return true; }',
      ].join('\n'));

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'destructive-guard-loads-policy');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.loadsPolicy).toBe(false);
    });

    it('passes when the guard file references blocked-commands.json', () => {
      scaffold(d, 'hooks/pre-bash-destructive-guard.mjs', [
        '// production-style guard',
        "import { readFileSync } from 'node:fs';",
        "const policy = JSON.parse(readFileSync('blocked-commands.json', 'utf8'));",
        'export default policy;',
      ].join('\n'));

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'destructive-guard-loads-policy');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.loadsPolicy).toBe(true);
    });

    it('passes when the guard file uses an import from .orchestrator/policy path', () => {
      scaffold(d, 'hooks/pre-bash-destructive-guard.mjs', [
        '// dynamic import path style',
        "import policy from '../.orchestrator/policy/blocked-commands.json' assert { type: 'json' };",
        'export default policy;',
      ].join('\n'));

      const checks = runCategory3(d);
      const check = checks.find((c) => c.check_id === 'destructive-guard-loads-policy');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.loadsPolicy).toBe(true);
    });
  });
});
