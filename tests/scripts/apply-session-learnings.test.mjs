/**
 * tests/scripts/apply-session-learnings.test.mjs
 *
 * CLI contract for scripts/apply-session-learnings.mjs (GitHub #69 / GitLab
 * #1446) — the only sanctioned session-end write path for learnings.jsonl.
 * Every case runs the real CLI via spawnSync against a mkdtemp repo whose
 * `.orchestrator/metrics/` holds a 3-record store; the CLI is always pinned to
 * that repo with `--repo-root`, so neither the store nor the events ledger of
 * the checkout is ever touched.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNextGeneration } from '../../scripts/apply-session-learnings.mjs';
import { makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const CLI = fileURLToPath(new URL('../../scripts/apply-session-learnings.mjs', import.meta.url));
const DAY_MS = 86400 * 1000;

const base = (id, subject, confidence, type = 'recurring-issue') => ({
  id,
  type,
  subject,
  insight: `insight for ${subject}`,
  evidence: `evidence for ${subject}`,
  confidence,
  source_session: 'main-2026-09-01-1000',
  created_at: '2026-09-01T10:00:00.000Z',
  expires_at: '2099-01-01T00:00:00.000Z',
  schema_version: 1,
  scope: 'local',
  host_class: null,
  anonymized: false,
});

const STORE = [
  base('rec-confirm', 'confirm-me', 0.9),
  base('rec-contradict', 'contradict-me', 0.5),
  base('rec-decay', 'leave-me', 0.5),
];

const NEW_LEARNING = {
  id: 'rec-new',
  type: 'workflow-pattern',
  subject: 'new-subject',
  insight: 'a new insight',
  evidence: 'a new evidence line',
  confidence: 0.6,
  source_session: 'main-2026-09-24-1500',
  scope: 'private',
  host_class: null,
  anonymized: false,
  file_paths: ['src/app.ts'],
};

const FULL_INPUT = {
  confidence_updates: [
    { id: 'rec-confirm', operation: 'confirm' },
    { id: 'rec-contradict', operation: 'contradict' },
  ],
  new_learnings: [NEW_LEARNING],
};

const tmpdirs = [];
afterEach(() => {
  for (const d of tmpdirs.splice(0)) removeTree(d);
});

/** A tmp repo with the 3-record store (and an optional CLAUDE.md). */
function makeRepo(claudeMd = null) {
  const repo = makeTmpDir('apply-session-learnings-');
  tmpdirs.push(repo);
  const metrics = path.join(repo, '.orchestrator', 'metrics');
  mkdirSync(metrics, { recursive: true });
  const store = path.join(metrics, 'learnings.jsonl');
  writeFileSync(store, `${STORE.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  if (claudeMd !== null) writeFileSync(path.join(repo, 'CLAUDE.md'), claudeMd, 'utf8');
  return { repo, metrics, store, original: readFileSync(store, 'utf8') };
}

/** Run the CLI pinned to `repo`; `stdin` is the input document (or null with --input). */
function runCli(repo, args, stdin) {
  return spawnSync(process.execPath, [CLI, '--repo-root', repo, ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
    input: stdin === null ? '' : JSON.stringify(stdin),
    // Empty values disable the remote event mirror in emitEvent.
    env: { ...process.env, CLANK_EVENT_SECRET: '', CLANK_EVENT_URL: '' },
  });
}

const backupsIn = (metrics) => readdirSync(metrics).filter((f) => f.startsWith('learnings.jsonl.bak-'));
// docs/events-schema.md: the event's presence is the proof a write ran.
const eventsIn = (metrics) => existsSync(path.join(metrics, 'events.jsonl'));
const recordsIn = (store) =>
  readFileSync(store, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

describe('apply-session-learnings CLI', () => {
  it('dry run (default) reports the planned changes and writes nothing', () => {
    const { repo, metrics, store, original } = makeRepo();
    const result = runCli(repo, ['--json'], FULL_INPUT);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dry_run: true,
      read: 3,
      confirmed: 1,
      contradicted: 1,
      appended: 1,
      decay_rate: 0.05,
      decayed: 1,
      written: 0,
    });
    expect(readFileSync(store, 'utf8')).toBe(original);
    expect(backupsIn(metrics)).toEqual([]);
    expect(eventsIn(metrics)).toBe(false);
  });

  it('--apply backs up the store, applies confirm/contradict/decay, appends the new record and emits the event', () => {
    const { repo, metrics, store, original } = makeRepo();
    const inputPath = path.join(repo, 'input.json');
    writeFileSync(inputPath, JSON.stringify(FULL_INPUT), 'utf8');

    const before = Date.now();
    const result = runCli(repo, ['--apply', '--json', '--input', inputPath], null);
    const after = Date.now();

    expect(result.status).toBe(0);
    const backups = backupsIn(metrics);
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(metrics, backups[0]), 'utf8')).toBe(original);

    const records = recordsIn(store);
    expect(records.map((r) => [r.id, r.confidence])).toEqual([
      ['rec-confirm', 1],
      ['rec-contradict', 0.3],
      ['rec-decay', 0.45],
      ['rec-new', 0.6],
    ]);
    // confirm re-derives expires_at from "now" + the 45-day recurring-issue TTL;
    // contradict and decay leave it alone.
    const confirmedExpiry = Date.parse(records[0].expires_at);
    expect(confirmedExpiry).toBeGreaterThanOrEqual(before - 1000 + 45 * DAY_MS);
    expect(confirmedExpiry).toBeLessThanOrEqual(after + 1000 + 45 * DAY_MS);
    expect(records[1].expires_at).toBe('2099-01-01T00:00:00.000Z');
    expect(records[2].expires_at).toBe('2099-01-01T00:00:00.000Z');
    expect(records[3]).toMatchObject({ scope: 'private', schema_version: 1, file_paths: ['src/app.ts'] });

    const events = readFileSync(path.join(metrics, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"orchestrator.learnings.session_write_applied"'))
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      file: '.orchestrator/metrics/learnings.jsonl',
      appended: 1,
      confirmed: 1,
      contradicted: 1,
      decayed: 1,
      pruned: 0,
    });
  });

  it.each([
    [
      'a new record with scope "project"',
      [],
      { new_learnings: [{ ...NEW_LEARNING, scope: 'project' }] },
      /new_learnings\[0\] \(id=rec-new\): scope must be one of/,
    ],
    [
      'a new record with schema_version 2',
      [],
      { new_learnings: [{ ...NEW_LEARNING, schema_version: 2 }] },
      /new_learnings\[0\] \(id=rec-new\): schema_version must be 0 \(legacy\) or 1/,
    ],
    [
      'a confidence update for an unknown id',
      [],
      { confidence_updates: [{ id: 'rec-missing', operation: 'confirm' }] },
      /id rec-missing not found in the store/,
    ],
    [
      'two new records sharing one id',
      [],
      { new_learnings: [{ ...NEW_LEARNING, id: 'rec-dup' }, { ...NEW_LEARNING, id: 'rec-dup', subject: 'other-subject' }] },
      /new_learnings\[1\] \(id=rec-dup\): id already exists/,
    ],
    [
      'a new record reusing an id already in the store',
      [],
      { new_learnings: [{ ...NEW_LEARNING, id: 'rec-decay' }] },
      /new_learnings\[0\] \(id=rec-decay\): id already exists/,
    ],
    ['--decay-rate 1.5', ['--decay-rate', '1.5'], {}, /--decay-rate must be a number in \[0, 1\], got: 1\.5/],
    ['--input naming a missing file', ['--input', 'absent-input.json'], {}, /cannot read input: ENOENT/],
  ])('--apply with %s exits 1 and leaves the store untouched', (_label, flags, input, message) => {
    const { repo, metrics, store, original } = makeRepo();
    const result = runCli(repo, ['--apply', '--json', ...flags], input);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(readFileSync(store, 'utf8')).toBe(original);
    expect(backupsIn(metrics)).toEqual([]);
    expect(eventsIn(metrics)).toBe(false);
  });

  it('refuses --apply on a store with a malformed line, which a dry run only reports', () => {
    const { repo, metrics, store } = makeRepo();
    const malformedStore = `${JSON.stringify(STORE[0])}\n{broken\n`;
    writeFileSync(store, malformedStore, 'utf8');

    const dryRun = runCli(repo, ['--json'], {});
    expect(dryRun.status).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ dry_run: true, read: 1, malformed: 1, written: 0 });

    const applied = runCli(repo, ['--apply', '--json'], {});
    expect(applied.status).toBe(2);
    expect(applied.stderr).toMatch(/refusing to rewrite — 1 malformed line\(s\)/);
    expect(readFileSync(store, 'utf8')).toBe(malformedStore);
    expect(backupsIn(metrics)).toEqual([]);
    expect(existsSync(path.join(metrics, 'learnings-archive.jsonl'))).toBe(false);
    expect(eventsIn(metrics)).toBe(false);
  });

  it('--apply with no store and an empty input writes nothing and emits no event', () => {
    const { repo, metrics, store } = makeRepo();
    rmSync(store);
    const result = runCli(repo, ['--apply', '--json'], { confidence_updates: [], new_learnings: [] });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dry_run: false, read: 0, written: 0 });
    expect(existsSync(store)).toBe(false);
    expect(eventsIn(metrics)).toBe(false);
  });

  it('--apply to a --file outside --repo-root writes that store but pins no event to the repo', () => {
    const { repo, metrics } = makeRepo();
    const foreign = makeRepo();
    const result = runCli(repo, ['--apply', '--json', '--file', foreign.store], {});

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/lies outside --repo-root/);
    expect(backupsIn(foreign.metrics)).toHaveLength(1);
    expect(eventsIn(metrics)).toBe(false);
  });

  it.each([
    ['--decay-rate 0 disables decay', ['--decay-rate', '0'], null, 0, 0],
    [
      'Session Config learning-decay-rate is honoured without a flag',
      [],
      '# Demo\n\n## Session Config\n\nlearning-decay-rate: 0.1\n',
      0.1,
      3,
    ],
  ])('%s', (_label, flags, claudeMd, rate, decayed) => {
    const { repo } = makeRepo(claudeMd);
    const result = runCli(repo, ['--json', ...flags], {});

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decay_rate: rate, decayed });
  });

  it('contradict floors confidence at 0 instead of going negative', () => {
    const { next } = buildNextGeneration({
      current: [base('rec-low', 'low', 0.1)],
      updates: [{ id: 'rec-low', operation: 'contradict' }],
      newLearnings: [],
      decayRate: 0,
      nowIso: '2026-09-24T12:00:00.000Z',
    });
    expect(next[0].confidence).toBe(0);
  });
});
