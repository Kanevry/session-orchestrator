/**
 * store-role.test.mjs — host-local learnings-store role resolution (#1516).
 *
 * Bugs these catch:
 *  - env does not win over owner.yaml (an operator's one-shot override ignored);
 *  - an invalid env value, or an owner.yaml whose learnings key is set but
 *    unusable (typo, unparseable, unreadable), resolves to writer instead of
 *    invalid — the host then rewrites a store it was meant to leave alone;
 *  - the memo keyed on something other than the env value, so a changed env
 *    keeps the old role for the rest of the process;
 *  - a typo in owner.yaml `learnings.store-role` survives validation and the
 *    host silently resolves to a role nobody configured;
 *  - an owner.yaml without any learnings key stops meaning writer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveStoreRole,
  _resetStoreRoleCacheForTests,
} from '../../../scripts/lib/learnings/store-role.mjs';
import { getDefaults, writeOwnerConfig } from '../../../scripts/lib/owner-yaml.mjs';

let home;

/** Write a valid owner.yaml into the tmp config home, optionally with raw YAML appended. */
function writeOwner(extraYaml = '') {
  const config = getDefaults();
  config.owner.name = 'Test Owner';
  const path = join(home, 'owner.yaml');
  expect(writeOwnerConfig(config, { path }).written).toBe(true);
  if (extraYaml) appendFileSync(path, extraYaml);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'store-role-'));
  _resetStoreRoleCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('resolveStoreRole', () => {
  it('defaults to writer with no env and no owner.yaml', () => {
    expect(resolveStoreRole({ env: { SO_CONFIG_HOME: home } })).toEqual({ role: 'writer', source: 'default' });
  });

  it('reads owner.yaml learnings.store-role, and env overrides it', () => {
    writeOwner('learnings:\n  store-role: inbox\n');
    expect(resolveStoreRole({ env: { SO_CONFIG_HOME: home } })).toEqual({ role: 'inbox', source: 'owner-yaml' });
    expect(
      resolveStoreRole({ env: { SO_CONFIG_HOME: home, SO_LEARNINGS_STORE_ROLE: ' writer ' } }),
    ).toEqual({ role: 'writer', source: 'env' });
  });

  // Bug: an invalid env value was WARNed and ignored, so a typo meant to make
  // the host an inbox fell back to owner.yaml or writer and rewrote the store.
  it('resolves an invalid env value to invalid, never to writer or the owner.yaml role', () => {
    writeOwner('learnings:\n  store-role: inbox\n');
    const result = resolveStoreRole({ env: { SO_CONFIG_HOME: home, SO_LEARNINGS_STORE_ROLE: 'inbx' } });
    expect(result).toMatchObject({ role: 'invalid', source: 'env' });
    expect(result.reason).toContain('inbx');
  });

  it('memoizes per env value, not once per process', () => {
    let loads = 0;
    const loadOwner = () => {
      loads += 1;
      return { config: {} };
    };
    const env = { SO_CONFIG_HOME: home };
    resolveStoreRole({ env, loadOwner });
    resolveStoreRole({ env, loadOwner });
    expect(loads).toBe(1);
    expect(resolveStoreRole({ env: { ...env, SO_LEARNINGS_STORE_ROLE: 'inbox' }, loadOwner }).role).toBe('inbox');
  });

  // Bug: owner.yaml dropped the invalid section and the resolver read that as
  // "not configured" -> writer, the one role the operator did NOT ask for.
  it('resolves a typo in owner.yaml learnings.store-role to invalid, not writer', () => {
    writeOwner('learnings:\n  store-role: inbx\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveStoreRole({ env: { SO_CONFIG_HOME: home } });
    expect(result).toMatchObject({ role: 'invalid', source: 'owner-yaml' });
    expect(result.reason).toContain('inbx');
  });

  // Bug (#1686): a typo in the KEY (`store_role`) loaded as "store-role absent"
  // and fell back to writer, so a host meant as inbox rewrote the synced store.
  it('resolves a misspelt key in owner.yaml learnings to invalid, not writer', () => {
    writeOwner('learnings:\n  store_role: inbox\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveStoreRole({ env: { SO_CONFIG_HOME: home } });
    expect(result).toMatchObject({ role: 'invalid', source: 'owner-yaml' });
    expect(result.reason).toContain('store_role');
  });

  it('resolves an owner.yaml without a learnings key to writer', () => {
    writeOwner();
    expect(resolveStoreRole({ env: { SO_CONFIG_HOME: home } })).toEqual({ role: 'writer', source: 'default' });
  });

  // Bug (#1686): an empty `learnings:` sets no role, yet resolved to invalid
  // and froze every write while the docs promise writer.
  it('resolves an empty learnings section to writer', () => {
    writeOwner('learnings:\n');
    expect(resolveStoreRole({ env: { SO_CONFIG_HOME: home } })).toEqual({ role: 'writer', source: 'default' });
  });

  // Bug: an unparseable file loads as defaults, so a store role in it vanished.
  it('resolves an unparseable owner.yaml that names learnings to invalid', () => {
    writeFileSync(join(home, 'owner.yaml'), 'learnings:\n  store-role: inbox\n  bad: [unclosed\n');
    expect(resolveStoreRole({ env: { SO_CONFIG_HOME: home } })).toMatchObject({
      role: 'invalid',
      source: 'owner-yaml',
    });
  });

  it('resolves an owner.yaml that exists but cannot be read to invalid', () => {
    mkdirSync(join(home, 'owner.yaml'));
    expect(resolveStoreRole({ env: { SO_CONFIG_HOME: home } })).toMatchObject({
      role: 'invalid',
      source: 'owner-yaml',
    });
  });
});
