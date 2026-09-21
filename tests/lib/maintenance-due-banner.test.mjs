/**
 * tests/lib/maintenance-due-banner.test.mjs
 *
 * The probe replaces three separate nudges with ONE session-start reading, so
 * its failure modes are all "the maintenance loop runs empty and nothing says
 * so" — or the inverse, HR-101: a banner that fires on every start and teaches
 * the operator to ignore banners. Each case below names the concrete bug it
 * catches (TV-001).
 *
 * SAFETY: every case pins `repoRoot` to a throwaway tmpdir and `SO_VAULT_DIR` /
 * `CLAUDE_PROJECT_DIR` to another, so nothing reaches the real repo ledgers or
 * the operator's vault (CLAUDE.md § `vault-dir` resolves HOST-LOCALLY).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  checkMaintenanceDue,
  computeMaintenanceDue,
  MAINTENANCE_TOTAL_SIGNALS,
  MAINTENANCE_MIN_LEARNINGS,
  HOUSEKEEPING_COOLDOWN_DAYS,
  TAIL_CHUNK_BYTES,
  GENERATED_RULE_EXPIRY_HORIZON_DAYS,
} from '@lib/maintenance-due-banner.mjs';
import {
  consumeDialecticPending,
  writeDialecticLastRun,
  writeDialecticPending,
} from '@lib/auto-dialectic.mjs';

let tmpRepo;
let savedEnv;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-due-repo-'));
  savedEnv = {
    SO_VAULT_DIR: process.env.SO_VAULT_DIR,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  };
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-due-vault-'));
  process.env.SO_VAULT_DIR = vault;
  process.env.CLAUDE_PROJECT_DIR = vault;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const metricsDir = () => path.join(tmpRepo, '.orchestrator', 'metrics');

function writeMetrics(name, lines) {
  fs.mkdirSync(metricsDir(), { recursive: true });
  fs.writeFileSync(path.join(metricsDir(), name), lines.join('\n') + '\n', 'utf8');
}

/** One learning line. `expiresAt` set ⇒ sweep-eligible once past the 14d grace. */
function learning(i, { expiresAt } = {}) {
  const obj = {
    id: `learn-${i}`,
    type: 'convention',
    subject: `subject-${i}`,
    insight: 'test insight',
    evidence: 'test evidence',
    confidence: 0.9,
    source_session: 'main-2026-01-01-1',
    created_at: '2026-01-01T00:00:00.000Z',
    schema_version: 1,
  };
  if (expiresAt) obj.expires_at = expiresAt;
  return JSON.stringify(obj);
}

/** N active learnings + optional M long-expired ones. */
function writeLearnings(active, expired = 0) {
  const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const lines = [
    ...Array.from({ length: active }, (_, i) => learning(i)),
    ...Array.from({ length: expired }, (_, i) => learning(1000 + i, { expiresAt: longAgo })),
  ];
  writeMetrics('learnings.jsonl', lines);
}

/** One rule file under `.claude/rules/`. `frontmatter` goes verbatim between the fences. */
function writeRule(name, frontmatter, body = 'body') {
  const dir = path.join(tmpRepo, '.claude', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n# ${name}\n\n${body}\n`, 'utf8');
}

// ---------------------------------------------------------------------------

describe('checkMaintenanceDue', () => {
  // BUG (HR-101): an instrument that warns on a repo with nothing to maintain
  // fires on essentially every session start and is worthless within a week.
  it('is silent when nothing is due', async () => {
    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(result).toBeNull();

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due).toEqual([]);
    expect(computed.undeterminable).toEqual([]);
    expect(computed.total).toBe(MAINTENANCE_TOTAL_SIGNALS);
    expect(computed.lastHousekeeping).toBeNull();
  });

  // BUG (HR-106): a bare "4 of 7" tells the operator nothing about WHICH signal
  // fired or what number drove it — the banner must carry the numbers the
  // verdict was computed from, and must list only signals that are actually due.
  it('lists exactly the due signals with their driving numbers', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due.map((d) => d.id)).toEqual(['evolve', 'reconcile', 'sweep']);
    expect(computed.undeterminable).toEqual([]);

    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(result?.severity).toBe('warn');
    expect(result.message).toContain('⚠ maintenance due: 3 of 7');
    expect(result.message).toContain(`evolve: never, ${MAINTENANCE_MIN_LEARNINGS + 5} active learnings`);
    // HR-106 regression (learning 013a45ba): the reconcile row used to print
    // `lastRunAt`, so a repo whose backlog keeps the signal due showed THAT
    // run's own date next to the word "due" — "last run today, due today".
    // The row must carry the judgment (`computeReconcileNudge().reasons`), and
    // must never be a bare date.
    const reconcileDetail = computed.due.find((d) => d.id === 'reconcile')?.detail;
    expect(reconcileDetail).toMatch(/learnings/);
    expect(reconcileDetail).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.message).toContain(`reconcile: ${reconcileDetail}`);
    expect(result.message).toContain('sweep: 3 expired');
    expect(result.message).toContain('run /session housekeeping.');
    // Signals that are NOT due must not appear at all.
    expect(result.message).not.toContain('dialectic:');
    expect(result.message).not.toContain('memory-cleanup:');
    expect(result.message).not.toContain('undeterminable');
  });

  // BUG: without a cooldown the banner keeps demanding /session housekeeping
  // right after one ran — the signals need a whole session to clear, so the
  // instrument would nag through every start of the following week.
  it('suppresses the banner after a recent housekeeping session, without suppressing the computation', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    writeMetrics('sessions.jsonl', [
      JSON.stringify({
        session_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        session_type: 'housekeeping',
        started_at: twoDaysAgo,
        completed_at: twoDaysAgo,
        status: 'completed',
      }),
    ]);

    expect(await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} })).toBeNull();

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.lastHousekeeping).toBe(twoDaysAgo);
    expect(computed.due.map((d) => d.id)).toContain('reconcile');

    // …and the suppression expires: the same fixture read from a clock past the
    // cooldown must warn again, or the cooldown would be a permanent mute.
    const later = Date.now() + (HOUSEKEEPING_COOLDOWN_DAYS + 1) * 86_400_000;
    const afterCooldown = await checkMaintenanceDue({
      repoRoot: tmpRepo,
      config: {},
      now: later,
    });
    expect(afterCooldown?.severity).toBe('warn');
  });

  // BUG (three-state): an unreadable ledger read as "no evolve run on record"
  // would report a DUE signal it never measured — and read as clean it would
  // hide one. Neither: it goes to `undeterminable`, and the banner says so.
  it('records an unreadable events.jsonl as undeterminable, never as clean', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5);
    // A directory where a file is expected: readFileSync throws EISDIR.
    fs.mkdirSync(path.join(metricsDir(), 'events.jsonl'), { recursive: true });

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.undeterminable).toContain('evolve');
    expect(computed.due.map((d) => d.id)).not.toContain('evolve');

    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(result.message).toContain('undeterminable: evolve');
  });

  // BUG: a probe that reads a RECORDED evolve run as "never" would nag a repo
  // that is already running the loop — the absence claim must be falsifiable.
  it('clears the evolve signal when the ledger carries a completed run', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5);
    writeMetrics('events.jsonl', [
      JSON.stringify({ event: 'subagent_stop', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        event: 'orchestrator.evolve.completed',
        timestamp: '2026-09-01T10:00:00.000Z',
      }),
    ]);

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due.map((d) => d.id)).not.toContain('evolve');
    expect(computed.undeterminable).toEqual([]);
  });

  // BUG (#1414): the probe read ONLY the active events.jsonl. After a rotation
  // the single `orchestrator.evolve.completed` record on the host sits in
  // `_archive/`, so a repo that HAS run /evolve was reported as "never" and
  // nagged at every session start — the HR-101 failure mode this module exists
  // to prevent, caused by the reader rather than by the threshold.
  it('finds an evolve record that rotation moved into _archive/', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5);
    const archiveDir = path.join(metricsDir(), '_archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'events-20260101T000000Z_20260201T000000Z.jsonl'),
      JSON.stringify({
        event: 'orchestrator.evolve.completed',
        timestamp: '2026-01-15T10:00:00.000Z',
      }) + '\n',
      'utf8',
    );
    // The ACTIVE file carries no evolve record at all — only the tombstone and
    // ordinary traffic, exactly as it looks after a rotation.
    writeMetrics('events.jsonl', [
      JSON.stringify({
        event: 'orchestrator.events.rotated',
        timestamp: '2026-02-01T00:00:00.000Z',
        archived_as: path.join(archiveDir, 'events-20260101T000000Z_20260201T000000Z.jsonl'),
      }),
      JSON.stringify({ event: 'subagent_stop', timestamp: '2026-09-02T00:00:00.000Z' }),
    ]);

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due.map((d) => d.id)).not.toContain('evolve');
    expect(computed.undeterminable).toEqual([]);
  });

  // BUG (#1290 item 2): the ledger is now read BACKWARDS in TAIL_CHUNK_BYTES
  // chunks. A chunked reader that parses the partial line at the front of each
  // chunk sees a record split across the boundary as two halves, neither of
  // which is valid JSON — so a repo that HAS run /evolve is reported as "never"
  // and nagged forever. Nothing in the suite could catch this: every other
  // fixture is a few hundred bytes, well inside one chunk.
  it('finds an evolve record split across the tail-scan chunk boundary', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5);

    const evolveLine = JSON.stringify({
      event: 'orchestrator.evolve.completed',
      timestamp: '2026-09-01T10:00:00.000Z',
    });
    // Size everything AFTER the evolve line so the boundary — counted from the
    // file's END, which is where the scan starts — falls INSIDE that line.
    const afterBytes = TAIL_CHUNK_BYTES - 1 - Math.floor(evolveLine.length / 2);
    const filler = (i) =>
      JSON.stringify({ event: 'subagent_stop', timestamp: '2026-09-02T00:00:00.000Z', i }) + '\n';
    let tail = '';
    for (let i = 0; tail.length + filler(i).length <= afterBytes; i += 1) tail += filler(i);
    tail += 'x'.repeat(afterBytes - tail.length - 1) + '\n'; // pad to the exact byte
    expect(tail.length).toBe(afterBytes);

    const head = [0, 1, 2].map((i) => filler(i)).join('');
    fs.mkdirSync(metricsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(metricsDir(), 'events.jsonl'),
      head + evolveLine + '\n' + tail,
      'utf8',
    );

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due.map((d) => d.id)).not.toContain('evolve');
    expect(computed.undeterminable).toEqual([]);
  });

  // BUG: a stale pending proposal is archaeology, not a nudge — re-raising a
  // months-old sidecar every start is the HR-101 failure mode again.
  it('counts a fresh pending sidecar and ignores an aged one', async () => {
    fs.mkdirSync(path.join(tmpRepo, '.orchestrator'), { recursive: true });
    const sidecar = path.join(tmpRepo, '.orchestrator', 'pending-dream.md');
    fs.writeFileSync(sidecar, '# pending\n', 'utf8');

    const fresh = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(fresh.due.map((d) => d.id)).toContain('pending-sidecar');

    const old = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(sidecar, old, old);
    const aged = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(aged.due.map((d) => d.id)).not.toContain('pending-sidecar');
  });

  // BUG (#1380): `/evolve dialectic` never advanced `dialectic-last-run` nor
  // deleted `dialectic-pending.md`, so after a run was applied both signals
  // stayed due — the banner nagged about work that was already done. Pins the
  // Step 6.4 bookkeeping pair against the probe that reads its effects.
  it('clears dialectic + pending-sidecar once a dialectic run is recorded and its sidecar consumed', async () => {
    writeMetrics(
      'sessions.jsonl',
      Array.from({ length: 6 }, (_, i) =>
        JSON.stringify({ session_id: `s-${i}`, started_at: `2026-01-0${i + 1}T08:00:00.000Z` }),
      ),
    );
    await writeDialecticPending({ repoRoot: tmpRepo, diff: '# target: user\n## A\n- x\n' });

    const before = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(before.due.map((d) => d.id)).toEqual(expect.arrayContaining(['dialectic', 'pending-sidecar']));

    const lastRun = await writeDialecticLastRun({ repoRoot: tmpRepo, isoTimestamp: new Date().toISOString() });
    const consumed = await consumeDialecticPending({ repoRoot: tmpRepo });
    expect(lastRun.ok).toBe(true);
    expect(consumed).toMatchObject({ ok: true, consumed: true });

    const after = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(after.due.map((d) => d.id)).not.toContain('dialectic');
    expect(after.due.map((d) => d.id)).not.toContain('pending-sidecar');

    // BUG (#1388 P9): since the consume ARCHIVES the sidecar instead of deleting
    // it, a fresh file now sits in `.orchestrator/consumed/`. If the probe ever
    // widened from its explicit two-path list to a directory scan, that archive
    // would re-raise `pending-sidecar` forever — the very signal the consume
    // just cleared. Pins the archive as invisible to the probe.
    expect(fs.existsSync(consumed.archivedTo)).toBe(true);
    expect(path.dirname(consumed.archivedTo)).toBe(path.join(tmpRepo, '.orchestrator', 'consumed'));
    expect(fs.readdirSync(path.join(tmpRepo, '.orchestrator', 'consumed'))).toHaveLength(1);
    const withArchive = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(withArchive.due.map((d) => d.id)).not.toContain('pending-sidecar');
  });

  // BUG (HR-106): a constant `total: 6` reports a denominator the rule never
  // judged — with `dialectic.cadence: 0` the dialectic signal is never
  // evaluated, so "3 of 7" on such a host quotes a number nothing measured.
  it('the denominator counts the signals actually evaluated, not the constant 6', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);
    const config = { dialectic: { cadence: 0 } };

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config });
    expect(computed.skipped).toEqual(['dialectic']);
    expect(computed.total).toBe(6);
    // A skipped signal is neither due nor undeterminable — it was not judged.
    expect(computed.undeterminable).toEqual([]);
    expect(computed.due.map((d) => d.id)).toEqual(['evolve', 'reconcile', 'sweep']);

    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config });
    expect(result.message).toContain('⚠ maintenance due: 3 of 6');
  });

  // BUG (HR-106, second kill-switch): the memory-cleanup signal is skipped on a
  // non-Claude harness. Counting it would report a denominator that includes a
  // signal this platform structurally cannot evaluate.
  it('drops the memory-cleanup signal from the denominator on a non-Claude platform', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);

    const computed = await computeMaintenanceDue({
      repoRoot: tmpRepo,
      config: {},
      platform: 'codex',
    });
    expect(computed.skipped).toEqual(['memory-cleanup']);
    expect(computed.total).toBe(6);
  });

  // BUG: a dialectic signal read that advances `.orchestrator/dialectic-last-run`
  // would consume the signal it reports — every session start would silently reset
  // the cadence. Only the side-effect-free `shouldDispatchAutoDialectic()` may be
  // called here (the recording wrapper was removed in #1288).
  it('writes nothing to the repo it measures', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);
    const before = fs.readdirSync(path.join(tmpRepo, '.orchestrator'), { recursive: true }).sort();
    await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    const after = fs.readdirSync(path.join(tmpRepo, '.orchestrator'), { recursive: true }).sort();
    expect(after).toEqual(before);
  });

  // --- generated-rules-expiring (S7, #1372) --------------------------------

  // BUG (the one this signal was built to replace): the expiry invariant used to
  // live in `tests/rules/generated-corpus-expiry.test.mjs` as an assertion
  // against TODAY, so `npm test` — pre-push hook AND CI — went red on a calendar
  // date with nothing committed, blocking unrelated work, while the repair is a
  // human consolidation no test run can perform. Here the same fact is a
  // session-start row at the moment the operator can act on it.
  it('flags a generated rule expiring inside the horizon, naming the file and the date', async () => {
    const days = GENERATED_RULE_EXPIRY_HORIZON_DAYS - 4;
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    writeRule('nearly-expired.md', `auto-generated: true\nexpires-at: ${expiresAt}`);

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    const row = computed.due.find((d) => d.id === 'generated-rules-expiring');
    // HR-106: the row carries the file and the date the verdict was computed
    // from — a bare "1 rule expiring" would leave the operator grepping.
    // Since #1377 the row also names the REPAIR — the operator who is told only
    // which file expired has to rediscover that the sweep command exists. The
    // assertion pins the file+date (the HR-106 fact) and the COMMAND, not the
    // sentence around it: pinning the whole copy text makes a wording edit red
    // while catching no bug (`test-value.md` TV-002c).
    expect(row?.detail).toContain(`nearly-expired.md ${expiresAt}`);
    expect(row?.detail).toContain('scripts/sweep-expired-rules.mjs');
    expect(computed.total).toBe(MAINTENANCE_TOTAL_SIGNALS);
    expect(computed.undeterminable).toEqual([]);

    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(result.message).toContain(`generated-rules-expiring: nearly-expired.md ${expiresAt}`);
  });

  // BUG (HR-101/HR-104): the reconcile engine stamps a ~30-day TTL on every rule
  // it writes, so a horizon that reaches that far is due on essentially every
  // session start — a standing condition, not a signal. The row must be silent
  // until the expiry is actually close.
  it('stays silent on a generated rule expiring beyond the horizon', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    writeRule('fresh.md', `auto-generated: true\nexpires-at: ${expiresAt}`);

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due.map((d) => d.id)).not.toContain('generated-rules-expiring');
    expect(computed.undeterminable).toEqual([]);
    expect(computed.total).toBe(MAINTENANCE_TOTAL_SIGNALS);
  });

  // BUG: a predicate that classifies every `.md` in `.claude/rules/` as
  // machine-generated would nag about hand-written rules the reconcile engine
  // never wrote and nobody may delete. The signal is still JUDGED here, so it
  // stays in the denominator (HR-106) — it is clean, not skipped.
  it('ignores hand-written rules and still counts itself in the denominator', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    // No provenance marker anywhere — `expires-at` sits in the BODY, not the
    // frontmatter, exactly as a prose mention would.
    writeRule('hand-written.md', 'globs:\n  - "tests/**"', `see expires-at: ${expiresAt}`);

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due.map((d) => d.id)).not.toContain('generated-rules-expiring');
    expect(computed.skipped).toEqual([]);
    expect(computed.total).toBe(MAINTENANCE_TOTAL_SIGNALS);
  });

  // BUG (three-state): an unreadable `.claude/rules/` read as "no generated
  // rules" reports a clean row for a directory the probe never saw — the
  // fail-open this module's `never` vs `undeterminable` discipline forbids.
  it('records an unreadable rules directory as undeterminable, never as clean', async () => {
    // A FILE where the directory is expected → readdirSync throws ENOTDIR.
    fs.mkdirSync(path.join(tmpRepo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, '.claude', 'rules'), 'not a directory\n', 'utf8');

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.undeterminable).toContain('generated-rules-expiring');
    expect(computed.due.map((d) => d.id)).not.toContain('generated-rules-expiring');

    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(result.message).toContain('undeterminable: generated-rules-expiring');
  });
});
