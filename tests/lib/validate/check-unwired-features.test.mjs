/**
 * tests/lib/validate/check-unwired-features.test.mjs
 *
 * Tests for scripts/lib/validate/check-unwired-features.mjs.
 *
 * The bug every case here names is ONE bug, in its variants:
 *   "a Session Config key exists in a config surface, but no code reads it."
 *
 * Each test plants a synthetic key in a tmpdir fixture repo and asserts the
 * census reports it — the fake-regression shape the check exists for. No test
 * pins a count against the real repo's growing key set, and no test asserts
 * prose presence (`test-value.md` TV-002).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  inspectUnwiredFeatures,
  collectOrphanedProseModules,
} from '@lib/validate/check-unwired-features.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-unwired-features.mjs');

/**
 * Build a minimal fixture repo: a template with one yaml fence, a live
 * `## Session Config` block, and a consumer file under scripts/lib/config/.
 *
 * @param {{template?: string, live?: string, parser?: string, consumer?: string}} parts
 * @returns {string} absolute fixture root (caller removes it)
 */
function makeFixture(parts) {
  const root = mkdtempSync(join(tmpdir(), 'unwired-features-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'lib', 'config'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });

  writeFileSync(
    join(root, 'docs', 'session-config-template.md'),
    ['# Template', '', '```yaml', parts.template ?? 'wired-key: true', '```', ''].join('\n'),
  );
  writeFileSync(
    join(root, 'CLAUDE.md'),
    ['# Fixture', '', '## Session Config', '', parts.live ?? 'wired-key: true', '', '## Other', ''].join(
      '\n',
    ),
  );
  writeFileSync(
    join(root, 'scripts', 'lib', 'config', 'fixture.mjs'),
    parts.parser ?? "export const KEY = kv['wired-key'];\n",
  );
  if (parts.consumer) writeFileSync(join(root, 'hooks', 'fixture-hook.mjs'), parts.consumer);
  return root;
}

describe('check-unwired-features — declared-but-unread census', () => {
  it('reports a template key that no code reads, and stops reporting it once a reader exists', () => {
    // Fake-regression: the SAME fixture, one line of parser code apart.
    const withoutReader = makeFixture({
      template: ['wired-key: true', 'ghost-key: false'].join('\n'),
    });
    const withReader = makeFixture({
      template: ['wired-key: true', 'ghost-key: false'].join('\n'),
      parser: "export const A = kv['wired-key'];\nexport const B = kv['ghost-key'];\n",
    });
    try {
      const red = inspectUnwiredFeatures(withoutReader);
      expect(red.findings.map((f) => `${f.kind}:${f.key}`)).toContain('unwired-config-key:ghost-key');

      const green = inspectUnwiredFeatures(withReader);
      expect(green.findings.map((f) => f.key)).not.toContain('ghost-key');
    } finally {
      rmSync(withoutReader, { recursive: true, force: true });
      rmSync(withReader, { recursive: true, force: true });
    }
  });

  it('reports a key declared only in the live Session Config (never documented in the template)', () => {
    // The compact-nudge / goal-integration shape: switched on in CLAUDE.md,
    // absent from the template, zero .mjs read sites.
    const root = makeFixture({ live: ['wired-key: true', 'goal-integration:', '  seams: [a]'].join('\n') });
    try {
      const result = inspectUnwiredFeatures(root);
      const finding = result.findings.find((f) => f.key === 'goal-integration');
      expect(finding?.kind).toBe('unwired-config-key');
      expect(finding?.message).toContain('CLAUDE.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a key that is only MENTIONED in code but unknown to the config-parser layer', () => {
    // The express-path shape: a log-message template literal is not a read.
    const root = makeFixture({
      template: ['wired-key: true', 'log-only-key: true'].join('\n'),
      consumer: 'export const msg = `state (log-only-key: ${flagPassedInByCaller})`;\n',
    });
    try {
      const result = inspectUnwiredFeatures(root);
      const finding = result.findings.find((f) => f.key === 'log-only-key');
      expect(finding?.kind).toBe('parser-orphan-config-key');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a nested key whose leaf is a generic word read under its own parent', () => {
    // False-positive guard: `enabled` must not be judged repo-wide. The parser
    // file names both the parent block and the leaf, which is a real read.
    const root = makeFixture({
      template: ['wired-key: true', 'feature-block:', '  enabled: true', '  mode: warn'].join('\n'),
      live: ['wired-key: true', 'feature-block:', '  enabled: true', '  mode: warn'].join('\n'),
      parser:
        "export const A = kv['wired-key'];\n" +
        "const block = kv['feature-block'] ?? {};\nexport const enabled = block.enabled;\nexport const mode = block.mode;\n",
    });
    try {
      const result = inspectUnwiredFeatures(root);
      expect(result.findings.map((f) => f.key)).not.toContain('feature-block.enabled');
      expect(result.findings.map((f) => f.key)).not.toContain('feature-block.mode');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat a commented-out key as declared', () => {
    // Commenting a key out IS the documented way to leave it unset
    // (`# bash-write-guard: true`); flagging it would make the check unusable.
    const root = makeFixture({
      template: ['wired-key: true', '# disabled-on-purpose: true'].join('\n'),
    });
    try {
      const result = inspectUnwiredFeatures(root);
      expect(result.findings.map((f) => f.key)).not.toContain('disabled-on-purpose');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 0 with findings present — the check is WARN-only, not a blocking gate', () => {
    const root = makeFixture({ template: ['wired-key: true', 'ghost-key: false'].join('\n') });
    try {
      const run = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('WARN: [unwired-config-key] ghost-key');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes tests/ from the consumer corpus, so a test-only key still counts as unread', () => {
    // The efficiency.output-level shape: 10 test files, 0 runtime consumers.
    const root = makeFixture({ template: ['wired-key: true', 'test-only-key: 1'].join('\n') });
    try {
      mkdirSync(join(root, 'scripts', 'tests'), { recursive: true });
      writeFileSync(
        join(root, 'scripts', 'tests', 'fixture.test.mjs'),
        "expect(kv['test-only-key']).toBe(1);\n",
      );
      const result = inspectUnwiredFeatures(root);
      expect(result.findings.map((f) => f.key)).toContain('test-only-key');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Explicit per-test timeout, NOT a global widen (`testing.md` § Async &
  // Timeout Patterns permits exactly this for a known-slow operation; § Shard-Time
  // Contention forbids raising the default to paper over one case).
  //
  // Measured 2026-08-21: this case walks the real repo tree and takes 5.3-6.0s in
  // isolation across three runs — barely 40% headroom under the 10s default. It
  // therefore passes alone and times out inside the full suite whenever the host
  // is loaded, which is the "green locally, red in the suite" shape that reads as
  // a code regression and is not one. The work is a filesystem census; the fix is
  // headroom, not a faster assertion.
  it('surfaces the real repo census without a tool error', { timeout: 30_000 }, () => {
    // Grounding pin: the collector must actually resolve this repo's surfaces.
    // Floor/ceiling per `testing.md` § Dynamic Artifact Counts — the key set grows.
    const result = inspectUnwiredFeatures(REPO_ROOT);
    expect(result.toolError).toBe(false);
    expect(result.summary.declaredKeys).toBeGreaterThan(100);
    expect(result.summary.consumerFiles).toBeGreaterThan(100);
    expect(result.findings.filter((f) => f.kind === 'allowlist-missing-reason')).toEqual([]);
    expect(result.findings.filter((f) => f.kind === 'allowlist-stale')).toEqual([]);
  });
});

/**
 * Build a fixture repo holding ONE library module plus one prose document, and
 * optionally a second module that references it.
 *
 * @param {{module?: string, prose?: string, proseName?: string, consumer?: string}} parts
 * @returns {string} absolute fixture root (caller removes it)
 */
function makeModuleFixture(parts) {
  const root = mkdtempSync(join(tmpdir(), 'orphan-module-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });

  writeFileSync(
    join(root, 'scripts', 'lib', 'orphan.mjs'),
    parts.module ?? 'export function doTheThing() {\n  return 1;\n}\n',
  );
  writeFileSync(join(root, 'docs', parts.proseName ?? 'guide.md'), parts.prose ?? '');
  if (parts.consumer) writeFileSync(join(root, 'scripts', 'lib', 'consumer.mjs'), parts.consumer);
  return root;
}

/** @param {string} root @returns {string[]} reported module paths */
const orphanKeys = (root) => collectOrphanedProseModules(root).findings.map((f) => f.key);

describe('check-unwired-features — S3 orphaned-prose-module census', () => {
  it('reports a module the prose only names by filename, and stops once the prose names a symbol', () => {
    // Fake-regression: the SAME module and the SAME document, one word apart.
    // Passive + bare filename = a promise nobody performs; naming the export
    // makes it an instruction addressed to a reader.
    const promise = makeModuleFixture({
      prose: 'All transitions are validated against `scripts/lib/orphan.mjs` before writing.\n',
    });
    const instruction = makeModuleFixture({
      prose: 'Validate each transition by calling `doTheThing()` from `scripts/lib/orphan.mjs`.\n',
    });
    try {
      expect(orphanKeys(promise)).toContain(join('scripts', 'lib', 'orphan.mjs'));
      expect(orphanKeys(instruction)).toEqual([]);
    } finally {
      rmSync(promise, { recursive: true, force: true });
      rmSync(instruction, { recursive: true, force: true });
    }
  });

  it('does not report a module reached by dynamic import through a URL variable', () => {
    // FP class 1 (skill-health/join.mjs): a `from '…orphan.mjs'` regex sees no
    // importer here, but category9-style code genuinely calls it. Any
    // non-comment mention of the basename counts as a reference.
    const root = makeModuleFixture({
      prose: 'The join step is described in `scripts/lib/orphan.mjs`.\n',
      consumer:
        "const url = new URL('./orphan.mjs', import.meta.url).href;\n" +
        'export const src = `const m = await import(${JSON.stringify(url)});`;\n',
    });
    try {
      expect(orphanKeys(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still reports a module whose only mention in code is a JSDoc comment', () => {
    // The mission-status-schema shape: three `* … orphan.mjs` JSDoc lines in the
    // one module that plausibly would have called it. Prose is not a call, and
    // neither is a comment.
    const root = makeModuleFixture({
      prose: 'Entries are validated against `scripts/lib/orphan.mjs`.\n',
      consumer:
        '/**\n * Callers needing validation should use the helper in orphan.mjs.\n */\n' +
        'export function write(x) {\n  return x;\n}\n',
    });
    try {
      expect(orphanKeys(root)).toContain(join('scripts', 'lib', 'orphan.mjs'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a re-export shim, which has no named export the prose could cite', () => {
    // FP class 2 (autopilot-telemetry.mjs): `export *` yields zero named
    // symbols, so "prose names none of its exports" is vacuously true.
    const root = makeModuleFixture({
      module: "export * from './autopilot/telemetry.mjs';\n",
      prose: 'Telemetry lives in `scripts/lib/orphan.mjs`.\n',
    });
    try {
      expect(orphanKeys(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a CLI entrypoint, which is invoked by path rather than imported', () => {
    const root = makeModuleFixture({
      module: '#!/usr/bin/env node\nexport function doTheThing() {\n  return 1;\n}\n',
      prose: 'Run `scripts/lib/orphan.mjs` to refresh the cache.\n',
    });
    try {
      expect(orphanKeys(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores CHANGELOG.md, so a symbol named only in release history does not excuse a dead module', () => {
    // The soul-resolve.mjs shape: the live rule names only the path, while a
    // months-old changelog entry names both exports. Counting history as a live
    // claim silenced a true positive.
    const root = makeModuleFixture({ prose: '', proseName: 'guide.md' });
    try {
      writeFileSync(
        join(root, 'CHANGELOG.md'),
        '- `scripts/lib/orphan.mjs` — pure `doTheThing()` resolver. 10 tests.\n',
      );
      writeFileSync(
        join(root, 'docs', 'guide.md'),
        'Slots are resolved in-memory each session by `scripts/lib/orphan.mjs`.\n',
      );
      expect(orphanKeys(root)).toContain(join('scripts', 'lib', 'orphan.mjs'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 0 with an S3 finding present — WARN-only, so validate-plugin stays green', () => {
    // validate-plugin tallies /^[ ]{2}FAIL:/gm module-wide: one FAIL line from a
    // WARN-only check would redden the whole script.
    const root = makeModuleFixture({
      prose: 'All transitions are validated against `scripts/lib/orphan.mjs`.\n',
    });
    try {
      const run = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('WARN: [orphaned-prose-module]');
      expect(run.stdout).not.toMatch(/^ {2}FAIL:/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
