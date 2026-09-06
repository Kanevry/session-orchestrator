/**
 * tests/lib/vault-backfill/template-baseline-resolution.test.mjs
 *
 * NAMED BUG (2026-09-06 Wave 1): `TEMPLATE_PATH` had exactly two tiers —
 * `PROJECTS_BASELINE_DIR` or the hardcoded `$HOME/Projects/projects-baseline`.
 * On a host whose (optional, private) baseline checkout lives anywhere else,
 * `loadTemplate` hard-aborted via `dieFn(2, …)` even though the host-local
 * override `owner.yaml paths.baseline-path` / `SO_BASELINE_PATH` was set — that
 * tier was simply not consulted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTENT = '# resolved via the host-local baseline override\n';

function baselineAt(dir) {
  mkdirSync(join(dir, 'templates', 'shared'), { recursive: true });
  writeFileSync(join(dir, 'templates', 'shared', '.vault.yaml.template'), CONTENT, 'utf8');
  return dir;
}

const dirs = [];
const saved = {};

beforeEach(() => {
  vi.resetModules();
  for (const k of ['PROJECTS_BASELINE_DIR', 'SO_BASELINE_PATH', 'SO_CONFIG_HOME']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  dirs.length = 0;
});

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe('vault-backfill TEMPLATE_PATH resolution', () => {
  it('honours SO_BASELINE_PATH — the tier the pre-fix module ignored', async () => {
    const base = baselineAt(tmp('vb-so-baseline-'));
    process.env.SO_BASELINE_PATH = base;

    const { TEMPLATE_PATH, loadTemplate } = await import('@lib/vault-backfill/template.mjs');
    const dieFn = vi.fn();
    expect(TEMPLATE_PATH).toContain(base);
    expect(loadTemplate(dieFn)).toBe(CONTENT);
    expect(dieFn).not.toHaveBeenCalled();
  });

  it('PROJECTS_BASELINE_DIR still outranks SO_BASELINE_PATH', async () => {
    const legacy = baselineAt(tmp('vb-legacy-'));
    const hostLocal = baselineAt(tmp('vb-hostlocal-'));
    process.env.PROJECTS_BASELINE_DIR = legacy;
    process.env.SO_BASELINE_PATH = hostLocal;

    const { TEMPLATE_PATH } = await import('@lib/vault-backfill/template.mjs');
    expect(TEMPLATE_PATH).toContain(legacy);
    expect(TEMPLATE_PATH).not.toContain(hostLocal);
  });

  it('the die message names the host-local override, not just the env var', async () => {
    const empty = tmp('vb-empty-');
    process.env.PROJECTS_BASELINE_DIR = empty;

    const { loadTemplate } = await import('@lib/vault-backfill/template.mjs');
    const dieFn = vi.fn();
    loadTemplate(dieFn);
    // The real `die` exits; a vi.fn() does not, so execution falls through to
    // the readFileSync ENOENT and calls dieFn a second time. Assert the FIRST
    // call — the one an operator actually sees.
    expect(dieFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    const [code, msg] = dieFn.mock.calls[0];
    expect(code).toBe(2);
    expect(msg).toContain('paths.baseline-path');
    expect(msg).toContain('docs/baseline.md');
  });
});
