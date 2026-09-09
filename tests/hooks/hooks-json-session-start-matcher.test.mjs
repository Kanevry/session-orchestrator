/**
 * tests/hooks/hooks-json-session-start-matcher.test.mjs
 *
 * Wiring test for the SessionStart matcher alternation in hooks/hooks.json
 * (Claude Code) and hooks/hooks-codex.json (Codex parity).
 *
 * Why this file exists: `validate-plugin` counts matcher ENTRIES, not the
 * alternatives inside a single `a|b|c` matcher string. So dropping `resume`
 * from the alternation keeps every existing gate green while silently
 * switching off the #1091 telemetry (native_source / resume_linkage) and the
 * F1/F2 high-water-mark preservation branches, which only run when this hook
 * fires on a native resume.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** Return the SessionStart matcher alternatives of a hooks manifest. */
function sessionStartAlternatives(relPath) {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
  const entries = manifest?.hooks?.SessionStart;
  expect(Array.isArray(entries)).toBe(true);
  expect(entries).toHaveLength(1);
  return String(entries[0].matcher).split('|');
}

describe('SessionStart matcher alternation', () => {
  it('hooks.json fires on exactly startup, resume, clear and compact', () => {
    // Catches: a dropped `resume` (or a fourth source silently added) — the
    // alternation is the ONLY thing that decides whether on-session-start.mjs
    // runs on a native resume at all.
    expect(sessionStartAlternatives('hooks/hooks.json')).toEqual([
      'startup',
      'resume',
      'clear',
      'compact',
    ]);
  });

  it('hooks-codex.json keeps the resume alternative in parity with hooks.json', () => {
    // Catches: a Claude-Code-only fix. Codex reads its own manifest, so a
    // matcher edited in one file and not the other leaves the Codex platform
    // without resume telemetry while the Claude-side test stays green.
    expect(sessionStartAlternatives('hooks/hooks-codex.json')).toContain('resume');
  });

  it('the SessionStart entry runs the on-session-start hook', () => {
    // Catches: the matcher above is meaningless if nothing behind it invokes
    // the hook — a renamed/removed command entry would leave both assertions
    // above passing while no telemetry is emitted at all.
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'hooks/hooks.json'), 'utf8'),
    );
    const commands = manifest.hooks.SessionStart[0].hooks.map((h) => h.command);
    expect(commands.some((c) => c.includes('hooks/on-session-start.mjs'))).toBe(true);
  });
});
