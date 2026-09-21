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
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isCliEntrypoint,
  inspectUnwiredFeatures,
  collectOrphanedProseModules,
  collectUnreachableLibraryModules,
  collectHandKeyedLearningSubjects,
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
    // gitignored `.orchestrator/metrics/*.jsonl` ledger (S5). The read is real but
    // never fatal: an absent ledger is a documented no-op, pinned by the
    // "silent no-op when the gitignored ledgers are absent" case below, so this
    // assertion's status is identical with and without the store.
    const result = inspectUnwiredFeatures(REPO_ROOT); // check-untracked-test-deps:ignore
    expect(result.toolError).toBe(false);
    expect(result.summary.declaredKeys).toBeGreaterThan(100);
    expect(result.summary.consumerFiles).toBeGreaterThan(100);
    expect(result.findings.filter((f) => f.kind === 'allowlist-missing-reason')).toEqual([]);
    expect(result.findings.filter((f) => f.kind === 'allowlist-stale')).toEqual([]);

    // #1069 ARCH-MED-2 — `leaveSourceRoot()` is wired by SKILL prose only. That
    // state is RECORDED as a named allowlist line (with its four callers) rather
    // than left anonymous inside the ~50-module S4 backlog, where no reviewer can
    // check a per-module expectation. Two ways this row goes red, both wanted:
    // drop the entry and the module reappears below; wire a real .mjs caller and
    // the `allowlist-stale` assertion above fires instead.
    const s4 = result.findings
      .filter((f) => f.kind === 'unreachable-library-module')
      .map((f) => f.key);
    expect(s4).not.toContain(join('scripts', 'lib', 'session-transition.mjs'));
    // Vacuum guard: an empty S4 census would satisfy the line above for the
    // wrong reason (`.claude/rules/host-resources.md` HR-105 — a class at 0%
    // is either genuinely rare or silently broken, and the two look alike).
    // The guard runs on the UNION of the two S4 kinds, because the 2026-09-07
    // category split (#1239) moved 46 of the 52 findings into the advisory
    // `coordinator-invoked-module` class without shrinking what was censused.
    const s4Advisory = result.findings
      .filter((f) => f.kind === 'coordinator-invoked-module')
      .map((f) => f.key);
    expect(s4.length + s4Advisory.length).toBeGreaterThan(10);
    expect(s4Advisory.length).toBeGreaterThan(0);
    // The ADVISORY half keeps its live-repo floor above; the REPORTABLE half no
    // longer has one, deliberately. `expect(s4.length).toBeGreaterThan(0)` stood
    // here until 2026-09-16, when the live reportable backlog reached zero —
    // `scripts/lib/locks/index.mjs` deleted (0 importers) and
    // `scripts/lib/worktree/index.mjs` reclassified by the export-* cluster-root
    // fix. A guard whose green state REQUIRES an unfixed defect in the tree is
    // the broken instrument `.claude/rules/host-resources.md` HR-101 describes:
    // it would have to be deleted by whoever fixed the last finding anyway, and
    // until then it taxes every real fix.
    // What it was protecting — "a module that qualifies still LANDS in the
    // reportable class, the split did not quietly route everything to advisory"
    // — is carried by the S4 fixture cases below, which assert the reportable
    // half by exact key on a synthetic tree and cannot be satisfied by an empty
    // census. The union floor above still proves S4 censuses the live repo at
    // all, which is the other half of HR-105.
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

/**
 * Build a fixture repo for the S4 reachability census.
 *
 * Shape: `hooks/hooks.json` names `hooks/entry.mjs` (the only mechanical entry
 * root), plus whatever modules the case plants under `scripts/lib/`.
 *
 * @param {{entry?: string, modules?: Record<string, string>, pkg?: object, prose?: string}} parts
 * @returns {string} absolute fixture root (caller removes it)
 */
function makeGraphFixture(parts) {
  const root = mkdtempSync(join(tmpdir(), 'unreachable-module-'));
  mkdirSync(join(root, 'hooks'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });

  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ command: 'node hooks/entry.mjs' }] } }),
  );
  writeFileSync(join(root, 'hooks', 'entry.mjs'), parts.entry ?? 'export const noop = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify(parts.pkg ?? { scripts: {} }));
  for (const [rel, body] of Object.entries(parts.modules ?? {})) {
    mkdirSync(join(root, 'scripts', 'lib', dirname(rel)), { recursive: true });
    writeFileSync(join(root, 'scripts', 'lib', rel), body);
  }
  if (parts.prose) {
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills', 'SKILL.md'), parts.prose);
  }
  return root;
}

/**
 * @param {string} root
 * @returns {string[]} module paths reported as `unreachable-library-module`
 *   (the reportable half of S4 — `coordinator-invoked-module` is the advisory
 *   half and is asserted on `findings` directly).
 */
const unreachableKeys = (root) =>
  collectUnreachableLibraryModules(root)
    .findings.filter((f) => f.kind === 'unreachable-library-module')
    .map((f) => f.key);

describe('check-unwired-features — S4 unreachable-library-module census', () => {
  it('reports a module only markdown names, and stops once a hook actually imports it', () => {
    // THE BUG: skills/session-start/SKILL.md Phase 4 named 19 banner probes, and
    // no hook reached one of them. S3 reads a symbol-naming document as wiring
    // (its condition 5), so it stayed silent for all 19.
    // Fake-regression: the SAME module and the SAME prose, one import apart.
    // The prose here names the FILE only — a document that also names an export
    // is the `coordinator-invoked-module` class, pinned separately below.
    const proseOnly = makeGraphFixture({
      modules: { 'probe-banner.mjs': 'export function checkProbe() {\n  return 1;\n}\n' },
      prose: 'Phase 4 banners are refreshed from `scripts/lib/probe-banner.mjs`.\n',
    });
    const hookWired = makeGraphFixture({
      entry: "import { checkProbe } from '../scripts/lib/probe-banner.mjs';\nexport const r = checkProbe();\n",
      modules: { 'probe-banner.mjs': 'export function checkProbe() {\n  return 1;\n}\n' },
      prose: 'Phase 4 banners are refreshed from `scripts/lib/probe-banner.mjs`.\n',
    });
    try {
      expect(unreachableKeys(proseOnly)).toContain(join('scripts', 'lib', 'probe-banner.mjs'));
      expect(unreachableKeys(hookWired)).toEqual([]);
    } finally {
      rmSync(proseOnly, { recursive: true, force: true });
      rmSync(hookWired, { recursive: true, force: true });
    }
  });

  it('keeps a module whose prose names the FILE only in the unreachable class', () => {
    // Regression guard for the 2026-09-07 category split (#1239). The split must
    // narrow the class by the discriminator (prose naming an EXPORT), never by
    // the weaker "some skill doc mentions the filename" — which every one of the
    // 52 findings satisfied and would have emptied the class outright.
    const root = makeGraphFixture({
      modules: { 'dead-feature.mjs': 'export function runDeadFeature() {\n  return 1;\n}\n' },
      prose: 'Cleanup is handled by `dead-feature.mjs` during session end.\n',
    });
    try {
      expect(unreachableKeys(root)).toEqual([join('scripts', 'lib', 'dead-feature.mjs')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('splits a module an instruction surface tells a coordinator to CALL into its own class', () => {
    // THE BUG the split fixes: 46 of 52 findings (88.5%, measured 2026-09-07) were
    // this shape — an instruction doc names the module AND an exported symbol, so
    // an LLM is told to call it. That is the plugin's architecture, and a class
    // firing at 88.5% is the broken instrument `.claude/rules/host-resources.md`
    // HR-101 forbids. Same fixture as the guard above, one symbol apart.
    const root = makeGraphFixture({
      modules: { 'dead-feature.mjs': 'export function runDeadFeature() {\n  return 1;\n}\n' },
      prose: 'Run `runDeadFeature()` from `dead-feature.mjs` in Phase 3.\n',
    });
    try {
      const findings = collectUnreachableLibraryModules(root).findings;
      const key = join('scripts', 'lib', 'dead-feature.mjs');
      // Reclassified, never suppressed: absent from the unreachable set, present
      // in `findings` — a programmatic consumer still sees the module.
      expect(findings.find((f) => f.key === key)?.kind).toBe('coordinator-invoked-module');
      expect(unreachableKeys(root)).toEqual([]);
      expect(findings.map((f) => f.key)).toContain(key);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('downgrades only the module a doc names by PATH when the basename collides', () => {
    // THE BUG: the downgrade matched `doc.body.includes(path.basename(file))`, so
    // one doc naming `a/writer.mjs` moved EVERY `writer.mjs` into the advisory
    // class — measured collision in this repo: `peer-cards/writer.mjs` vs
    // `reconcile/writer.mjs`. Both modules export the SAME symbol here on
    // purpose: the export half then cannot discriminate, so only the path half
    // can, and the case goes red without the fix.
    const root = makeGraphFixture({
      modules: {
        'a/writer.mjs': 'export function writeCard() {\n  return 1;\n}\n',
        'b/writer.mjs': 'export function writeCard() {\n  return 2;\n}\n',
      },
      prose: 'Run `writeCard()` from `a/writer.mjs` in Phase 3.\n',
    });
    try {
      const findings = collectUnreachableLibraryModules(root).findings;
      const keyA = join('scripts', 'lib', 'a', 'writer.mjs');
      const keyB = join('scripts', 'lib', 'b', 'writer.mjs');
      expect(findings.find((f) => f.key === keyA)?.kind).toBe('coordinator-invoked-module');
      expect(findings.find((f) => f.key === keyB)?.kind).toBe('unreachable-library-module');
      expect(unreachableKeys(root)).toEqual([keyB]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not downgrade a module whose basename is only a SUBSTRING of a named one', () => {
    // THE BUG (Codex, 2026-09-07): the downgrade matched `body.includes(base)`, so
    // a doc naming `config-writer.mjs` also matched `writer.mjs` INSIDE it and moved
    // a genuinely unreachable module into the advisory class — a real finding lost to
    // a doc that never named it. Basenames are unique here on purpose, so the
    // collision branch cannot mask the substring branch.
    const root = makeGraphFixture({
      modules: { 'writer.mjs': 'export function render() {\n  return 1;\n}\n' },
      prose: 'Use config-writer.mjs and render().\n',
    });
    try {
      const key = join('scripts', 'lib', 'writer.mjs');
      const findings = collectUnreachableLibraryModules(root).findings;
      expect(findings.find((f) => f.key === key)?.kind).toBe('unreachable-library-module');
      expect(unreachableKeys(root)).toEqual([key]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies the same token boundary to the qualified path of a colliding basename', () => {
    // The collision branch of the same defect: `includes('a/writer.mjs')` fires
    // inside `xtra/a/writer.mjs`. Both fixture modules share `writer.mjs`, so the
    // qualified `dirname/base` form is what is matched, and a doc naming a
    // longer-prefixed path must downgrade neither.
    const root = makeGraphFixture({
      modules: {
        'a/writer.mjs': 'export function writeCard() {\n  return 1;\n}\n',
        'b/writer.mjs': 'export function writeCard() {\n  return 2;\n}\n',
      },
      prose: 'Run `writeCard()` from `xtra-a/writer.mjs` in Phase 3.\n',
    });
    try {
      const keyA = join('scripts', 'lib', 'a', 'writer.mjs');
      const keyB = join('scripts', 'lib', 'b', 'writer.mjs');
      expect(unreachableKeys(root).sort()).toEqual([keyA, keyB].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts a static import from skills/ as an edge, so its target is not reported', () => {
    // Corpus gap, not a defect: `skills/vault-sync/validator.mjs:71` statically
    // imports `scripts/lib/vault-sync-baseline.mjs`, but `skills/**` was never
    // walked, so the import was invisible and the target read as unreachable.
    // Code under skills/ is code; only its MARKDOWN is prose.
    const root = makeGraphFixture({
      modules: { 'dead-feature.mjs': 'export function runDeadFeature() {\n  return 1;\n}\n' },
    });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'tool.mjs'),
      "import { runDeadFeature } from '../scripts/lib/dead-feature.mjs';\nexport const r = runDeadFeature();\n",
    );
    try {
      expect(collectUnreachableLibraryModules(root).findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a module reached only TRANSITIVELY through another module', () => {
    // False-positive edge: `memory-paths.mjs` is imported by `memory-banner.mjs`,
    // never by a hook. A one-hop reachability check would report it and be wrong —
    // the graph must close transitively or every second-level helper fires.
    const root = makeGraphFixture({
      entry: "import { mid } from '../scripts/lib/middle.mjs';\nexport const r = mid();\n",
      modules: {
        'middle.mjs': "import { leaf } from './deep/leaf.mjs';\nexport function mid() {\n  return leaf();\n}\n",
        'deep/leaf.mjs': 'export function leaf() {\n  return 1;\n}\n',
      },
    });
    try {
      expect(unreachableKeys(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports only the ROOT of a dead cluster, not the interior it drags down', () => {
    // THE BUG this collapse prevents: `scripts/lib/owner-config.mjs` has no
    // importer and drags a 7-file subtree with it. Reporting all 7 turns one
    // deletion into seven findings that vanish together — the line-count that
    // gets a WARN-only census switched off (`.claude/rules/host-resources.md` HR-101).
    const root = makeGraphFixture({
      modules: {
        'orphan-root.mjs': "import { helper } from './orphan/helper.mjs';\nexport function top() {\n  return helper();\n}\n",
        'orphan/helper.mjs': 'export function helper() {\n  return 1;\n}\n',
      },
    });
    try {
      expect(unreachableKeys(root)).toEqual([join('scripts', 'lib', 'orphan-root.mjs')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // THE BUG (#1293): the root filter suppressed a module whenever ANY other
  // unreachable module mentioned its bare basename. `owner.mjs` naming
  // `index.mjs` therefore masked BOTH `a/index.mjs` and `b/index.mjs` at once
  // — the live instance was `locks/index.mjs` + `worktree/index.mjs`, which
  // only resurfaced when the masking module was deleted for an unrelated
  // reason. The mention sits in CODE, not a comment: `mentionedModuleTokens`
  // skips comment-only lines. The second row is the over-correction guard:
  // making an ambiguous basename never suppress would re-report every
  // interior member of a drag cluster, which the cluster-root collapse exists
  // to prevent — a qualified `a/index.mjs` mention is a real reference and
  // must collapse that root, and only that one.
  it.each([
    {
      name: 'keeps both differently-pathed roots when one module mentions their BARE colliding basename',
      mention: "'index.mjs'",
      aUnreachable: true,
      bUnreachable: true,
    },
    {
      name: 'still collapses the ONE colliding root a module names by its qualified path',
      mention: "'a/index.mjs'",
      aUnreachable: false,
      bUnreachable: true,
    },
  ])('$name', ({ mention, aUnreachable, bUnreachable }) => {
    const root = makeGraphFixture({
      modules: {
        'a/index.mjs': 'export function fromA() {\n  return 1;\n}\n',
        'b/index.mjs': 'export function fromB() {\n  return 2;\n}\n',
        'owner.mjs': `export const target = ${mention};\n`,
      },
    });
    try {
      const keys = unreachableKeys(root);
      expect(keys.includes(join('scripts', 'lib', 'a', 'index.mjs'))).toBe(aUnreachable);
      expect(keys.includes(join('scripts', 'lib', 'b', 'index.mjs'))).toBe(bUnreachable);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts two dragged modules that share a basename as two, not one', () => {
    // THE BUG (#1298): the "drags N" tail counted basename TOKENS from the
    // `mentions` Set, so a root importing `a/index.mjs` AND `b/index.mjs`
    // collapsed both into one `index.mjs` and read "drags 1" — while the root
    // filter (#1293), judging the same pair per module, suppressed both.
    const root = makeGraphFixture({
      modules: {
        'a/index.mjs': 'export function fromA() {\n  return 1;\n}\n',
        'b/index.mjs': 'export function fromB() {\n  return 2;\n}\n',
        'owner.mjs':
          "import { fromA } from './a/index.mjs';\nimport { fromB } from './b/index.mjs';\n" +
          'export function top() {\n  return fromA() + fromB();\n}\n',
      },
    });
    try {
      const findings = collectUnreachableLibraryModules(root).findings;
      expect(findings.map((f) => f.key)).toEqual([join('scripts', 'lib', 'owner.mjs')]);
      expect(findings[0].message).toContain(', and drags 2 further unreachable module(s).');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // THE BUG (#1293 remainder): a PURE `export *` barrel has zero NAMED exports,
  // so the S4 population predicate (`exports.length > 0`) dropped it entirely.
  // That did not merely hide the barrel — it removed the barrel as the CLUSTER
  // ROOT of the module it re-exports, so the interior module was reported in its
  // place. Live instance measured 2026-09-16: `scripts/lib/worktree.mjs` is
  // `export * from './worktree/index.mjs';`, its only importers (`workspace.mjs`,
  // `worktree-freshness.mjs`) are themselves unreachable, and S4 reported
  // `scripts/lib/worktree/index.mjs`.
  //
  // Not a BFS defect: star re-export lines are not comments, so `mentions`
  // already carries the target and a REACHABLE barrel already propagates
  // reachability (measured the same day: `worktree.mjs` carries `index.mjs`).
  // The population is the whole of it.
  it.each([
    { name: 'export *', line: "export * from './sub/index.mjs';\n" },
    { name: 'export * as ns', line: "export * as sub from './sub/index.mjs';\n" },
  ])('collapses a pure $name barrel and its target into ONE cluster root', ({ line }) => {
    const root = makeGraphFixture({
      modules: {
        'barrel.mjs': line,
        'sub/index.mjs': 'export function fromSub() {\n  return 1;\n}\n',
        'owner.mjs': "import { fromSub } from './barrel.mjs';\nexport function top() {\n  return fromSub();\n}\n",
      },
    });
    try {
      // One dead cluster, one line — at the importer that heads it. Before the
      // fix the interior `sub/index.mjs` was reported alongside it.
      expect(unreachableKeys(root)).toEqual([join('scripts', 'lib', 'owner.mjs')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the barrel itself when nothing imports it and its target is dead too', () => {
    // The over-correction guard for the case above: admitting barrels to the
    // population must not blanket-whitelist them. A barrel nothing imports, over
    // a target nothing else reaches, is a dead cluster and stays reportable —
    // otherwise the fix would trade one misplaced finding for zero findings.
    const root = makeGraphFixture({
      modules: {
        'barrel.mjs': "export * from './sub/index.mjs';\n",
        'sub/index.mjs': 'export function fromSub() {\n  return 1;\n}\n',
      },
    });
    try {
      expect(unreachableKeys(root)).toEqual([join('scripts', 'lib', 'barrel.mjs')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a backward-compat shim re-exporting a module that IS reached', () => {
    // FP class the population change would otherwise introduce, measured
    // 2026-09-16: `scripts/lib/autopilot-telemetry.mjs` is
    // `export * from './autopilot/telemetry.mjs'` over a live target, its sole
    // importer a test — it became a new permanent WARN with no exit, because the
    // coordinator-invoked downgrade iterates `exports` and a star re-export has
    // none. S3 exempts this exact shim by name; S4 must not re-indict it.
    const root = makeGraphFixture({
      entry: "import { live } from '../scripts/lib/live.mjs';\nexport const r = live();\n",
      modules: {
        'shim.mjs': "export * from './live.mjs';\n",
        'live.mjs': 'export function live() {\n  return 1;\n}\n',
      },
    });
    try {
      expect(unreachableKeys(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a CLI entrypoint, whose markdown-only invocation is the design', () => {
    // The deliberate boundary. Treating entrypoints as non-roots was measured at
    // 268/467 modules (57.5%) versus 73 (15.6%) — straight into HR-101's
    // broken-instrument band. `scripts/vault-mirror.mjs` is the known instance
    // this boundary knowingly gives up.
    const root = makeGraphFixture({
      modules: { 'tool.mjs': '#!/usr/bin/env node\nexport function run() {\n  return 1;\n}\n' },
      prose: 'Run `scripts/lib/tool.mjs` to refresh the board.\n',
    });
    try {
      expect(unreachableKeys(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts an npm script as wiring, so a module CI reaches is not reported', () => {
    // False-positive edge: hooks are not the only mechanical entry surface. A
    // module reached solely by `npm run <x>` is wired, and reporting it would
    // indict every build helper in the repo.
    const root = makeGraphFixture({
      modules: { 'built.mjs': 'export function build() {\n  return 1;\n}\n' },
      pkg: { scripts: { build: 'node scripts/lib/built.mjs' } },
    });
    try {
      expect(unreachableKeys(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a module whose only mention in reachable code is a comment', () => {
    // The inverse guard, and the one that keeps S4 honest: a JSDoc line naming a
    // module is documentation, not a call. If comments counted as edges, a single
    // `@see foo.mjs` in a live file would mark a dead module wired forever.
    const root = makeGraphFixture({
      entry: '/**\n * Callers should use the helper in ghost.mjs.\n */\nexport const noop = 1;\n',
      modules: { 'ghost.mjs': 'export function ghost() {\n  return 1;\n}\n' },
    });
    try {
      expect(unreachableKeys(root)).toContain(join('scripts', 'lib', 'ghost.mjs'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the CLI at exit 0 and prints an aggregate, with --list expanding it', () => {
    // THE BUG: validate-plugin tallies /^[ ]{2}FAIL:/gm module-wide and ignores
    // this check's exit code. A blocking S4 would redden the whole validator on a
    // 50-module backlog; an unaggregated one would print 50 WARN lines against the
    // 1-2 every sibling check emits, which is how a census gets switched off.
    const root = makeGraphFixture({
      modules: {
        'ghost-a.mjs': 'export function a() {\n  return 1;\n}\n',
        'ghost-b.mjs': 'export function b() {\n  return 1;\n}\n',
        'advised.mjs': 'export function runAdvised() {\n  return 1;\n}\n',
      },
      prose: 'Run `runAdvised()` from `advised.mjs` in Phase 3.\n',
    });
    try {
      const aggregate = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
      expect(aggregate.status).toBe(0);
      expect(aggregate.stdout).not.toMatch(/^ {2}FAIL:/m);
      expect(aggregate.stdout).toMatch(/WARN: \[unreachable-library-module\] 2 library module\(s\)/);
      // The advisory class carries no WARN at all in the default output: it fires
      // on every run with no action attached (HR-101). Its count still rides the
      // PASS line, which is what ratchets run to run.
      expect(aggregate.stdout).not.toMatch(/coordinator-invoked-module/);
      expect(aggregate.stdout).toMatch(/1 coordinator-invoked module\(s\)/);

      const listed = spawnSync('node', [SCRIPT, root, '--list'], { encoding: 'utf8' });
      expect(listed.status).toBe(0);
      expect(listed.stdout.match(/WARN: \[unreachable-library-module\]/g)).toHaveLength(2);
      expect(listed.stdout.match(/WARN: \[coordinator-invoked-module\]/g)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Build a fixture repo carrying only the two host-local JSONL ledgers S5 reads.
 *
 * @param {{learnings?: object[], sessions?: object[]}} parts
 * @returns {string} absolute fixture root (caller removes it)
 */
function makeLedgerFixture(parts) {
  const root = mkdtempSync(join(tmpdir(), 'sizing-subject-'));
  const metrics = join(root, '.orchestrator', 'metrics');
  mkdirSync(metrics, { recursive: true });
  if (parts.learnings) {
    writeFileSync(
      join(metrics, 'learnings.jsonl'),
      `${parts.learnings.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  }
  if (parts.sessions) {
    writeFileSync(
      join(metrics, 'sessions.jsonl'),
      `${parts.sessions.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  }
  return root;
}

const ULTRADEEP_SESSION = {
  session_id: 'main-2026-09-13-session-4',
  session_type: 'deep',
  session_profile: 'ultradeep',
};

describe('check-unwired-features — S5 effective-sizing subject parity (#1247/#1363)', () => {
  it('reports a hand-concatenated subject that re-merges ultradeep onto the deep row, and stops once it is derived', () => {
    // The bug: the analyzer is PROSE ("always derive via sizingSubject()"), so a
    // run that writes `${session_type}-session-sizing` by hand puts a 7-wave
    // ultradeep session on the same row as a 5-wave deep one — byte-identical to
    // the pre-#1247 literal, and previously invisible to every gate.
    const handKeyed = makeLedgerFixture({
      sessions: [ULTRADEEP_SESSION],
      learnings: [
        {
          id: 'lrn-1',
          type: 'effective-sizing',
          subject: 'deep-session-sizing',
          source_session: ULTRADEEP_SESSION.session_id,
        },
      ],
    });
    const derived = makeLedgerFixture({
      sessions: [ULTRADEEP_SESSION],
      learnings: [
        {
          id: 'lrn-1',
          type: 'effective-sizing',
          subject: 'deep-ultradeep-session-sizing',
          source_session: ULTRADEEP_SESSION.session_id,
        },
      ],
    });
    try {
      const red = collectHandKeyedLearningSubjects(handKeyed);
      expect(red.findings.map((f) => `${f.kind}:${f.key}`)).toEqual(['hand-keyed-learning-subject:lrn-1']);
      expect(red.findings[0].message).toContain('deep-ultradeep-session-sizing');
      expect(red.scanned.judged).toBe(1);

      const green = collectHandKeyedLearningSubjects(derived);
      expect(green.findings).toEqual([]);
      expect(green.scanned.judged).toBe(1);
    } finally {
      rmSync(handKeyed, { recursive: true, force: true });
      rmSync(derived, { recursive: true, force: true });
    }
  });

  it('carries the S5 finding through inspectUnwiredFeatures into summary + findings (wiring pin)', () => {
    // Fängt: die drei Verdrahtungszeilen in inspectUnwiredFeatures, die
    // `summary.handKeyedSubjects` / `summary.judgedSubjects` setzen und die
    // Findings pushen. Alle übrigen S5-Fälle rufen den Kollektor DIREKT — ohne
    // diesen Test verschwindet S5 lautlos aus dem Zensus (gebaut, aber nicht
    // eingeschaltet), obwohl der Kollektor weiter korrekt arbeitet.
    const root = makeFixture({});
    const metrics = join(root, '.orchestrator', 'metrics');
    mkdirSync(metrics, { recursive: true });
    writeFileSync(join(metrics, 'sessions.jsonl'), `${JSON.stringify(ULTRADEEP_SESSION)}\n`);
    writeFileSync(
      join(metrics, 'learnings.jsonl'),
      `${JSON.stringify({
        id: 'lrn-wired',
        type: 'effective-sizing',
        subject: 'deep-session-sizing',
        source_session: ULTRADEEP_SESSION.session_id,
      })}\n`,
    );
    try {
      const result = inspectUnwiredFeatures(root);
      expect(result.summary.handKeyedSubjects).toBe(1);
      expect(result.summary.judgedSubjects).toBe(1);
      expect(result.findings.map((f) => `${f.kind}:${f.key}`)).toContain(
        'hand-keyed-learning-subject:lrn-wired',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('judges only canonically-shaped subjects, so a free-form one is not a finding', () => {
    // Scope guard: measured 2026-09-13, 5 of this repo's 6 live effective-sizing
    // learnings carry free-form sentence subjects. Judging those would put the
    // class at 83% on day one (HR-101) — and a sentence cannot collide two
    // profiles onto one row, which is the only defect S5 exists for.
    const root = makeLedgerFixture({
      sessions: [ULTRADEEP_SESSION],
      learnings: [
        {
          id: 'lrn-free',
          type: 'effective-sizing',
          subject: 'deep known-scope: 4 Wellen / 16 Agenten',
          source_session: ULTRADEEP_SESSION.session_id,
        },
      ],
    });
    try {
      const result = collectHandKeyedLearningSubjects(root);
      expect(result.findings).toEqual([]);
      expect(result.scanned.judged).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a learning that names the semantic session id, not the raw uuid', () => {
    // Fängt: eine Indizierung nur über `session_id`. Ein Learning trägt in
    // `source_session` die Form, die der Schreiber hatte — auf Claude Code ist
    // das die semantische Id, während der Session-Record zusätzlich eine UUID
    // führt. Ohne den zweiten Index landet so ein Learning in `unattributed`
    // und wird nie beurteilt: S5 schweigt still statt zu melden.
    const root = makeLedgerFixture({
      sessions: [
        {
          session_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
          semantic_session_id: 'main-2026-09-13-session-42',
          session_type: 'deep',
          session_profile: 'ultradeep',
        },
      ],
      learnings: [
        {
          id: 'lrn-semantic',
          type: 'effective-sizing',
          subject: 'deep-session-sizing',
          source_session: 'main-2026-09-13-session-42',
        },
      ],
    });
    try {
      const result = collectHandKeyedLearningSubjects(root);
      expect(result.scanned).toEqual({ judged: 1, unattributed: 0 });
      expect(result.findings.map((f) => `${f.kind}:${f.key}`)).toEqual([
        'hand-keyed-learning-subject:lrn-semantic',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts an unresolvable source_session instead of reporting it', () => {
    // The ledger is append-only and host-local, so a learning routinely outlives
    // the session record it names. Reporting that would be a finding about
    // retention, and a false positive is what gets a WARN-only check ignored.
    const root = makeLedgerFixture({
      sessions: [{ session_id: 'someone-else', session_type: 'feature' }],
      learnings: [
        {
          id: 'lrn-orphan',
          type: 'effective-sizing',
          subject: 'deep-session-sizing',
          source_session: 'main-2026-01-01-session-1',
        },
      ],
    });
    try {
      const result = collectHandKeyedLearningSubjects(root);
      expect(result.findings).toEqual([]);
      expect(result.scanned).toEqual({ judged: 0, unattributed: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a silent no-op when the gitignored ledgers are absent, and survives a truncated line', () => {
    // Both files are gitignored (`.gitignore:55`), so CI and every fresh clone
    // run without them: an absent ledger must not become a tool error, and one
    // interrupted append must not blind the rest of the census.
    const empty = mkdtempSync(join(tmpdir(), 'sizing-subject-none-'));
    const truncated = makeLedgerFixture({ sessions: [ULTRADEEP_SESSION] });
    writeFileSync(
      join(truncated, '.orchestrator', 'metrics', 'learnings.jsonl'),
      `{"id":"lrn-1","type":"effective-sizing","subject":"deep-session-sizing","source_sess\n`,
    );
    try {
      expect(collectHandKeyedLearningSubjects(empty)).toEqual({
        findings: [],
        scanned: { judged: 0, unattributed: 0 },
      });
      expect(collectHandKeyedLearningSubjects(truncated).findings).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(truncated, { recursive: true, force: true });
    }
  });

  it('reaches the helper mechanically — sizing-subject.mjs is no longer prose-wired only', () => {
    // #1363: before this check imported it, `scripts/lib/learnings/sizing-subject.mjs`
    // had ZERO import sites and sat in the S4 advisory census on the strength of
    // one SKILL sentence. The import below is the wiring; this asserts it is
    // visible to the very graph that reported the module.
    // collector reads no ledger at all, only the module graph.
    const census = collectUnreachableLibraryModules(REPO_ROOT); // check-untracked-test-deps:ignore
    expect(census.findings.map((f) => f.key)).not.toContain(
      join('scripts', 'lib', 'learnings', 'sizing-subject.mjs'),
    );
  }, 30_000);
});

describe('isCliEntrypoint — guard grammar', () => {
  // #1371 swept ~50 CLIs from `process.argv[1] === import.meta.url` to the
  // shared isMainModule() predicate. A swept file matches none of the other
  // alternatives, so without this one it reclassifies as a library candidate and
  // S4 reports it as an `unreachable-library-module` ROOT — dragging its
  // transitive members in with it. The sweep and this grammar must land
  // together; measured on this repo the un-extended regex took the unreachable
  // census from 2 to 4.
  it('recognises the isMainModule() guard as a CLI entrypoint', () => {
    const swept =
      "import { isMainModule } from '../is-main-module.mjs';\n" +
      'if (isMainModule(import.meta.url)) main();\n';
    expect(isCliEntrypoint(swept)).toBe(true); // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`

    // still true for every pre-sweep form, and still false for a plain library
    expect(isCliEntrypoint('#!/usr/bin/env node\nmain();\n')).toBe(true); // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
    expect(
      isCliEntrypoint("if (import.meta.url === pathToFileURL(process.argv[1]).href) main();\n"), // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
    ).toBe(true);
    expect(isCliEntrypoint('export function helper() {\n  return 1;\n}\n')).toBe(false); // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
  });
});
