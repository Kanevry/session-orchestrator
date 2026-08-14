import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSecretValueMasker } from '@lib/secret-masker.mjs';

/**
 * Contract tests for the value-based secret masker (#974).
 *
 * WHY EVERY NEEDLE IS GENERATED AT RUNTIME (`'so-test-needle-' + randomUUID()`)
 * and never written as a file literal:
 *   - it carries no vendor shape (`sk-ant-`, `glpat-`, `ghp_`), so it passes
 *     `check-test-fixture-shapes.mjs` F5–F8, `.gitleaks.toml` and
 *     `check-owner-leakage.mjs` without a `// @secret-shape-allowed` escape
 *     hatch — a magic comment would be a bypass, not a solution;
 *   - it still tests the real thing, because this masker is VALUE-based, not
 *     SHAPE-based. A test that NEEDED a real `sk-ant-` literal would be proving
 *     the masker had secretly become shape-based — that would be the bug.
 *
 * No test prints or asserts a real environment value: only names, lengths and
 * counts. Every fixture below is synthetic.
 */

const M = '[REDACTED]';
const markerCount = (s) => s.split(M).length - 1;
const newNeedle = () => `so-test-needle-${randomUUID()}`;

describe('createSecretValueMasker — positive path', () => {
  it('replaces a secret-named env VALUE wherever it occurs in the text', () => {
    // Bug caught: the masker builds no needles at all, or splices at the wrong
    // offset. Asserted against the EXACT output string (not `toContain(M)`),
    // which is what discriminates a correct splice from a mangled one.
    const needle = newNeedle();
    const { mask, needleCount } = createSecretValueMasker({ MY_API_TOKEN: needle });
    expect(needleCount).toBe(1);
    expect(mask(`2026-08-14 auth ok token=${needle} user=alice`)).toBe(
      '2026-08-14 auth ok token=[REDACTED] user=alice',
    );
  });

  it('replaces EVERY occurrence of the same needle, not only the first', () => {
    // Bug caught: a non-global regex (or a single-shot replace) leaves the
    // second and later occurrences of the secret in the log verbatim — the
    // common case, since a token usually appears in both a request and a retry.
    const needle = newNeedle();
    const { mask } = createSecretValueMasker({ SERVICE_KEY: needle });
    const out = mask(`try ${needle} | retry ${needle} | done`);
    expect(out).toBe('try [REDACTED] | retry [REDACTED] | done');
    expect(markerCount(out)).toBe(2);
  });

  it('qualifies a LOWERCASE secret-bearing key name', () => {
    // Bug caught: testing the key name against an upper-case-only pattern lets
    // a lowercase credential (`github_token`, as written by several CI images)
    // through unmasked. This pins the deliberate widening over the mirrored
    // SECRET_ENV_NAME_RE shape, which is anchored to upper case.
    const needle = newNeedle();
    const { mask, needleCount } = createSecretValueMasker({ github_token: needle });
    expect(needleCount).toBe(1);
    expect(mask(`Authorization: Bearer ${needle}`)).toBe('Authorization: Bearer [REDACTED]');
  });
});

describe('createSecretValueMasker — over-masking guards (the measured failure mode)', () => {
  // Synthetic stand-ins matching the MEASURED lengths of the six colliding host
  // values (21 / 21 / 28 / 58 / 58). Real values are never used or printed.
  const SYNTH_USER = 'so-test-user-aaaaaaaa'; // 21 chars, as measured for USER
  const SYNTH_HOME = `/Users/${SYNTH_USER}`; // 28 chars, as measured for HOME
  const SYNTH_PWD = `${SYNTH_HOME}/Projects/so-test-repo-aaaaaaa`;

  it('sanity: the synthetic collider fixtures carry the measured lengths', () => {
    // Bug caught: an edited fixture that quietly lost its length would make the
    // two tests below vacuous — they would then assert "a short string is not
    // masked", which no design under discussion would have violated.
    expect(SYNTH_USER).toHaveLength(21);
    expect(SYNTH_HOME).toHaveLength(28);
    expect(SYNTH_PWD).toHaveLength(58);
  });

  it('produces ZERO needles from the five measured colliding keys', () => {
    // Bug caught: a length-first design. Discovery measured 5.2 MB of real log
    // text: these five values account for 157 + 157 + 154 mis-maskings, and no
    // length threshold separates them from real secrets (shortest real secret
    // 32 chars, longest collider 58 — the bands overlap completely). If this
    // count is anything but 0, the filter ORDER has regressed.
    const { needleCount } = createSecretValueMasker({
      USER: SYNTH_USER,
      LOGNAME: SYNTH_USER,
      HOME: SYNTH_HOME,
      PWD: SYNTH_PWD,
      OLDPWD: SYNTH_PWD,
    });
    expect(needleCount).toBe(0);
  });

  it('leaves a real-shaped log line with a home path completely untouched', () => {
    // Bug caught: the 157-collision failure itself, asserted on the OUTPUT
    // rather than on the needle count — a masker could qualify zero needles yet
    // still rewrite the line via a stray normalisation on the pass-through path.
    const { mask } = createSecretValueMasker({ USER: SYNTH_USER, HOME: SYNTH_HOME, PWD: SYNTH_PWD });
    const line = `${SYNTH_PWD}/scripts/lib/secret-masker.mjs: ok (user ${SYNTH_USER})`;
    expect(mask(line)).toBe(line);
  });

  it('does NOT mask CLAUDE_CODE_SESSION_ID — a correlation key, not a credential', () => {
    // Bug caught: widening the key-name heuristic to `_ID`. That value is 36
    // chars with 39 corpus hits — length-indistinguishable from a 32-char token
    // — and appears in ordinary log lines, so masking it destroys correlation
    // for zero security gain (the credential beside it is
    // CLAUDE_CODE_MESSAGING_TOKEN, which DOES qualify via `_TOKEN`).
    // This test, not an allowlist entry, is what carries the decision: an
    // allowlist entry would silently absorb such a widening, this goes RED.
    const sessionId = randomUUID(); // 36 chars, same shape as the real value
    const { mask, needleCount } = createSecretValueMasker({ CLAUDE_CODE_SESSION_ID: sessionId });
    expect(needleCount).toBe(0);
    expect(mask(`[session ${sessionId}] wave 2 started`)).toBe(
      `[session ${sessionId}] wave 2 started`,
    );
  });

  it('does NOT mask a long value under a non-secret key name', () => {
    // Bug caught: filter 2 (key-name heuristic) missing entirely, which turns
    // every sufficiently long env value into a needle. Neither key below is on
    // the allowlist, so only the heuristic can be rejecting them here.
    const long = `so-test-value-${randomUUID()}`;
    const { mask, needleCount } = createSecretValueMasker({
      EDITOR: long,
      npm_config_registry: long,
    });
    expect(needleCount).toBe(0);
    expect(mask(`resolved ${long} from config`)).toBe(`resolved ${long} from config`);
  });

  it('does NOT build a needle from a value shorter than the length floor', () => {
    // Bug caught: dropping filter 3. A secret-named key carrying a degenerate
    // value (`MY_TOKEN=abc`) becomes a 3-char needle that shreds every line
    // containing those letters — here the whole surrounding sentence.
    const { mask, needleCount } = createSecretValueMasker({ MY_TOKEN: 'abc' });
    expect(needleCount).toBe(0);
    expect(mask('abc: fetched abcdef from the cache')).toBe('abc: fetched abcdef from the cache');
  });
});

describe('createSecretValueMasker — pattern construction', () => {
  it('escapes regex metacharacters so a needle matches ONLY itself', () => {
    // Bug caught: interpolating the raw value into a RegExp. `decoy` is exactly
    // the string the UNESCAPED pattern would match (`.` → any char, `(C)` a
    // group, `[D]*` zero repetitions) while being a DIFFERENT string from the
    // needle — verified constructively: unescaped matches decoy, escaped does
    // not. Without escaping, this test's second assertion goes RED.
    const suffix = randomUUID();
    const needle = `so-test-needle-A.B(C)[D]*E-${suffix}`;
    const decoy = `so-test-needle-AXBCE-${suffix}`;
    const { mask } = createSecretValueMasker({ TRICKY_SECRET: needle });
    expect(mask(`v=${needle};`)).toBe('v=[REDACTED];');
    expect(mask(`v=${decoy};`)).toBe(`v=${decoy};`);
  });

  it('collapses a needle that is a PREFIX of another into exactly ONE marker', () => {
    // Bug caught: re-deriving splice logic here instead of delegating to
    // redactSpans. A naive per-pattern replace chain redacts the short needle
    // first and leaks the suffix residue (`[REDACTED]-tail-…`); a missing merge
    // emits two nested markers. Both survive a `toContain('[REDACTED]')` check.
    const short = newNeedle();
    const long = `${short}-tail`;
    const { mask, needleCount } = createSecretValueMasker({ A_TOKEN: short, B_TOKEN: long });
    expect(needleCount).toBe(2);
    const out = mask(`x ${long} y`);
    expect(out).toBe('x [REDACTED] y');
    expect(markerCount(out)).toBe(1);
  });

  it('DEDUPLICATES two keys that carry the identical value', () => {
    // Bug caught: one pattern per KEY instead of per distinct VALUE. Harmless
    // in output (redactSpans merges the duplicate spans) but it inflates the
    // needleCount a consumer logs and doubles the per-line regex work on a hot
    // path — the count is the only observable, so it is what gets asserted.
    const needle = newNeedle();
    const { needleCount } = createSecretValueMasker({ A_TOKEN: needle, B_KEY: needle });
    expect(needleCount).toBe(1);
  });

  it('ignores a non-string value under a secret-bearing key instead of throwing', () => {
    // Bug caught: `RegExp.escape` throws a TypeError on a non-string, which
    // would crash the hot path that builds the masker. The signature accepts an
    // arbitrary object, so this input is reachable from any caller that is not
    // process.env.
    const build = () => createSecretValueMasker({ NUM_TOKEN: 12345678901234, NULL_KEY: null });
    expect(build).not.toThrow();
    expect(build().needleCount).toBe(0);
  });
});

describe('createSecretValueMasker — pass-through fidelity', () => {
  // Byte-fidelity fixture built by CONCATENATION from explicit code units —
  // never via JSON.stringify, whose output cannot carry a raw control byte, so
  // a pass-through assert against a stringify-produced fixture could not bite
  // (learnings-index: "byte-for-byte pass-through asserts cannot bite on a
  // JSON.stringify-produced fixture"). String.fromCharCode is used instead of
  // \u escapes, which can land as literal control bytes in the source file and
  // make it invisible to plain grep.
  const RAW_FIXTURE =
    'a' +
    String.fromCharCode(9, 0, 13, 10) + // TAB, NUL, CR, LF
    'b' +
    String.fromCharCode(160) + // NBSP
    'c' +
    String.fromCharCode(55357, 56832) + // astral surrogate pair
    'd';
  const EXPECTED_UNITS = [97, 9, 0, 13, 10, 98, 160, 99, 55357, 56832, 100];
  // NB: iterate by code UNIT (s.length), not via Array.from(s, …) — the string
  // iterator walks code POINTS and would collapse the surrogate pair.
  const codeUnits = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

  it('sanity: the byte-fidelity fixture carries the control units it claims', () => {
    // Bug caught: a fixture normalised by an editor would make both
    // pass-through assertions below vacuous.
    expect([...RAW_FIXTURE].length).toBe(10); // 10 code POINTS, 11 code units
    expect(codeUnits(RAW_FIXTURE)).toEqual(EXPECTED_UNITS);
  });

  it('returns text BYTE-IDENTICALLY when the env is empty', () => {
    // Bug caught: a zero-needle path that still rebuilds the string (trim,
    // re-encode, normalise). This is the COMMON case — most hosts carry no
    // qualifying secret at all — so a lossy pass-through would corrupt every
    // line the consumer prints while every positive test above stayed green.
    const { mask, needleCount } = createSecretValueMasker({});
    expect(needleCount).toBe(0);
    expect(mask(RAW_FIXTURE)).toBe(RAW_FIXTURE);
    expect(codeUnits(mask(RAW_FIXTURE))).toEqual(EXPECTED_UNITS);
  });

  it('returns text BYTE-IDENTICALLY when needles exist but none match', () => {
    // Bug caught: a DIFFERENT return path than the zero-needle guard above
    // (redactSpans' `spans.length === 0` branch). A regression that rebuilds
    // the output from slices with zero merged intervals shows up only here.
    const { mask, needleCount } = createSecretValueMasker({ SOME_TOKEN: newNeedle() });
    expect(needleCount).toBe(1);
    expect(mask(RAW_FIXTURE)).toBe(RAW_FIXTURE);
    expect(codeUnits(mask(RAW_FIXTURE))).toEqual(EXPECTED_UNITS);
  });

  it('passes a non-object env and a non-string text through without throwing', () => {
    // Bug caught: `Object.entries(undefined)` throws, killing a hot path on a
    // malformed argument. Masking is a defensive wrapper — it must never be the
    // thing that takes the process down.
    expect(createSecretValueMasker(undefined).needleCount).toBe(0);
    expect(createSecretValueMasker(null).mask(RAW_FIXTURE)).toBe(RAW_FIXTURE);
    const { mask } = createSecretValueMasker({ X_TOKEN: newNeedle() });
    expect(mask(undefined)).toBe(undefined);
  });
});
