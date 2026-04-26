/**
 * tests/hooks/banner-version-sync.test.mjs
 *
 * Regression test for #252 / follow-up #267:
 * The banner string in hooks/hooks.json + hooks/hooks-codex.json must include
 * the package.json version. A bump that forgets to update both banners fails here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

function bannerCommandsFor(hooksFile) {
  const cfg = JSON.parse(readFileSync(path.join(REPO_ROOT, hooksFile), 'utf8'));
  const out = [];
  const matchers = cfg?.hooks?.SessionStart ?? [];
  for (const m of matchers) {
    for (const h of m.hooks ?? []) {
      if (typeof h.command === 'string' && h.command.includes('Session Orchestrator')) {
        out.push(h.command);
      }
    }
  }
  return out;
}

describe('banner version-sync (#267)', () => {
  it('hooks/hooks.json banner contains the package.json version', () => {
    const version = readVersion();
    const banners = bannerCommandsFor('hooks/hooks.json');
    expect(banners.length).toBeGreaterThan(0);
    for (const b of banners) {
      expect(b).toContain(version);
    }
  });

  it('hooks/hooks-codex.json banner contains the package.json version', () => {
    const version = readVersion();
    const banners = bannerCommandsFor('hooks/hooks-codex.json');
    expect(banners.length).toBeGreaterThan(0);
    for (const b of banners) {
      expect(b).toContain(version);
    }
  });
});
