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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SURFACES,
  scanSurfaces,
  applyVersion,
  checkChangelogEntry,
  checkLeakage,
  verifyLiveSite,
} from '../../scripts/release.mjs';

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
    'site/index.html': `<script type="application/ld+json">{"softwareVersion": "${v}"}</script>\n<span class="mono-num">v${v}</span>\n`,
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
    expect(changed).toHaveLength(SURFACES.length);
    const rows = scanSurfaces(root, '3.19.0');
    expect(rows.filter((r) => !r.ok)).toEqual([]);
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
  it('flags each of the seven leak classes on real npm-notice shaped lines', () => {
    const lines = [
      'npm notice 1.2kB tests/lib/foo.test.mjs',
      'npm notice 3.4kB .orchestrator/metrics/sessions.jsonl',
      'npm notice 0.5kB .claude/settings.json',
      'npm notice 0.5kB .github/workflows/ci.yml',
      'npm notice 9.9kB node_modules/left-pad/index.js',
      'npm notice 0.1kB .env.local',
      'npm notice 0.2kB owner.yaml',
    ];
    const names = checkLeakage(lines).map((v) => v.name);
    expect(new Set(names)).toEqual(new Set(['tests/', '.orchestrator/', '.claude/', '.github/', 'node_modules', '.env', 'owner.yaml']));
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
    let n = 0;
    const flaky = async () => {
      n += 1;
      return { ok: true, status: 200, text: async () => body(n < 3 ? '3.19.0' : '3.20.0') };
    };
    const r = await verifyLiveSite('3.20.0', { attempts: 5, delayMs: 0, fetchImpl: flaky, url: 'https://example.test/llms.txt' });
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });
});
