/**
 * tests/lib/session-registry-private-config-dir.test.mjs
 *
 * NAMED BUG (2026-09-06 Wave 1): `registryBaseDir()` hardcoded
 * `path.join(os.homedir(), '.config', 'session-orchestrator', 'sessions')` and
 * honoured only `SO_SESSION_REGISTRY_DIR`. It therefore ignored `SO_CONFIG_HOME`
 * — the env var every OTHER host-private artefact moves with (#1223,
 * `resolvePrivateConfigDir`). A sandboxed probe run that set `SO_CONFIG_HOME` to
 * a tmpdir registered its throwaway session in the operator's REAL registry,
 * where it was then discovered as a live peer. Measured during Wave 1: a
 * throwaway consumer repo left an entry behind.
 *
 * These tests fail against the pre-fix module: with SO_CONFIG_HOME set and
 * SO_SESSION_REGISTRY_DIR unset, the old code returned a homedir path, so
 * `startsWith(tmp)` was false and the real active/ directory gained a file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registryBaseDir,
  activeDir,
  sweepLogPath,
  registerSelf,
  deregisterSelf,
} from '@lib/session-registry.mjs';

/** The real registry this test must never touch. */
const REAL_ACTIVE = join(homedir(), '.config', 'session-orchestrator', 'sessions', 'active');

function listReal() {
  try {
    return readdirSync(REAL_ACTIVE).sort();
  } catch {
    return null; // absent — equally valid, compared as null === null
  }
}

let sandbox;
const saved = {};

beforeEach(() => {
  for (const k of ['SO_CONFIG_HOME', 'XDG_CONFIG_HOME', 'SO_SESSION_REGISTRY_DIR']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  sandbox = mkdtempSync(join(tmpdir(), 'session-registry-cfghome-'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('registryBaseDir honours the host-private config dir', () => {
  it('SO_CONFIG_HOME moves the registry (the bug: it was ignored)', () => {
    process.env.SO_CONFIG_HOME = sandbox;
    expect(registryBaseDir()).toBe(join(sandbox, 'sessions'));
    expect(activeDir().startsWith(sandbox)).toBe(true);
    expect(sweepLogPath().startsWith(sandbox)).toBe(true);
  });

  it('XDG_CONFIG_HOME moves the registry under a session-orchestrator segment', () => {
    process.env.XDG_CONFIG_HOME = sandbox;
    expect(registryBaseDir()).toBe(join(sandbox, 'session-orchestrator', 'sessions'));
  });

  it('SO_SESSION_REGISTRY_DIR still outranks SO_CONFIG_HOME', () => {
    const explicit = join(sandbox, 'explicit-registry');
    process.env.SO_CONFIG_HOME = sandbox;
    process.env.SO_SESSION_REGISTRY_DIR = explicit;
    expect(registryBaseDir()).toBe(explicit);
  });

  it('a whitespace-only SO_SESSION_REGISTRY_DIR falls through instead of being used verbatim', () => {
    process.env.SO_CONFIG_HOME = sandbox;
    process.env.SO_SESSION_REGISTRY_DIR = '   ';
    expect(registryBaseDir()).toBe(join(sandbox, 'sessions'));
  });

  it('a run under SO_CONFIG_HOME writes NO file into the real registry', async () => {
    const before = listReal();

    process.env.SO_CONFIG_HOME = sandbox;
    const sessionId = 'cfghome-isolation-probe';
    await registerSelf({ sessionId, projectRoot: sandbox, mode: 'session' });

    // It landed in the sandbox …
    expect(existsSync(join(sandbox, 'sessions', 'active', `${sessionId}.json`))).toBe(true);
    // … and the operator's real registry is byte-for-byte unchanged.
    expect(listReal()).toEqual(before);

    await deregisterSelf(sessionId);
  });
});
