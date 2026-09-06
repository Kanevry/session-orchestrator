/**
 * tests/docs/session-config-ultradeep.test.mjs
 *
 * Doc↔code parity for the two claims the ultradeep documentation makes ABOUT
 * THE PARSER in `docs/session-config-reference.md` § Session Profile and
 * `docs/session-config-template.md` § Session Structure.
 *
 * THE BUG THIS CATCHES (TV-001):
 *
 *  (1) The docs promise `agents-per-wave: 6 (deep: 18, ultradeep: 18)` works
 *      "with no code change". If `_coerceInteger`'s override syntax is ever
 *      narrowed to a fixed key set, an `ultradeep:` override either THROWS at
 *      session-start or is silently dropped back to the `default` — a repo that
 *      followed the documentation would then run its 18-agent research wave at
 *      6 agents and nothing would say why. The override string is read OUT OF
 *      THE DOC, so doc and parser cannot drift apart in either direction.
 *
 *  (2) `session-profile` is documented as NOT a Session Config key. If someone
 *      later wires one into `parseSessionConfig()` without removing the "inert
 *      prose" warning, the docs actively mislead — the same trap the existing
 *      `session-type:` note exists for.
 *
 * NOT A PROSE PIN (TV-002c): no sentence is asserted. A config line is
 * extracted from the doc and handed to the real parser.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { _coerceInteger } from '@lib/config/coercers.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const REFERENCE = readFileSync(path.join(REPO_ROOT, 'docs/session-config-reference.md'), 'utf8');
const TEMPLATE = readFileSync(path.join(REPO_ROOT, 'docs/session-config-template.md'), 'utf8');

/** The `agents-per-wave: N (…)` override VALUE as the doc spells it. */
function documentedOverrideValue(doc) {
  const m = doc.match(/agents-per-wave:\s*(\d+\s*\([^)]*ultradeep[^)]*\))/);
  return m ? m[1].trim() : null;
}

describe('agents-per-wave — the documented ultradeep override actually parses', () => {
  it('the reference documents an ultradeep override', () => {
    expect(documentedOverrideValue(REFERENCE)).toBeTruthy();
  });

  it('the parser returns every override key, not just the known ones', () => {
    const value = documentedOverrideValue(REFERENCE);
    const kv = new Map([['agents-per-wave', value]]);
    expect(_coerceInteger(kv, 'agents-per-wave', 6)).toEqual({
      default: 6,
      deep: 18,
      ultradeep: 18,
    });
  });

  it('the template promises the same shape the reference does', () => {
    expect(documentedOverrideValue(TEMPLATE)).toBe(documentedOverrideValue(REFERENCE));
  });
});

describe('session-profile is not a Session Config key', () => {
  it('parseSessionConfig emits none even when a repo writes one', () => {
    const config = parseSessionConfig(
      ['## Session Config', '', 'waves: 7', 'session-profile: ultradeep', ''].join('\n')
    );
    expect(Object.keys(config)).not.toContain('session-profile');
    expect(Object.keys(config)).not.toContain('session_profile');
    // The surrounding block still parses — the stray key is inert, not fatal.
    expect(config.waves).toBe(7);
  });
});
