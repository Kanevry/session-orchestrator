/**
 * tests/telemetry/parity.test.mjs — client<->server usage-ping field-parity
 * guard (Epic #841 W4-Panel Q3-Arch #5).
 *
 * Two independently-maintained field lists live in two separate trees:
 *   - scripts/lib/telemetry/schema.mjs   USAGE_PING_FIELDS  (client whitelist)
 *   - server/ingest/validate.mjs         validateUsagePingV1 (server per-field checks)
 *
 * Nothing forces these to stay in lockstep — a field dropped from one side
 * while still required by the other would silently reject (or silently
 * accept) real traffic. This file proves BOTH directions against the REAL
 * modules (no mocks):
 *
 *   1. Forward:  every field in USAGE_PING_FIELDS (minus the two envelope
 *      fields the dispatcher itself consumes) is independently REQUIRED by
 *      the server's `validateRecord` — deleting it from an otherwise-valid
 *      record makes validation fail on exactly that field.
 *   2. Reverse:  the server requires no top-level field OUTSIDE the client
 *      whitelist — a record built from EXACTLY the USAGE_PING_FIELDS key set
 *      (and nothing else) passes validation.
 *
 * `validPing()` is a hand-written literal (NOT derived from USAGE_PING_FIELDS)
 * so a shrinking whitelist cannot shrink this fixture in lockstep — see the
 * fake-regression note on the reverse-direction test below.
 */

import { describe, it, expect } from 'vitest';

import { USAGE_PING_FIELDS } from '../../scripts/lib/telemetry/schema.mjs';
import { validateRecord, ValidationError } from '../../server/ingest/validate.mjs';

const START = '2026-07-20T00:00:00.000Z';

/**
 * A fully-valid usage-ping v1 record, hardcoded field-by-field to mirror the
 * documented v1 contract (schema.mjs module docblock). Deliberately NOT built
 * by spreading USAGE_PING_FIELDS — see the module docblock above.
 */
function validPing(overrides = {}) {
  return {
    record_kind: 'usage-ping',
    schema_version: 1,
    anon_id: '99999999-8888-4777-8666-555555555555',
    sent_at: START,
    plugin_version: '1.0.0',
    platform: 'claude',
    os: 'darwin',
    arch: 'arm64',
    node_major: 24,
    ci: false,
    fleet: false,
    session_type: 'housekeeping',
    duration_bucket: '<15m',
    skills: [],
    commands: [],
    ...overrides,
  };
}

/** Envelope fields — the dispatcher itself consumes these to route to a
 * per-kind validator; they are not exercised by the per-field omission loop. */
const ENVELOPE_FIELDS = new Set(['record_kind', 'schema_version']);

const CLIENT_REQUIRED_FIELDS = USAGE_PING_FIELDS.filter((field) => !ENVELOPE_FIELDS.has(field));

/** Run validateRecord and return the thrown error, or null if it did not throw. */
function captureValidationError(record) {
  try {
    validateRecord(record);
  } catch (err) {
    return err;
  }
  return null;
}

describe('telemetry parity: client whitelist <-> server usage-ping validator', () => {
  it('a fully-populated usage-ping record built from the client whitelist passes server validation', () => {
    expect(() => validateRecord(validPing())).not.toThrow();
  });

  // Reverse direction: the server requires no top-level field the client does
  // not already send. `validPing()` carries EXACTLY the USAGE_PING_FIELDS key
  // set (asserted below) and validates cleanly — if the server's validator
  // required some field X not in USAGE_PING_FIELDS, validPing() would be
  // missing it and the "passes server validation" test above would fail.
  it('the valid fixture carries exactly the USAGE_PING_FIELDS key set (server requires no field outside the client whitelist)', () => {
    expect(Object.keys(validPing()).sort()).toEqual([...USAGE_PING_FIELDS].sort());
  });

  // Forward direction, per-field: deleting any ONE client-whitelisted field
  // (other than the two envelope fields) from an otherwise-valid record must
  // make the server reject it, naming that exact field.
  //
  // Fake-regression (why this goes RED on drift): if a field — say 'ci' — is
  // removed from USAGE_PING_FIELDS in schema.mjs while validateUsagePingV1 in
  // validate.mjs still calls requireBool(record, 'ci'), TWO things happen:
  //   (a) the it.each loop below simply stops generating a case for 'ci'
  //       (silent shrinkage, easy to miss) — but
  //   (b) the "exactly the USAGE_PING_FIELDS key set" test above catches it
  //       anyway: validPing() still hardcodes the 'ci' key (independent
  //       literal), so Object.keys(validPing()) no longer equals
  //       [...USAGE_PING_FIELDS] once the import shrinks — that test goes RED.
  // Conversely, if the SERVER stopped requiring a field the client still
  // whitelists (e.g. validateUsagePingV1 drops its 'ci' check), the
  // corresponding it.each case below goes RED directly: deleting 'ci' from
  // the fixture would no longer throw, so `err` stays null and
  // `expect(err).toBeInstanceOf(ValidationError)` fails.
  it.each(CLIENT_REQUIRED_FIELDS)('rejects a usage-ping missing the client-whitelisted field "%s"', (field) => {
    const ping = validPing();
    delete ping[field];
    const err = captureValidationError(ping);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.field).toBe(field);
  });
});
