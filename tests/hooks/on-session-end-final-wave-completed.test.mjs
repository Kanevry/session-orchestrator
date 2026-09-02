/**
 * tests/hooks/on-session-end-final-wave-completed.test.mjs
 *
 * Regression tests for #1193 — the FINAL `orchestrator.wave.completed`.
 *
 * The bug each case names: `hooks/post-tool-batch-wave-signal.mjs` closes wave
 * N-1 only at an N-1→N transition, so the LAST wave of a session was never
 * closed by anybody (measured fleet-wide 2026-09-02: 1018 started vs 722
 * completed — 296 gaps over 296 wave runs, i.e. exactly one missing final
 * completion per run). `hooks/on-session-end.mjs` is now that emitter, and the
 * `last_wave_completed` high-water mark keeps it emitting AT MOST once.
 *
 * Strategy mirrors tests/hooks/on-session-end.test.mjs: spawn the hook with a
 * controlled CLAUDE_PROJECT_DIR + stdin, then read events.jsonl. The ambient
 * env is scrubbed of the operator's own session identity and telemetry config,
 * so a spawn-based hook test cannot inherit either.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { telemetryIsolationEnv } from '../_helpers/telemetry-isolation.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-session-end.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');
const SESSION_REL = path.join('.orchestrator', 'current-session.json');

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ose-final-wave-'));
  tmpDirs.push(dir);
  return dir;
}

/** Write current-session.json verbatim (string form so malformed input is testable). */
async function writeSessionFile(projectDir, contents) {
  await fs.mkdir(path.join(projectDir, '.orchestrator'), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, SESSION_REL),
    typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2) + '\n',
  );
}

async function readSessionFile(projectDir) {
  return JSON.parse(await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8'));
}

async function readEvents(projectDir) {
  try {
    const raw = await fs.readFile(path.join(projectDir, EVENTS_REL), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const waveCompleted = (events) => events.filter((e) => e.event === 'orchestrator.wave.completed');

/**
 * Ownership fixtures. The ids are UUID-shaped ON PURPOSE: `resolveSession()`
 * keeps a stdin id only when `parseSessionId()` calls it a UUID, and otherwise
 * falls back to the file's id — which would make ANY non-UUID stdin id read as
 * "owning" and hide the very guard these cases pin.
 */
const MINE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** stdin for a SessionEnd of the session that current-session.json describes. */
const owningStdin = (reason = 'other') => JSON.stringify({ session_id: MINE, reason });

function runHook({ projectDir, stdin = '{}' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
        // A spawn-based hook test inherits the OPERATOR's live session identity
        // otherwise — which would let a real semantic id leak into the fixture's
        // attestation path and make these assertions machine-dependent.
        CLAUDE_CODE_SESSION_ID: undefined,
        CLAUDE_SESSION_ID: undefined,
        ...telemetryIsolationEnv(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe('on-session-end — final orchestrator.wave.completed (#1193)', () => {
  it('emits exactly one wave.completed for an unclosed last wave and persists the marker', async () => {
    // Catches: the last wave of every session was silently never closed.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, {
      session_id: MINE, last_wave: 3, semantic_session_id: 'fixture-1',
    });

    const { code } = await runHook({ projectDir, stdin: owningStdin() });
    expect(code).toBe(0);

    const events = await readEvents(projectDir);
    const waves = waveCompleted(events);
    expect(waves).toHaveLength(1);
    expect(waves[0].wave_number).toBe(3);
    expect(waves[0].reason).toBe('session-end');
    expect(waves[0].emitted_by).toBe('on-session-end');

    expect((await readSessionFile(projectDir)).last_wave_completed).toBe(3);

    // …and the terminal lifecycle event is still emitted.
    expect(events.some((e) => e.event === 'orchestrator.session.ended')).toBe(true);
  });

  it.each([
    {
      // Catches: a duplicate completion for a wave post-tool-batch already closed.
      label: 'the last wave was already closed by an N+1 transition',
      session: { session_id: MINE, last_wave: 3, last_wave_completed: 3 },
    },
    {
      // Catches: a fabricated wave 0 for a session that never batched.
      label: 'last_wave is 0',
      session: { session_id: MINE, last_wave: 0 },
    },
    {
      // Catches: an invented completion for a session with no wave lifecycle at all.
      label: 'last_wave is absent (Express-Path / coordinator-direct)',
      session: { session_id: MINE, semantic_session_id: 'fixture-no-wave' },
    },
  ])('emits nothing when $label', async ({ session }) => {
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, session);

    await runHook({ projectDir, stdin: owningStdin() });

    expect(waveCompleted(await readEvents(projectDir))).toHaveLength(0);
  });

  it('is idempotent across two SessionEnd runs on the same session file', async () => {
    // Catches: clear-then-end (or a double SessionEnd) doubling the completion.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, { session_id: MINE, last_wave: 2 });

    await runHook({ projectDir, stdin: owningStdin() });
    await runHook({ projectDir, stdin: owningStdin() });

    const waves = waveCompleted(await readEvents(projectDir));
    expect(waves).toHaveLength(1);
    expect(waves[0].wave_number).toBe(2);
  });

  it('tolerates a malformed current-session.json: exit 0, session.ended still emitted, no wave event', async () => {
    // Catches: the new read/RMW throwing and taking session teardown with it.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, '{ not json at all');

    const { code } = await runHook({ projectDir, stdin: owningStdin() });
    expect(code).toBe(0);

    const events = await readEvents(projectDir);
    expect(events.some((e) => e.event === 'orchestrator.session.ended')).toBe(true);
    expect(waveCompleted(events)).toHaveLength(0);
  });

  it('emits NOTHING and leaves the file untouched when the ending session is not the recorded one (F1)', async () => {
    // Catches: session A's SessionEnd closing live session B's wave 3 AND
    // stamping last_wave_completed into B's file, so B's own SessionEnd then
    // stays silent — the #1193 gap preserved on the wrong session. Two windows
    // share one working copy routinely; current-session.json describes whoever
    // ran SessionStart last, not whoever is ending.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, {
      session_id: OTHER, last_wave: 3, semantic_session_id: 'peer-session',
    });
    const before = await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8');

    const { code } = await runHook({
      projectDir,
      stdin: JSON.stringify({ session_id: MINE, reason: 'other' }),
    });
    expect(code).toBe(0);

    const events = await readEvents(projectDir);
    expect(waveCompleted(events)).toHaveLength(0);
    // The peer's marker is untouched — byte-for-byte.
    expect(await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8')).toBe(before);
    expect(Object.hasOwn(await readSessionFile(projectDir), 'last_wave_completed')).toBe(false);
    // The terminal event still fires; only the wave claim is withheld.
    expect(events.some((e) => e.event === 'orchestrator.session.ended')).toBe(true);
  });

  it('emits NOTHING and leaves the file untouched when stdin carries NO session_id (F-A)', async () => {
    // Catches the self-fulfilling ownership predicate: `resolveSession()` used
    // to assign the FILE's id to `sessionId` and only then compare the two, so
    // an id-less SessionEnd always read as "I am the recorded session". A peer
    // running SessionEnd with `{"reason":"other"}` therefore closed THIS
    // session's wave 3 and stamped last_wave_completed into its file, after
    // which the real owner's SessionEnd stayed silent — the #1193 gap
    // preserved on the wrong session, by the guard meant to prevent it.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, {
      session_id: OTHER, last_wave: 3, semantic_session_id: 'peer-session',
    });
    const before = await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8');

    const { code } = await runHook({
      projectDir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
    });
    expect(code).toBe(0);

    const events = await readEvents(projectDir);
    expect(waveCompleted(events)).toHaveLength(0);
    expect(await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8')).toBe(before);

    // The same hollow predicate gated these two since #863 — they are withheld
    // for exactly the same reason.
    const ended = events.find((e) => e.event === 'orchestrator.session.ended');
    expect(ended).toBeDefined();
    expect(Object.hasOwn(ended, 'duration_ms')).toBe(false);
    expect(Object.hasOwn(ended, 'semantic_session_id')).toBe(false);
  });

  it('emits NOTHING when the stdin session_id is not UUID-shaped (F-A)', async () => {
    // Catches the same hole reached via a semantic-id-sending harness: a
    // non-UUID stdin id is discarded by `parseSessionId`, lands in the fallback,
    // and then compared against the value it was just copied from.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, {
      session_id: OTHER, last_wave: 4, semantic_session_id: 'peer-session',
    });
    const before = await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8');

    const { code } = await runHook({
      projectDir,
      stdin: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'main-2026-09-02-session-11',
        reason: 'other',
      }),
    });
    expect(code).toBe(0);

    const events = await readEvents(projectDir);
    expect(waveCompleted(events)).toHaveLength(0);
    expect(await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8')).toBe(before);

    const ended = events.find((e) => e.event === 'orchestrator.session.ended');
    expect(Object.hasOwn(ended, 'duration_ms')).toBe(false);
    expect(Object.hasOwn(ended, 'semantic_session_id')).toBe(false);
  });

  it.each(['clear', 'resume'])('emits NOTHING on reason=%s — the logical session continues (F2)', async (reason) => {
    // Catches: /clear (or a resume) mid-wave closing a LIVE wave, whose marker
    // on-session-start.mjs then preserves, suppressing the real completion.
    // `resume` is the SAME class as `clear` — on-session-start.mjs preserves
    // last_wave/last_wave_completed across both — and is the MORE common of the
    // two (fleet n=1498, 2026-09-02: 12 resume vs 9 clear).
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, { session_id: MINE, last_wave: 3 });

    const { code } = await runHook({ projectDir, stdin: owningStdin(reason) });
    expect(code).toBe(0);

    const events = await readEvents(projectDir);
    expect(waveCompleted(events)).toHaveLength(0);
    expect(Object.hasOwn(await readSessionFile(projectDir), 'last_wave_completed')).toBe(false);
    expect(events.some((e) => e.event === 'orchestrator.session.ended')).toBe(true);
  });
  it('re-verifies ownership on the SECOND read of current-session.json (TOCTOU)', async () => {
    // Catches: ownership is attested in resolveSession() against the FIRST read
    // of current-session.json, while last_wave/last_wave_completed are taken
    // from a SECOND read inside emitFinalWaveCompleted(). Without a re-check
    // there, the emitter trusts a stale attestation. A genuine swap BETWEEN the
    // two reads needs a seam that is deliberately NOT added; this pins the
    // re-check itself with a peer-owned file, which the re-verify refuses on
    // its own even if the first-read attestation were ever to pass.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, { session_id: OTHER, last_wave: 6 });
    const before = await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8');

    const { code } = await runHook({ projectDir, stdin: owningStdin() });
    expect(code).toBe(0);

    expect(waveCompleted(await readEvents(projectDir))).toHaveLength(0);
    expect(await fs.readFile(path.join(projectDir, SESSION_REL), 'utf8')).toBe(before);
  });

  it('emits NOTHING when the marker is AHEAD of last_wave, and never lowers it', async () => {
    // Catches Q3-MED-3: the batch hook's explicit `wave-complete{5}` branch can
    // leave last_wave_completed ABOVE last_wave. The old `lastWave !== marker`
    // compare then read "different" as "unclosed", emitted a DUPLICATE
    // completed(4) and walked the marker BACKWARDS to 4.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, { session_id: MINE, last_wave: 4, last_wave_completed: 5 });

    const { code } = await runHook({ projectDir, stdin: owningStdin() });
    expect(code).toBe(0);

    expect(waveCompleted(await readEvents(projectDir))).toHaveLength(0);
    expect((await readSessionFile(projectDir)).last_wave_completed).toBe(5);
  });

  it('treats a string marker as ABSENT, not as "different" (Q3-LOW-4)', async () => {
    // Catches: a hand-edited or legacy file carrying last_wave_completed: '3'
    // against last_wave: 3. The old strict `!==` compared 3 to '3', called them
    // different, and emitted a duplicate completion for an already-closed wave.
    const projectDir = await mkProject();
    await writeSessionFile(projectDir, { session_id: MINE, last_wave: 3, last_wave_completed: '3' });

    const { code } = await runHook({ projectDir, stdin: owningStdin() });
    expect(code).toBe(0);

    const waves = waveCompleted(await readEvents(projectDir));
    expect(waves).toHaveLength(1);
    expect(waves[0].wave_number).toBe(3);
    expect((await readSessionFile(projectDir)).last_wave_completed).toBe(3);
  });
});
