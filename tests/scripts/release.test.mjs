// tests/scripts/release.test.mjs
//
// Release-dispatch surface guard (#978 local half).
//
// The bug class each test catches:
//   1. A surface regex silently stops matching after a file refactor →
//      the check would pass while the surface ships stale (pattern-dead
//      must be a FAILURE, never a silent skip).
//   2. applyVersion misses a surface the scan knows about → set-version
//      leaves a stale file behind.
//   3. The CHANGELOG gate accepts an unfolded [Unreleased] or a missing
//      release entry → release notes ship incomplete.
//   4. A leakage pattern regresses to never-matching → secrets/tests leak
//      into the published tarball unseen.
//   5. A preflight check whose EVIDENCE-GATHERING failed reports `ok:true`
//      anyway — an errored `git grep` reading as a clean sweep, an
//      unparseable `npm view` reading as "no collision", an unparsed
//      `npm pack` listing reading as "0 leaks". Each is a green check that
//      verified nothing, guarding a step that cannot be undone.
//   6. A post-publish reconciliation misses its GitHub release, or an unknown
//      GitHub state authorizes a duplicate create.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  SURFACES,
  MIN_PACKED_ENTRIES,
  scanSurfaces,
  applyVersion,
  checkChangelogEntry,
  checkLeakage,
  parsePackedEntry,
  LEAKAGE_PATTERNS,
  HISTORY_ALLOWLIST,
  verifyLiveSite,
  evaluateDriftSweep,
  evaluateRegistryCollision,
  evaluateLeakageGate,
  evaluateRemoteHeadParity,
  evaluateNpmAuth,
  evaluateCiRow,
  validateFlags,
  ensureGithubRelease,
  evaluatePublishReceipt,
  waitForRegistryPropagation,
  runPublishRelease,
  printPublishOutcome,
} from '../../scripts/release.mjs';
import { DEGRADED_REASONS } from '../../scripts/lib/ci-status-banner.mjs';

// Fixture shapes are copied from the live repo files (golden-record rule in
// .claude/rules/testing.md) — hand-inventing them would let the real files
// drift away from the patterns while the test stays green.
function writeFixture(root, v) {
  const files = {
    'package.json': `{\n  "name": "session-orchestrator",\n  "version": "${v}",\n  "license": "MIT"\n}\n`,
    '.claude-plugin/plugin.json': `{\n  "name": "session-orchestrator",\n  "version": "${v}"\n}\n`,
    '.claude-plugin/marketplace.json': `{\n  "plugins": [{\n    "name": "session-orchestrator",\n    "version": "${v}"\n  }]\n}\n`,
    '.codex-plugin/plugin.json': `{\n  "name": "session-orchestrator",\n  "version": "${v}+codex.20260731000000"\n}\n`,
    'hooks/hooks.json': `{"hooks":{"SessionStart":[{"hooks":[{"command":"echo '🎯 Session Orchestrator v${v} — /session'"}]}]}}\n`,
    'hooks/hooks-codex.json': `{"hooks":{"SessionStart":[{"hooks":[{"command":"echo '🎯 Session Orchestrator v${v} — /session'"}]}]}}\n`,
    'README.md': `# session-orchestrator\n\n[![Version](https://img.shields.io/badge/version-${v}-blue.svg)](CHANGELOG.md)\n\n## Recent highlights (v${v})\n\nEvery release is additive and backward-compatible. Highlights of the v${v} line:\n`,
    // Copied from the live page's three version cells (commit 8802aa4 shape),
    // plus a PROSE mention of an older release. That last line is load-bearing:
    // the pattern this surface used to carry was /v(\d+\.\d+\.\d+)\b/g, a
    // replace-all that would have silently rewritten this sentence on every
    // --set-version. See the "historical prose" test below.
    'site/index.html': [
      `<a class="brand" href="#main">session&#8209;orchestrator <b>v<span class="num" data-metric="version">${v}</span></b></a>`,
      `<p class="meta">v<span class="num" data-metric="version">${v}</span> &middot; MIT &middot; npm session-orchestrator</p>`,
      `<div class="read"><p class="n v">v<span class="num" data-metric="version">${v}</span></p><p class="l">current release</p></div>`,
      `<p>The wave executor shipped in v3.2.0 and has not changed shape since.</p>`,
      '',
    ].join('\n'),
    'site/llms.txt': `Version: ${v} · npm: session-orchestrator\n`,
    'site/llms-full.txt': `Version ${v} · npm package: session-orchestrator\nVersion ${v} · 46 skills\n`,
    'package-lock.json': `{\n  "name": "session-orchestrator",\n  "version": "${v}",\n  "packages": { "": { "name": "session-orchestrator", "version": "${v}" } }\n}\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'release-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanSurfaces', () => {
  it('reports every surface green when all carry the target version', () => {
    writeFixture(root, '3.19.0');
    const rows = scanSurfaces(root, '3.19.0');
    expect(rows.filter((r) => !r.ok)).toEqual([]);
    // one row per SURFACES entry + package-lock.json
    expect(rows).toHaveLength(SURFACES.length + 1);
  });

  it('fails exactly the stale surface and names the found version', () => {
    writeFixture(root, '3.19.0');
    writeFileSync(
      join(root, 'hooks/hooks.json'),
      `{"hooks":{"SessionStart":[{"hooks":[{"command":"echo '🎯 Session Orchestrator v3.18.0 — /session'"}]}]}}\n`,
    );
    const rows = scanSurfaces(root, '3.19.0');
    const bad = rows.filter((r) => !r.ok);
    expect(bad.map((r) => r.file)).toEqual(['hooks/hooks.json']);
    expect(bad[0].problems.join()).toContain('3.18.0');
  });

  it('treats a dead pattern as a failure, never a silent pass', () => {
    writeFixture(root, '3.19.0');
    // README loses its version badge entirely — zero matches must FAIL.
    writeFileSync(join(root, 'README.md'), '# session-orchestrator\n\n## Recent highlights (v3.19.0)\n\nHighlights of the v3.19.0 line:\n');
    const rows = scanSurfaces(root, '3.19.0');
    const readme = rows.find((r) => r.file === 'README.md');
    expect(readme.ok).toBe(false);
    expect(readme.problems.join()).toContain('pattern-dead');
  });

  it('matches the live site/index.html metric-cell markup, and fails when that markup moves again', () => {
    // THE BUG: commit 8802aa4 replaced this surface's markup (softwareVersion
    // out of the JSON-LD, bare vX.Y.Z literals into data-metric cells) without
    // updating SURFACES, leaving BOTH patterns matching nothing. The check was
    // red at HEAD for exactly the right reason. This pins the new shape AND
    // pins that the pattern-dead guard still bites when it moves again.
    writeFixture(root, '3.21.0');
    expect(scanSurfaces(root, '3.21.0').find((r) => r.file === 'site/index.html').ok).toBe(true);

    // A stale cell is named, not skipped.
    writeFileSync(
      join(root, 'site/index.html'),
      '<p class="meta">v<span class="num" data-metric="version">3.20.0</span></p>\n',
    );
    const stale = scanSurfaces(root, '3.21.0').find((r) => r.file === 'site/index.html');
    expect(stale.ok).toBe(false);
    expect(stale.problems.join()).toContain('3.20.0');

    // The markup moving AGAIN (cells renamed away) must be pattern-dead, not a
    // silent pass — the guard that found the 8802aa4 drift in the first place.
    writeFileSync(join(root, 'site/index.html'), '<p class="meta">v<span class="num">3.21.0</span></p>\n');
    const moved = scanSurfaces(root, '3.21.0').find((r) => r.file === 'site/index.html');
    expect(moved.ok).toBe(false);
    expect(moved.problems.join()).toContain('pattern-dead');
  });

  it('fails a stale package-lock via JSON parse, not pattern match', () => {
    writeFixture(root, '3.19.0');
    writeFileSync(
      join(root, 'package-lock.json'),
      '{"name":"session-orchestrator","version":"3.18.0","packages":{"":{"version":"3.18.0"}}}',
    );
    const lock = scanSurfaces(root, '3.19.0').find((r) => r.file === 'package-lock.json');
    expect(lock.ok).toBe(false);
    expect(lock.problems.join()).toContain('3.18.0');
  });
});

describe('applyVersion', () => {
  it('rewrites every pattern surface so a follow-up scan is green', () => {
    writeFixture(root, '3.18.0');
    // Lock is synced by npm in the real flow, not by applyVersion — pin it
    // to the target here so the scan isolates the pattern surfaces.
    writeFileSync(
      join(root, 'package-lock.json'),
      '{"name":"session-orchestrator","version":"3.19.0","packages":{"":{"version":"3.19.0"}}}',
    );
    const changed = applyVersion(root, '3.19.0');
    expect(changed).toHaveLength(SURFACES.filter((s) => !s.checkOnly).length);
    // site/index.html stays stale here BY DESIGN — scripts/site-numbers.mjs
    // owns that write in the real --set-version flow. Scan it separately.
    const rows = scanSurfaces(root, '3.19.0').filter((r) => r.file !== 'site/index.html');
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });

  it('does not write site/index.html — one cell, one writer', () => {
    // THE BUG: applyVersion and `site-numbers.mjs --write` would both be
    // authoritative for the same data-metric cell. Two writers on one value is
    // a divergence waiting to happen, and the divergence would only surface in
    // a shipped release. The split is structural (`checkOnly`), not a comment
    // asking the next editor to remember.
    writeFixture(root, '3.18.0');
    const before = readFileSync(join(root, 'site/index.html'), 'utf8');
    expect(applyVersion(root, '3.19.0')).not.toContain('site/index.html');
    expect(readFileSync(join(root, 'site/index.html'), 'utf8')).toBe(before);
  });

  it('leaves a historical version mentioned in site prose alone', () => {
    // THE BUG the old pattern would have shipped: /v(\d+\.\d+\.\d+)\b/g was a
    // replace-all over the whole page, so "shipped in v3.2.0" became "shipped
    // in v3.19.0" on the next --set-version — a factual claim rewritten by a
    // version bumper, silently. Belt and braces: checkOnly means applyVersion
    // does not touch the file at all, and the pattern is cell-anchored so it
    // could not reach the sentence even if it did.
    writeFixture(root, '3.18.0');
    applyVersion(root, '3.19.0');
    expect(readFileSync(join(root, 'site/index.html'), 'utf8')).toContain('shipped in v3.2.0');
  });

  it('rotates the codex cachebuster to a fresh valid UTC stamp alongside the base bump', () => {
    writeFixture(root, '3.18.0');
    applyVersion(root, '3.19.0');
    const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8'));
    const m = manifest.version.match(/^3\.19\.0\+codex\.(\d{14})$/);
    expect(m).not.toBeNull();
    // The stamp must be rotated off the fixture's frozen value, not copied.
    expect(m[1]).not.toBe('20260731000000');
  });

  it('is idempotent on pattern surfaces — a second run changes nothing but the rotating cachebuster', () => {
    writeFixture(root, '3.18.0');
    applyVersion(root, '3.19.0');
    const secondRun = applyVersion(root, '3.19.0').filter((f) => f !== '.codex-plugin/plugin.json');
    expect(secondRun).toEqual([]);
  });
});

describe('checkChangelogEntry', () => {
  const goodLog = `# Changelog\n\n## [Unreleased]\n\n## [3.19.0] - 2026-08-04\n\n### Added\n- thing\n\n## [3.18.0] - 2026-07-31\n`;

  it('accepts a dated topmost entry with a folded [Unreleased]', () => {
    expect(checkChangelogEntry(goodLog, '3.19.0')).toEqual({ ok: true, problems: [] });
  });

  it('rejects a missing release entry', () => {
    const res = checkChangelogEntry('# Changelog\n\n## [Unreleased]\n\n## [3.18.0] - 2026-07-31\n', '3.19.0');
    expect(res.ok).toBe(false);
    expect(res.problems.join()).toContain('no "## [3.19.0]');
  });

  it('rejects an [Unreleased] section that still has content', () => {
    const res = checkChangelogEntry(
      `# Changelog\n\n## [Unreleased]\n\n### Added\n- not folded yet\n\n## [3.19.0] - 2026-08-04\n`,
      '3.19.0',
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join()).toContain('fold');
  });

  it('rejects the target not being the topmost release entry', () => {
    const res = checkChangelogEntry(
      `# Changelog\n\n## [Unreleased]\n\n## [3.18.0] - 2026-07-31\n\n## [3.19.0] - 2026-08-04\n`,
      '3.19.0',
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join()).toContain('topmost');
  });
});

describe('checkLeakage', () => {
  // THE BUG: a leak class is added to LEAKAGE_PATTERNS and never exercised.
  // That is not hypothetical — `.DS_Store` was listed as checked in
  // docs/distribution/npm-publish-checklist.md while the executed gate did not
  // carry it at all (measured 2026-08-19: three leakage lists, three different
  // sets). Deriving the expectation FROM the production list means the next
  // pattern added without a sample line fails here instead of shipping unproven.
  const SAMPLE_LINE = {
    'tests/': 'npm notice 1.2kB tests/lib/foo.test.mjs',
    '.orchestrator/': 'npm notice 3.4kB .orchestrator/metrics/sessions.jsonl',
    '.claude/': 'npm notice 0.5kB .claude/settings.json',
    '.github/': 'npm notice 0.5kB .github/workflows/ci.yml',
    node_modules: 'npm notice 9.9kB node_modules/left-pad/index.js',
    '.env': 'npm notice 0.1kB .env.local',
    'owner.yaml': 'npm notice 0.2kB owner.yaml',
    '.DS_Store': 'npm notice 6.1kB site/.DS_Store',
  };

  it('carries a sample line for every declared leak class', () => {
    const declared = LEAKAGE_PATTERNS.map((p) => p.name);
    expect(Object.keys(SAMPLE_LINE).sort()).toEqual([...declared].sort());
  });

  it('flags every declared leak class on real npm-notice shaped lines', () => {
    const declared = LEAKAGE_PATTERNS.map((p) => p.name);
    const names = checkLeakage(declared.map((n) => SAMPLE_LINE[n])).map((v) => v.name);
    expect(new Set(names)).toEqual(new Set(declared));
  });

  it('returns no violations for a clean pack list', () => {
    const lines = [
      'npm notice package: session-orchestrator@3.19.0',
      'npm notice 1.2kB scripts/release.mjs',
      'npm notice 3.4kB skills/npm-publish/SKILL.md',
      'npm notice 0.9kB hooks/hooks.json',
    ];
    expect(checkLeakage(lines)).toEqual([]);
  });

  it('checks only packed paths and blocks tests or .claude as nested path segments', () => {
    const violations = checkLeakage([
      'npm notice 1.2kB fixtures/tests/credentials.json',
      'npm notice 1.2kB fixtures/.claude/settings.json',
      'npm notice 1.2kB contest/notes.txt',
      'npm notice 1.2kB .claude-plugin/marketplace.json',
      'npm notice package: diagnostic mentions tests/ and .claude/',
    ]);

    expect(violations).toEqual([
      { name: 'tests/', line: 'npm notice 1.2kB fixtures/tests/credentials.json' },
      { name: '.claude/', line: 'npm notice 1.2kB fixtures/.claude/settings.json' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// verifyLiveSite (#1043)
//
// The bug class these catch: the site fell a full release behind twice in four
// weeks while every other surface reported success, because the deploy was a
// checklist line nobody re-read. The replacement is only worth having if it
// keeps its FOUR outcomes distinct — a later refactor that collapses them onto
// a flat `{ok:false}` throws away the exact diagnosis the function exists for,
// and would still pass a test that only asserted `ok`.
// ---------------------------------------------------------------------------

describe('verifyLiveSite', () => {
  const opts = (fetchImpl) => ({ attempts: 1, delayMs: 0, fetchImpl, url: 'https://example.test/llms.txt' });
  const body = (v) => `Session Orchestrator\nVersion: ${v} · npm: session-orchestrator\n`;
  const ok200 = (text) => async () => ({ ok: true, status: 200, text: async () => text });

  it('accepts when the live version equals the released one', async () => {
    const r = await verifyLiveSite('3.20.0', opts(ok200(body('3.20.0'))));
    expect(r.ok).toBe(true);
  });

  it('rejects a stale live version AND names both versions', async () => {
    const r = await verifyLiveSite('3.20.0', opts(ok200(body('3.19.0'))));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('3.19.0');
    expect(r.detail).toContain('3.20.0');
  });

  it('distinguishes an unreachable host from a stale version', async () => {
    const r = await verifyLiveSite('3.20.0', opts(async () => { throw new Error('ENOTFOUND'); }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('fetch failed');
    expect(r.detail).not.toContain('live serves');
  });

  it('distinguishes a non-200 from a stale version', async () => {
    const r = await verifyLiveSite('3.20.0', opts(async () => ({ ok: false, status: 503 })));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('503');
    expect(r.detail).not.toContain('live serves');
  });

  it('reports a moved surface as its own failure, not as a version mismatch', async () => {
    // A 200 whose body no longer carries the version line means the CHECK is
    // broken, not the deploy. Collapsing this onto "stale" would send the
    // operator to look at Vercel while the real fix is in this file.
    const r = await verifyLiveSite('3.20.0', opts(ok200('User-agent: *\nAllow: /\n')));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('the surface moved');
    expect(r.detail).not.toContain('live serves');
  });

  it('retries before giving up, so an async deploy is not a false negative', async () => {
    const flaky = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => body('3.19.0') })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => body('3.19.0') })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => body('3.20.0') });

    const r = await verifyLiveSite('3.20.0', {
      attempts: 5,
      delayMs: 0,
      fetchImpl: flaky,
      url: 'https://example.test/llms.txt',
    });

    expect(r.ok).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Preflight evaluators — the fail-closed family.
//
// Shared bug class: a check whose evidence-gathering FAILED reporting `ok:true`
// anyway. All three of the originals produced an empty result set from a failed
// subprocess and read that emptiness as an all-clear, on the one code path
// (publish) that cannot be undone. Each test below feeds exactly the degraded
// shape that used to pass.
// ---------------------------------------------------------------------------

const ALLOWLIST = /^(CHANGELOG\.md|docs\/)/;

describe('evaluateDriftSweep', () => {
  it.each([2, 128])('treats failed git grep exit %i as inconclusive, not as a clean sweep', (status) => {
    // THE BUG: the old code read `.stdout` and never `.status`. `git grep`
    // exits 1 on "no match" (fine) and non-0/1 on a real error — measured 128
    // for a bad regex and a bad pathspec, and git documents 2 for usage errors.
    // Both produced an empty stdout, so a sweep that never ran reported
    // "no tracked file still carries 3.20.0".
    const r = evaluateDriftSweep({ status, stdout: '', stderr: 'fatal: bad thing' }, '3.20.0', ALLOWLIST);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('inconclusive');
  });

  it('accepts exit 1 (no match) as the genuine clean sweep', () => {
    const r = evaluateDriftSweep({ status: 1, stdout: '', stderr: '' }, '3.20.0', ALLOWLIST);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('no tracked file');
  });

  it('fails on hits outside the history allowlist and names them', () => {
    const grep = { status: 0, stdout: 'CHANGELOG.md\ndocs/x.md\nsite/llms.txt\n', stderr: '' };
    const r = evaluateDriftSweep(grep, '3.20.0', ALLOWLIST);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('site/llms.txt');
    expect(r.detail).not.toContain('CHANGELOG.md');
  });

  // THE BUG: the cases above run against a hand-copied ALLOWLIST in this file,
  // so the regex `preflight` actually uses was covered by nothing — an edit to
  // it could not go red here. These two run the PRODUCTION export.
  it('exempts the one page that keeps a dated historical version literal', () => {
    const grep = { status: 0, stdout: 'site/guide/index.html\n', stderr: '' };
    const r = evaluateDriftSweep(grep, '3.20.0', HISTORY_ALLOWLIST);
    expect(r.ok).toBe(true);
  });

  // THE BUG: the cheapest way to silence a sweep hit is to widen the allowlist to
  // the whole directory — and then every future version literal under it goes
  // unswept forever. Each exemption here is ONE file with a dated reason at the
  // regex; a sibling in the same directory must stay swept.
  it.each([
    ['site/guide/index.html', true],
    ['commands/release.md', true],
    ['site/guide/other.html', false],
    ['commands/close.md', false],
    ['site/index.html', false],
  ])('classifies %s as history-allowlisted=%s', (file, expected) => {
    expect(HISTORY_ALLOWLIST.test(file)).toBe(expected);
  });

  it('still sweeps every other shipped page', () => {
    const grep = { status: 0, stdout: 'site/index.html\nsite/impressum/index.html\n', stderr: '' };
    const r = evaluateDriftSweep(grep, '3.20.0', HISTORY_ALLOWLIST);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('site/index.html');
    expect(r.detail).toContain('site/impressum/index.html');
  });
});

describe('evaluateRegistryCollision', () => {
  it('refuses to clear a target when npm view output is unparseable', () => {
    // THE BUG, and the most dangerous one in the file: `catch {}` left the
    // version list EMPTY, and `!published.includes(target)` then read that
    // emptiness as "the version is free". An npm output-format change or a
    // captive-portal/proxy HTML body with exit 0 turned the collision check
    // into consent. Reproduced verbatim before the fix: ok = true, "latest: ?".
    const r = evaluateRegistryCollision({ status: 0, stdout: '<html>proxy</html>', stderr: '' }, '3.21.0');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('cannot rule out a collision');
  });

  it('refuses to clear a target on an empty version list', () => {
    // A published package always has at least one version; an empty list is a
    // shape we do not understand, not an all-clear.
    const r = evaluateRegistryCollision({ status: 0, stdout: '[]', stderr: '' }, '3.21.0');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('cannot rule out a collision');
  });

  it('fails on a real collision and passes on a genuinely free version', () => {
    const versions = JSON.stringify(['3.19.0', '3.20.0']);
    expect(evaluateRegistryCollision({ status: 0, stdout: versions, stderr: '' }, '3.20.0')).toEqual({
      ok: false,
      detail: '3.20.0 already published',
    });
    expect(evaluateRegistryCollision({ status: 0, stdout: versions, stderr: '' }, '3.21.0')).toEqual({
      ok: true,
      detail: 'latest: 3.20.0',
    });
  });

  it('separates E404 (first publish) from every other npm view failure', () => {
    expect(evaluateRegistryCollision({ status: 1, stdout: '', stderr: 'npm error code E404' }, '1.0.0').ok).toBe(true);
    const down = evaluateRegistryCollision({ status: 1, stdout: '', stderr: 'ETIMEDOUT' }, '1.0.0');
    expect(down.ok).toBe(false);
    expect(down.detail).toContain('npm view failed');
  });
});

describe('evaluateLeakageGate', () => {
  // Shaped from real `npm pack --dry-run` stderr at 8984224 (830 entries).
  const listing = (n, extra = []) =>
    [
      'npm notice',
      // \u{1F4E6} escaped, not literal: check-unicode-safety.mjs forbids an emoji
      // codepoint in a tracked file, and the runtime string is byte-identical.
      'npm notice \u{1F4E6}  session-orchestrator@3.21.0',
      'npm notice Tarball Contents',
      ...Array.from({ length: n }, (_, i) => `npm notice ${1 + (i % 9)}.${i % 10}kB skills/s${i}/SKILL.md`),
      ...extra,
      `npm notice total files: ${n + extra.length}`,
    ].join('\n');

  it('refuses to call an unparsed pack listing "0 leaks"', () => {
    // THE BUG: exit 0 + output the scan cannot parse → zero lines scanned →
    // zero violations → "0 packed entries, 0 leaks". The SURFACES table has
    // `pattern-dead` for exactly this class; the leak scan had no equivalent.
    // Reproduced verbatim before the fix: ok = true on empty stdout+stderr.
    const r = evaluateLeakageGate({ status: 0, stdout: '', stderr: '' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('did not parse');
    expect(r.detail).toContain(`floor ${MIN_PACKED_ENTRIES}`);
  });

  it('refuses a listing that parses but sits under the floor', () => {
    // The same hole one step less obvious: a format change that still yields a
    // handful of matchable lines. 12 entries scanned is not evidence about 830.
    expect(evaluateLeakageGate({ status: 0, stdout: '', stderr: listing(12) }).ok).toBe(false);
  });

  it('passes a full listing with no leaks, and reports the real entry count', () => {
    // Regression guard on the counter itself: the old inline regex required a
    // DIGIT immediately before "B", so it matched only byte-sized entries —
    // 108 of 830 at 8984224. A floor asserted on that counter would have been
    // permanently red.
    const r = evaluateLeakageGate({ status: 0, stdout: '', stderr: listing(830) });
    expect(r).toEqual({ ok: true, detail: '830 packed entries, 0 leaks' });
  });

  it('still catches a leak inside an otherwise healthy listing', () => {
    const r = evaluateLeakageGate({
      status: 0,
      stdout: '',
      stderr: listing(830, ['npm notice 1.2kB tests/lib/foo.test.mjs']),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('tests/');
  });

  it('fails a non-zero npm pack instead of scanning its rubble', () => {
    const r = evaluateLeakageGate({ status: 1, stdout: '', stderr: 'npm error ENOENT' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('npm pack failed');
  });

  it('accepts the actual working tree package without internal test material', () => {
    // THE BUG: package.json whitelisted scripts/ and skills/ wholesale, so npm
    // packed their internal tests and fixtures. Synthetic notice lines could
    // prove matching, but not that the release configuration produced a clean
    // real tarball.
    // Pin the loglevel instead of inheriting it: under `npm run --silent`
    // (the pre-push gate) an inherited silent level makes `npm pack --dry-run`
    // emit ZERO notice lines with exit 0, so this test went red inside the
    // nested gate while passing under a bare `npm test`. Same env-isolation
    // class as the TYPECHECK_CMD/TEST_CMD boilerplate in the gate tests.
    const pack = spawnSync('npm', ['pack', '--dry-run'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_loglevel: 'notice' },
    });
    const packedPaths = [];
    for (const line of `${pack.stdout || ''}\n${pack.stderr || ''}`.split('\n')) {
      const entry = parsePackedEntry(line);
      if (entry) packedPaths.push(entry.path);
    }

    expect(pack.status).toBe(0);
    expect(packedPaths).toEqual(expect.arrayContaining([
      'templates/node-minimal/tests/sanity.test.ts',
      'templates/python-uv/tests/test_sanity.py',
    ]));
    expect(evaluateLeakageGate(pack)).toEqual({
      ok: true,
      detail: expect.stringMatching(/^\d+ packed entries, 0 leaks$/),
    });
    // 60s, not the 5s default: this spawns a REAL `npm pack --dry-run` over the
    // whole working tree. Measured tripping the default under CPU 100% while
    // passing in isolation — a load threshold, not a correctness one.
  }, 60_000);
});

describe('evaluateRemoteHeadParity', () => {
  const HEAD = '89842241b678cec0c32a2b74569abded1ea989c1';
  const BEHIND = '0123456789abcdef0123456789abcdef01234567';

  it('fails when the github mirror is behind HEAD', () => {
    // THE BUG: preflight compared HEAD to origin/main only. Vercel deploys off
    // the GITHUB mirror, so a lagging mirror was discovered by verifyLiveSite —
    // i.e. AFTER npm publish and AFTER both tag pushes, the two irreversible
    // steps. This moves the discovery in front of them.
    const r = evaluateRemoteHeadParity('github', { status: 0, stdout: `${BEHIND}\trefs/heads/main\n` }, HEAD);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('the mirror is behind');
    expect(r.detail).toContain(BEHIND.slice(0, 8));
  });

  it('fails a failed ls-remote rather than passing on its silence', () => {
    const r = evaluateRemoteHeadParity('github', { status: 128, stdout: '', stderr: 'could not read' }, HEAD);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('failed');
  });

  it('fails output that carries no sha at all', () => {
    const r = evaluateRemoteHeadParity('github', { status: 0, stdout: '\n' }, HEAD);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('no sha');
  });

  it('passes when the remote branch is exactly HEAD', () => {
    expect(evaluateRemoteHeadParity('origin', { status: 0, stdout: `${HEAD}\trefs/heads/main\n` }, HEAD)).toEqual({
      ok: true,
      detail: HEAD.slice(0, 8),
    });
  });
});

describe('evaluateNpmAuth', () => {
  it('refuses an exit-0 whoami that printed no identity', () => {
    // Same class as the three above: a zero exit is not an identity.
    expect(evaluateNpmAuth({ status: 0, stdout: '\n', stderr: '' }).ok).toBe(false);
  });

  it('fails a dead token before the publish rather than during it', () => {
    const r = evaluateNpmAuth({ status: 1, stdout: '', stderr: 'npm error code E401' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('E401');
  });

  it('passes and names the authenticated identity', () => {
    expect(evaluateNpmAuth({ status: 0, stdout: 'kanevry\n', stderr: '' })).toEqual({
      ok: true,
      detail: 'authenticated as kanevry',
    });
  });
});

describe('validateFlags', () => {
  it('refuses --skip-ci under --publish', () => {
    // THE BUG: --skip-ci makes ci-green-on-head report `ok:true` with the
    // detail "SKIPPED via --skip-ci". Under --publish that is a green summary
    // which verified nothing about CI authorising npm publish + two tag pushes,
    // none of which can be taken back.
    const r = validateFlags({ publish: true, 'skip-ci': true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.message).toContain('irreversible');
  });

  it('still allows --skip-ci for --check, which commits to nothing', () => {
    expect(validateFlags({ check: true, 'skip-ci': true })).toEqual({ ok: true });
    expect(validateFlags({ publish: true })).toEqual({ ok: true });
  });
});

describe('ensureGithubRelease', () => {
  const okRes = { status: 0, stdout: 'https://github.com/Owner/repo/releases/tag/v3.21.0\n', stderr: '' };

  it('is a no-op when the release already exists, instead of erroring', () => {
    // THE BUG: `gh release create` on an existing release exits non-zero. A
    // recovery action that encounters an already-created release must report a
    // no-op, not turn that successful artifact into a duplicate-create error.
    const calls = [];
    const r = ensureGithubRelease('/repo', '3.21.0', {
      repoSpec: 'github.com/Owner/repo',
      runImpl: (cmd, args) => {
        calls.push(args);
        return okRes; // `gh release view` finds it
      },
    });
    expect(r).toMatchObject({ ok: true, created: false, tag: 'v3.21.0' });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['release', 'view']);
  });

  it('creates with --verify-tag and the resolved -R spec when absent', () => {
    // --verify-tag is what makes "release without a tag" structurally
    // impossible rather than merely discouraged — gh refuses when the tag is
    // not on the remote. The spec comes from resolveRepoSpec (#1039), never a
    // hardcoded owner/repo.
    const root = mkdtempSync(join(tmpdir(), 'release-gh-'));
    try {
      writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [3.21.0] - 2026-08-19\n\n### Added\n- a thing\n');
      let notesSeenByGh = null;
      const runImpl = vi
        .fn()
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'release not found' })
        .mockImplementationOnce((_cmd, args) => {
          // Read the notes file HERE — this is the only moment it exists, and
          // it is exactly the moment gh would read it. The production code
          // removes it in a finally, which is why asserting after the call
          // would (and did) fail with ENOENT.
          notesSeenByGh = readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
          return okRes;
        });
      const r = ensureGithubRelease(root, '3.21.0', {
        repoSpec: 'github.com/Owner/repo',
        runImpl,
      });
      expect(r).toMatchObject({ ok: true, created: true, tag: 'v3.21.0' });
      const [, createArgs] = runImpl.mock.calls[1];
      expect(runImpl.mock.calls[1][0]).toBe('gh');
      expect(createArgs).toContain('--verify-tag');
      expect(createArgs.slice(0, 3)).toEqual(['release', 'create', 'v3.21.0']);
      expect(createArgs[createArgs.indexOf('--repo') + 1]).toBe('github.com/Owner/repo');
      // The body is the CHANGELOG excerpt, passed by file (never as argv).
      expect(notesSeenByGh).toContain('- a thing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not create on an unknown gh release-view result', () => {
    // A non-zero status alone is not "release absent": auth, network and empty
    // output all share it. Creating in those states risks targeting the wrong
    // repository or turning a transient API failure into a duplicate release.
    const root = mkdtempSync(join(tmpdir(), 'release-gh-'));
    try {
      writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [3.21.0] - 2026-08-19\n\n- x\n');
      const calls = [];
      const unknown = ensureGithubRelease(root, '3.21.0', {
        repoSpec: 'github.com/Owner/repo',
        runImpl: (cmd, args) => {
          calls.push({ cmd, args });
          return { status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' };
        },
      });
      expect(unknown).toMatchObject({ ok: false, created: false, state: 'unknown' });
      expect(unknown.detail).toContain('could not determine whether GitHub release');
      expect(calls).toHaveLength(1);
      expect(calls[0].args.slice(0, 2)).toEqual(['release', 'view']);

      const missing = ensureGithubRelease(root, '3.21.0', {
        repoSpec: 'github.com/Owner/repo',
        runImpl: () => {
          throw new Error('spawn gh ENOENT');
        },
      });
      expect(missing.ok).toBe(false);
      expect(missing.detail).toContain('ENOENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('evaluatePublishReceipt', () => {
  it('confirms only the receipt for the target package version', () => {
    const receipt = evaluatePublishReceipt({
      status: 0,
      stdout: '+ session-orchestrator@3.21.0\n',
      stderr: '',
    }, '3.21.0');

    expect(receipt).toMatchObject({ confirmed: true, target: '3.21.0' });
    expect(evaluatePublishReceipt({ status: 0, stdout: '+ session-orchestrator@3.20.0\n', stderr: '' }, '3.21.0').confirmed).toBe(false);
  });
});

describe('waitForRegistryPropagation', () => {
  it('confirms the registry after a successful checked wait', () => {
    const registryViews = ['3.20.0\n', '3.21.0\n'];
    const calls = [];
    const result = waitForRegistryPropagation('/repo', '3.21.0', {
      attempts: 2,
      runImpl: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { status: 0, stdout: registryViews.shift(), stderr: '' };
      },
      waitImpl: () => {
        calls.push('wait');
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(result).toMatchObject({ ok: true, kind: 'verified', attempts: 2 });
    expect(calls).toEqual([
      'npm view session-orchestrator version',
      'wait',
      'npm view session-orchestrator version',
    ]);
  });

  it('returns a visible propagation result when the checked wait fails', () => {
    const calls = [];
    const result = waitForRegistryPropagation('/repo', '3.21.0', {
      attempts: 2,
      runImpl: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { status: 0, stdout: '3.20.0\n', stderr: '' };
      },
      waitImpl: () => {
        calls.push('wait');
        return { status: 1, stdout: '', stderr: 'sleep unavailable' };
      },
    });

    expect(result).toMatchObject({ ok: false, kind: 'wait-failed' });
    expect(result.detail).toContain('sleep unavailable');
    expect(calls).toEqual(['npm view session-orchestrator version', 'wait']);
  });

  it('returns a visible propagation result when the registry query fails', () => {
    const result = waitForRegistryPropagation('/repo', '3.21.0', {
      runImpl: () => ({ status: 1, stdout: '', stderr: 'EAI_AGAIN registry.npmjs.org' }),
      waitImpl: () => {
        throw new Error('wait must not be called after a failed query');
      },
    });

    expect(result).toMatchObject({ ok: false, kind: 'query-failed' });
    expect(result.detail).toContain('EAI_AGAIN');
  });
});

describe('runPublishRelease', () => {
  it('runs every tail operation in order after registry propagation times out', async () => {
    const calls = [];
    const outcome = await runPublishRelease('/repo', '3.21.0', {
      publishImpl: () => ({
        receipt: { confirmed: true, target: '3.21.0' },
        propagation: { ok: false, kind: 'timeout', detail: 'registry has not propagated' },
      }),
      tagAndPushImpl: () => {
        calls.push('tag-and-push');
        return { tag: 'v3.21.0', pushed: ['origin', 'github'] };
      },
      ensureGithubReleaseImpl: () => {
        calls.push('github-release');
        return { ok: true, created: true, state: 'created', detail: 'GitHub release v3.21.0 created' };
      },
      verifyLiveSiteImpl: async () => {
        calls.push('live-site');
        return { ok: true, detail: 'attempt 1/1' };
      },
    });

    expect(calls).toEqual(['tag-and-push', 'github-release', 'live-site']);
    expect(outcome).toMatchObject({
      status: 'post-publish-reconciliation',
      tag: 'v3.21.0',
      reconciliation: [{ phase: 'registry-propagation', kind: 'timeout' }],
    });
  });

  it('reconciles a post-receipt tag-and-push exception without probing dependent phases', async () => {
    const calls = [];
    const tagFailure = Object.assign(new Error('git push github v3.21.0 exited 1: remote rejected'), {
      releaseProgress: {
        tag: 'v3.21.0',
        localTagCreated: true,
        pushed: ['origin'],
        remotes: [
          { remote: 'origin', mainPushed: true, tagPushed: true },
          { remote: 'github', mainPushed: true, tagPushed: false },
        ],
      },
    });
    const outcome = await runPublishRelease('/repo', '3.21.0', {
      publishImpl: () => ({
        receipt: { confirmed: true, target: '3.21.0', detail: 'session-orchestrator@3.21.0 receipt confirmed' },
        propagation: { ok: true, kind: 'verified', detail: 'registry reports 3.21.0 on attempt 1/5' },
      }),
      tagAndPushImpl: () => {
        calls.push('tag-and-push');
        throw tagFailure;
      },
      ensureGithubReleaseImpl: () => {
        calls.push('github-release');
        return { ok: true, detail: 'must not run' };
      },
      verifyLiveSiteImpl: async () => {
        calls.push('live-site');
        return { ok: true, detail: 'must not run' };
      },
    });

    expect(calls).toEqual(['tag-and-push']);
    expect(outcome).toMatchObject({
      status: 'post-publish-reconciliation',
      receipt: { confirmed: true, target: '3.21.0' },
      propagation: { ok: true, kind: 'verified' },
      tag: 'v3.21.0',
      pushed: ['origin'],
      tagProgress: {
        localTagCreated: true,
        remotes: [
          { remote: 'origin', mainPushed: true, tagPushed: true },
          { remote: 'github', mainPushed: true, tagPushed: false },
        ],
      },
      release: { ok: false, skipped: true },
      live: { ok: false, skipped: true },
    });
    expect(outcome.reconciliation).toEqual([
      expect.objectContaining({ phase: 'tag-and-push', kind: 'failed', detail: expect.stringContaining('remote rejected') }),
      expect.objectContaining({ phase: 'github-release', kind: 'skipped-prerequisite' }),
      expect.objectContaining({ phase: 'live-site', kind: 'skipped-prerequisite' }),
    ]);

    const stdout = [];
    const stderr = [];
    const exitCode = printPublishOutcome(outcome, '3.21.0', {
      log: (line) => stdout.push(line),
      error: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(1);
    expect(stdout.join('\n')).not.toContain('tagged v3.21.0');
    expect(stderr.join('\n')).toContain('tag-and-push');
    expect(stderr.join('\n')).toContain('Do NOT rerun `--publish`');
    expect(stderr.join('\n')).not.toContain('gh release view');
    expect(stderr.join('\n')).not.toContain('vercel.com');
  });

  it('blocks every tail operation when the npm receipt is not target-confirmed', async () => {
    const calls = [];
    await expect(runPublishRelease('/repo', '3.21.0', {
      publishImpl: () => ({
        receipt: { confirmed: false, target: '3.21.0' },
        propagation: { ok: false, kind: 'not-run', detail: 'no receipt' },
      }),
      tagAndPushImpl: () => calls.push('tag-and-push'),
      ensureGithubReleaseImpl: () => calls.push('github-release'),
      verifyLiveSiteImpl: () => calls.push('live-site'),
    })).rejects.toThrow('target-confirmed npm publish receipt');

    expect(calls).toEqual([]);
  });
});

describe('runPublishRelease — the irreversible default', () => {
  // The bug this catches: an importer that forgets `publishImpl` used to get the
  // live `npm publish --access public` as the DI default, bypassing preflight
  // (leakage gate, CI gate, dirty-tree gate) and burning a version number.
  it('refuses to publish when no publisher is injected', async () => {
    await expect(runPublishRelease('/repo', '9.9.9', {})).rejects.toThrow(
      /requires an explicit publishImpl/,
    );
  });

  it('refuses when publishImpl is present but not callable', async () => {
    await expect(
      runPublishRelease('/repo', '9.9.9', { publishImpl: 'nope' }),
    ).rejects.toThrow(/requires an explicit publishImpl/);
  });
});

// ── #1031: the CI preflight row reads a THREE-state probe ────────────────────

describe('evaluateCiRow', () => {
  // BUG this catches (TV-001): `checkCiStatus` gained a degraded state whose
  // object carries no `status`. The pre-#1031 expression interpolated it
  // anyway, so an unreadable CI check printed `status: undefined` — a red row
  // whose detail names no cause, which an operator reads as "CI is broken"
  // when the truth is "we never found out". Red without the `degraded` branch.
  it('names the reason when the probe could not read CI state', () => {
    expect(evaluateCiRow({ severity: 'warn', ok: false, degraded: 'query-failed', message: 'x' }))
      .toEqual({ ok: false, detail: 'CI status unknown (query-failed)' });
  });

  it('never passes a degraded result, whatever the reason', () => {
    // Loop over the EXPORTED enum, not a hand-typed copy of it: the branch
    // under test is reason-agnostic, so a hand list adds no coverage and
    // silently stops covering the newest member the day one is added.
    expect(DEGRADED_REASONS.length).toBeGreaterThanOrEqual(5); // vacuum guard
    for (const reason of DEGRADED_REASONS) {
      expect(evaluateCiRow({ degraded: reason }).ok).toBe(false);
    }
  });

  it('passes only an actual green reading', () => {
    expect(evaluateCiRow({ status: 'green', ok: true })).toEqual({ ok: true, detail: 'status: green' });
  });

  it('fails a red reading and names the failing job', () => {
    expect(evaluateCiRow({ status: 'red', failingJobName: 'lint' }))
      .toEqual({ ok: false, detail: 'status: red (lint)' });
  });

  it('fails an unknown reading', () => {
    expect(evaluateCiRow({ status: 'unknown' })).toEqual({ ok: false, detail: 'status: unknown' });
  });

  // `null` is the probe's ABSENCE state (no VCS remote) — a release still may
  // not proceed on it, but the detail must not claim a reason it does not have.
  it('reports absence distinctly from degradation', () => {
    expect(evaluateCiRow(null)).toEqual({ ok: false, detail: 'CI status unavailable' });
  });
});
