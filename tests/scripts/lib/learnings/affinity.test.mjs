/**
 * tests/scripts/lib/learnings/affinity.test.mjs
 *
 * Contract tests for scripts/lib/learnings/affinity.mjs.
 *
 * The module is a FROZEN SURFACE consumed by two independent workstreams
 * (#1014 scope→learning relevance, #1016 learning→learning similarity). Each
 * describe block below pins exactly one contract point and names the concrete
 * bug it catches — no test here exists to raise coverage.
 *
 * Expected values are hand-computed literals for hand-chosen inputs. None of
 * them re-derives the production formula (a mirrored formula reproduces the
 * production bug and asserts nothing).
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AFFINITY_DEFAULTS,
  affinity,
  pathAffinity,
  toAffinityContext,
  tokenAffinity,
  tokenize,
} from '@lib/learnings/affinity.mjs';

const MODULE_PATH = resolve(process.cwd(), 'scripts/lib/learnings/affinity.mjs');

const EMPTY_RESULT = {
  score: 0,
  pathScore: 0,
  tokenScore: 0,
  typeMatch: false,
  sharedPaths: [],
  sharedTokens: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Contract 1 — range, type, and result shape
// ---------------------------------------------------------------------------

describe('contract 1: every returned number is finite and in [0,1]', () => {
  // Bug caught: zero-length inputs divide by zero (0/0 → NaN, or n/0 → Infinity)
  // and leak a non-comparable score into a consumer's sort, silently corrupting
  // the ranking instead of failing loudly.
  it('returns exactly 0 — never NaN — when both sides are empty', () => {
    const res = affinity({ file_paths: [], text: '' }, { file_paths: [], text: '' });

    expect(res).toEqual(EMPTY_RESULT);
    expect(Number.isNaN(res.score)).toBe(false);
  });

  it('returns exactly 0 for each axis when only one side carries data', () => {
    const res = affinity({ file_paths: ['scripts/lib/x.mjs'], text: 'alpha beta' }, {});

    expect(res.pathScore).toBe(0);
    expect(res.tokenScore).toBe(0);
    expect(res.score).toBe(0);
  });

  it('clamps to 1 for a fully identical pair', () => {
    const rec = { file_paths: ['scripts/lib/x.mjs'], text: 'alpha beta gamma' };
    const res = affinity(rec, rec);

    expect(res.pathScore).toBe(1);
    expect(res.tokenScore).toBe(1);
    expect(res.score).toBe(1);
  });

  it('stays in [0,1] when a caller passes weights that do not sum to 1', () => {
    const a = { file_paths: ['scripts/lib/x.mjs'], text: 'alpha' };
    const b = { file_paths: ['scripts/lib/x.mjs'], text: 'alpha' };

    expect(affinity(a, b, { pathWeight: 10, tokenWeight: 10 }).score).toBe(1);
    expect(affinity(a, b, { pathWeight: 0, tokenWeight: 0 }).score).toBe(0);
    expect(affinity(a, b, { pathWeight: Number.NaN, tokenWeight: Infinity }).score).toBe(1);
  });

  // Bug caught: an unbounded sharedTokens list is a diagnostic that becomes a
  // payload — a 400-token overlap would land verbatim in a dispatch prompt.
  it('caps sharedTokens at 32, sorted', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${String(i).padStart(2, '0')}`);
    const rec = { text: words.join(' ') };
    const res = affinity(rec, rec);

    expect(res.sharedTokens).toHaveLength(32);
    expect(res.sharedTokens[0]).toBe('word00');
    expect(res.sharedTokens[31]).toBe('word31');
  });
});

// ---------------------------------------------------------------------------
// Contract 2 — symmetry
// ---------------------------------------------------------------------------

describe('contract 2: affinity(a,b).score === affinity(b,a).score', () => {
  // Bug caught: the naive aggregate "mean over a of its best match in b" is
  // one-directional. For a=1 path fully contained in b's 3 paths it reports
  // 1.0 one way and 0.333 the other. #1016 halves an O(n²) duplicate scan on
  // symmetry, so a one-directional score silently drops half its candidates.
  const a = { file_paths: ['scripts/lib/learnings/io.mjs'], text: 'alpha beta' };
  const b = {
    file_paths: ['scripts/lib/learnings/io.mjs', 'hooks/x.mjs', 'docs/y.md'],
    text: 'alpha beta gamma delta',
  };

  it('is symmetric for path lists of different sizes', () => {
    // (1/1 + 1/3) / 2 = 0.6666… — NOT the 1.0 a one-directional mean reports.
    expect(pathAffinity(a, b)).toBeCloseTo(0.6667, 4);
    expect(pathAffinity(a, b)).toBe(pathAffinity(b, a));
  });

  it('is symmetric for token sets of different sizes', () => {
    // |{alpha,beta} ∩ {alpha,beta,gamma,delta}| / |union| = 2/4 = 0.5
    expect(tokenAffinity(a, b)).toBe(0.5);
    expect(tokenAffinity(a, b)).toBe(tokenAffinity(b, a));
  });

  it('is symmetric for the composite result', () => {
    expect(affinity(a, b).score).toBe(affinity(b, a).score);
    expect(affinity(a, b)).toEqual(affinity(b, a));
  });
});

// ---------------------------------------------------------------------------
// Contract 3 — determinism / purity
// ---------------------------------------------------------------------------

describe('contract 3: deterministic and pure — no clock, fs, randomness, network', () => {
  it('returns deep-equal results for repeated calls on equal inputs', () => {
    const a = { file_paths: ['scripts/lib/a.mjs'], text: 'shared token here' };
    const b = { file_paths: ['scripts/lib/b.mjs'], text: 'shared token there' };

    expect(affinity(a, b)).toEqual(affinity({ ...a }, { ...b }));
  });

  // Bug caught: a later edit adds `import { readFile } from 'node:fs'` or
  // reaches back to `../learnings.mjs`, turning a pure primitive into an I/O
  // module and re-introducing the cycle schema.mjs was extracted to break.
  it('imports exactly one module: ./schema.mjs', () => {
    const src = readFileSync(MODULE_PATH, 'utf8');
    const specifiers = [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);

    expect(specifiers).toEqual(['./schema.mjs']);
  });

  // Bug caught: someone adds a recency/decay axis here (the surface.mjs
  // `effectiveScore(entry, nowMs, decay)` shape) and the primitive stops being
  // referentially transparent — two identical inputs then score differently.
  it('contains no clock or randomness call', () => {
    const src = readFileSync(MODULE_PATH, 'utf8');

    expect(src).not.toMatch(/Date\.now\(/);
    expect(src).not.toMatch(/new Date\(/);
    expect(src).not.toMatch(/Math\.random\(/);
    expect(src).not.toMatch(/randomUUID\(/);
  });
});

// ---------------------------------------------------------------------------
// Contract 4 — never throws
// ---------------------------------------------------------------------------

describe('contract 4: never throws — hostile input yields the all-zero result', () => {
  // Bug caught: a null/primitive record from a malformed JSONL line aborts the
  // whole wave dispatch. surfaceTopN returns [] on an unreadable file; this
  // primitive follows that read-path convention, NOT validateLearning's throw.
  const hostile = [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'scripts/lib/x.mjs'],
    ['boolean', true],
    ['empty array', []],
    ['populated array', ['scripts/lib/x.mjs']],
    ['empty object', {}],
    ['null-prototype object', Object.create(null)],
  ];

  it.each(hostile)('handles %s on both sides', (_label, value) => {
    expect(affinity(value, value)).toEqual(EMPTY_RESULT);
    expect(affinity(value, { file_paths: ['scripts/lib/x.mjs'] })).toEqual(EMPTY_RESULT);
    expect(affinity({ file_paths: ['scripts/lib/x.mjs'] }, value)).toEqual(EMPTY_RESULT);
  });

  it('handles a record whose field access throws', () => {
    const booby = {
      get file_paths() {
        throw new Error('boom');
      },
    };

    expect(() => affinity(booby, booby)).not.toThrow();
    expect(affinity(booby, { file_paths: ['scripts/lib/x.mjs'] })).toEqual(EMPTY_RESULT);
    expect(() => pathAffinity(booby, booby)).not.toThrow();
    expect(() => tokenAffinity(booby, booby)).not.toThrow();
    expect(toAffinityContext(booby)).toEqual({ filePaths: [], tokens: [], type: null });
  });

  it('returns a fresh result object each call (no shared frozen singleton)', () => {
    const first = affinity(null, null);
    const second = affinity(null, null);

    expect(first).not.toBe(second);
    expect(first.sharedPaths).not.toBe(second.sharedPaths);
  });
});

// ---------------------------------------------------------------------------
// Contract 5 — segment-aware path matching
// ---------------------------------------------------------------------------

describe('contract 5: path matching is segment-aware, not string-equal', () => {
  const p = (...paths) => ({ file_paths: paths });

  // Bug caught: plain string equality scores a file against its own declared
  // directory scope at 0 — the single most common shape #1014 passes in.
  it('scores a file inside a declared directory scope above zero', () => {
    expect(pathAffinity(p('scripts/lib/learnings/io.mjs'), p('scripts/lib/learnings/'))).toBe(0.75);
  });

  it('scores an exact match at 1 and orders exact > prefix > ancestor > unrelated', () => {
    const exact = pathAffinity(p('scripts/lib/learnings/io.mjs'), p('scripts/lib/learnings/io.mjs'));
    const prefix = pathAffinity(p('scripts/lib/learnings/io.mjs'), p('scripts/lib'));
    const ancestor = pathAffinity(p('scripts/lib/learnings/io.mjs'), p('scripts/lib/config/x.mjs'));
    const unrelated = pathAffinity(p('scripts/lib/learnings/io.mjs'), p('hooks/x.mjs'));

    expect(exact).toBe(1);
    expect(prefix).toBe(0.75);
    expect(ancestor).toBe(0.25);
    expect(unrelated).toBe(0);
  });

  // Bug caught: `b.startsWith(a)` treats a truncated segment as a directory
  // prefix — 'scripts/lib/learn' would score 0.75 against the learnings dir
  // and pull unrelated learnings into every dispatch.
  it('does not treat a truncated segment as a directory prefix', () => {
    expect(pathAffinity(p('scripts/lib/learn'), p('scripts/lib/learnings/io.mjs'))).toBe(0.25);
  });

  it('strips a leading ./ and a trailing / before comparing', () => {
    expect(pathAffinity(p('./scripts/lib/x.mjs'), p('scripts/lib/x.mjs'))).toBe(1);
    expect(pathAffinity(p('scripts/lib/'), p('scripts/lib'))).toBe(1);
  });

  // Bug caught: case-insensitive comparison passes on macOS and mis-scores on
  // the Linux CI runner, which is the authority.
  it('is case-sensitive', () => {
    expect(pathAffinity(p('Scripts/Lib/X.mjs'), p('scripts/lib/x.mjs'))).toBe(0);
  });

  // Bug caught: expanding globs here would make the primitive impure w.r.t. the
  // filesystem. Globs are compared literally; the caller pre-expands.
  it('compares glob metacharacters literally instead of expanding them', () => {
    expect(pathAffinity(p('scripts/*.mjs'), p('scripts/*.mjs'))).toBe(1);
    expect(pathAffinity(p('scripts/*.mjs'), p('scripts/foo.mjs'))).toBe(0.25);
  });

  it('reports only exact overlaps in sharedPaths, sorted and deduped', () => {
    const res = affinity(
      p('scripts/lib/b.mjs', './scripts/lib/a.mjs', 'scripts/lib/a.mjs'),
      p('scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/lib/learnings/')
    );

    expect(res.sharedPaths).toEqual(['scripts/lib/a.mjs', 'scripts/lib/b.mjs']);
  });
});

// ---------------------------------------------------------------------------
// Contract 6 — dialect tolerance without stderr spam
// ---------------------------------------------------------------------------

describe('contract 6: legacy `files` reads as `file_paths`, silently', () => {
  // Bug caught: reading only `file_paths` scores every legacy-dialect record
  // at 0 — they vanish from every consumer's ranking without any error.
  it('scores a legacy `files` record identically to its canonical twin', () => {
    const legacy = { files: ['scripts/lib/learnings/io.mjs'], type: 'anti-pattern' };
    const canonical = { file_paths: ['scripts/lib/learnings/io.mjs'], type: 'anti-pattern' };
    const probe = { file_paths: ['scripts/lib/learnings/io.mjs'], type: 'anti-pattern' };

    expect(affinity(legacy, probe)).toEqual(affinity(canonical, probe));
    expect(affinity(legacy, probe).sharedPaths).toEqual(['scripts/lib/learnings/io.mjs']);
  });

  // Bug caught: importing `normalizeLearning` instead of `normalizeDialects`.
  // normalizeLearning WARNs on a missing schema_version and on missing legacy
  // required fields, so an N×M pass over the corpus floods stderr on every
  // single agent dispatch. Unique ids defeat its per-id warn dedupe, so this
  // goes red on the swap rather than passing on a pre-warmed cache.
  it('emits nothing on stderr for records missing schema_version', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    affinity(
      { id: 'affinity-warn-probe-a', files: ['scripts/lib/a.mjs'], subject: 'alpha subject' },
      { id: 'affinity-warn-probe-b', files: ['scripts/lib/b.mjs'], subject: 'beta subject' }
    );

    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Contract 7 — the field allowlist
// ---------------------------------------------------------------------------

describe('contract 7: reads only the relatedness fields', () => {
  const base = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    type: 'anti-pattern',
    subject: 'pipeline regression',
    insight: 'shard timeout hides the failure',
    evidence: 'observed twice',
    file_paths: ['scripts/lib/a.mjs'],
    confidence: 0.9,
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-12-01T00:00:00.000Z',
    updated_at: '2026-02-01T00:00:00.000Z',
    scope: 'local',
    host_class: 'darwin',
    anonymized: false,
    source_session: 'main-2026-01-01-session-1',
    schema_version: 1,
  };

  // Bug caught: folding confidence or recency into the score turns the
  // primitive into a ranking function — the exact boundary violation that
  // would make #1014 and #1016 need divergent copies again.
  it('ignores ranking, policy, and privacy fields entirely', () => {
    const twin = {
      ...base,
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      confidence: 0.1,
      created_at: '2020-01-01T00:00:00.000Z',
      expires_at: '2020-12-01T00:00:00.000Z',
      updated_at: '2020-02-01T00:00:00.000Z',
      last_reinforced: '2020-03-01T00:00:00.000Z',
      scope: 'public',
      host_class: 'linux',
      anonymized: true,
      source_session: 'other-2020-01-01-session-9',
    };
    const probe = { file_paths: ['scripts/lib/a.mjs'], text: 'pipeline regression' };

    expect(affinity(twin, probe)).toEqual(affinity(base, probe));
  });

  // Bug caught: `evidence` may legally be an array (schema.mjs deliberately
  // does not coerce it). A string-only tokenizer drops those tokens silently.
  it('tokenizes an array-valued evidence field', () => {
    const arrayEvidence = { evidence: ['pipeline', 'regression'] };
    const stringText = { text: 'pipeline regression' };

    expect(tokenAffinity(arrayEvidence, stringText)).toBe(1);
  });

  it('reports typeMatch only when both types are present and equal', () => {
    expect(affinity({ type: 'anti-pattern' }, { type: 'anti-pattern' }).typeMatch).toBe(true);
    expect(affinity({ type: 'anti-pattern' }, { type: 'proven-pattern' }).typeMatch).toBe(false);
    expect(affinity({ type: '' }, { type: '' }).typeMatch).toBe(false);
    expect(affinity({}, {}).typeMatch).toBe(false);
  });

  // Bug caught: typeMatch silently boosting the score would make the signal
  // un-tunable by the consumer that owns the ranking decision.
  it('does not fold typeMatch into the score', () => {
    const withType = affinity(
      { type: 'anti-pattern', text: 'alpha beta' },
      { type: 'anti-pattern', text: 'alpha gamma' }
    );
    const withoutType = affinity({ text: 'alpha beta' }, { text: 'alpha gamma' });

    expect(withType.typeMatch).toBe(true);
    expect(withoutType.typeMatch).toBe(false);
    expect(withType.score).toBe(withoutType.score);
  });

  it('normalizes a raw record and a scope descriptor to the same shape', () => {
    expect(toAffinityContext({ files: ['./scripts/lib/a.mjs/'], type: ' anti-pattern ' })).toEqual({
      filePaths: ['scripts/lib/a.mjs'],
      tokens: [],
      type: 'anti-pattern',
    });
    expect(toAffinityContext({ file_paths: ['scripts/lib/a.mjs'], text: 'alpha be' })).toEqual({
      filePaths: ['scripts/lib/a.mjs'],
      tokens: ['alpha'],
      type: null,
    });
  });

  it('tokenizes to lowercase alphanumeric runs at or above minTokenLength', () => {
    expect(AFFINITY_DEFAULTS.minTokenLength).toBe(3);
    expect(tokenize('Scripts/lib—Learnings_io.mjs v2 v2')).toEqual([
      'scripts',
      'lib',
      'learnings',
      'mjs',
    ]);
    expect(tokenize('a bb ccc', { minTokenLength: 1 })).toEqual(['a', 'bb', 'ccc']);
    expect(tokenize(42)).toEqual([]);
  });
});
