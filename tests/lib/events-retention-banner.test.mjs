/**
 * tests/lib/events-retention-banner.test.mjs — #1401 part 3 (variant a).
 *
 * The probe compares the time span the retained `_archive/` ring plus the live
 * ledger cover against the largest `REQUIRED_EVENTS_WINDOW_DAYS` any reader of
 * the rotated ledger declares. Fixtures use the real archive-name shape
 * (`events-<YYYYMMDDTHHMMSSZ>_<YYYYMMDDTHHMMSSZ>.jsonl`, `events-rotation.mjs`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  checkEventsRetention,
  EVENTS_WINDOW_READERS,
} from '../../scripts/lib/events-retention-banner.mjs';
import { PROBES, runSessionStartProbes } from '../../scripts/lib/session-start-probes.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+/, '').replace(/[-:]/g, '');

const dirs = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop(), { recursive: true, force: true });
});

/**
 * A repo root whose `_archive/` holds one archive per entry of `startsAgoH`
 * (hours before NOW), each one hour long, plus a live `events.jsonl` — stamped
 * `activeAgoH` hours before NOW when given, stampless otherwise. A string
 * entry is written verbatim as the archive's file name.
 */
async function repoWithArchives(startsAgoH, activeAgoH) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'events-retention-'));
  dirs.push(root);
  const metrics = path.join(root, '.orchestrator', 'metrics');
  await fs.mkdir(path.join(metrics, '_archive'), { recursive: true });
  const active = activeAgoH === undefined
    ? '{}\n'
    : `${JSON.stringify({ event: 'subagent_stop', timestamp: new Date(NOW - activeAgoH * HOUR).toISOString() })}\n`;
  await fs.writeFile(path.join(metrics, 'events.jsonl'), active);
  for (const h of startsAgoH) {
    const from = NOW - h * HOUR;
    const name = typeof h === 'string' ? h : `events-${stamp(from)}_${stamp(from + HOUR)}.jsonl`;
    await fs.writeFile(path.join(metrics, '_archive', name), '{}\n');
  }
  return root;
}

describe('checkEventsRetention', () => {
  // BUG this catches (#1401): `max-backups` bounds the archive COUNT, so a high
  // write rate shrinks the retained TIME span below what telemetry/sync reads
  // (1 day) and the pruned records vanish without anyone being told.
  it('warns when a FULL ring covers less than the largest declared reader window', async () => {
    const root = await repoWithArchives([12, 9, 6]);
    const out = await checkEventsRetention({ repoRoot: root, config: { 'events-rotation': { 'max-backups': 3 } }, now: NOW });

    expect(out).toMatchObject({ severity: 'warn', kind: 'retention-short', requiredDays: 1, requiredBy: 'telemetry/sync', archives: 3, maxBackups: 3 });
    expect(out.message).toBe(
      '⚠ events-retention: the rotated events ledger covers 0.5d (3 archives at events-rotation.max-backups: 3), less than the 1d window telemetry/sync declares as REQUIRED_EVENTS_WINDOW_DAYS — events older than 0.5d are not retained; raise events-rotation.max-backups or max-size-mb.',
    );
  });

  // BUG this catches (HR-101): judged without the ring-full guard, every young
  // repo — whose whole history is a few hours — "covers less than a day" and
  // the banner fires on every start although nothing was ever pruned.
  // The `unknown_` row: an archive whose first stamp the rotator could not
  // derive must fall back to its LAST stamp. Without it the start is NaN,
  // `Math.min` turns NaN, `NaN >= 1` is false and the banner warns "covers
  // NaNd" on every start — permanently, since the rotator sorts `unknown_`
  // newest and never prunes it. The dated archives are 12h/6h old, so
  // dropping the unknown archive instead would warn too.
  // BUG this also catches (HR-105, #1489): a silent answer that drops the
  // measurement — `null` — makes a probe that never fires indistinguishable
  // from a dead one. The no-archive row is where 31 of 35 fleet ledgers sit
  // (2026-10-02): coverage must come from the active file's first stamp there.
  it.each([
    { label: 'the ring is not full, however young the ledger', startsAgoH: [3, 2], maxBackups: 3, kind: 'ring-not-full', coverageDays: 0.125, oldestEventAt: '2026-10-02T09:00:00.000Z', archives: 2 },
    { label: 'no archive exists yet', startsAgoH: [], activeAgoH: 36, maxBackups: 3, kind: 'ring-not-full', coverageDays: 1.5, oldestEventAt: '2026-10-01T00:00:00.000Z', archives: 0 },
    { label: 'a full ring covers the window', startsAgoH: [72, 48, 24], maxBackups: 3, kind: 'covered', coverageDays: 3, oldestEventAt: '2026-09-29T12:00:00.000Z', archives: 3 },
    {
      label: 'a full ring covers the window from an archive whose first stamp is unknown',
      startsAgoH: [`events-unknown_${stamp(NOW - 72 * HOUR)}.jsonl`, 12, 6],
      maxBackups: 3,
      kind: 'covered',
      coverageDays: 3,
      oldestEventAt: '2026-09-29T12:00:00.000Z',
      archives: 3,
    },
  ])('stays silent but carries the coverage when $label', async ({ startsAgoH, activeAgoH, maxBackups, kind, coverageDays, oldestEventAt, archives }) => {
    const root = await repoWithArchives(startsAgoH, activeAgoH);
    const out = await checkEventsRetention({ repoRoot: root, config: { 'events-rotation': { 'max-backups': maxBackups } }, now: NOW });

    expect(out).toEqual({
      severity: 'ok',
      kind,
      coverageDays,
      oldestEventAt,
      requiredDays: 1,
      requiredBy: 'telemetry/sync',
      archives,
      maxBackups,
    });
  });

  // BUG this catches (three-state honesty): an absent ledger or an unlistable
  // `_archive/` read as "no archives" — i.e. as clean — so a measurement that
  // never happened was indistinguishable from "retention is fine".
  it('keeps not-measured and unmeasurable apart from clean', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'events-retention-'));
    dirs.push(empty);
    expect(await checkEventsRetention({ repoRoot: empty, now: NOW })).toEqual({ severity: 'ok', kind: 'not-measured', reason: 'no-events-ledger' });

    const broken = await fs.mkdtemp(path.join(os.tmpdir(), 'events-retention-'));
    dirs.push(broken);
    await fs.mkdir(path.join(broken, '.orchestrator', 'metrics'), { recursive: true });
    await fs.writeFile(path.join(broken, '.orchestrator', 'metrics', '_archive'), 'not a directory');
    expect(await checkEventsRetention({ repoRoot: broken, now: NOW })).toMatchObject({ severity: 'warn', degraded: true, kind: 'unmeasurable' });
  });

  // BUG this catches (#1401 review): the registry precondition took the mere
  // existence of `_archive/` for a ledger, so an empty or foreign-only archive
  // directory ran the probe, whose `not-measured` answer (severity ok) the
  // runner recorded as `ran-clean` — a measurement that never happened, scored
  // clean. The unlistable row pins the other direction: the stricter
  // precondition must not skip a directory it cannot read.
  it.each([
    { label: 'no metrics directory', setup: async () => {}, outcome: 'skipped' },
    { label: 'an empty _archive/', setup: (m) => fs.mkdir(path.join(m, '_archive'), { recursive: true }), outcome: 'skipped' },
    {
      label: 'an _archive/ holding only a foreign file',
      setup: async (m) => {
        await fs.mkdir(path.join(m, '_archive'), { recursive: true });
        await fs.writeFile(path.join(m, '_archive', 'events-wt-x-20261001T000000Z.jsonl'), '{}\n');
      },
      outcome: 'skipped',
    },
    {
      label: 'an unlistable _archive/',
      setup: async (m) => {
        await fs.mkdir(m, { recursive: true });
        await fs.writeFile(path.join(m, '_archive'), 'not a directory');
      },
      outcome: 'ran-warn',
    },
  ])('records $label as $outcome through the real runner', async ({ setup, outcome }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'events-retention-'));
    dirs.push(root);
    await setup(path.join(root, '.orchestrator', 'metrics'));
    const probe = PROBES.find((p) => p.id === 'events-retention');

    const out = await runSessionStartProbes({ repoRoot: root, config: {} }, { probes: [probe], emit: async () => {} });

    expect(out.results).toHaveLength(1);
    expect(out.results[0].outcome).toBe(outcome);
    if (outcome === 'skipped') expect(out.results[0].reason).toBe('no-events-ledger');
  });
});

describe('EVENTS_WINDOW_READERS census', () => {
  // BUG this catches: a hand-typed reader list cannot prove a census. A caller
  // of any of the three rotated-ledger readers joining without a declared
  // window would be silently ignored by the probe; a listed reader dropping its
  // constant would leave the probe judging against a stale requirement. #1489:
  // the census once matched `readEventsWithRotations(` only, so the three
  // `scanEventsBackwards(` / `listEventSourcesNewestFirst(` callers went unlisted.
  it('lists exactly the code callers of the rotated-ledger readers, each declaring a window', async () => {
    const READER_CALL = /\b(readEventsWithRotations|scanEventsBackwards|listEventSourcesNewestFirst)\(/;
    // The library that DEFINES the three readers; its internal call is the
    // implementation, not a reader of the ledger.
    const definingModule = path.join(REPO_ROOT, 'scripts', 'lib', 'events.mjs');
    const callers = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!e.name.endsWith('.mjs') || p === definingModule) continue;
        const code = readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
        if (code.some((l) => READER_CALL.test(l))) {
          callers.push(path.relative(path.join(REPO_ROOT, 'scripts', 'lib'), p));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'scripts'));
    walk(path.join(REPO_ROOT, 'hooks'));
    walk(path.join(REPO_ROOT, 'skills'));

    expect(callers.length).toBeGreaterThan(0);
    expect(callers.sort()).toEqual(EVENTS_WINDOW_READERS.map((r) => r.spec.replace(/^\.\//, '')).sort());
    for (const r of EVENTS_WINDOW_READERS) {
      const mod = await import(new URL(r.spec, new URL('../../scripts/lib/', import.meta.url)).href);
      const v = mod.REQUIRED_EVENTS_WINDOW_DAYS;
      expect(v === null || (Number.isFinite(v) && v > 0), `${r.label}: ${v}`).toBe(true);
    }
  });
});
