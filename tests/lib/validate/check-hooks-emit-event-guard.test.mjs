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

import { describe, it, expect, afterEach, vi } from 'vitest';
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
  it('returns 0 for the real repo — the #1183 baseline is empty and every site is guarded (MED-3)', () => {
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
// Baseline Map: stale entries and missing reasons (MED-3, architect review)
//
// The bug this guards against: BASELINE_UNGUARDED was a bare Set with no
// per-entry reason and no drain mechanism — a future exemption could be
// added with no linked issue, and a site fixed under its own file-scope
// left a permanently-silent baseline entry behind forever. Mirrors
// check-unwired-features.mjs's ALLOWLIST allowlist-stale /
// allowlist-missing-reason precedent.
// ---------------------------------------------------------------------------

describe('scanHooksEmitEventGuard — baseline Map: stale entries and missing reasons (MED-3)', () => {
  it('reports a baseline entry whose site is now guarded as baseline-stale', () => {
    const root = makeFixture({
      'guarded.mjs': "async function a() {\n  try {\n    await emitEvent('a.guarded', {});\n  } catch {}\n}\n",
    });
    const baseline = new Map([['hooks/guarded.mjs::a.guarded', 'placeholder reason — GitLab #0000']]);

    const { findings } = scanHooksEmitEventGuard(root, { baseline });

    expect(findings).toEqual([
      {
        kind: 'baseline-stale',
        key: 'hooks/guarded.mjs::a.guarded',
        message: 'baseline entry no longer matches an unguarded call site (guarded or removed) — remove the entry',
      },
    ]);
  });

  it('reports a baseline entry whose site no longer exists at all as baseline-stale', () => {
    const root = makeFixture({
      'other.mjs': "async function a() {\n  doWork();\n}\n",
    });
    const baseline = new Map([['hooks/removed.mjs::gone.event', 'placeholder reason — GitLab #0000']]);

    const { findings } = scanHooksEmitEventGuard(root, { baseline });

    expect(findings).toEqual([
      {
        kind: 'baseline-stale',
        key: 'hooks/removed.mjs::gone.event',
        message: 'baseline entry no longer matches an unguarded call site (guarded or removed) — remove the entry',
      },
    ]);
  });

  it('reports a baseline entry with a whitespace-only reason as baseline-missing-reason while the site still matches', () => {
    const root = makeFixture({
      'unguarded.mjs': "async function b() {\n  await emitEvent('b.unguarded', {});\n}\n",
    });
    const baseline = new Map([['hooks/unguarded.mjs::b.unguarded', '   ']]);

    const { findings } = scanHooksEmitEventGuard(root, { baseline });

    expect(findings).toEqual([
      {
        kind: 'baseline-missing-reason',
        key: 'hooks/unguarded.mjs::b.unguarded',
        message: 'baseline entry has no reason — name the linked issue or remove the entry',
      },
      {
        kind: 'unguarded',
        file: 'hooks/unguarded.mjs',
        line: 2,
        eventType: 'b.unguarded',
        baselined: true,
      },
    ]);
  });

  it('a reasoned baseline entry that still matches produces neither baseline-stale nor baseline-missing-reason', () => {
    const root = makeFixture({
      'unguarded.mjs': "async function b() {\n  await emitEvent('b.unguarded', {});\n}\n",
    });
    const baseline = new Map([['hooks/unguarded.mjs::b.unguarded', 'placeholder reason — GitLab #0000']]);

    const { findings } = scanHooksEmitEventGuard(root, { baseline });

    expect(findings).toEqual([
      { kind: 'unguarded', file: 'hooks/unguarded.mjs', line: 2, eventType: 'b.unguarded', baselined: true },
    ]);
  });

  it('empty baseline + all-guarded fixture passes with zero findings (the shipped default shape)', () => {
    const root = makeFixture({
      'guarded.mjs': "async function a() {\n  try {\n    await emitEvent('a.guarded', {});\n  } catch {}\n}\n",
    });

    const { findings, parseErrors } = scanHooksEmitEventGuard(root, { baseline: new Map() });

    expect(parseErrors).toEqual([]);
    expect(findings).toEqual([]);
  });

  it('runCheckHooksEmitEventGuard exits 1 and prints baseline-stale for a stale entry (CLI print format)', () => {
    const root = makeFixture({
      'guarded.mjs': "async function a() {\n  try {\n    await emitEvent('a.guarded', {});\n  } catch {}\n}\n",
    });
    const baseline = new Map([['hooks/guarded.mjs::a.guarded', 'placeholder reason — GitLab #0000']]);

    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => logs.push(line));
    try {
      const code = runCheckHooksEmitEventGuard(root, { baseline });
      expect(code).toBe(1);
    } finally {
      spy.mockRestore();
    }

    const out = logs.join('\n');
    expect(out).toContain('FAIL');
    expect(out).toContain('hooks/guarded.mjs::a.guarded');
    expect(out).toContain('baseline-stale');
    expect(out).toContain('Results: 0 passed, 1 failed');
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
