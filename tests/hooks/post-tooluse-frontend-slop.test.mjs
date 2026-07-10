/**
 * tests/hooks/post-tooluse-frontend-slop.test.mjs
 *
 * Tests for hooks/post-tooluse-frontend-slop.mjs (#684).
 *
 * The hook is an OPT-IN, NON-BLOCKING PostToolUse detector: after an
 * Edit/Write/MultiEdit on a scannable UI file it runs the deterministic
 * frontend-slop detector and, when findings exist, writes a
 * `hookSpecificOutput.additionalContext` roll-up to stdout + appends an
 * `orchestrator.frontend_slop.warning` event. DEFAULT OFF — exits 0 silently
 * unless `frontend-slop-hook.enabled: true` in the sandbox CLAUDE.md. Exit 0
 * ALWAYS (PostToolUse cannot block an applied edit).
 *
 * Strategy (mirrors tests/hooks/loop-guard.test.mjs): spawn the hook via node
 * with stdin piped, CLAUDE_PROJECT_DIR pointing to a tmp sandbox that holds
 * both the CLAUDE.md config and the fixture file the detector reads from disk.
 * Assert exit code + stdout shape + events.jsonl contents (behaviour, not
 * implementation).
 *
 * Coverage:
 *   (a) disabled by default (no CLAUDE.md) → exit 0, no stdout, no event.
 *   (b) enabled + a frontend file WITH slop → exit 0 + additionalContext lists
 *       the rule(s) + a warning event.
 *   (c) enabled + a NON-frontend file (.md / .py) → exit 0, no detection.
 *   (d) enabled + a CLEAN frontend file → exit 0, no stdout, no event.
 *   (e) non-Edit/Write tool_name → exit 0 no-op.
 *   (f) malformed / empty stdin → exit 0, never throws.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../../hooks/post-tooluse-frontend-slop.mjs', import.meta.url).pathname;
const EVENTS_REL = join('.orchestrator', 'metrics', 'events.jsonl');

// A .css fixture that trips the high-severity `gradient-text` rule:
// background-clip:text + a gradient() anywhere in the file.
const SLOP_CSS = [
  '.hero-title {',
  '  background: linear-gradient(90deg, #f00, #00f);',
  '  -webkit-background-clip: text;',
  '  color: transparent;',
  '}',
  '',
].join('\n');

// A clean .css fixture with no slop tells.
const CLEAN_CSS = [
  '.card {',
  '  color: #1a1a1a;',
  '  padding: 1rem;',
  '}',
  '',
].join('\n');

// A .css fixture that trips MANY rules across all three fpRisk tiers and >5
// total findings — exercises the buildWarning roll-up (`+N more` truncation,
// the `/`-joined fpRisk set) and the by_rule / high-severity event payload.
// Each line trips exactly one rule (8 distinct rules):
//   gradient-text + ai-purple-gradient (the purple→blue gradient line trips
//   both: clip:text fires gradient-text, purple/blue fires ai-purple-gradient),
//   side-stripe-border, overused-font, bounce-easing, pure-black-ink,
//   arbitrary-z-index, layout-property-transition.
const MULTI_SLOP_CSS = [
  '.a { background: linear-gradient(90deg, purple, blue); -webkit-background-clip: text; }',
  '.b { border-left: 4px solid red; }',
  '.c { font-family: Inter, sans-serif; }',
  '.d { transition: bounce 1s; }',
  '.e { color: #000; }',
  '.f { z-index: 9999; }',
  '.g { transition: width 0.3s; }',
  '',
].join('\n');

const CLAUDE_MD_ENABLED = [
  '# Sandbox',
  '',
  'frontend-slop-hook:',
  '  enabled: true',
  '',
].join('\n');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'frontend-slop-hook-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

/** Spawn the hook with the given stdin payload object (or raw string). */
function runHook(payloadObj) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmp,
      SO_HOOK_PROFILE: 'full',
      SO_DISABLED_HOOKS: '',
    },
    timeout: 10_000,
  });
}

/** Write CLAUDE.md into the sandbox so the config gate can read it. */
function writeClaudeMd(content) {
  writeFileSync(join(tmp, 'CLAUDE.md'), content, 'utf8');
}

/** Write a fixture file into the sandbox and return its absolute path. */
function writeFixture(name, content) {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Read + parse the events.jsonl records (skips blank lines). */
function readEvents() {
  const path = join(tmp, EVENTS_REL);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** PostToolUse payload for an edit-shaped tool call on a file. */
function editPayload(toolName, filePath, extra = {}) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'slop-test-session',
    tool_name: toolName,
    tool_input: { file_path: filePath },
    ...extra,
  };
}

describe('post-tooluse-frontend-slop hook', () => {
  it('(a) disabled by default (no CLAUDE.md): slop file → exit 0, no stdout, no event', () => {
    const file = writeFixture('styles.css', SLOP_CSS);
    const result = runHook(editPayload('Edit', file));

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(b) enabled + frontend file with slop → exit 0 + additionalContext lists the rule + event', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('styles.css', SLOP_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);

    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('frontend-slop');
    expect(out.hookSpecificOutput.additionalContext).toContain('gradient-text');
    expect(out.hookSpecificOutput.additionalContext).toContain('styles.css');
    expect(out.hookSpecificOutput.additionalContext).toContain('rules/opt-in-stack/frontend.md');

    const events = readEvents().filter((e) => e.event === 'orchestrator.frontend_slop.warning');
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('styles.css');
    expect(events[0].total).toBeGreaterThanOrEqual(1);
    expect(events[0].high).toBeGreaterThanOrEqual(1);
    expect(events[0].by_rule['gradient-text']).toBeGreaterThanOrEqual(1);
    expect(events[0].session_id).toBe('slop-test-session');
  });

  it('(b2) enabled + Write tool (not just Edit) also scans + warns', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('component.tsx', SLOP_CSS);

    const result = runHook(editPayload('Write', file));
    expect(result.status).toBe(0);

    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('gradient-text');
  });

  it('(c) enabled + a NON-frontend file (.md) → exit 0, no detection, no event', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    // Even though the .md content contains the slop pattern, the extension gate
    // skips it before the detector ever runs.
    const file = writeFixture('NOTES.md', SLOP_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(c2) enabled + a .py file → exit 0, no detection (extension gate)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('script.py', SLOP_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(d) enabled + a CLEAN frontend file → exit 0, no stdout, no event', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('clean.css', CLEAN_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(e) non-Edit/Write tool_name → exit 0 no-op even with a slop file', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('styles.css', SLOP_CSS);

    const result = runHook(editPayload('Read', file));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(f) malformed stdin → exit 0, no crash, no event', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const result = runHook('{{not valid json}}');

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(f2) empty stdin → exit 0, no crash, no event', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const result = runHook('');

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(g) enabled + Edit payload missing file_path → exit 0 no-op', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const result = runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'slop-test-session',
      tool_name: 'Edit',
      tool_input: {},
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(h) MultiEdit tool_name is also gated in and scans the file', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('multi.css', SLOP_CSS);

    const result = runHook(editPayload('MultiEdit', file));
    expect(result.status).toBe(0);

    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('gradient-text');

    const events = readEvents().filter((e) => e.event === 'orchestrator.frontend_slop.warning');
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('multi.css');
  });

  it('(i) roll-up truncates past 5 findings and aggregates the fpRisk set', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('many.css', MULTI_SLOP_CSS);

    const result = runHook(editPayload('Write', file));
    expect(result.status).toBe(0);

    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    // 8 distinct rules trip → "8 finding(s)" and "+3 more" (only 5 are shown).
    expect(ctx).toContain('8 finding(s) in many.css');
    expect(ctx).toContain('+3 more');
    // The three fpRisk tiers present (high/low/medium) are joined with "/".
    expect(ctx).toContain('(fpRisk: high/low/medium)');
    expect(ctx).toContain('rules/opt-in-stack/frontend.md');
  });

  it('(j) event payload carries the full by_rule breakdown + high-severity count', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('many.css', MULTI_SLOP_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);

    const events = readEvents().filter((e) => e.event === 'orchestrator.frontend_slop.warning');
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.total).toBe(8);
    // Exactly two high-severity rules fire: gradient-text + side-stripe-border.
    expect(ev.high).toBe(2);
    expect(ev.by_rule).toEqual({
      'ai-purple-gradient': 1,
      'gradient-text': 1,
      'side-stripe-border': 1,
      'overused-font': 1,
      'bounce-easing': 1,
      'pure-black-ink': 1,
      'arbitrary-z-index': 1,
      'layout-property-transition': 1,
    });
  });

  it('(k) a .scss SCANNABLE_EXT file is scanned (not just .css/.tsx)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('theme.scss', SLOP_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('gradient-text');
  });

  it('(l) a .ts file is NOT scanned — only .tsx is scannable (extension gate)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    // .ts looks UI-adjacent but is deliberately absent from SCANNABLE_EXTS.
    const file = writeFixture('logic.ts', SLOP_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(m) a file path with no extension → exit 0 no-op (extension gate)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('Makefile', SLOP_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('(n) extension match is case-insensitive (.CSS uppercase is scanned)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const file = writeFixture('STYLES.CSS', SLOP_CSS);

    const result = runHook(editPayload('Edit', file));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('gradient-text');
  });
});
