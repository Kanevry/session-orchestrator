/**
 * tests/lib/secret-output-detector.test.mjs — detectSecretOutput (#1786).
 *
 * Hook wiring (event, message, both payload shapes) is covered end-to-end in
 * tests/hooks/post-bash-write-verify.test.mjs; this file pins only what the
 * process test cannot reach cheaply: key attribution and the scan window.
 */

import { describe, it, expect } from 'vitest';

import { detectSecretOutput, SCAN_WINDOW_CHARS } from '../../scripts/lib/secret-output-detector.mjs';

const VALUE = 'fixture-value-not-a-real-credential-4217';

describe('detectSecretOutput', () => {
  it('attributes hits to every key NAME sharing the value and returns nothing value-derived', () => {
    // Bug caught: a value-deduped needle set (the masker's) loses the second
    // key name, so the operator rotates one credential and leaves its twin.
    const r = detectSecretOutput({
      toolResponse: { stdout: VALUE, stderr: `x${VALUE}` },
      env: { B_FIXTURE_TOKEN: VALUE, A_FIXTURE_KEY: VALUE, PWD: VALUE },
    });
    expect(r).toEqual({ hits: 4, envKeys: ['A_FIXTURE_KEY', 'B_FIXTURE_TOKEN'], truncated: false });
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });

  it('attributes a DSN printed in Bash output to its `_DSN` key by name only', () => {
    // Bug caught (#1799 point 1): a `_DSN` key was no needle, so a printed
    // database DSN with its password raised no SEC-008 incident at all.
    const dsn = `postgres://ro:fake-pass-${VALUE}@db.example.org/x`;
    const r = detectSecretOutput({
      toolResponse: { stdout: `env dump\nAPP_RO_DSN=${dsn}\n`, stderr: '' },
      env: { APP_RO_DSN: dsn },
    });
    expect(r).toEqual({ hits: 1, envKeys: ['APP_RO_DSN'], truncated: false });
    expect(JSON.stringify(r)).not.toContain('fake-pass');
  });

  it('finds a value with quote and backslash inside JSON.stringify output', () => {
    // Bug caught (review of b4f93ac5): the incident printed JSON.stringify of
    // an object holding env values; a value with `"` or `\` appears ESCAPED
    // there, and a raw-value search reported 0 hits and no incident.
    const tricky = 'fixture"value\\not-a-real-credential-4217';
    const r = detectSecretOutput({
      toolResponse: { stdout: JSON.stringify({ env: { SVC_FIXTURE_TOKEN: tricky } }), stderr: '' },
      env: { SVC_FIXTURE_TOKEN: tricky },
    });
    expect(r).toEqual({ hits: 1, envKeys: ['SVC_FIXTURE_TOKEN'], truncated: false });
    // A trailing `\` makes the raw value a prefix of its escaped form; one
    // serialized occurrence must still count once (Codex delta review).
    const trailing = 'fixture-value-not-a-real-credential-4217\\';
    expect(detectSecretOutput({
      toolResponse: JSON.stringify({ t: trailing }),
      env: { SVC_FIXTURE_TOKEN: trailing },
    }).hits).toBe(1);
  });

  it('scans head and tail of an over-long stream separately and says truncated', () => {
    // Bug caught: an uncapped scan on a pathological stream, or a head+tail
    // JOIN that assembles a needle across the cut (a false alarm).
    const half = VALUE.length / 2;
    const tailHit = `${'x'.repeat(SCAN_WINDOW_CHARS * 3)}${VALUE}`;
    expect(detectSecretOutput({ toolResponse: tailHit, env: { F_TOKEN: VALUE } }))
      .toEqual({ hits: 1, envKeys: ['F_TOKEN'], truncated: true });
    const straddle = `${'x'.repeat(SCAN_WINDOW_CHARS - half)}${VALUE.slice(0, half)}`
      + `${'y'.repeat(SCAN_WINDOW_CHARS)}${VALUE.slice(half)}${'z'.repeat(SCAN_WINDOW_CHARS - half)}`;
    expect(detectSecretOutput({ toolResponse: straddle, env: { F_TOKEN: VALUE } }).hits).toBe(0);
  });
});
