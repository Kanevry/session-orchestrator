/**
 * inbox-store-role.test.mjs — end-to-end behaviour of the learnings inbox
 * store role (#1516) through the real io.mjs entry points.
 *
 * Complements store-role.test.mjs (role resolution) and the #1516 block in
 * learnings-expiry-sweep.test.mjs (sweep/prune skip). Bugs these catch:
 *  - the inbox host still rewrites learnings.jsonl -> content conflict on pull;
 *  - the union read duplicates or loses an inbox record;
 *  - an archived / receipted id is resurrected from a stale inbox;
 *  - repeated inbox-role rewrites duplicate inbox lines or touch the store;
 *  - a repo that never opted in changes read results or generation tokens;
 *  - an invalid role writes as if it were writer;
 *  - a writer that crashed after its rename but before its receipt leaves an
 *    ingested record live without a receipt, so dropping it later resurrects it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendLearning,
  readLearnings,
  readLearningsSnapshot,
  rewriteLearnings,
} from '../../../scripts/lib/learnings/io.mjs';
import {
  _resetStoreRoleCacheForTests,
  LearningsStoreRoleError,
} from '../../../scripts/lib/learnings/store-role.mjs';
import { pruneLearnings, sweepExpiredLearnings } from '../../../scripts/lib/learnings/expiry-sweep.mjs';

const FUTURE = '2099-01-01T00:00:00.000Z';

function learning(id, overrides = {}) {
  return {
    id,
    type: 'recurring-issue',
    subject: `subject-${id}`,
    insight: `insight text ${id}`,
    evidence: `evidence text ${id}`,
    confidence: 0.6,
    source_session: 'sess-1',
    created_at: '2026-10-01T00:00:00.000Z',
    expires_at: FUTURE,
    schema_version: 1,
    ...overrides,
  };
}

function setRole(role) {
  vi.stubEnv('SO_LEARNINGS_STORE_ROLE', role);
  _resetStoreRoleCacheForTests();
}

function writeJsonl(file, entries) {
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function lines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'inbox-role-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetStoreRoleCacheForTests();
  rmSync(tmp, { recursive: true, force: true });
});

describe('two hosts sharing a vault repo', () => {
  it('merges a same-cycle writer rewrite and inbox append without conflict, then ingests the inbox record once', async () => {
    const origin = join(tmp, 'origin.git');
    const seed = join(tmp, 'seed');
    const hostA = join(tmp, 'host-a');
    const hostB = join(tmp, 'host-b');
    git(tmp, 'init', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', origin, seed);
    const metrics = join('.orchestrator', 'metrics');
    mkdirSync(join(seed, metrics), { recursive: true });
    writeFileSync(
      join(seed, '.gitattributes'),
      '.orchestrator/metrics/learnings-inbox.jsonl merge=union\n' +
        '.orchestrator/metrics/learnings-inbox-ingested.jsonl merge=union\n',
    );
    writeJsonl(join(seed, metrics, 'learnings.jsonl'), [learning('base')]);
    git(seed, 'checkout', '-b', 'main');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-m', 'seed');
    git(seed, 'push', 'origin', 'main');
    git(tmp, 'clone', '-b', 'main', origin, hostA);
    git(tmp, 'clone', '-b', 'main', origin, hostB);
    const storeA = join(hostA, metrics, 'learnings.jsonl');
    const storeB = join(hostB, metrics, 'learnings.jsonl');
    const storeBBefore = readFileSync(storeB, 'utf8');

    // Host A (writer): append its own record and rewrite its read with a bump.
    setRole('writer');
    await appendLearning(storeA, learning('from-a'));
    const readA = await readLearnings(storeA);
    await rewriteLearnings(
      storeA,
      readA.entries.map((e) => (e.id === 'base' ? { ...e, confidence: 0.9 } : e)),
      { backup: false },
    );

    // Host B (inbox): append a new record in the same cycle.
    setRole('inbox');
    await appendLearning(storeB, learning('from-b'));
    expect(readFileSync(storeB, 'utf8')).toBe(storeBBefore);

    git(hostA, 'add', '-A');
    git(hostA, 'commit', '-m', 'a');
    git(hostA, 'push', 'origin', 'main');
    git(hostB, 'add', '-A');
    git(hostB, 'commit', '-m', 'b');
    // Both pulls must exit 0: execFileSync throws on a merge conflict.
    git(hostB, 'pull', '--no-rebase', '--no-edit');
    git(hostB, 'push', 'origin', 'main');
    git(hostA, 'pull', '--no-rebase', '--no-edit');

    setRole('writer');
    const merged = await readLearnings(storeA);
    expect(merged.entries.map((e) => e.id).sort()).toEqual(['base', 'from-a', 'from-b']);
    expect(merged.entries.find((e) => e.id === 'base').confidence).toBe(0.9);
    expect(merged.inbox).toEqual({ visible: 1, hidden: 0, malformed: 0 });

    // Writer ingests: the inbox record moves into live, a receipt hides the inbox copy.
    await rewriteLearnings(storeA, merged.entries, { backup: false });
    const receipts = join(hostA, metrics, 'learnings-inbox-ingested.jsonl');
    expect(lines(receipts).map((l) => JSON.parse(l).id)).toEqual(['from-b']);
    const after = await readLearnings(storeA);
    expect(after.entries.map((e) => e.id).sort()).toEqual(['base', 'from-a', 'from-b']);
    expect(after.inbox).toEqual({ visible: 0, hidden: 1, malformed: 0 });
  });
});

describe('inbox visibility', () => {
  let store;
  let inbox;
  beforeEach(() => {
    store = join(tmp, 'learnings.jsonl');
    inbox = join(tmp, 'learnings-inbox.jsonl');
    setRole('writer');
  });

  it('never returns an inbox record whose id is already in the archive', async () => {
    writeJsonl(store, [learning('live')]);
    writeJsonl(inbox, [learning('expired-x')]);
    writeJsonl(join(tmp, 'learnings-archive.jsonl'), [learning('expired-x')]);

    const result = await readLearnings(store);

    expect(result.entries.map((e) => e.id)).toEqual(['live']);
    expect(result.inbox).toEqual({ visible: 0, hidden: 1, malformed: 0 });
  });

  it('returns an id that sits in both live and inbox (no receipt yet) exactly once, the live copy', async () => {
    writeJsonl(store, [learning('dup', { confidence: 0.9 })]);
    writeJsonl(inbox, [learning('dup', { confidence: 0.1 })]);

    const result = await readLearnings(store);

    expect(result.entries.map((e) => [e.id, e.confidence])).toEqual([['dup', 0.9]]);
    expect(result.inbox).toEqual({ visible: 0, hidden: 1, malformed: 0 });
  });

  it('keeps an ingested inbox record hidden after a later rewrite drops it from live without archiving', async () => {
    writeJsonl(store, [learning('live')]);
    writeJsonl(inbox, [learning('x')]);
    const withX = await readLearnings(store);
    expect(withX.entries.map((e) => e.id)).toEqual(['live', 'x']);
    await rewriteLearnings(store, withX.entries, { backup: false });

    await rewriteLearnings(store, [learning('live')], { backup: false });

    const result = await readLearnings(store);
    expect(result.entries.map((e) => e.id)).toEqual(['live']);
  });
  // Bug: a writer that crashed between its rename and appendInboxReceipts left
  // an ingested record live without a receipt; only ids VISIBLE from the inbox
  // were receipted, so it never got one and dropping it later resurrected it.
  it('receipts an inbox id that is live without a receipt, so a later drop keeps it hidden', async () => {
    const receipts = join(tmp, 'learnings-inbox-ingested.jsonl');
    writeJsonl(store, [learning('live'), learning('x')]);
    writeJsonl(inbox, [learning('x')]);

    await rewriteLearnings(store, (await readLearnings(store)).entries, { backup: false });
    expect(lines(receipts).map((l) => JSON.parse(l).id)).toEqual(['x']);

    await rewriteLearnings(store, [learning('live')], { backup: false });
    expect((await readLearnings(store)).entries.map((e) => e.id)).toEqual(['live']);
  });
});

describe('writer archives an inbox-visible record', () => {
  // Bug: the writer wrote receipts only for ids it carried into live. The
  // archive file is not synced between hosts, so on the inbox host a record
  // the writer archived straight from the inbox became visible again forever.
  it.each([
    ['expiry sweep', (store, archive) =>
      sweepExpiredLearnings({ filePath: store, archivePath: archive, dryRun: false, now: new Date('2026-10-19T00:00:00Z') })],
    ['prune', (store, archive) =>
      pruneLearnings({ filePath: store, archivePath: archive, dryRun: false, now: new Date('2026-10-19T00:00:00Z') })],
  ])('%s writes a receipt, so the record stays hidden without the archive file', async (_name, run) => {
    const store = join(tmp, 'learnings.jsonl');
    const inbox = join(tmp, 'learnings-inbox.jsonl');
    const archive = join(tmp, 'learnings-archive.jsonl');
    const receipts = join(tmp, 'learnings-inbox-ingested.jsonl');
    setRole('writer');
    writeJsonl(store, [learning('L1')]);
    writeJsonl(inbox, [learning('x-gone', { expires_at: '2026-01-01T00:00:00.000Z' })]);

    await run(store, archive);
    await run(store, archive);

    expect(lines(receipts).map((l) => JSON.parse(l).id)).toEqual(['x-gone']);
    rmSync(archive);
    const view = await readLearnings(store);
    expect(view.entries.map((e) => e.id)).toEqual(['L1']);
  });

  // Bug: a writer that died between its archive append and its receipt left
  // the record archived but unreceipted. The local archive hides it on the
  // writer, so no later run saw it and the inbox host showed it forever.
  it('heals an archived inbox record left without a receipt on the next writer rewrite', async () => {
    const store = join(tmp, 'learnings.jsonl');
    const archive = join(tmp, 'learnings-archive.jsonl');
    const receipts = join(tmp, 'learnings-inbox-ingested.jsonl');
    setRole('writer');
    writeJsonl(store, [learning('L1')]);
    writeJsonl(join(tmp, 'learnings-inbox.jsonl'), [learning('x-exp')]);
    writeJsonl(archive, [learning('x-exp')]);

    await rewriteLearnings(store, (await readLearnings(store)).entries, { backup: false });

    expect(lines(receipts).map((l) => JSON.parse(l).id)).toEqual(['x-exp']);
    rmSync(archive);
    expect((await readLearnings(store)).entries.map((e) => e.id)).toEqual(['L1']);
  });
});

describe('inbox-role rewriteLearnings', () => {
  it('leaves the live store byte-identical, appends only new ids, and is idempotent', async () => {
    const store = join(tmp, 'learnings.jsonl');
    const inbox = join(tmp, 'learnings-inbox.jsonl');
    writeJsonl(store, [learning('old')]);
    const before = readFileSync(store, 'utf8');
    setRole('inbox');
    const batch = [learning('old', { confidence: 0.99 }), learning('new')];

    await rewriteLearnings(store, batch);
    await rewriteLearnings(store, batch);

    expect(readFileSync(store, 'utf8')).toBe(before);
    expect(lines(inbox).map((l) => JSON.parse(l).id)).toEqual(['new']);
    expect(existsSync(`${store}.bak`)).toBe(false);
  });
});

describe('writer role without an inbox file', () => {
  it('returns no inbox key and a generation equal to the sha256 of the raw store text', async () => {
    const store = join(tmp, 'learnings.jsonl');
    writeJsonl(store, [learning('only')]);
    const raw = readFileSync(store, 'utf8');
    setRole('writer');

    const read = await readLearnings(store);
    const snap = await readLearningsSnapshot(store);

    expect(read.entries.map((e) => e.id)).toEqual(['only']);
    expect('inbox' in read).toBe(false);
    expect('inbox' in snap).toBe(false);
    expect(snap.generation).toMatch(/^sha256:[0-9a-f]{64}$/);
    const { digestSha256 } = await import('../../../scripts/lib/crypto-digest-utils.mjs');
    expect(snap.generation).toBe(`sha256:${digestSha256(raw)}`);
  });
});

describe('invalid store role (fail-closed)', () => {
  // Bug: an invalid role resolved to writer, so a host whose operator meant
  // `inbox` rewrote the synced store wholesale.
  it('refuses appendLearning, rewriteLearnings and a sweep apply, writing nothing', async () => {
    const store = join(tmp, 'learnings.jsonl');
    const inbox = join(tmp, 'learnings-inbox.jsonl');
    const archive = join(tmp, 'learnings-archive.jsonl');
    setRole('inbx');
    writeJsonl(store, [learning('L1'), learning('old', { expires_at: '2026-01-01T00:00:00.000Z' })]);
    const before = readFileSync(store, 'utf8');

    await expect(appendLearning(store, learning('new'))).rejects.toBeInstanceOf(LearningsStoreRoleError);
    await expect(rewriteLearnings(store, [learning('L1')], { backup: false })).rejects.toBeInstanceOf(
      LearningsStoreRoleError,
    );
    await expect(
      sweepExpiredLearnings({ filePath: store, archivePath: archive, dryRun: false, now: new Date('2026-10-19T00:00:00Z') }),
    ).rejects.toBeInstanceOf(LearningsStoreRoleError);
    await expect(
      pruneLearnings({ filePath: store, archivePath: archive, dryRun: false, now: new Date('2026-10-19T00:00:00Z') }),
    ).rejects.toBeInstanceOf(LearningsStoreRoleError);

    expect(readFileSync(store, 'utf8')).toBe(before);
    expect(existsSync(inbox)).toBe(false);
    expect(existsSync(archive)).toBe(false);
    // Readers keep working.
    expect((await readLearnings(store)).entries.map((e) => e.id)).toEqual(['L1', 'old']);
    // A dry run is no write and still runs.
    await expect(rewriteLearnings(store, [learning('L1')], { dryRun: true })).resolves.toHaveLength(1);
  });
});
