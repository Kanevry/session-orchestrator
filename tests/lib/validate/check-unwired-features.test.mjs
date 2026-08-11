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
import { inspectUnwiredFeatures } from '@lib/validate/check-unwired-features.mjs';

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

  it('surfaces the real repo census without a tool error', () => {
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
