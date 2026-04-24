/**
 * tests/lib/events-default-url.test.mjs
 *
 * Smoke test for issue #260: `DEFAULT_EVENT_URL` refactor.
 *
 * Contract:
 *   - `DEFAULT_EVENT_URL` is exported from scripts/lib/events.mjs.
 *   - It is a non-empty string starting with `https://`.
 *   - hooks/on-stop.mjs imports it (no hardcoded duplicate of the URL literal
 *     lives in that hook — a regression would add a second occurrence of the
 *     `'https://events.gotzendorfer.at'` string across scripts/ + hooks/).
 *
 * The grep-count assertion ensures we keep the constant defined in exactly
 * one place (the export in events.mjs) and imported everywhere else.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

import { DEFAULT_EVENT_URL } from '../../scripts/lib/events.mjs';

// ---------------------------------------------------------------------------
// 1. Exported constant shape
// ---------------------------------------------------------------------------

describe('DEFAULT_EVENT_URL', () => {
  it('is exported as a non-empty string', () => {
    expect(typeof DEFAULT_EVENT_URL).toBe('string');
    expect(DEFAULT_EVENT_URL.length).toBeGreaterThan(0);
  });

  it('starts with https://', () => {
    expect(DEFAULT_EVENT_URL.startsWith('https://')).toBe(true);
  });

  it('contains no trailing slash (concatenated with path suffix at call sites)', () => {
    // Consumers append `/api/webhooks/events` — a trailing slash would produce
    // a double-slash URL and is a regression worth guarding against.
    expect(DEFAULT_EVENT_URL.endsWith('/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Single-source-of-truth check — grep across scripts/ + hooks/
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
      // Skip vendor / generated dirs
      if (entry === 'node_modules' || entry === '.git') continue;
      walkMjs(full, acc);
    } else if (entry.endsWith('.mjs')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('DEFAULT_EVENT_URL — single source of truth', () => {
  it('literal URL string occurs in exactly ONE .mjs file (events.mjs)', () => {
    const literal = DEFAULT_EVENT_URL; // derived from the constant, not hardcoded
    const dirs = [
      path.join(repoRoot, 'scripts'),
      path.join(repoRoot, 'hooks'),
    ];
    const hits = [];
    for (const dir of dirs) {
      for (const file of walkMjs(dir)) {
        // Skip the constant-definition file itself? No — we INCLUDE it and
        // assert count === 1 (i.e. only events.mjs mentions the literal).
        const raw = readFileSync(file, 'utf8');
        if (raw.includes(literal)) hits.push(file);
      }
    }
    expect(hits).toHaveLength(1);
    // Normalize path separators — Windows uses `\`, the regex uses `/`.
    expect(hits[0].replaceAll(path.sep, '/')).toMatch(/scripts\/lib\/events\.mjs$/);
  });

  it('hooks/on-stop.mjs imports DEFAULT_EVENT_URL (not redeclares the literal)', () => {
    const raw = readFileSync(
      path.join(repoRoot, 'hooks', 'on-stop.mjs'),
      'utf8',
    );
    expect(raw).toContain('DEFAULT_EVENT_URL');
    expect(raw).toContain("from '../scripts/lib/events.mjs'");
    // Negative: the literal URL must NOT appear hardcoded in the hook.
    expect(raw.includes(DEFAULT_EVENT_URL)).toBe(false);
  });
});
