/**
 * Retention rules of the vault mirror and the bestand pruner (#1513).
 *
 * Black-box over the two CLIs against a real tmp vault. The fixture notes are
 * shaped after real Meta-Vault notes (the triple of one learning — flat
 * pre-#725 slug, namespaced pre-#725 slug, namespaced canonical slug — and a
 * table-only session note), anonymised: invented repos, subjects and numbers.
 *
 * Each test names the defect it catches.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const MIRROR = resolve(process.cwd(), 'scripts/vault-mirror.mjs');
const PRUNE = resolve(process.cwd(), 'scripts/vault-mirror-prune.mjs');
const GEN = '_generator: session-orchestrator-vault-mirror@1';

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) removeTree(dirs.pop());
});
function tmp(prefix) {
  const d = makeTmpDir(prefix);
  dirs.push(d);
  return d;
}

function run(script, args) {
  const projectDir = tmp('vm-ret-events-');
  return spawnSync('node', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, VAULT_MIRROR_SKIP_CANONICAL_CHECK: '1', CLAUDE_PROJECT_DIR: projectDir, SO_VAULT_DIR: projectDir },
  });
}
const actionsOf = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));

function put(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

const INSIGHT =
  'Splitting a wave so each agent owns a distinct file set removed merge conflicts; the coordinator re-ran the gate after the wave for the one authoritative count.';

function learningNote({ id, insight = INSIGHT, expires = '2099-01-01', updated = '2026-06-15', extra = '' }) {
  return `---
id: ${id}
type: learning
title: Splitting a wave so each agent owns a distinct file set
status: draft
created: 2026-06-15
updated: ${updated}
tags: [learning/effective-sizing, status/draft, source/legacy-unknown]
source_session: legacy-unknown
expires: ${expires}
${extra}${GEN}
---

# Splitting a wave so each agent owns a distinct file set

- **Type:** effective-sizing
- **Confidence:** 0.7

## Insight

${insight}

## Evidence

W2 a.py | b.py; gate 532 -> 553 -> 556.
`;
}

function sessionNote(id, notes = '') {
  return `---
id: ${id}
type: session
title: "Session 2026-09-24 — deep"
status: verified
created: 2026-09-24
updated: 2026-09-24
tags: [session/deep, status/verified]
source-repo: widget-tool
${GEN}
---

# Session ${id}

- **Type:** deep · **Platform:** claude
- **Waves:** 5 · **Agents:** 15 · **Files changed:** 28

## Agent summary

- Complete: 15 · Partial: 0 · Failed: 0 · Spiral: 0
${notes ? `\n## Notes\n\n${notes}\n` : ''}`;
}

const CONCAT = '3parallelimplagentsondisjointfiles';
const CANON = '3-parallel-impl-agents-on-disjoint-files';

describe('vault-mirror-prune (bestand)', () => {
  function seedVault() {
    const v = tmp('vm-ret-vault-');
    put(v, `40-learnings/${CONCAT}.md`, learningNote({ id: CONCAT }));
    put(v, `40-learnings/widget-tool/${CONCAT}.md`, learningNote({ id: CONCAT }));
    put(v, `40-learnings/widget-tool/${CANON}.md`, learningNote({ id: CANON, extra: 'source-repo: widget-tool\n' }));
    put(v, '40-learnings/widget-tool/old-lesson.md', learningNote({ id: 'old-lesson', insight: 'An unrelated lesson.', expires: '2026-01-01' }));
    put(v, '40-learnings/widget-tool/hand-written.md', '---\nid: hand-written\ntype: learning\nexpires: 2020-01-01\n---\n\n## Insight\n\n' + INSIGHT + '\n');
    put(v, '40-learnings/gadgetv2/keep-me.md', learningNote({ id: 'keep-me', insight: 'Only the alias folder has this one.' }));
    put(v, '40-learnings/gadget-v2/other.md', learningNote({ id: 'other', insight: 'Lives in the canonical folder.' }));
    put(v, '50-sessions/widget-tool/main-2026-09-24-session-1.md', sessionNote('main-2026-09-24-session-1'));
    put(v, '50-sessions/widget-tool/main-2026-09-24-session-2.md', sessionNote('main-2026-09-24-session-2', 'x'.repeat(450)));
    return v;
  }

  it('dry run writes nothing and plans one reason per note, keeping the canonical copy and every hand-written note', () => {
    // Defects caught: a dry run that writes; the canonical (namespaced,
    // hyphenated) copy archived instead of its twins; a hand-written note or a
    // narrative session entering the plan.
    const v = seedVault();
    const manifestPath = join(tmp('vm-ret-out-'), 'm.json');
    const r = run(PRUNE, ['--vault-dir', v, '--manifest', manifestPath, '--now', '2026-10-03T00:00:00Z']);
    expect(r.status).toBe(0);
    expect(existsSync(join(v, '90-archive'))).toBe(false);
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const by = Object.fromEntries(m.actions.map((a) => [a.path, a]));
    expect(by[`40-learnings/${CONCAT}.md`]).toMatchObject({ reason: 'duplicate', action: 'archive', keep: `40-learnings/widget-tool/${CANON}.md` });
    expect(by[`40-learnings/widget-tool/${CONCAT}.md`]).toMatchObject({ reason: 'duplicate', keep: `40-learnings/widget-tool/${CANON}.md` });
    expect(by[`40-learnings/widget-tool/${CANON}.md`]).toBeUndefined();
    expect(by['40-learnings/widget-tool/old-lesson.md']).toMatchObject({ reason: 'expired', action: 'archive' });
    expect(by['40-learnings/widget-tool/hand-written.md']).toBeUndefined();
    expect(by['40-learnings/gadgetv2/keep-me.md']).toMatchObject({ reason: 'namespace-alias', action: 'move', target: '40-learnings/gadget-v2/keep-me.md' });
    expect(by['50-sessions/widget-tool/main-2026-09-24-session-1.md']).toMatchObject({
      reason: 'metrics-only-session',
      rollup: '50-sessions/widget-tool/_rollup-2026-09.md',
    });
    expect(by['50-sessions/widget-tool/main-2026-09-24-session-2.md']).toBeUndefined();
    expect(m.aliases).toEqual({ gadgetv2: 'gadget-v2' });
  });

  it('--apply archives with status archived, writes the rollup row, and a second run plans nothing', () => {
    // Defects caught: an archived note losing its bytes or keeping status
    // draft; a metrics-only session archived without its rollup row; a
    // non-idempotent pruner that re-plans (or re-writes) on the second run.
    const v = seedVault();
    const r = run(PRUNE, ['--vault-dir', v, '--apply', '--now', '2026-10-03T00:00:00Z', '--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim()).applied).toMatchObject({ archived: 4, moved: 1, rollupsWritten: 1, errors: 0 });

    const archived = readFileSync(join(v, '90-archive/mirror/40-learnings/widget-tool/old-lesson.md'), 'utf8');
    expect(archived).toMatch(/^status: archived\narchived-reason: expired$/m);
    expect(archived).toContain('An unrelated lesson.');
    expect(existsSync(join(v, '40-learnings/widget-tool/old-lesson.md'))).toBe(false);
    expect(existsSync(join(v, `40-learnings/widget-tool/${CANON}.md`))).toBe(true);
    expect(existsSync(join(v, '40-learnings/widget-tool/hand-written.md'))).toBe(true);
    expect(existsSync(join(v, '40-learnings/gadget-v2/keep-me.md'))).toBe(true);
    const rollup = readFileSync(join(v, '50-sessions/widget-tool/_rollup-2026-09.md'), 'utf8');
    expect(rollup).toContain('| 2026-09-24 | `main-2026-09-24-session-1` | deep | 5 | 15 | 28 |');
    expect(rollup).not.toContain('session-2`');

    const before = readFileSync(join(v, '50-sessions/widget-tool/_rollup-2026-09.md'), 'utf8');
    const again = run(PRUNE, ['--vault-dir', v, '--apply', '--now', '2026-10-03T00:00:00Z', '--json']);
    const summary = JSON.parse(again.stdout.trim());
    expect(summary.counts).toEqual({});
    expect(summary.applied).toMatchObject({ archived: 0, moved: 0, rollupsWritten: 0 });
    expect(readFileSync(join(v, '50-sessions/widget-tool/_rollup-2026-09.md'), 'utf8')).toBe(before);
  });
});

describe('vault-mirror write-time retention', () => {
  const learning = (over = {}) => ({
    id: 'aaaaaaaa-0001-4000-8000-000000000001',
    type: 'effective-sizing',
    subject: '3 parallel impl agents on disjoint files',
    insight: INSIGHT,
    evidence: 'W2 a.py | b.py',
    confidence: 0.7,
    source_session: 'main-2026-06-14-session-1',
    created_at: '2026-06-15T10:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
    ...over,
  });
  function mirror(vault, kind, records, { archive = null } = {}) {
    const metrics = join(tmp('vm-ret-src-'), '.orchestrator', 'metrics');
    mkdirSync(metrics, { recursive: true });
    const src = join(metrics, kind === 'learning' ? 'learnings.jsonl' : 'sessions.jsonl');
    writeFileSync(src, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    if (archive) writeFileSync(join(metrics, 'learnings-archive.jsonl'), archive.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = run(MIRROR, ['--vault-dir', vault, '--source', src, '--kind', kind, '--vault-name', 'widget-tool', '--repo-root', dirname(dirname(metrics))]);
    expect(r.status, r.stderr).toBe(0);
    return actionsOf(r.stdout);
  }

  it('updates the pre-#725 legacy-slug note in place instead of creating a canonical twin', () => {
    // Defect caught: the 364 duplicate files of the Meta-Vault — every
    // learning mirrored before #725 got a second, hyphenated file.
    const v = tmp('vm-ret-vault-');
    put(v, `40-learnings/widget-tool/${CONCAT}.md`, learningNote({ id: CONCAT, updated: '2026-06-01' }));
    const [a] = mirror(v, 'learning', [learning()]);
    expect(a).toMatchObject({ action: 'updated', path: `40-learnings/widget-tool/${CONCAT}.md` });
    expect(readdirSync(join(v, '40-learnings/widget-tool'))).toEqual([`${CONCAT}.md`]);
  });

  it('refuses a new note whose insight already exists under another slug', () => {
    // Defect caught: one learning re-recorded under a new subject/id lands as
    // a second note with the identical insight.
    const v = tmp('vm-ret-vault-');
    put(v, '40-learnings/widget-tool/some-other-slug.md', learningNote({ id: 'some-other-slug', insight: `  ${INSIGHT.toUpperCase()}  ` }));
    const [a] = mirror(v, 'learning', [learning()]);
    expect(a).toMatchObject({ action: 'skipped-duplicate-insight', path: '40-learnings/widget-tool/some-other-slug.md' });
    expect(existsSync(join(v, `40-learnings/widget-tool/${CANON}.md`))).toBe(false);
  });

  it('never creates an expired learning, and archives the note of one that expired', () => {
    // Defect caught: 2.826 expired learnings standing as status: draft, and the
    // mirror re-creating notes that are dead on arrival.
    const v = tmp('vm-ret-vault-');
    const [created] = mirror(v, 'learning', [learning({ expires_at: '2020-01-01T00:00:00Z' })]);
    expect(created.action).toBe('skipped-expired');
    expect(existsSync(join(v, `40-learnings/widget-tool/${CANON}.md`))).toBe(false);

    put(v, `40-learnings/widget-tool/${CANON}.md`, learningNote({ id: CANON }));
    const [marked] = mirror(v, 'learning', [learning({ expires_at: '2020-01-01T00:00:00Z' })]);
    expect(marked.action).toBe('updated');
    expect(readFileSync(join(v, `40-learnings/widget-tool/${CANON}.md`), 'utf8')).toMatch(/^status: archived\narchived-reason: expired$/m);
    const [again] = mirror(v, 'learning', [learning({ expires_at: '2020-01-01T00:00:00Z' })]);
    expect(again.action).toBe('skipped-noop');
  });

  it('marks the note of a record that left the store, but never one a live record owns', () => {
    // Defects caught: notes of learnings archived by /evolve staying draft
    // forever; and the flip-flop where the live pass writes draft and the
    // archive pass writes archived on every run.
    const v = tmp('vm-ret-vault-');
    put(v, '40-learnings/widget-tool/gone-lesson.md', learningNote({ id: 'gone-lesson', insight: 'Gone.' }));
    put(v, `40-learnings/widget-tool/${CANON}.md`, learningNote({ id: CANON }));
    const gone = learning({ id: 'bbbbbbbb-0002-4000-8000-000000000002', subject: 'gone lesson', insight: 'Gone.', _archive_reason: 'pruned' });
    const relearned = learning({ id: 'cccccccc-0003-4000-8000-000000000003', _archive_reason: 'expired' });
    const actions = mirror(v, 'learning', [learning()], { archive: [gone, relearned] });
    expect(actions.find((a) => a.id === 'gone-lesson')).toMatchObject({ action: 'updated', archived_reason: 'superseded' });
    expect(readFileSync(join(v, '40-learnings/widget-tool/gone-lesson.md'), 'utf8')).toMatch(/^status: archived$/m);
    expect(readFileSync(join(v, `40-learnings/widget-tool/${CANON}.md`), 'utf8')).not.toMatch(/^status: archived$/m);
  });

  it('rolls a table-only session into the month rollup, idempotently, and still writes a narrative session', () => {
    // Defects caught: a metrics-only session getting its own note again, a
    // rollup that gains a duplicate row (or new bytes) on every run, and a
    // narrative session lost to the gate.
    const v = tmp('vm-ret-vault-');
    const base = {
      session_type: 'deep',
      started_at: '2026-09-24T08:00:00Z',
      completed_at: '2026-09-24T10:00:00Z',
      waves: 5,
      agents_dispatched: 15,
      files_changed: 28,
      agent_summary: { complete: 15, partial: 0, failed: 0, spiral: 0 },
      effectiveness: { planned_issues: 1, completed_issues: 1, carryover: 0, completion_rate: 1 },
    };
    const records = [
      { ...base, session_id: 'main-2026-09-24-session-1' },
      { ...base, session_id: 'main-2026-09-24-session-2', notes: 'Decided to keep the old endpoint one more release. '.repeat(10) },
    ];
    const first = mirror(v, 'session', records);
    expect(first.map((a) => a.action)).toEqual(['skipped-metrics-only', 'created']);
    expect(existsSync(join(v, '50-sessions/widget-tool/main-2026-09-24-session-1.md'))).toBe(false);
    const rollupPath = join(v, '50-sessions/widget-tool/_rollup-2026-09.md');
    const bytes = readFileSync(rollupPath, 'utf8');
    expect(bytes.match(/`main-2026-09-24-session-1`/g)).toHaveLength(1);

    const second = mirror(v, 'session', records);
    expect(second.map((a) => a.action)).toEqual(['skipped-noop', 'skipped-noop']);
    expect(readFileSync(rollupPath, 'utf8')).toBe(bytes);
  });
});

// ── Review findings on MR !75 (each test was red before its fix) ─────────────

describe('review fixes (#1513, MR !75)', () => {
  const NOW = '2026-10-03T00:00:00Z';
  const prunePlan = (v) => {
    const out = join(tmp('vm-ret-out-'), 'm.json');
    const r = run(PRUNE, ['--vault-dir', v, '--manifest', out, '--now', NOW]);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(readFileSync(out, 'utf8'));
  };
  const session = (over = {}) => ({
    session_type: 'deep',
    started_at: '2026-09-27T08:00:00Z',
    completed_at: '2026-09-27T10:00:00Z',
    waves: 5,
    agents_dispatched: 15,
    files_changed: 28,
    agent_summary: { complete: 15, partial: 0, failed: 0, spiral: 0 },
    effectiveness: { planned_issues: 1, completed_issues: 1, carryover: 0, completion_rate: 1 },
    ...over,
  });
  function mirrorRun(vault, kind, records, ns = 'widget-tool') {
    const metrics = join(tmp('vm-ret-src-'), '.orchestrator', 'metrics');
    mkdirSync(metrics, { recursive: true });
    const src = join(metrics, kind === 'learning' ? 'learnings.jsonl' : 'sessions.jsonl');
    writeFileSync(src, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const r = run(MIRROR, ['--vault-dir', vault, '--source', src, '--kind', kind, '--vault-name', ns, '--repo-root', dirname(dirname(metrics))]);
    expect(r.status, r.stderr).toBe(0);
    return actionsOf(r.stdout);
  }
  const learningRec = (over = {}) => ({
    id: 'dddddddd-0004-4000-8000-000000000004',
    type: 'effective-sizing',
    subject: 'brand new lesson',
    insight: INSIGHT,
    evidence: 'e',
    confidence: 0.7,
    source_session: 'main-2026-06-14-session-1',
    created_at: '2026-06-15T10:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
    ...over,
  });

  it('H1: a duplicate group never keeps an expired copy — the live, verified twin stays active', () => {
    // Shape of the real case: hyphenated draft copy expired 2026-09-07, the
    // concatenated verified copy valid until 2026-12-19. Before the fix the
    // live one was archived as duplicate and the kept one as expired.
    const v = tmp('vm-ret-vault-');
    put(v, `40-learnings/widget-tool/${CANON}.md`, learningNote({ id: CANON, expires: '2026-09-07' }));
    put(
      v,
      `40-learnings/widget-tool/${CONCAT}.md`,
      learningNote({ id: CONCAT, expires: '2026-12-19' }).replace('status: draft', 'status: verified'),
    );
    const by = Object.fromEntries(prunePlan(v).actions.map((a) => [a.path, a]));
    expect(by[`40-learnings/widget-tool/${CONCAT}.md`]).toBeUndefined();
    expect(by[`40-learnings/widget-tool/${CANON}.md`]).toMatchObject({ reason: 'expired', action: 'archive' });
  });

  it('H2: narrative only in summary/narrative is rendered, an old empty note is healed, and the pruner leaves it alone', () => {
    // Before the fix the note carried no text, the pruner archived it, the
    // mirror re-created it — forever.
    const v = tmp('vm-ret-vault-');
    put(v, '50-sessions/widget-tool/vault-deep-2026-09-27.md', sessionNote('vault-deep-2026-09-27').replace(/2026-09-24/g, '2026-09-27'));
    const text = 'The owner decided to move the archive behind the tunnel first. '.repeat(8);
    const actions = mirrorRun(v, 'session', [session({ session_id: 'vault-deep-2026-09-27', summary: text })]);
    expect(actions[0].action).toBe('updated');
    const note = readFileSync(join(v, '50-sessions/widget-tool/vault-deep-2026-09-27.md'), 'utf8');
    expect(note).toContain('The owner decided to move the archive');
    expect(prunePlan(v).actions).toEqual([]);
    expect(mirrorRun(v, 'session', [session({ session_id: 'vault-deep-2026-09-27', summary: text })])[0].action).toBe('skipped-noop');
  });

  it('H2b: a re-appended record without free text keeps the narrative of the record it supersedes', () => {
    // Real shape (vault ledger lines 101/108): the newer duplicate of a session
    // carries no narrative and wins the collapse; the older one carries 1.172
    // chars. Before the fix the session was rolled up as metrics-only.
    const v = tmp('vm-ret-vault-');
    const text = 'Four parallel waves repaired the research notes and narrowed the schema exclusions. '.repeat(6);
    const actions = mirrorRun(v, 'session', [
      session({ session_id: 'main-2026-07-26-session-2', narrative: text }),
      session({ session_id: 'main-2026-07-26-session-2', completed_at: '2026-09-28T07:00:00Z' }),
    ]);
    expect(actions.map((a) => a.action)).toEqual(['skipped-duplicate-session', 'created']);
    const note = readFileSync(join(v, '50-sessions/widget-tool/main-2026-07-26-session-2.md'), 'utf8');
    expect(note).toContain('Four parallel waves repaired');
  });

  it('M2: the mirror writes into the canonical folder of a hyphen alias, not the alias', () => {
    const v = tmp('vm-ret-vault-');
    put(v, '40-learnings/gadget-v2/other.md', learningNote({ id: 'other', insight: 'Lives in the canonical folder, nothing in common.' }));
    const [a] = mirrorRun(v, 'learning', [learningRec()], 'gadgetv2');
    expect(a).toMatchObject({ action: 'created', path: '40-learnings/gadget-v2/brand-new-lesson.md' });
    expect(existsSync(join(v, '40-learnings/gadgetv2'))).toBe(false);
  });

  it('M3: a flat note of another repo (or without source-repo) does not block a new learning', () => {
    const v = tmp('vm-ret-vault-');
    put(v, '40-learnings/foreign.md', learningNote({ id: 'foreign', extra: 'source-repo: other-tool\n' }));
    put(v, '40-learnings/anon.md', learningNote({ id: 'anon' }));
    const [a] = mirrorRun(v, 'learning', [learningRec()]);
    expect(a.action).toBe('created');
  });

  it('M4: a placeholder insight is never treated as the same learning', () => {
    const placeholder = '(legacy record — insight backfilled during 2026-07-02 recovery)';
    const v = tmp('vm-ret-vault-');
    put(v, '40-learnings/widget-tool/old-one.md', learningNote({ id: 'old-one', insight: placeholder }));
    put(v, '40-learnings/widget-tool/old-two.md', learningNote({ id: 'old-two', insight: placeholder }));
    expect(prunePlan(v).actions).toEqual([]);
    const [a] = mirrorRun(v, 'learning', [learningRec({ insight: placeholder })]);
    expect(a.action).toBe('created');
  });

  it('N1: --apply refuses an archive zone that resolves outside the vault (symlink)', () => {
    const v = tmp('vm-ret-vault-');
    const outside = tmp('vm-ret-outside-');
    symlinkSync(outside, join(v, '90-archive'));
    put(v, '40-learnings/widget-tool/old-lesson.md', learningNote({ id: 'old-lesson', expires: '2026-01-01' }));
    const r = run(PRUNE, ['--vault-dir', v, '--apply', '--now', NOW, '--json']);
    expect(r.status).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(v, '40-learnings/widget-tool/old-lesson.md'))).toBe(true);
  });

  it('N4: an occupied archive target with other content gets a .dup-<hash8> sibling instead of a permanent error', () => {
    const v = tmp('vm-ret-vault-');
    put(v, '40-learnings/widget-tool/old-lesson.md', learningNote({ id: 'old-lesson', expires: '2026-01-01' }));
    put(v, '90-archive/mirror/40-learnings/widget-tool/old-lesson.md', 'earlier archived content\n');
    const manifestPath = join(tmp('vm-ret-out-'), 'm.json');
    const r = run(PRUNE, ['--vault-dir', v, '--apply', '--now', NOW, '--manifest', manifestPath]);
    expect(r.status, r.stderr).toBe(0);
    const files = readdirSync(join(v, '90-archive/mirror/40-learnings/widget-tool')).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^old-lesson\.dup-[0-9a-f]{8}\.md$/);
    expect(readFileSync(join(v, '90-archive/mirror/40-learnings/widget-tool/old-lesson.md'), 'utf8')).toBe('earlier archived content\n');
    expect(existsSync(join(v, '40-learnings/widget-tool/old-lesson.md'))).toBe(false);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).applied.suffixed).toHaveLength(1);
  });
});
