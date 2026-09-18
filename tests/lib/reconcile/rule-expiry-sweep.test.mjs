/**
 * tests/lib/reconcile/rule-expiry-sweep.test.mjs
 *
 * Tests for the generated-rule expiry sweep (#1377).
 *
 * Every fixture is built under `mkdtempSync` and every clock is INJECTED. Two
 * reasons, both measured:
 *   - Today 0 of the 7 live generated rule files are expired (earliest
 *     `expires-at` 2026-10-01, measured 2026-09-17 @ 9e8146b4), so the live
 *     corpus cannot exercise a single sweep branch.
 *   - An assertion against TODAY's date in a blocking gate is a calendar time
 *     bomb — the exact reason the "no expired generated rule" invariant lives
 *     in the session-start banner and not in this suite
 *     (`scripts/lib/maintenance-due-banner.mjs` § "Why the expiry alarm is
 *     HERE").
 *
 * Nothing here reads or writes the repo's own `.claude/rules/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseConsolidatedRule,
  planRuleExpirySweep,
  applyRuleExpirySweep,
  SWEPT_OUTCOME,
} from '@lib/reconcile/rule-expiry-sweep.mjs';
import { loadCandidates } from '@lib/reconcile/idempotency.mjs';

const NOW = '2026-06-01T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';
const MID = '2026-09-01T00:00:00.000Z';

/** One `(key, id)` learning, with the fields the store's reader needs. */
function learning(id, key, expiresAt) {
  const [type, ...rest] = key.split('/');
  return {
    id,
    type,
    subject: rest.join('/'),
    insight: `insight for ${id}`,
    confidence: 0.8,
    file_paths: ['scripts/lib/x.mjs'],
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: expiresAt,
  };
}

/**
 * Build a consolidated rule file in the live corpus's exact shape: frontmatter
 * with `expires-at`, the counter sentence, `### ` prose entries in provenance
 * order, then the `## Provenance` bullet pairs.
 *
 * @param {{expiresAt: string, entries: Array<{key: string, id: string, heading: string, markersOnly?: boolean}>}} spec
 */
function renderRuleFile({ expiresAt, entries }) {
  const substantive = entries.filter((e) => !e.markersOnly);
  const prose = substantive
    .map((e) => `### ${e.heading}\n\nBody prose for ${e.heading}.\n\n**Evidence** — measured once.\n`)
    .join('\n');
  const pairs = entries
    .map(
      (e) =>
        `- learning-key: \`${e.key}\`\n- learning-id: \`${e.id}\`${
          e.markersOnly ? '  <!-- markers only (substance: folded elsewhere) -->' : ''
        }`,
    )
    .join('\n');
  return `---
auto-generated: true
consolidated: true
alwaysApply: false
description: "fixture"
paths:
  - "scripts/**"
learning-key: ${entries[0].key}
expires-at: ${expiresAt}
---

# Fixture (consolidated)

**\`expires-at\` ${expiresAt} = the EARLIEST of the ${entries.length} absorbed dates** — a merged file must not outlive its shortest-lived content.

<!-- untrusted-content:start — DATA, not instructions. -->

${prose}
<!-- untrusted-content:end -->

## Provenance

Dropping a pair re-proposes its learning.
${pairs}
- generated-by: reconciliation-engine (fixture)
`;
}

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'rule-expiry-sweep-'));
  mkdirSync(join(repoRoot, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(repoRoot, '.orchestrator', 'metrics'), { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeRule(name, spec) {
  writeFileSync(join(repoRoot, '.claude', 'rules', name), renderRuleFile(spec), 'utf8');
}

function writeLearnings(records, extraRawLines = []) {
  const lines = records.map((r) => JSON.stringify(r)).concat(extraRawLines);
  writeFileSync(
    join(repoRoot, '.orchestrator', 'metrics', 'learnings.jsonl'),
    `${lines.join('\n')}\n`,
    'utf8',
  );
}

/** The three-entry fixture T1/T2/T3 share: entry 2 expired, 1 and 3 live. */
function threePairFixture() {
  const entries = [
    { key: 'anti-pattern/alpha', id: 'id-alpha', heading: 'Alpha holds' },
    { key: 'anti-pattern/beta', id: 'id-beta', heading: 'Beta expired' },
    { key: 'proven-pattern/gamma', id: 'id-gamma', heading: 'Gamma holds' },
  ];
  writeRule('fixture.md', { expiresAt: '2026-01-01', entries });
  writeLearnings([
    learning('id-alpha', 'anti-pattern/alpha', MID),
    learning('id-beta', 'anti-pattern/beta', PAST),
    learning('id-gamma', 'proven-pattern/gamma', FUTURE),
  ]);
  return entries;
}

const readRule = (name = 'fixture.md') =>
  readFileSync(join(repoRoot, '.claude', 'rules', name), 'utf8');

/** Marker sets exactly as `engine.mjs`'s dedupe scan reads them. */
function markerSets() {
  const dir = join(repoRoot, '.claude', 'rules');
  const ids = new Set();
  const keys = new Set();
  for (const name of ['fixture.md']) {
    if (!existsSync(join(dir, name))) continue;
    const content = readFileSync(join(dir, name), 'utf8');
    for (const m of content.matchAll(/-\s*learning-id:\s*`([^`]+)`/g)) ids.add(m[1]);
    for (const m of content.matchAll(/-\s*learning-key:\s*`([^`]+)`/g)) keys.add(m[1]);
  }
  return { ids, keys };
}

describe('parseConsolidatedRule', () => {
  it('reads the header, the counter sentence, the prose entries and the pairs (bug: a parser that scans the whole file for `expires-at:` picks up a learning quoting one)', () => {
    threePairFixture();
    const parsed = parseConsolidatedRule(readRule());
    expect(parsed.expiresAt).toBe('2026-01-01');
    expect(parsed.counterCount).toBe(3);
    expect(parsed.entries.map((e) => e.heading)).toEqual([
      'Alpha holds',
      'Beta expired',
      'Gamma holds',
    ]);
    expect(parsed.pairs.map((p) => p.id)).toEqual(['id-alpha', 'id-beta', 'id-gamma']);
    expect(parsed.pairs.every((p) => p.markersOnly === false)).toBe(true);
  });
});

describe('planRuleExpirySweep + applyRuleExpirySweep', () => {
  it('T1 — one of three entries expired: rewrite drops that prose block and keeps ALL THREE id bullets, the expired one marked `markers only` (bug: removing the pair too silently re-proposes the learning on the next /reconcile run)', async () => {
    threePairFixture();
    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.plans).toHaveLength(1);
    expect(plan.plans[0].action).toBe('rewrite');
    expect(plan.plans[0].expiredPairIds).toEqual(['id-beta']);
    expect(plan.plans[0].keptPairIds).toEqual(['id-alpha', 'id-gamma']);

    const res = applyRuleExpirySweep(plan, { repoRoot, now: NOW });
    expect(res.errors).toEqual([]);
    expect(res.rewritten).toEqual(['fixture.md']);

    const after = readRule();
    expect(after).not.toContain('### Beta expired');
    expect(after).not.toContain('Body prose for Beta expired.');
    expect(after).toContain('### Alpha holds');
    expect(after).toContain('### Gamma holds');
    // All three pairs still present — this is the whole contract.
    for (const id of ['id-alpha', 'id-beta', 'id-gamma']) {
      expect(after).toContain(`- learning-id: \`${id}\``);
    }
    const betaLine = after.split('\n').find((l) => l.includes('id-beta'));
    expect(betaLine).toMatch(/markers only/);
    expect(after.split('\n').find((l) => l.includes('id-alpha'))).not.toMatch(/markers only/);
  });

  it('T2 — after apply, the dedupe marker sets are byte-for-byte the same size (fake-regression target: a naive "delete the bullet too" implementation drops one id and one key here)', async () => {
    threePairFixture();
    const before = markerSets();
    expect(before.ids.size).toBe(3);
    expect(before.keys.size).toBe(3);

    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    applyRuleExpirySweep(plan, { repoRoot, now: NOW });

    const after = markerSets();
    expect(after.ids.size).toBe(before.ids.size);
    expect(after.keys.size).toBe(before.keys.size);
    expect([...after.ids].sort()).toEqual([...before.ids].sort());
    expect([...after.keys].sort()).toEqual([...before.keys].sort());
  });

  it('T3 — header and counter sentence are recomputed to the earliest REMAINING date, with the pair count unchanged (bug: leaving the header at the expired entry\'s date re-expires the file immediately)', async () => {
    threePairFixture();
    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    // Earliest of the two SURVIVING dates (2026-09-01, 2026-12-01).
    expect(plan.plans[0].newExpiresAt).toBe('2026-09-01');
    expect(plan.plans[0].newAbsorbedCount).toBe(3);

    applyRuleExpirySweep(plan, { repoRoot, now: NOW });
    const parsed = parseConsolidatedRule(readRule());
    expect(parsed.expiresAt).toBe('2026-09-01');
    expect(parsed.counterDate).toBe('2026-09-01');
    // N counts pairs REMAINING IN THE FILE; a rewrite removes none, and all 7
    // live sentences carry the total pair count (measured 2026-09-17).
    expect(parsed.counterCount).toBe(3);
  });

  it('T4 — every entry expired: the file is deleted, and every provenance key is stamped terminal BEFORE the unlink (bug: stamping after the delete leaves a window in which /reconcile sees neither file nor candidate and re-proposes the lot)', async () => {
    const entries = [
      { key: 'anti-pattern/alpha', id: 'id-alpha', heading: 'Alpha' },
      { key: 'anti-pattern/beta', id: 'id-beta', heading: 'Beta' },
      { key: 'proven-pattern/old', id: 'id-old', heading: 'Old', markersOnly: true },
    ];
    writeRule('fixture.md', { expiresAt: '2026-01-01', entries });
    writeLearnings([
      learning('id-alpha', 'anti-pattern/alpha', PAST),
      learning('id-beta', 'anti-pattern/beta', PAST),
      learning('id-old', 'proven-pattern/old', PAST),
    ]);

    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.plans[0].action).toBe('delete');
    // Markers-only pairs are dedupe markers too — the delete removes them, so
    // they must be stamped as well.
    expect(plan.plans[0].stampKeys).toEqual([
      'anti-pattern/alpha',
      'anti-pattern/beta',
      'proven-pattern/old',
    ]);

    const res = applyRuleExpirySweep(plan, { repoRoot, now: NOW });
    expect(res.errors).toEqual([]);
    expect(res.deleted).toEqual(['fixture.md']);
    expect(res.stamped).toBe(3);
    expect(existsSync(join(repoRoot, '.claude', 'rules', 'fixture.md'))).toBe(false);

    const { records } = loadCandidates({ repoRoot });
    const stamped = new Map(records.map((r) => [r.learning_key, r]));
    for (const key of plan.plans[0].stampKeys) {
      expect(stamped.get(key)?.processed_at).toBeTruthy();
      expect(stamped.get(key)?.outcome).toBe(SWEPT_OUTCOME);
    }
  });

  it('T5 — an unresolvable learning-id keeps its entry and blocks the file delete (bug: treating "not in learnings.jsonl" as "expired" deletes prose on no evidence; 5 of 92 live ids do not resolve)', async () => {
    const entries = [
      { key: 'anti-pattern/alpha', id: 'id-alpha', heading: 'Alpha' },
      { key: 'anti-pattern/ghost', id: 'id-ghost', heading: 'Ghost' },
    ];
    writeRule('fixture.md', { expiresAt: '2026-01-01', entries });
    // `id-ghost` is deliberately absent from the store.
    writeLearnings([learning('id-alpha', 'anti-pattern/alpha', PAST)]);

    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.plans[0].action).toBe('rewrite');
    expect(plan.plans[0].unresolvedPairIds).toEqual(['id-ghost']);
    expect(plan.plans[0].expiredPairIds).toEqual(['id-alpha']);

    applyRuleExpirySweep(plan, { repoRoot, now: NOW });
    expect(existsSync(join(repoRoot, '.claude', 'rules', 'fixture.md'))).toBe(true);
    expect(readRule()).toContain('### Ghost');
    // No resolvable surviving date → the header is left alone rather than guessed.
    expect(parseConsolidatedRule(readRule()).expiresAt).toBe('2026-01-01');
  });

  it('T6 — headings that do not map 1:1 onto non-markers pairs yield action "keep" plus skipped:no-1to1-mapping (bug: a positional mapping applied to a merged-prose file deletes the wrong paragraph; 4 of the 7 live files are this shape)', async () => {
    const content = renderRuleFile({
      expiresAt: '2026-01-01',
      entries: [
        { key: 'anti-pattern/alpha', id: 'id-alpha', heading: 'Alpha and Beta together' },
        { key: 'anti-pattern/beta', id: 'id-beta', heading: 'REMOVED', markersOnly: false },
      ],
      // Two substantive pairs, but the second heading is stripped below so only
      // one prose entry remains — the live merged-prose shape.
    }).replace(/### REMOVED[\s\S]*?(?=<!-- untrusted-content:end -->)/, '');
    writeFileSync(join(repoRoot, '.claude', 'rules', 'fixture.md'), content, 'utf8');
    writeLearnings([
      learning('id-alpha', 'anti-pattern/alpha', PAST),
      learning('id-beta', 'anti-pattern/beta', PAST),
    ]);

    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.skipped).toEqual([{ file: 'fixture.md', reason: 'no-1to1-mapping' }]);
    expect(plan.plans[0].action).toBe('keep');
    expect(plan.plans[0].expiredPairIds).toEqual([]);
    expect(plan.plans[0].headings).toBe(1);
    expect(plan.plans[0].substantivePairs).toBe(2);
  });

  it('T7 — a dry-run plan leaves the fixture byte-identical (bug: a planner that annotates or normalizes in place makes "preview" a write)', async () => {
    threePairFixture();
    const before = readRule();
    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.plans[0].action).toBe('rewrite'); // there IS work to do
    expect(readRule()).toBe(before);
    expect(plan.plans[0].bytesBefore).toBe(Buffer.byteLength(before, 'utf8'));
    expect(plan.plans[0].bytesAfter).toBeLessThan(plan.plans[0].bytesBefore);
  });

  it('T8 — a truncated learnings.jsonl line is COUNTED in malformedLines (bug: a leniently-skipping JSONL parser turns a partial read into a clean verdict, and this sweep deletes prose on that verdict)', async () => {
    threePairFixture();
    writeLearnings(
      [
        learning('id-alpha', 'anti-pattern/alpha', MID),
        learning('id-gamma', 'proven-pattern/gamma', FUTURE),
      ],
      ['{"id":"id-beta","expires_at":"2026-01-0'],
    );

    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.malformedLines).toBe(1);
    // `id-beta` was ONLY in the broken line, so it is unresolved, not expired.
    expect(plan.plans[0].unresolvedPairIds).toEqual(['id-beta']);
    expect(plan.plans[0].expiredPairIds).toEqual([]);
    // Nothing expired — the only write planned is the header raise (header
    // 2026-01-01 sits below the earliest RESOLVABLE date 2026-09-01).
    expect(plan.plans[0].reason).toBe('header-raise');
    expect(plan.plans[0].newExpiresAt).toBe('2026-09-01');
  });

  it('reports a header that OUTLIVES its content as an advisory and leaves the file byte-identical — a header is never LOWERED (bug: recomputing in both directions on every run shortens a healthy file\'s TTL and kills an entry early)', async () => {
    const entries = [{ key: 'anti-pattern/alpha', id: 'id-alpha', heading: 'Alpha' }];
    // Header 2026-12-15 is LATER than the single absorbed date 2026-12-01.
    writeRule('fixture.md', { expiresAt: '2026-12-15', entries });
    writeLearnings([learning('id-alpha', 'anti-pattern/alpha', FUTURE)]);

    const before = readRule();
    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.plans[0].action).toBe('keep');
    expect(plan.plans[0].reason).toBeUndefined();
    expect(plan.plans[0].advisory).toBe(
      'header expires-at 2026-12-15 != earliest resolvable absorbed date 2026-12-01',
    );
    applyRuleExpirySweep(plan, { repoRoot, now: NOW });
    expect(readRule()).toBe(before);
  });

  it('T13 — a header BELOW the earliest absorbed date is raised to it with nothing expired, and every other byte of the file is unchanged (bug: a too-low header drops the whole file out of rule-loader injection while its materialized markers keep /reconcile from ever re-proposing the learnings — substance goes dark with no way back)', async () => {
    const entries = [
      { key: 'anti-pattern/alpha', id: 'id-alpha', heading: 'Alpha holds' },
      { key: 'proven-pattern/gamma', id: 'id-gamma', heading: 'Gamma holds' },
    ];
    // Header 2026-10-01; both absorbed dates are LATER, earliest 2026-10-16.
    writeRule('fixture.md', { expiresAt: '2026-10-01', entries });
    writeLearnings([
      learning('id-alpha', 'anti-pattern/alpha', '2026-10-16T00:00:00.000Z'),
      learning('id-gamma', 'proven-pattern/gamma', '2026-11-20T00:00:00.000Z'),
    ]);

    const before = readRule();
    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    // The rewrite reason is visible in the dry-run plan (and thus in `--json`)
    // BEFORE anything is written.
    expect(plan.plans[0].action).toBe('rewrite');
    expect(plan.plans[0].reason).toBe('header-raise');
    expect(plan.plans[0].expiredPairIds).toEqual([]);
    expect(plan.plans[0].newExpiresAt).toBe('2026-10-16');
    expect(readRule()).toBe(before); // dry-run still writes nothing

    const res = applyRuleExpirySweep(plan, { repoRoot, now: NOW });
    expect(res.errors).toEqual([]);
    expect(res.rewritten).toEqual(['fixture.md']);

    const after = readRule();
    const parsed = parseConsolidatedRule(after);
    expect(parsed.expiresAt).toBe('2026-10-16');
    expect(parsed.counterDate).toBe('2026-10-16');
    expect(parsed.counterCount).toBe(2);

    // Byte-identity of everything else: exactly the frontmatter line and the
    // counter sentence differ, and the remaining lines match position for
    // position.
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines).toHaveLength(beforeLines.length);
    const changed = beforeLines
      .map((l, i) => (l === afterLines[i] ? -1 : i))
      .filter((i) => i >= 0);
    expect(changed).toEqual([
      parseConsolidatedRule(before).expiresAtLine,
      parseConsolidatedRule(before).counterLine,
    ]);
  });

  it('T9 — a `no-1to1-mapping` file STILL carries the header advisory (bug: computing it after the skip branch structurally excluded the 4 merged-prose files, test-hygiene.md among them, so the shipped instrument could not report the very header-outliving-content defect its docblock named)', async () => {
    // Same ambiguous shape as T6: two substantive pairs, one prose entry.
    const content = renderRuleFile({
      expiresAt: '2026-10-20',
      entries: [
        { key: 'anti-pattern/alpha', id: 'id-alpha', heading: 'Alpha and Beta together' },
        { key: 'anti-pattern/beta', id: 'id-beta', heading: 'REMOVED' },
      ],
    }).replace(/### REMOVED[\s\S]*?(?=<!-- untrusted-content:end -->)/, '');
    writeFileSync(join(repoRoot, '.claude', 'rules', 'fixture.md'), content, 'utf8');
    writeLearnings([
      learning('id-alpha', 'anti-pattern/alpha', FUTURE),
      learning('id-beta', 'anti-pattern/beta', MID), // the earliest — 2026-09-01
    ]);

    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.skipped).toEqual([{ file: 'fixture.md', reason: 'no-1to1-mapping' }]);
    expect(plan.plans[0].action).toBe('keep');
    // Header 2026-10-20 OUTLIVES its earliest resolvable content 2026-09-01.
    expect(plan.plans[0].advisory).toBe(
      'header expires-at 2026-10-20 != earliest resolvable absorbed date 2026-09-01',
    );
  });

  it('T10 — a symlinked rule entry is REFUSED on --apply: the victim stays byte-identical and the link stays a link (bug: writeFileSync FOLLOWS a symlink and rewrites its target, so a symlink tracked at .claude/rules/<n>.md turned this sweep into an arbitrary-file writer with nothing in the rules dir to show for it)', async () => {
    const victimDir = mkdtempSync(join(tmpdir(), 'rule-expiry-victim-'));
    const victim = join(victimDir, 'precious.md');
    // The victim's content PARSES as a consolidated rule, which is what makes
    // the file reachable: listMachineGeneratedRules readFileSync's through the
    // link, so the sweep plans a rewrite for it.
    const entries = [
      { key: 'anti-pattern/alpha', id: 'id-alpha', heading: 'Alpha holds' },
      { key: 'anti-pattern/beta', id: 'id-beta', heading: 'Beta expired' },
    ];
    writeFileSync(victim, renderRuleFile({ expiresAt: '2026-01-01', entries }), 'utf8');
    writeLearnings([
      learning('id-alpha', 'anti-pattern/alpha', FUTURE),
      learning('id-beta', 'anti-pattern/beta', PAST),
    ]);
    symlinkSync(victim, join(repoRoot, '.claude', 'rules', 'linked.md'));
    const victimBefore = readFileSync(victim, 'utf8');

    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    expect(plan.plans.map((p) => [p.file, p.action])).toEqual([['linked.md', 'rewrite']]);

    const res = applyRuleExpirySweep(plan, { repoRoot, now: NOW });
    expect(res.rewritten).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].file).toBe('linked.md');
    expect(res.errors[0].error).toMatch(/symlink/);
    // The whole point: nothing was written THROUGH the link.
    expect(readFileSync(victim, 'utf8')).toBe(victimBefore);
    expect(lstatSync(join(repoRoot, '.claude', 'rules', 'linked.md')).isSymbolicLink()).toBe(true);

    rmSync(victimDir, { recursive: true, force: true });
  });

  it('T11 — a plan naming a path outside the rules directory is refused (bug: join() walks a `../` plan entry straight out of .claude/rules, and this function is exported)', () => {
    const outside = join(repoRoot, 'outside.md');
    writeFileSync(outside, 'untouched\n', 'utf8');
    const res = applyRuleExpirySweep(
      { plans: [{ file: '../../outside.md', action: 'rewrite', nextContent: 'pwned\n' }] },
      { repoRoot, now: NOW },
    );
    expect(res.rewritten).toEqual([]);
    expect(res.errors[0].error).toMatch(/resolves outside/);
    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
  });

  it('T12 — the applied rewrite leaves no tmp or backup litter in the rules dir (bug: a bare writeFileSync is non-atomic, and a hand-rolled tmp+rename leaks its tmp sibling on every failed write)', async () => {
    threePairFixture();
    const plan = await planRuleExpirySweep({ repoRoot, now: NOW });
    const res = applyRuleExpirySweep(plan, { repoRoot, now: NOW });
    expect(res.errors).toEqual([]);
    expect(res.rewritten).toEqual(['fixture.md']);
    // atomicWriteWithBackup with `backup: false` (our call shape) documents
    // exactly one artefact: the renamed target. No `.bak-<ISO>`, no tmp.
    expect(readdirSync(join(repoRoot, '.claude', 'rules'))).toEqual(['fixture.md']);
  });

  it('refuses a missing repoRoot rather than sweeping the operator\'s live checkout via process.cwd() (bug: an ambient-cwd default makes a test run rewrite .claude/rules)', async () => {
    await expect(planRuleExpirySweep({})).rejects.toThrow(/repoRoot is required/);
    expect(() => applyRuleExpirySweep({ plans: [] }, {})).toThrow(/repoRoot is required/);
  });

  it('rejects a negative grace window instead of sweeping the future (bug: a negative grace day count expires entries that have not expired yet)', async () => {
    threePairFixture();
    await expect(planRuleExpirySweep({ repoRoot, graceDays: -5 })).rejects.toThrow(/graceDays/);
  });
});
