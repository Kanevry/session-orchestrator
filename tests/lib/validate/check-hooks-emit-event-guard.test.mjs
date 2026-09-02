/**
 * tests/lib/validate/check-hooks-emit-event-guard.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-hooks-emit-event-guard.mjs
 * (#1183) — every `emitEvent(...)` call site under `hooks/**\/*.mjs` must be
 * try/catch-guarded, because `emitEvent()` throws `EventValidationError` on a
 * malformed record and an uncaught throw aborts the hook process (fail-open
 * on the exit-0-JSON deny protocol).
 *
 * The bug this check exists to catch: a hook author adds a new `emitEvent()`
 * call with no surrounding try/catch, and a later malformed payload (or an
 * events-schema tightening) then crashes that hook's process instead of
 * degrading to a dropped telemetry line.
 *
 *   0 = clean (baselined pre-existing sites WARN but do not fail)
 *   1 = at least one NEW (non-baselined) unguarded call site
 *   2 = tool error (e.g. a hook file that fails to parse)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  findEmitEventCalls,
  scanHooksEmitEventGuard,
  runCheckHooksEmitEventGuard,
} from '@lib/validate/check-hooks-emit-event-guard.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-hooks-emit-event-guard.mjs');

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

const tmpRoots = [];

/**
 * Build a tmp repo root with a `hooks/` directory containing exactly the
 * `.mjs` files given in `files` (relative path under hooks/ -> source text).
 */
function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-hooks-emit-event-guard-'));
  tmpRoots.push(root);
  for (const [relPath, source] of Object.entries(files)) {
    const abs = join(root, 'hooks', relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, source, 'utf8');
  }
  return root;
}

function run(repoRoot) {
  return spawnSync('node', [SCRIPT, repoRoot], { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// In-process: import-safety + live repo baseline-only
// ---------------------------------------------------------------------------

describe('runCheckHooksEmitEventGuard — in-process against the live repo', () => {
  it('returns 0 for the real repo — only the #1183-baselined pre-existing sites remain', () => {
    expect(runCheckHooksEmitEventGuard(REPO_ROOT)).toBe(0);
  });

  it('scanHooksEmitEventGuard finds zero NEW (non-baselined) findings against the real repo', () => {
    const { findings, parseErrors } = scanHooksEmitEventGuard(REPO_ROOT);
    expect(parseErrors).toEqual([]);
    expect(findings.filter((f) => !f.baselined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findEmitEventCalls — the scope-walk unit itself
// ---------------------------------------------------------------------------

describe('findEmitEventCalls — try/catch scope walk', () => {
  it('reports a top-level call with no try/catch as unguarded', () => {
    const calls = findEmitEventCalls(
      "async function main() {\n  await emitEvent('x.y', {});\n}\n",
      'fixture.mjs',
    );
    expect(calls).toEqual([{ line: 2, guarded: false, eventType: 'x.y' }]);
  });

  it('reports a call inside try { } catch { } as guarded', () => {
    const calls = findEmitEventCalls(
      "async function main() {\n  try {\n    await emitEvent('x.y', {});\n  } catch {}\n}\n",
      'fixture.mjs',
    );
    expect(calls).toEqual([{ line: 3, guarded: true, eventType: 'x.y' }]);
  });

  it('reports a call inside try { } finally { } (no catch) as unguarded — the throw still propagates', () => {
    const calls = findEmitEventCalls(
      "async function main() {\n  try {\n    await emitEvent('x.y', {});\n  } finally {}\n}\n",
      'fixture.mjs',
    );
    expect(calls).toEqual([{ line: 3, guarded: false, eventType: 'x.y' }]);
  });

  it('reports a call inside the catch block itself as unguarded — that try does not guard its own handler', () => {
    const calls = findEmitEventCalls(
      "async function main() {\n  try {\n    doWork();\n  } catch {\n    await emitEvent('x.y', {});\n  }\n}\n",
      'fixture.mjs',
    );
    expect(calls).toEqual([{ line: 5, guarded: false, eventType: 'x.y' }]);
  });

  it('the nested-function false negative: an emitEvent() call inside a helper invoked FROM a try in another function is unguarded', () => {
    const source = [
      'async function outer() {',
      '  try {',
      '    await helper();',
      '  } catch {}',
      '}',
      'async function helper() {',
      "  await emitEvent('x.y', {});",
      '}',
    ].join('\n');
    const calls = findEmitEventCalls(source, 'fixture.mjs');
    expect(calls).toEqual([{ line: 7, guarded: false, eventType: 'x.y' }]);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: guarded/unguarded fixtures
// ---------------------------------------------------------------------------

describe('check-hooks-emit-event-guard CLI — guarded/unguarded fixtures', () => {
  it('exits 1 and names the unguarded file:line when one guarded and one unguarded call exist', () => {
    const root = makeFixture({
      'guarded.mjs': "async function a() {\n  try {\n    await emitEvent('a.guarded', {});\n  } catch {}\n}\n",
      'unguarded.mjs': "async function b() {\n  await emitEvent('b.unguarded', {});\n}\n",
    });

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL');
    expect(r.stdout).toContain('hooks/unguarded.mjs:2');
    expect(r.stdout).not.toContain('hooks/guarded.mjs');
  });

  it('exits 0 when every call site is guarded', () => {
    const root = makeFixture({
      'guarded.mjs': "async function a() {\n  try {\n    await emitEvent('a.guarded', {});\n  } catch {}\n}\n",
    });

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FAIL');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });

  it('reports the nested-function false-negative fixture as unguarded (exit 1)', () => {
    const root = makeFixture({
      'nested.mjs': [
        'async function outer() {',
        '  try {',
        '    await helper();',
        '  } catch {}',
        '}',
        'async function helper() {',
        "  await emitEvent('x.y', {});",
        '}',
      ].join('\n'),
    });

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('hooks/nested.mjs:7');
  });

  it('exits 2 and writes usage to stderr when no repo-root argument is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: check-hooks-emit-event-guard.mjs <repo-root>');
  });
});
