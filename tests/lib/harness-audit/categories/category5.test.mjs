/**
 * tests/lib/harness-audit/categories/category5.test.mjs
 *
 * Vitest suite for scripts/lib/harness-audit/categories/category5.mjs
 *
 * Category 5: Plugin-Root Resolution — checks parse-config-fallback-chain,
 * hooks-use-plugin-root-var, config-reading-doc, bootstrap-gate-doc.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory5 } from '../../../../scripts/lib/harness-audit/categories/category5.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'cat5-'));
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** Write all files needed for a fully-passing category 5 run. */
function scaffoldHappyPath(root) {
  // c5.1 — env vars in platform.mjs
  ensureDir(join(root, 'scripts/lib'));
  writeFileSync(
    join(root, 'scripts/lib/platform.mjs'),
    '// platform resolution\n' +
      "const root = process.env.CLAUDE_PLUGIN_ROOT || process.env.CODEX_PLUGIN_ROOT || process.env.CURSOR_RULES_DIR || '.';\n",
  );

  // c5.2 — hooks.json using env var prefix (no absolute paths)
  ensureDir(join(root, 'hooks'));
  writeFileSync(
    join(root, 'hooks/hooks.json'),
    JSON.stringify({
      hooks: [
        { event: 'PreToolUse', command: 'node $CLAUDE_PLUGIN_ROOT/hooks/pre-bash.mjs' },
      ],
    }),
  );

  // c5.3 — config-reading.md with PLUGIN_ROOT mention
  ensureDir(join(root, 'skills/_shared'));
  writeFileSync(
    join(root, 'skills/_shared/config-reading.md'),
    '# Config Reading\n\nUse PLUGIN_ROOT to locate the plugin.\n',
  );

  // c5.4 — bootstrap-gate.md with all required strings
  writeFileSync(
    join(root, 'skills/_shared/bootstrap-gate.md'),
    '# Bootstrap Gate\n\nReads CLAUDE.md Session Config section.\nChecks bootstrap.lock exists.\n',
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runCategory5', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Happy path — all 4 checks pass
  // -------------------------------------------------------------------------
  it('returns 4 passing checks when all plugin-root files are correctly wired', () => {
    scaffoldHappyPath(root);

    const checks = runCategory5(root);

    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checks.map((c) => c.check_id)).toEqual([
      'parse-config-fallback-chain',
      'hooks-use-plugin-root-var',
      'config-reading-doc',
      'bootstrap-gate-doc',
    ]);
  });

  // -------------------------------------------------------------------------
  // Failure case — env vars missing from all resolution surface files
  // -------------------------------------------------------------------------
  it('fails parse-config-fallback-chain when none of the 3 env vars appear anywhere', () => {
    // Provide platform.mjs but with no env var references
    ensureDir(join(root, 'scripts/lib'));
    writeFileSync(join(root, 'scripts/lib/platform.mjs'), '// no env vars here\n');

    const checks = runCategory5(root);
    const chain = checks.find((c) => c.check_id === 'parse-config-fallback-chain');

    expect(chain.status).toBe('fail');
    expect(chain.evidence.envVarsFound).toHaveLength(0);
    expect(chain.message).toContain('CLAUDE_PLUGIN_ROOT');
  });

  // -------------------------------------------------------------------------
  // Edge case — env vars can be detected in arbitrary files (hooks.json counts)
  // -------------------------------------------------------------------------
  it('passes parse-config-fallback-chain when env vars are spread across hooks JSON files', () => {
    ensureDir(join(root, 'scripts/lib'));
    // platform.mjs has only one
    writeFileSync(
      join(root, 'scripts/lib/platform.mjs'),
      'const a = process.env.CLAUDE_PLUGIN_ROOT;\n',
    );

    // Two more via hooks JSON files
    ensureDir(join(root, 'hooks'));
    writeFileSync(
      join(root, 'hooks/hooks-codex.json'),
      JSON.stringify({ command: 'node $CODEX_PLUGIN_ROOT/hooks/pre.mjs' }),
    );
    writeFileSync(
      join(root, 'hooks/hooks-cursor.json'),
      JSON.stringify({ dir: '$CURSOR_RULES_DIR/hooks' }),
    );

    // Satisfy remaining checks so we can isolate c5.1
    ensureDir(join(root, 'skills/_shared'));
    writeFileSync(
      join(root, 'skills/_shared/config-reading.md'),
      'PLUGIN_ROOT details\n',
    );
    writeFileSync(
      join(root, 'skills/_shared/bootstrap-gate.md'),
      'CLAUDE.md Session Config bootstrap.lock\n',
    );
    writeFileSync(
      join(root, 'hooks/hooks.json'),
      JSON.stringify({ hooks: [{ event: 'PreToolUse', command: 'node $CLAUDE_PLUGIN_ROOT/hooks/pre.mjs' }] }),
    );

    const checks = runCategory5(root);
    const chain = checks.find((c) => c.check_id === 'parse-config-fallback-chain');

    expect(chain.status).toBe('pass');
    expect(chain.evidence.envVarsFound).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Failure case — hooks.json uses absolute path instead of env var
  // -------------------------------------------------------------------------
  it('fails hooks-use-plugin-root-var when hooks.json contains absolute path commands', () => {
    scaffoldHappyPath(root);

    // Overwrite hooks.json with a bad absolute-path command
    writeFileSync(
      join(root, 'hooks/hooks.json'),
      JSON.stringify({
        hooks: [
          { event: 'PreToolUse', command: 'node /home/user/hooks/pre-bash.mjs' },
        ],
      }),
    );

    const checks = runCategory5(root);
    const hookCheck = checks.find((c) => c.check_id === 'hooks-use-plugin-root-var');

    expect(hookCheck.status).toBe('fail');
    expect(hookCheck.evidence.absolutePathCount).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Failure case — config-reading.md present but lacks PLUGIN_ROOT mention
  // -------------------------------------------------------------------------
  it('fails config-reading-doc when config-reading.md does not mention PLUGIN_ROOT', () => {
    scaffoldHappyPath(root);

    // Overwrite with content that has no PLUGIN_ROOT reference
    writeFileSync(
      join(root, 'skills/_shared/config-reading.md'),
      '# Config Reading\n\nRead session config from CLAUDE.md.\n',
    );

    const checks = runCategory5(root);
    const doc = checks.find((c) => c.check_id === 'config-reading-doc');

    expect(doc.status).toBe('fail');
    expect(doc.evidence.present).toBe(true);
    expect(doc.message).toContain('PLUGIN_ROOT');
  });
});
