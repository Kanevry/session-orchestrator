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
import { PROBES } from '../../scripts/lib/session-start-probes.mjs';

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
 * (hours before NOW), each one hour long, plus a live `events.jsonl`.
 */
async function repoWithArchives(startsAgoH) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'events-retention-'));
  dirs.push(root);
  const metrics = path.join(root, '.orchestrator', 'metrics');
  await fs.mkdir(path.join(metrics, '_archive'), { recursive: true });
  await fs.writeFile(path.join(metrics, 'events.jsonl'), '{}\n');
  for (const h of startsAgoH) {
    const from = NOW - h * HOUR;
    await fs.writeFile(path.join(metrics, '_archive', `events-${stamp(from)}_${stamp(from + HOUR)}.jsonl`), '{}\n');
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
      '⚠ events-retention: the rotated events ledger covers 0.5d (3 archives at events-rotation.max-backups: 3), but telemetry/sync reads a 1d window — older events are pruned before it reads them; raise events-rotation.max-backups or max-size-mb.',
    );
  });

  // BUG this catches (HR-101): judged without the ring-full guard, every young
  // repo — whose whole history is a few hours — "covers less than a day" and
  // the banner fires on every start although nothing was ever pruned.
  it.each([
    { label: 'the ring is not full, however young the ledger', startsAgoH: [3, 2], maxBackups: 3 },
    { label: 'a full ring covers the window', startsAgoH: [72, 48, 24], maxBackups: 3 },
  ])('stays silent when $label', async ({ startsAgoH, maxBackups }) => {
    const root = await repoWithArchives(startsAgoH);
    expect(await checkEventsRetention({ repoRoot: root, config: { 'events-rotation': { 'max-backups': maxBackups } }, now: NOW })).toBeNull();
  });

  // BUG this catches (three-state honesty): an absent ledger or an unlistable
  // `_archive/` read as "no archives" — i.e. as clean — so a measurement that
  // never happened was indistinguishable from "retention is fine".
  it('keeps not-measured and unmeasurable apart from clean', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'events-retention-'));
    dirs.push(empty);
    expect(await checkEventsRetention({ repoRoot: empty, now: NOW })).toEqual({ severity: 'ok', kind: 'not-measured', reason: 'no-events-ledger' });
    // The runner-visible half: recorded as `skipped`, never `ran-clean`.
    expect(PROBES.find((p) => p.id === 'events-retention').precondition({ repoRoot: empty })).toBe('no-events-ledger');

    const broken = await fs.mkdtemp(path.join(os.tmpdir(), 'events-retention-'));
    dirs.push(broken);
    await fs.mkdir(path.join(broken, '.orchestrator', 'metrics'), { recursive: true });
    await fs.writeFile(path.join(broken, '.orchestrator', 'metrics', '_archive'), 'not a directory');
    expect(await checkEventsRetention({ repoRoot: broken, now: NOW })).toMatchObject({ severity: 'warn', degraded: true, kind: 'unmeasurable' });
  });
});

describe('EVENTS_WINDOW_READERS census', () => {
  // BUG this catches: a hand-typed reader list cannot prove a census. A fourth
  // `readEventsWithRotations(` caller joining without a declared window would
  // be silently ignored by the probe; a listed reader dropping its constant
  // would leave the probe judging against a stale requirement.
  it('lists exactly the code callers of readEventsWithRotations, each declaring a window', async () => {
    const callers = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!e.name.endsWith('.mjs')) continue;
        const code = readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
        if (code.some((l) => /readEventsWithRotations\(/.test(l) && !/export function readEventsWithRotations/.test(l))) {
          callers.push(path.relative(path.join(REPO_ROOT, 'scripts', 'lib'), p));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'scripts'));
    walk(path.join(REPO_ROOT, 'hooks'));

    expect(callers.length).toBeGreaterThan(0);
    expect(callers.sort()).toEqual(EVENTS_WINDOW_READERS.map((r) => r.spec.replace(/^\.\//, '')).sort());
    for (const r of EVENTS_WINDOW_READERS) {
      const mod = await import(new URL(r.spec, new URL('../../scripts/lib/', import.meta.url)).href);
      const v = mod.REQUIRED_EVENTS_WINDOW_DAYS;
      expect(v === null || (Number.isFinite(v) && v > 0), `${r.label}: ${v}`).toBe(true);
    }
  });
});
