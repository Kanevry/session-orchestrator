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

import {
  USAGE_PING_FIELDS,
  SHARED_LIST_BOUNDS,
  buildUsagePing,
} from '../../scripts/lib/telemetry/schema.mjs';
// The client-side whitelist's SSOT (GitLab #1252). `schema.mjs` re-exports the
// same frozen array for legacy importers; the parity contract is between the
// SSOT and the server's mirror, so it is the SSOT that is addressed here.
import { VALID_SESSION_PROFILES } from '../../scripts/lib/session-schema/constants.mjs';
import {
  validateRecord,
  ValidationError,
  SESSION_PROFILES,
  INGEST_LIST_BOUNDS,
} from '../../server/ingest/validate.mjs';

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

// ---------------------------------------------------------------------------
// session_profile — the OPTIONAL field whose VALUE is bounded on both sides
// (2026-09-06). It was the only repo-authored free text on the wire: a STATE.md
// carrying `session-profile: client-acme-private-repo` sent that string verbatim
// and the server persisted it into raw_json. Client omission alone is not the
// fix — a foreign or tampered client bypasses it — so the two whitelists must
// stay in lockstep, which is exactly what this file exists to enforce.
// ---------------------------------------------------------------------------

describe('telemetry parity: session_profile whitelist (client omission <-> server rejection)', () => {
  const PRIVATE_LOOKING = 'client-acme-private-repo';

  it('the two whitelists are the same set (client schema.mjs <-> server validate.mjs)', () => {
    expect([...SESSION_PROFILES].sort()).toEqual([...VALID_SESSION_PROFILES].sort());
  });

  it.each([...VALID_SESSION_PROFILES])('a whitelisted profile "%s" round-trips: emitted by the client AND accepted by the server', (profile) => {
    const ping = buildUsagePing({
      env: {},
      now: START,
      ownerConfig: {},
      roster: { skills: new Set(), commands: new Set() },
      sessionRecord: { session_type: 'deep' },
      sessionProfile: profile,
    });
    expect(ping.session_profile).toBe(profile);
    expect(() => validateRecord(validPing({ session_profile: profile }))).not.toThrow();
  });

  it('THE LEAK, both sides: a private-looking profile never leaves the client, and is rejected if some other client sends it', () => {
    const ping = buildUsagePing({
      env: {},
      now: START,
      ownerConfig: {},
      roster: { skills: new Set(), commands: new Set() },
      sessionRecord: { session_type: 'deep' },
      sessionProfile: PRIVATE_LOOKING,
    });
    // client: absent from the wire entirely — not 'other', not null, not the string
    expect('session_profile' in ping).toBe(false);
    expect(JSON.stringify(ping)).not.toContain(PRIVATE_LOOKING);

    // server: the same value, arriving anyway, is refused — so it never reaches
    // raw_json. A length-only bound would have STORED it (24 chars, lowercase).
    const err = captureValidationError(validPing({ session_profile: PRIVATE_LOOKING }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.field).toBe('session_profile');
    expect(err.message).not.toContain(PRIVATE_LOOKING); // SEC-009: never echo input
  });

  it('the server rejects a non-string / oversized / near-miss profile, and still accepts its ABSENCE', () => {
    for (const bad of [42, null, {}, ['ultradeep'], 'Ultradeep', 'ultradeep ', 'x'.repeat(200)]) {
      const err = captureValidationError(validPing({ session_profile: bad }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.field).toBe('session_profile');
    }
    // optional: an omitted profile is the common case and must stay valid
    expect(() => validateRecord(validPing())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// List bounds — the numeric half of the same two-tree contract (GitLab #1252).
// The client caps `skills`/`commands` at MAX_NAMES entries of MAX_NAME_LENGTH
// chars; the server rejects above MAX_LIST_ITEMS / MAX_LIST_ITEM_LEN. Two
// hand-typed pairs in two trees, previously compared by nothing: a client
// capping HIGHER than the server emits pings the server 400s.
//
// Only these TWO bounds are shared. The server's other five (MAX_ANON_ID,
// MAX_SENT_AT, MAX_PLUGIN_VERSION, MAX_SESSION_TYPE, MAX_SESSION_PROFILE) are
// SERVER-ONLY BY DESIGN — they bound input from any client, including foreign
// or tampered ones, and have no client counterpart to keep in lockstep. Do not
// "complete" this test by inventing five client constants to match them.
// ---------------------------------------------------------------------------

describe('telemetry parity: shared list bounds (client caps <-> server limits)', () => {
  it('the two shared bounds are equal (schema.mjs SHARED_LIST_BOUNDS <-> validate.mjs INGEST_LIST_BOUNDS)', () => {
    expect(SHARED_LIST_BOUNDS).toEqual(INGEST_LIST_BOUNDS);
  });

  it('a list at exactly the shared bound is accepted by the server', () => {
    const name = 'x'.repeat(INGEST_LIST_BOUNDS.maxItemLength);
    const skills = Array.from({ length: INGEST_LIST_BOUNDS.maxItems }, (_, i) => `${name.slice(0, -6)}${String(i).padStart(6, '0')}`);
    expect(() => validateRecord(validPing({ skills }))).not.toThrow();
  });

  it('one item past either shared bound is rejected — so the client cap is what keeps real traffic valid', () => {
    const overLong = validPing({ skills: ['x'.repeat(SHARED_LIST_BOUNDS.maxItemLength + 1)] });
    expect(captureValidationError(overLong)).toBeInstanceOf(ValidationError);

    const tooMany = validPing({
      skills: Array.from({ length: SHARED_LIST_BOUNDS.maxItems + 1 }, (_, i) => `s${i}`),
    });
    expect(captureValidationError(tooMany)).toBeInstanceOf(ValidationError);
  });
});
