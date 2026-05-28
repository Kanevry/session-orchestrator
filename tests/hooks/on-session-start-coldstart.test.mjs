/**
 * tests/hooks/on-session-start-coldstart.test.mjs
 *
 * Unit tests for readColdStartConfig() from hooks/on-session-start.mjs
 * (MED-7, issue #589).
 *
 * The existing on-session-start hook test (tests/hooks/on-session-start.test.mjs)
 * is entirely spawn-based and never exercises readColdStartConfig in isolation —
 * the malformed-config catch at hooks/on-session-start.mjs:127 (the inner
 * `try { parseSessionConfig(md) } catch { return defaults }`) had no direct
 * coverage. This file imports the function directly to cover both the
 * happy-path (valid cold-start block → parsed values) AND the fallback path
 * (parseSessionConfig throws → exact defaults object).
 *
 * Import hazard: hooks/on-session-start.mjs self-executes on import — it calls
 * `process.exit(0)` at module top-level (profile-gate early-exit at L39) and
 * again in `main().finally(() => process.exit(0))` at the bottom. A naive
 * static import would terminate the vitest worker. We neutralise this by
 * stubbing `process.exit` to a no-op BEFORE a single dynamic import, and by
 * pointing the hook's env at isolated tmp dirs so the incidental `main()` run
 * writes nothing into the real repo. readColdStartConfig itself reads from its
 * `projectRoot` ARGUMENT (not global env), so each case is independent of that
 * incidental run.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module load — stub process.exit + isolate env, then import once.
// ---------------------------------------------------------------------------

let readColdStartConfig;
let exitSpy;
const savedEnv = {};
let envSandbox;

beforeAll(async () => {
  // Neutralise the self-executing module's process.exit() calls so importing
  // it does not kill the vitest worker.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);

  // Isolate the incidental main() run: point project dir + registry at tmp.
  envSandbox = realpathSync(mkdtempSync(join(tmpdir(), 'coldstart-hook-env-')));
  for (const k of ['CLAUDE_PROJECT_DIR', 'SO_SESSION_REGISTRY_DIR', 'SO_HOOK_PROFILE', 'CLANK_EVENT_SECRET']) {
    savedEnv[k] = process.env[k];
  }
  process.env.CLAUDE_PROJECT_DIR = envSandbox;
  process.env.SO_SESSION_REGISTRY_DIR = join(envSandbox, 'registry');
  process.env.SO_HOOK_PROFILE = 'off'; // shortest module-init path
  process.env.CLANK_EVENT_SECRET = ''; // never hit the network

  const mod = await import('../../hooks/on-session-start.mjs');
  readColdStartConfig = mod.readColdStartConfig;
});

afterAll(() => {
  exitSpy?.mockRestore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(envSandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Per-test tmp project dirs (each carries its own CLAUDE.md)
// ---------------------------------------------------------------------------

const tmpDirs = [];

function mkProjectWithClaudeMd(claudeMdBody) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coldstart-cfg-')));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'CLAUDE.md'), claudeMdBody, 'utf8');
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const DEFAULTS = {
  enabled: true,
  'nudge-after-hours': 1,
  'silence-after-sessions': 1,
};

// ---------------------------------------------------------------------------
// Export sanity — the one-keyword testability export must be wired.
// ---------------------------------------------------------------------------

describe('readColdStartConfig — export', () => {
  it('is exported as an async function', () => {
    // FALSIFICATION: if the `export` keyword were dropped from
    // hooks/on-session-start.mjs:102, this import would yield undefined and
    // typeof would be 'undefined'.
    expect(typeof readColdStartConfig).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Happy path — valid cold-start block parses through to typed values.
// ---------------------------------------------------------------------------

describe('readColdStartConfig — happy path (valid cold-start block)', () => {
  it('returns the parsed cold-start values when the block is valid', async () => {
    // A complete, well-formed Session Config with an explicit cold-start block.
    const dir = mkProjectWithClaudeMd([
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      'cold-start:',
      '  enabled: true',
      '  nudge-after-hours: 3',
      '  silence-after-sessions: 2',
      '',
    ].join('\n'));

    const cfg = await readColdStartConfig(dir);

    // FALSIFICATION: if readColdStartConfig ignored the parsed block (e.g.
    // always returned defaults), nudge-after-hours would be 1, not 3 — so this
    // proves the catch is the FALLBACK path, not the only path.
    expect(cfg).toEqual({
      enabled: true,
      'nudge-after-hours': 3,
      'silence-after-sessions': 2,
    });
  });

  it('honours cold-start.enabled: false from a valid block', async () => {
    const dir = mkProjectWithClaudeMd([
      '## Session Config',
      '',
      'cold-start:',
      '  enabled: false',
      '',
    ].join('\n'));

    const cfg = await readColdStartConfig(dir);

    // FALSIFICATION: a hard-coded `enabled: true` return would fail here.
    expect(cfg.enabled).toBe(false);
    // Numeric keys fall back to their PRD defaults when not specified.
    expect(cfg['nudge-after-hours']).toBe(1);
    expect(cfg['silence-after-sessions']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fallback path — parseSessionConfig throws → exact defaults (L127 catch).
// ---------------------------------------------------------------------------

describe('readColdStartConfig — malformed config falls back to defaults (L127 catch)', () => {
  it('returns the exact PRD defaults when parseSessionConfig throws', async () => {
    // `enforcement: bogus-value` makes parseSessionConfig throw via _coerceEnum
    // ("enforcement must be strict|warn|off"). This is a KNOWN coerced key, so
    // unlike a tolerant block parser it surfaces as a thrown error — exactly the
    // input that exercises the inner catch at hooks/on-session-start.mjs:127.
    const dir = mkProjectWithClaudeMd([
      '# Project',
      '',
      '## Session Config',
      '',
      'enforcement: bogus-value',
      'cold-start:',
      '  enabled: false',
      '  nudge-after-hours: 9',
      '',
    ].join('\n'));

    const cfg = await readColdStartConfig(dir);

    // FALSIFICATION: if the catch were absent, parseSessionConfig's throw would
    // propagate out of readColdStartConfig and reject this await. If the catch
    // returned the half-parsed block instead of defaults, enabled would be
    // false / nudge-after-hours would be 9. The contract is: ANY parse failure
    // → the untouched defaults object.
    expect(cfg).toEqual(DEFAULTS);
  });

  it('returns the exact PRD defaults when no config file exists (outer catch)', async () => {
    // A tmp dir with NO CLAUDE.md / AGENTS.md → readConfigFile throws → the
    // OUTER catch (L128) returns defaults. Distinct from the inner-catch case
    // above; both must yield the same defaults object.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coldstart-nocfg-')));
    tmpDirs.push(dir);

    const cfg = await readColdStartConfig(dir);

    expect(cfg).toEqual(DEFAULTS);
  });
});
