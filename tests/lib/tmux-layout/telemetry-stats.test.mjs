/**
 * tests/lib/tmux-layout/telemetry-stats.test.mjs
 *
 * Rotation-boundary coverage for scripts/lib/tmux-layout/telemetry-stats.mjs
 * (#1407). The existing suite `tests/skills/tmux-layout-telemetry.test.mjs`
 * writes ONE events.jsonl and never rotates, so neither behaviour below has a
 * test there (checked 2026-09-20: `rg -n "rotation|_archive"` over that file →
 * no matches).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ARCHIVE_DIR_NAME, ROTATION_EVENT } from '@lib/events-schema.mjs';
import {
  readTmuxEvents,
  readTmuxEventsEnvelope,
  computeStats,
} from '@lib/tmux-layout/telemetry-stats.mjs';

describe('telemetry-stats reads across rotation boundaries', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tmux-stats-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const evt = (event, timestamp, extra = {}) =>
    `${JSON.stringify({ timestamp, event, layout: 'default', schema_version: 1, ...extra })}\n`;

  const tombstone = (timestamp, archivedAs) =>
    `${JSON.stringify({
      timestamp,
      event: ROTATION_EVENT,
      archived_as: archivedAs,
      size_before: 10485760,
      lines: 120,
      first_ts: '2026-04-12T06:33:01.123Z',
      last_ts: '2026-09-18T19:14:02Z',
      malformed_lines: 0,
      schema_version: 1,
    })}\n`;

  function archivePath(name) {
    mkdirSync(path.join(dir, ARCHIVE_DIR_NAME), { recursive: true });
    return path.join(dir, ARCHIVE_DIR_NAME, name);
  }

  it('counts archived invocations, so one rotation cannot flip the promotion gate', () => {
    // BUG THIS CATCHES (#1407): `readTmuxEvents` read only the active file, so
    // the ALL-TIME rate of the #563 promotion gate silently meant "since the
    // last rotation". Here 5 of the 6 invocations sit in the archive: reading
    // the active file alone yields 1 invocation and `meetsPromotionGate:false`
    // — the gate flips on a rotation, not on behaviour.
    const active = path.join(dir, 'events.jsonl');
    const archived = archivePath('events-20260412T063301Z_20260918T191402Z.jsonl');

    let body = '';
    for (let i = 0; i < 5; i += 1) {
      body += evt('tmux-layout.invoked', `2026-09-1${i}T10:00:00.000Z`);
      body += evt('tmux-layout.completed', `2026-09-1${i}T10:00:01.000Z`);
    }
    writeFileSync(archived, body);
    writeFileSync(
      active,
      tombstone('2026-09-19T07:00:00.000Z', archived) +
        evt('tmux-layout.invoked', '2026-09-19T08:00:00.000Z') +
        evt('tmux-layout.completed', '2026-09-19T08:00:01.000Z'),
    );

    const stats = computeStats(readTmuxEvents(active));

    expect(stats.invocations).toBe(6);
    expect(stats.completions).toBe(6);
    expect(stats.completionRate).toBe(1);
    expect(stats.meetsPromotionGate).toBe(true);
  });

  it('reports a missing archive as a gap instead of an empty window', () => {
    // BUG THIS CATCHES (#1407 AC-3): a deleted archive and a quiet week are
    // indistinguishable when the reader returns a bare array. `complete:false`
    // plus the tombstone's range is the only thing that tells them apart.
    const active = path.join(dir, 'events.jsonl');
    const vanished = archivePath('events-20260412T063301Z_20260918T191402Z.jsonl');
    // `vanished` is deliberately never written.

    writeFileSync(
      active,
      tombstone('2026-09-19T07:00:00.000Z', vanished) +
        evt('tmux-layout.invoked', '2026-09-19T08:00:00.000Z'),
    );

    const envelope = readTmuxEventsEnvelope(active);

    expect(envelope.complete).toBe(false);
    expect(envelope.gaps).toEqual([
      expect.objectContaining({
        kind: 'missing-archive',
        archived_as: vanished,
        first_ts: '2026-04-12T06:33:01.123Z',
        last_ts: '2026-09-18T19:14:02Z',
      }),
    ]);
    // The surviving records are still returned — a gap is a finding, not a throw.
    expect(envelope.events).toHaveLength(1);
  });
});
