/**
 * tests/scripts/lib/learnings/judgment.test.mjs
 *
 * Unit tests for scripts/lib/learnings/judgment.mjs — the relation-judgment
 * contract and its fail-closed enforcement (#1016).
 *
 * Fixtures are GOLDEN-RECORD derived: the field set, ordering, optional-field
 * presence and the odd float confidence are copied from the two live records in
 * .orchestrator/metrics/learnings.jsonl (2026-08-13 harvest) that form the
 * canonical FALSE POSITIVE this module is designed against — same file
 * (rule-loader.mjs), different frontmatter keys, identical `scope`, both without
 * `host_class`. The live file itself is deliberately NOT read: records expire,
 * which would drift the assertions with the wall clock.
 *
 * Every test names the concrete bug it catches. Assertions are on parsed units
 * (the verdict object, a spy call count, a file byte-hash) — never a file-wide
 * `toContain`, and never a bare "record count unchanged", which a merge that
 * replaces two records with one satisfies while destroying data.
 *
 * Three guards carry a FAKE REGRESSION: the guard is removed in a COPY of the
 * module, the same probe re-run against the copy, and the copy asserted to
 * misbehave. A green test alone never proves a refusal bites.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_JUDGE_TIMEOUT_MS,
  JUDGMENT_DECISIONS,
  applyVerdict,
  buildCorpusFingerprint,
  buildJudgmentInput,
  judgeCandidate,
  parseJudgment,
  voidVerdict,
} from '@lib/learnings/judgment.mjs';

const MODULE_PATH = new URL('../../../../scripts/lib/learnings/judgment.mjs', import.meta.url)
  .pathname;

// ---------------------------------------------------------------------------
// Golden-record fixtures — the canonical false-positive pair
// ---------------------------------------------------------------------------

/** Live record 5bd963d4… — "the `paths:` frontmatter key is INERT". */
const RECORD_A = Object.freeze({
  id: '5bd963d4-2f3b-423c-8c97-bc6753d37626',
  created_at: '2026-07-04T17:26:08.039Z',
  wave_id: 'W1',
  type: 'recurring-issue',
  subject: 'legacy paths: frontmatter key silently no-ops in rule-loader',
  insight:
    "rule-loader.mjs only parses the 'globs:' frontmatter key; a rule file using the legacy 'paths:' key parses as globs===null and is treated as always-on.",
  evidence: "Verified via loadApplicableRules({rulesDir, scopePaths:['docs/x.md']}).",
  confidence: 0.7499999999999999,
  schema_version: 1,
  source_session: 'main-2026-07-04-session-5',
  scope: 'local',
  occurrences: 1,
  _provenance: 'agent-proposed@W1',
  expires_at: '2026-08-18T17:26:08.039Z',
  host_class: null,
  anonymized: false,
});

/** Live record fe22ff1a… — "a frontmatter key is LIVE". Same file, other key. */
const RECORD_B = Object.freeze({
  id: 'fe22ff1a-3be5-48ab-b225-bf05f1dcbccb',
  created_at: '2026-07-29T09:12:44.101Z',
  wave_id: 'W2',
  type: 'anti-pattern',
  subject: 'Verify a frontmatter key has no runtime semantics before adding it',
  insight:
    'Before a coordinator prompt tells an agent to stamp a new metadata key onto existing files, grep the CONSUMING loader for that key. expires-at already carries runtime semantics.',
  evidence: 'rule-loader.mjs reads expires-at when deciding rule staleness.',
  confidence: 0.7499999999999999,
  schema_version: 1,
  source_session: 'main-2026-07-29-deep-1',
  scope: 'local',
  occurrences: 1,
  _provenance: 'agent-proposed@W2',
  expires_at: '2026-09-12T09:12:44.101Z',
  host_class: null,
  anonymized: false,
});

/** A third live-shaped record, so a batch can carry two distinct targets. */
const RECORD_C = Object.freeze({
  ...RECORD_B,
  id: 'c0ffee00-1111-4222-8333-444444444444',
  subject: 'rule-loader glob expansion is case-sensitive on Linux CI',
});

const INPUT = buildJudgmentInput({ candidate: RECORD_A, neighbours: [RECORD_B, RECORD_C] });

/** Identifier-level surface — file PLUS the key, per the module's surface rule. */
const SURFACE = 'rule-loader.mjs frontmatter key "expires-at"';
const RATIONALE = 'Both records judge the rule-loader.mjs frontmatter key "expires-at" semantics.';

/** A well-formed decision of any type, overridable field by field. */
function decision(overrides = {}) {
  return {
    decision: 'contradict',
    target_ids: [RECORD_B.id],
    surface: SURFACE,
    rationale: RATIONALE,
    confidence: 0.8,
    ...overrides,
  };
}

/** A well-formed envelope around the given decisions. */
function envelope(decisions, overrides = {}) {
  return { candidate_id: RECORD_A.id, decisions, ...overrides };
}

// ---------------------------------------------------------------------------
// A faithful effect double: handlers that actually touch a store on disk
// ---------------------------------------------------------------------------

let dir;
let storePath;
let archivePath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judgment-'));
  storePath = join(dir, 'learnings.jsonl');
  archivePath = join(dir, 'learnings.archive.jsonl');
  writeFileSync(
    storePath,
    [RECORD_A, RECORD_B, RECORD_C].map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  writeFileSync(archivePath, '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hashOf(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/**
 * Effect handlers that mirror what each decision really performs, so a byte-hash
 * assertion is load-bearing rather than decorative.
 *
 * `proposeContradiction` renders the AUQ AND writes the -0.2, compressing the
 * operator's approval step: the operator step is not what these tests guard —
 * the guard is that an unreadable judgment never reaches the renderer at all.
 */
function makeEffects() {
  const calls = { refine: 0, supersede: 0, merge: 0, proposeContradiction: 0 };
  const seen = [];
  const handlers = {
    refine: (d) => {
      calls.refine += 1;
      seen.push(d);
      appendFileSync(storePath, JSON.stringify({ _refined_from: d.target_ids }) + '\n');
    },
    supersede: (d) => {
      calls.supersede += 1;
      seen.push(d);
      appendFileSync(
        archivePath,
        JSON.stringify({ _archive_reason: 'superseded', _superseded_by: d.target_ids[0] }) + '\n',
      );
      const kept = readFileSync(storePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .filter((l) => !d.target_ids.includes(JSON.parse(l).id));
      writeFileSync(storePath, kept.join('\n') + '\n');
    },
    merge: (d) => {
      calls.merge += 1;
      seen.push(d);
      appendFileSync(
        archivePath,
        JSON.stringify({ _archive_reason: 'merged', _merged_into: d.target_ids[0] }) + '\n',
      );
    },
    proposeContradiction: (d) => {
      calls.proposeContradiction += 1;
      seen.push(d);
      appendFileSync(
        storePath,
        JSON.stringify({ _confidence_delta: -0.2, on: d.target_ids }) + '\n',
      );
    },
  };
  return { calls, seen, handlers };
}

// ---------------------------------------------------------------------------
// Fake-regression harness — load a SABOTAGED copy of the module
// ---------------------------------------------------------------------------

const sabotaged = [];

afterEach(() => {
  while (sabotaged.length > 0) rmSync(sabotaged.pop(), { force: true });
});

/**
 * Import a copy of judgment.mjs with the given guard(s) removed.
 * Throws when an anchor is missing — a sabotage that silently no-ops would make
 * the whole fake regression vacuous (it would "prove" a guard by proving nothing).
 */
async function loadSabotaged(replacements) {
  let src = readFileSync(MODULE_PATH, 'utf8');
  for (const [from, to] of replacements) {
    if (!src.includes(from)) throw new Error(`sabotage anchor not found: ${from}`);
    src = src.split(from).join(to);
  }
  const file = join(dir, `judgment-sabotaged-${sabotaged.length}.mjs`);
  writeFileSync(file, src);
  sabotaged.push(file);
  return import(pathToFileURL(file).href);
}

// ===========================================================================
// F1 — unparseable output
// ===========================================================================

describe('F1 unparseable', () => {
  // BUG: unreadable judge output falls back to a default decision — the exact
  // upstream defect #1016 exists to avoid.
  it('voids the batch on malformed JSON instead of defaulting', () => {
    const v = parseJudgment('{"candidate_id": "x", "decisions": [', INPUT);
    expect(v.ok).toBe(false);
    expect(v.failureMode).toBe('unparseable');
    expect(v.decisions).toEqual([]);
    expect(v.requeueCandidate).toBe(true);
  });

  // BUG: a bare array read as the decisions list — envelope-less leniency lets a
  // verdict with no candidate_id through, so it can be applied to any candidate.
  it.each([
    ['bare array', '[{"decision":"skip","target_ids":[]}]'],
    ['bare number', '42'],
    ['bare string', '"skip"'],
  ])('voids a %s envelope', (_label, raw) => {
    const v = parseJudgment(raw, INPUT);
    expect(v.ok).toBe(false);
    expect(v.failureMode).toBe('unparseable');
  });

  // BUG: a judge that throws is treated as a transport hiccup and retried into a
  // write, or worse, defaulted.
  it('maps a thrown judge to unparseable and never retries', async () => {
    let calls = 0;
    const v = await judgeCandidate(INPUT, {
      judge: () => {
        calls += 1;
        throw new Error('provider exploded');
      },
    });
    expect(calls).toBe(1);
    expect(v.ok).toBe(false);
    expect(v.failureMode).toBe('unparseable');
    expect(v.detail).toContain('provider exploded');
  });

  // BUG: no judge wired at all silently produces a decision.
  it('voids when no judge is injected', async () => {
    const v = await judgeCandidate(INPUT, {});
    expect(v.ok).toBe(false);
    expect(v.decisions).toEqual([]);
  });

  // FAKE REGRESSION — the priority probe. Replace fail-closed with a default
  // decision in a COPY and prove the intact module leaves BOTH the store bytes
  // and the AUQ renderer untouched where the sabotaged one does not.
  it('fake regression: a default-on-unparseable fallback would reach the AUQ and the store', async () => {
    const malformed = '{"candidate_id": "x", "decisions": [';

    // --- intact module ---
    const before = hashOf(storePath);
    const intact = makeEffects();
    const intactResult = await applyVerdict(parseJudgment(malformed, INPUT), intact.handlers);
    expect(intactResult.applied).toBe(false);
    expect(intact.calls.proposeContradiction).toBe(0);
    expect(hashOf(storePath)).toBe(before);

    // --- sabotaged copy: fail-closed replaced by a fabricated default ---
    const mod = await loadSabotaged([
      [
        "return voidVerdict('unparseable', `JSON.parse failed: ${err?.message ?? err}`, candidateId);",
        "return { ok: true, candidate_id: candidateId, decisions: [{ decision: 'contradict', target_ids: [[...validIds][0]], surface: 'fallback', rationale: 'fallback', confidence: 0.5 }], failureMode: null, detail: '', requeueCandidate: false, counters: _emptyCounters() };",
      ],
    ]);
    const broken = makeEffects();
    const brokenResult = await applyVerdict(mod.parseJudgment(malformed, INPUT), broken.handlers);

    expect(brokenResult.applied).toBe(true);
    expect(broken.calls.proposeContradiction).toBe(1);
    expect(hashOf(storePath)).not.toBe(before);
  });
});

// ===========================================================================
// F2 — partial output (the batch is atomic)
// ===========================================================================

describe('F2 partial', () => {
  // BUG: per-decision salvage — the valid sibling decision is applied while its
  // malformed neighbour is dropped, i.e. fail-open in a partial-success costume.
  it('voids the WHOLE batch, not just the malformed decision', async () => {
    const v = parseJudgment(
      envelope([decision({ decision: 'skip', target_ids: [] }), { decision: 'supersede' }]),
      INPUT,
    );
    expect(v.ok).toBe(false);
    expect(v.failureMode).toBe('partial');
    expect(v.decisions).toEqual([]);

    const before = hashOf(storePath);
    const fx = makeEffects();
    await applyVerdict(v, fx.handlers);
    expect(fx.calls).toEqual({ refine: 0, supersede: 0, merge: 0, proposeContradiction: 0 });
    expect(hashOf(storePath)).toBe(before);
  });

  // BUG: a verdict computed for a DIFFERENT candidate is applied to this one.
  it('voids on candidate_id mismatch', () => {
    const v = parseJudgment(envelope([decision()], { candidate_id: RECORD_C.id }), INPUT);
    expect(v.failureMode).toBe('partial');
    expect(v.detail).toContain('candidate_id mismatch');
  });

  // BUG: THE canonical false positive — a contradiction asserted at file level.
  // RECORD_A and RECORD_B both concern rule-loader.mjs but different keys, are
  // both scope=local and both host_class-less, so nothing mechanical separates
  // them. A missing surface must therefore never be tolerated.
  it('voids a relation decision with no surface (the rule-loader false positive)', () => {
    const v = parseJudgment(envelope([decision({ surface: undefined })]), INPUT);
    expect(v.failureMode).toBe('partial');
    expect(v.detail).toContain('surface');
  });

  it.each([[''], ['   ']])('voids a relation decision whose surface is %j', (surface) => {
    expect(parseJudgment(envelope([decision({ surface })]), INPUT).failureMode).toBe('partial');
  });

  // BUG: a rationale that names no surface is unevaluable — the operator sees
  // "these two conflict" with nothing to check it against.
  it('voids when the rationale does not name the surface', () => {
    const v = parseJudgment(
      envelope([decision({ rationale: 'Both records describe the same loader.' })]),
      INPUT,
    );
    expect(v.failureMode).toBe('partial');
    expect(v.detail).toContain('does not name the surface');
  });

  // Positive control for the surface rule: an identifier-level surface named in
  // the rationale is accepted. BUG this guards: a gate so tight nothing passes —
  // a producer that never produces leaves #1016's four consumers unreachable.
  it('accepts an identifier-level surface named in the rationale', () => {
    const v = parseJudgment(envelope([decision()]), INPUT);
    expect(v.ok).toBe(true);
    expect(v.decisions).toHaveLength(1);
    expect(v.decisions[0]).toMatchObject({
      decision: 'contradict',
      target_ids: [RECORD_B.id],
      surface: SURFACE,
      confidence: 0.8,
    });
  });

  // BUG: a verdict computed against a DIFFERENT presentation (stale retry,
  // reordered pool) is applied to the current one.
  it('voids when an echoed corpus_fingerprint disagrees with the input', () => {
    const v = parseJudgment(
      envelope([decision()], { corpus_fingerprint: { digest: 'deadbeefdeadbeef' } }),
      INPUT,
    );
    expect(v.failureMode).toBe('partial');
    expect(v.detail).toContain('corpus_fingerprint');
  });

  // BUG: `target_ids` empty on a relation decision — a supersede with no target
  // that a downstream handler reads as "archive everything related".
  it.each([
    ['refine', 'refine'],
    ['supersede', 'supersede'],
    ['merge', 'merge'],
    ['contradict', 'contradict'],
  ])('voids %s with empty target_ids', (_label, kind) => {
    const v = parseJudgment(envelope([decision({ decision: kind, target_ids: [] })]), INPUT);
    expect(v.failureMode).toBe('partial');
  });

  // BUG: a skip carrying targets — a decision that writes nothing smuggling a
  // target list a later refactor might act on.
  it.each([['skip'], ['abstain']])('voids %s carrying target_ids', (kind) => {
    const v = parseJudgment(
      envelope([{ decision: kind, target_ids: [RECORD_B.id], confidence: 0.5 }]),
      INPUT,
    );
    expect(v.failureMode).toBe('partial');
  });

  // BUG: an unbounded or absent confidence flows into a downstream threshold
  // comparison and silently passes it.
  it.each([
    ['absent', undefined],
    ['null', null],
    ['string', '0.8'],
    ['above 1', 1.5],
    ['negative', -0.1],
    ['NaN', Number.NaN],
  ])('voids a decision whose confidence is %s', (_label, confidence) => {
    expect(parseJudgment(envelope([decision({ confidence })]), INPUT).failureMode).toBe('partial');
  });

  // BUG: an input whose id gate cannot be checked is waved through, so every
  // target id becomes unverifiable.
  it.each([
    ['no input', undefined],
    ['no candidate', {}],
    ['no fingerprint', { candidate: RECORD_A }],
  ])('voids when the judgment input is unusable (%s)', (_label, badInput) => {
    const v = parseJudgment(envelope([decision()]), badInput);
    expect(v.ok).toBe(false);
    expect(v.failureMode).toBe('partial');
  });
});

// ===========================================================================
// F3 — phantom target id
// ===========================================================================

describe('F3 phantom_id', () => {
  // BUG: an id the judge invented (or one from a record never presented) is
  // accepted, and a supersede then archives a record nobody reviewed.
  it('voids on a target id that was never presented', () => {
    const v = parseJudgment(
      envelope([decision({ target_ids: ['99999999-0000-4000-8000-000000000000'] })]),
      INPUT,
    );
    expect(v.failureMode).toBe('phantom_id');
    expect(v.decisions).toEqual([]);
  });

  // FAKE REGRESSION — the "drop the bad id and keep the rest" temptation. A
  // supersede whose target list is silently truncated archives the WRONG record.
  it('fake regression: dropping the phantom id would hand the effect an unvetted target', async () => {
    const raw = envelope([
      decision({
        decision: 'supersede',
        target_ids: ['99999999-0000-4000-8000-000000000000', RECORD_B.id],
      }),
    ]);

    // --- intact module ---
    const before = hashOf(storePath);
    const intact = makeEffects();
    const intactResult = await applyVerdict(parseJudgment(raw, INPUT), intact.handlers);
    expect(intactResult.applied).toBe(false);
    expect(intact.calls.supersede).toBe(0);
    expect(hashOf(storePath)).toBe(before);
    expect(readFileSync(archivePath, 'utf8')).toBe('');

    // --- sabotaged copy: the phantom gate neutralised ---
    const mod = await loadSabotaged([['if (!validIds.has(tid)) {', 'if (false) {']]);
    const broken = makeEffects();
    const brokenResult = await applyVerdict(mod.parseJudgment(raw, INPUT), broken.handlers);

    expect(brokenResult.applied).toBe(true);
    expect(broken.calls.supersede).toBe(1);
    expect(broken.seen[0].target_ids).toContain('99999999-0000-4000-8000-000000000000');
    expect(readFileSync(archivePath, 'utf8')).not.toBe('');
  });
});

// ===========================================================================
// F4 — self-reference
// ===========================================================================

describe('F4 self_reference', () => {
  // BUG: the candidate lands in its own target list and a merge archives the
  // record into itself — data loss through a legal-looking path. Reported as
  // self_reference, NOT phantom_id: the two need different operator responses.
  it('reports self_reference (not phantom_id) when the candidate targets itself', () => {
    const v = parseJudgment(envelope([decision({ target_ids: [RECORD_A.id] })]), INPUT);
    expect(v.failureMode).toBe('self_reference');
  });

  // BUG: the pool builder hands the candidate back as its own neighbour, which
  // would put the candidate id into the fingerprint and legitimise self-archival.
  it('never lets the candidate become its own neighbour', () => {
    const input = buildJudgmentInput({
      candidate: RECORD_A,
      neighbours: [RECORD_A, RECORD_B, RECORD_A],
    });
    expect(input.neighbours.map((n) => n.id)).toEqual([RECORD_B.id]);
    expect(input.corpus_fingerprint.ids).not.toContain(RECORD_A.id);
  });

  // FAKE REGRESSION — the phantom gate is the OTHER arm of this protection, so
  // the probe neutralises it by making the candidate id legitimately valid (the
  // exact misuse the self-check defends: a fingerprint built over the whole
  // store instead of the presented pool). Disabling only one arm would leave
  // this test green on the other.
  it('fake regression: without the self-check a merge archives the record into itself', async () => {
    const wideInput = {
      ...INPUT,
      corpus_fingerprint: buildCorpusFingerprint([RECORD_A, RECORD_B, RECORD_C]),
    };
    const raw = envelope([decision({ decision: 'merge', target_ids: [RECORD_A.id] })]);

    // --- intact module: the self-check is the only thing left standing ---
    const intact = makeEffects();
    const intactResult = await applyVerdict(parseJudgment(raw, wideInput), intact.handlers);
    expect(parseJudgment(raw, wideInput).failureMode).toBe('self_reference');
    expect(intactResult.applied).toBe(false);
    expect(intact.calls.merge).toBe(0);
    expect(readFileSync(archivePath, 'utf8')).toBe('');

    // --- sabotaged copy: self-check removed, phantom gate already satisfied ---
    const mod = await loadSabotaged([['if (tid === candidateId) {', 'if (false) {']]);
    const broken = makeEffects();
    const brokenResult = await applyVerdict(mod.parseJudgment(raw, wideInput), broken.handlers);

    expect(brokenResult.applied).toBe(true);
    expect(broken.calls.merge).toBe(1);
    expect(readFileSync(archivePath, 'utf8')).toContain(`"_merged_into":"${RECORD_A.id}"`);
  });
});

// ===========================================================================
// F5 — empty response
// ===========================================================================

describe('F5 empty', () => {
  // BUG: absence of a verdict read as a verdict of no-relation. That inflates
  // the skip count with undecided cases and makes the telemetry a lie.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   \n  '],
  ])('reports empty (never skip) for %s', (_label, raw) => {
    const v = parseJudgment(raw, INPUT);
    expect(v.ok).toBe(false);
    expect(v.failureMode).toBe('empty');
    expect(v.counters.decisions.skip).toBe(0);
    expect(v.counters.decisions.abstain).toBe(1);
  });

  it('reports empty for a well-formed envelope carrying zero decisions', () => {
    const v = parseJudgment(envelope([]), INPUT);
    expect(v.failureMode).toBe('empty');
    expect(v.counters.decisions.skip).toBe(0);
  });

  // BUG: a decided `skip` and an undecided batch become indistinguishable —
  // the exact collapse that makes fail-open invisible in telemetry.
  it('keeps a real skip distinct from an empty response in the counters', () => {
    const skipped = parseJudgment(
      envelope([{ decision: 'skip', target_ids: [], confidence: 0.9 }]),
      INPUT,
    );
    expect(skipped.ok).toBe(true);
    expect(skipped.counters.decisions.skip).toBe(1);
    expect(skipped.counters.decisions.abstain).toBe(0);
    expect(skipped.counters.voided).toBe(0);
  });
});

// ===========================================================================
// F6 — timeout
// ===========================================================================

describe('F6 timeout', () => {
  // BUG: a stuck provider holds session close, or a partially-streamed array is
  // applied once the race resolves.
  it('resolves to a timeout void and leaves the candidate queued', async () => {
    const v = await judgeCandidate(INPUT, {
      judge: () => new Promise(() => {}),
      timeoutMs: 20,
    });
    expect(v.ok).toBe(false);
    expect(v.failureMode).toBe('timeout');
    expect(v.requeueCandidate).toBe(true);
    expect(v.decisions).toEqual([]);
  });

  // BUG: a judge that answers late still wins the race and its output is applied
  // after the batch was already declared timed out.
  it('ignores a judge that resolves after the deadline', async () => {
    const fx = makeEffects();
    const before = hashOf(storePath);
    const v = await judgeCandidate(INPUT, {
      judge: () => new Promise((resolve) => setTimeout(() => resolve(envelope([decision()])), 80)),
      timeoutMs: 15,
    });
    await applyVerdict(v, fx.handlers);
    expect(v.failureMode).toBe('timeout');
    expect(fx.calls.proposeContradiction).toBe(0);
    expect(hashOf(storePath)).toBe(before);
  });

  it('exposes a finite default budget so a missing timeoutMs cannot mean "forever"', () => {
    expect(Number.isFinite(DEFAULT_JUDGE_TIMEOUT_MS)).toBe(true);
    expect(DEFAULT_JUDGE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// ===========================================================================
// F7 — enum violation
// ===========================================================================

describe('F7 enum_violation', () => {
  // BUG: casing drift or a near-miss coerced to the nearest member — coercion is
  // how `abstain` becomes a write. `store` in particular must never resolve:
  // the persist decision has its own owner and its own operator AUQ.
  it.each([['Skip'], ['SKIP'], ['store'], ['update'], ['contradicted'], ['merge ']])(
    'voids on the non-member %j without coercing it',
    (member) => {
      const v = parseJudgment(envelope([decision({ decision: member })]), INPUT);
      expect(v.failureMode).toBe('enum_violation');
      expect(v.decisions).toEqual([]);
    },
  );

  it.each([[42], [null], [{}], [['skip']]])('voids on a non-string decision %j', (member) => {
    const v = parseJudgment(envelope([decision({ decision: member })]), INPUT);
    expect(v.ok).toBe(false);
    expect(JUDGMENT_DECISIONS).not.toContain(member);
  });

  // BUG: an ABSENT decision field reported as an enum violation would send the
  // operator hunting a vocabulary problem that is really a truncated response.
  it('reports an absent decision field as partial, not enum_violation', () => {
    const v = parseJudgment(envelope([{ target_ids: [], confidence: 0.5 }]), INPUT);
    expect(v.failureMode).toBe('partial');
  });
});

// ===========================================================================
// F8 — duplicate target
// ===========================================================================

describe('F8 duplicate_target', () => {
  // BUG: applying in array order lets the second write operate on an
  // already-archived record — a dangling tombstone pointer one level down.
  it('voids when two decisions in one batch name the same target', () => {
    const v = parseJudgment(
      envelope([
        decision({ decision: 'refine' }),
        decision({ decision: 'supersede', target_ids: [RECORD_B.id] }),
      ]),
      INPUT,
    );
    expect(v.failureMode).toBe('duplicate_target');
  });

  it('voids when one decision repeats a target within its own list', () => {
    const v = parseJudgment(
      envelope([decision({ decision: 'merge', target_ids: [RECORD_B.id, RECORD_B.id] })]),
      INPUT,
    );
    expect(v.failureMode).toBe('duplicate_target');
  });

  // Positive control: distinct targets across a batch are legal, so the guard is
  // not a blanket ban on many-to-many.
  it('accepts a batch whose decisions name distinct targets', () => {
    const v = parseJudgment(
      envelope([
        decision({ decision: 'refine', target_ids: [RECORD_B.id] }),
        decision({ decision: 'merge', target_ids: [RECORD_C.id] }),
      ]),
      INPUT,
    );
    expect(v.ok).toBe(true);
    expect(v.decisions.map((d) => d.target_ids[0])).toEqual([RECORD_B.id, RECORD_C.id]);
  });
});

// ===========================================================================
// applyVerdict — the choke point, and the AUQ-is-a-write clause
// ===========================================================================

describe('applyVerdict', () => {
  // BUG: a failure mode that still reaches the AskUserQuestion renderer. The AUQ
  // IS the write authorization — an operator approving a garbled verdict has
  // failed open through the human.
  it.each([
    ['unparseable'],
    ['partial'],
    ['phantom_id'],
    ['self_reference'],
    ['empty'],
    ['timeout'],
    ['enum_violation'],
    ['duplicate_target'],
  ])('refuses every effect — including the AUQ — for a %s void', async (mode) => {
    const before = hashOf(storePath);
    const fx = makeEffects();
    const result = await applyVerdict(voidVerdict(mode, 'probe', RECORD_A.id), fx.handlers);
    expect(result.applied).toBe(false);
    expect(result.invoked).toEqual([]);
    expect(fx.calls).toEqual({ refine: 0, supersede: 0, merge: 0, proposeContradiction: 0 });
    expect(hashOf(storePath)).toBe(before);
    expect(readFileSync(archivePath, 'utf8')).toBe('');
  });

  // FAKE REGRESSION — the ok-gate has a redundant sibling (the
  // zero-decisions refusal), so this probe disables BOTH arms in the same run.
  // Disabling one alone would leave the test green on the other and prove nothing.
  it('fake regression: with both refusal arms removed, a not-ok verdict reaches the AUQ', async () => {
    // A hand-built hostile verdict: ok:false yet carrying a payload. Any caller
    // (or refactor) that constructs a verdict by hand can produce this shape.
    const hostile = {
      ok: false,
      candidate_id: RECORD_A.id,
      decisions: [decision()],
      failureMode: 'timeout',
      detail: '',
      requeueCandidate: true,
      counters: {},
    };

    // --- intact module ---
    const before = hashOf(storePath);
    const intact = makeEffects();
    const intactResult = await applyVerdict(hostile, intact.handlers);
    expect(intactResult.applied).toBe(false);
    expect(intact.calls.proposeContradiction).toBe(0);
    expect(hashOf(storePath)).toBe(before);

    // --- sabotaged copy: BOTH arms removed ---
    const mod = await loadSabotaged([
      ['verdict.ok !== true || ', ''],
      ["if (verdict.decisions.length === 0) return refuse('verdict-has-no-decisions');", ''],
    ]);
    const broken = makeEffects();
    const brokenResult = await mod.applyVerdict(hostile, broken.handlers);

    expect(brokenResult.applied).toBe(true);
    expect(broken.calls.proposeContradiction).toBe(1);
    expect(hashOf(storePath)).not.toBe(before);
  });

  // BUG: the decisions that happen to come first are applied, and only then does
  // the missing handler surface — a half-applied atomic batch.
  it('refuses the whole batch before invoking anything when a handler is unwired', async () => {
    const v = parseJudgment(
      envelope([
        decision({ decision: 'refine', target_ids: [RECORD_C.id] }),
        decision({ decision: 'contradict', target_ids: [RECORD_B.id] }),
      ]),
      INPUT,
    );
    expect(v.ok).toBe(true);

    const before = hashOf(storePath);
    const fx = makeEffects();
    delete fx.handlers.proposeContradiction;
    const result = await applyVerdict(v, fx.handlers);

    expect(result.applied).toBe(false);
    expect(result.refused).toContain('proposeContradiction');
    expect(fx.calls.refine).toBe(0);
    expect(hashOf(storePath)).toBe(before);
  });

  // BUG: skip/abstain wired to an effect handler — a decision that means "do
  // nothing" performing something.
  it.each([['skip'], ['abstain']])('invokes no handler for %s', async (kind) => {
    const v = parseJudgment(envelope([{ decision: kind, target_ids: [], confidence: 0.6 }]), INPUT);
    const before = hashOf(storePath);
    const fx = makeEffects();
    const result = await applyVerdict(v, fx.handlers);
    expect(result.applied).toBe(true);
    expect(result.invoked).toEqual([]);
    expect(hashOf(storePath)).toBe(before);
  });

  // Positive control. BUG: a gate so tight that a well-formed contradiction
  // never reaches the operator leaves #1016's four consumers producer-less —
  // which is the status quo this module exists to end.
  it('delivers a well-formed contradiction to the AUQ renderer', async () => {
    const v = parseJudgment(envelope([decision()]), INPUT);
    const fx = makeEffects();
    const result = await applyVerdict(v, fx.handlers);
    expect(result.applied).toBe(true);
    expect(result.invoked).toEqual(['proposeContradiction']);
    expect(fx.calls.proposeContradiction).toBe(1);
    expect(fx.seen[0].target_ids).toEqual([RECORD_B.id]);
  });

  // BUG: a throwing handler is swallowed and the batch reports success.
  it('reports a throwing effect instead of claiming the batch applied', async () => {
    const v = parseJudgment(envelope([decision()]), INPUT);
    const result = await applyVerdict(v, {
      proposeContradiction: () => {
        throw new Error('AUQ unavailable');
      },
    });
    expect(result.applied).toBe(false);
    expect(result.refused).toContain('AUQ unavailable');
  });
});

// ===========================================================================
// buildJudgmentInput — what the judge is allowed to see
// ===========================================================================

describe('buildJudgmentInput', () => {
  // BUG: an archived record presented as a neighbour invites a supersede that
  // archives an already-archived record, recreating the dangling-pointer defect.
  it('excludes archived records from the neighbour pool and the fingerprint', () => {
    const archived = {
      ...RECORD_C,
      _archived_at: '2026-08-01T00:00:00Z',
      _archive_reason: 'expired',
    };
    const input = buildJudgmentInput({ candidate: RECORD_A, neighbours: [archived, RECORD_B] });
    expect(input.neighbours.map((n) => n.id)).toEqual([RECORD_B.id]);
    expect(input.corpus_fingerprint.ids).toEqual([RECORD_B.id]);
  });

  // BUG: an unbounded neighbour set silently blows the judge prompt budget, and
  // the tail of the pool is dropped by the provider rather than by policy.
  it('caps the neighbour pool at maxNeighbours', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...RECORD_B,
      id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    const input = buildJudgmentInput({ candidate: RECORD_A, neighbours: many, maxNeighbours: 3 });
    expect(input.neighbours).toHaveLength(3);
    expect(input.corpus_fingerprint.count).toBe(3);
  });

  // BUG: a candidate with no id is judged anyway, making every target id
  // uncheckable against a self-reference.
  it.each([
    ['no id', {}],
    ['empty id', { id: '' }],
    ['not a record', null],
  ])('returns null for a candidate with %s', (_label, candidate) => {
    expect(buildJudgmentInput({ candidate, neighbours: [RECORD_B] })).toBeNull();
  });

  // BUG: a reordered pool produces a different digest, so a legitimate retry
  // looks like a stale verdict (and vice versa).
  it('derives a digest from the id SET, independent of presentation order', () => {
    const a = buildCorpusFingerprint([RECORD_B, RECORD_C]);
    const b = buildCorpusFingerprint([RECORD_C, RECORD_B]);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(buildCorpusFingerprint([RECORD_B]).digest);
  });
});
