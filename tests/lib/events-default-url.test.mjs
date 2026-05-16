/**
 * tests/lib/events-default-url.test.mjs
 *
 * Regression guard for issue #228: personal-domain default URL removal.
 *
 * Contract:
 *   - `DEFAULT_EVENT_URL` no longer exists in scripts/lib/events.mjs (#228).
 *   - No literal `events.gotzendorfer.at` URL appears anywhere in scripts/ or hooks/.
 *   - hooks/on-stop.mjs no longer imports DEFAULT_EVENT_URL.
 *   - emitEvent requires both CLANK_EVENT_SECRET and CLANK_EVENT_URL to POST;
 *     setting only CLANK_EVENT_SECRET (without a URL) is a no-op.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function walkMjs(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walkMjs(full, acc);
    } else if (entry.endsWith('.mjs')) {
      acc.push(full);
    }
  }
  return acc;
}

async function importEventsWithDir(dir) {
  process.env.CLAUDE_PROJECT_DIR = dir;
  vi.resetModules();
  return import('@lib/events.mjs');
}

// ---------------------------------------------------------------------------
// 1. DEFAULT_EVENT_URL is no longer exported (#228)
// ---------------------------------------------------------------------------

describe('DEFAULT_EVENT_URL removed (#228)', () => {
  it('scripts/lib/events.mjs does not export DEFAULT_EVENT_URL', async () => {
    vi.resetModules();
    const mod = await import('@lib/events.mjs');
    expect(mod.DEFAULT_EVENT_URL).toBeUndefined();
  });

  it('scripts/lib/events.mjs does not contain the personal domain literal', () => {
    const raw = readFileSync(
      path.join(repoRoot, 'scripts', 'lib', 'events.mjs'),
      'utf8',
    );
    expect(raw).not.toContain('gotzendorfer.at');
  });
});

// ---------------------------------------------------------------------------
// 2. Personal domain absent from scripts/ and hooks/ .mjs files
// ---------------------------------------------------------------------------

describe('personal domain absent from source files (#228)', () => {
  it('no .mjs file in scripts/ or hooks/ contains "events.gotzendorfer.at"', () => {
    const literal = 'events.gotzendorfer.at';
    const dirs = [
      path.join(repoRoot, 'scripts'),
      path.join(repoRoot, 'hooks'),
    ];
    const hits = [];
    for (const dir of dirs) {
      for (const file of walkMjs(dir)) {
        const raw = readFileSync(file, 'utf8');
        if (raw.includes(literal)) hits.push(file);
      }
    }
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. hooks/on-stop.mjs no longer imports DEFAULT_EVENT_URL
// ---------------------------------------------------------------------------

describe('hooks/on-stop.mjs migration (#228)', () => {
  it('does not import DEFAULT_EVENT_URL from events.mjs', () => {
    const raw = readFileSync(
      path.join(repoRoot, 'hooks', 'on-stop.mjs'),
      'utf8',
    );
    expect(raw).not.toContain('DEFAULT_EVENT_URL');
  });

  it('does not contain the personal domain literal', () => {
    const raw = readFileSync(
      path.join(repoRoot, 'hooks', 'on-stop.mjs'),
      'utf8',
    );
    expect(raw).not.toContain('gotzendorfer.at');
  });
});

// ---------------------------------------------------------------------------
// 4. emitEvent: CLANK_EVENT_SECRET alone (no URL) must NOT call fetch
// ---------------------------------------------------------------------------

describe('emitEvent — no fetch when only CLANK_EVENT_SECRET is set (no URL)', () => {
  let tmpDir;
  const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'so-events-nourltest-'));
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (origClaudeProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
    }
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does not call fetch when CLANK_EVENT_SECRET is set but CLANK_EVENT_URL is absent', async () => {
    process.env.CLANK_EVENT_SECRET = 'test-secret-token';
    // CLANK_EVENT_URL intentionally not set — no personal-domain default fallback
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{}', { status: 200 }),
    );
    const { emitEvent } = await importEventsWithDir(tmpDir);
    await emitEvent('no.url.event', { x: 1 });
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
