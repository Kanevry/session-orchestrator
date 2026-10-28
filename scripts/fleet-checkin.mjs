#!/usr/bin/env node
/**
 * fleet-checkin.mjs — write this session's fleet check-in (#1462, PRD !53 § 3.2).
 *
 * Thin CLI over `scripts/lib/fleet-protocol.mjs`, called by session-start
 * Phase 7.6 and the operations-contract peer preflight BEFORE the first writing
 * action of a session.
 *
 * Usage:
 *   echo '<check-in JSON>' | node scripts/fleet-checkin.mjs
 *
 * Reads one JSON object from stdin, stamps `zeit` (always overwritten), validates
 * it with `validateCheckin()`, and writes it atomically (tmp file + rename in
 * the target directory, mode 0600) to `<navigatorDir>/checkin/<session>.json`.
 * Then reads the navigator lease and emits `orchestrator.fleet.checkin` with the
 * payload `{ session, repo, modus, kandidaten, navigator_state }` — no paths, no
 * quota, no `auftrag_ref`.
 * Without fleet integration, valid input exits 0 with `skipped: "no-fleet"` and no directory, file or event.
 * That holds for `plattform: "kopflos"` too: the record cannot prove a coordinator started the run,
 * and a write would create the navigator directory, which then flips every later solo session to
 * fleet. A headless run without fleet integration applies the Standard-Auflagen instead (#1559 review).
 *
 * Identity (#1839): the semantic id collides across repos on the same day. When
 * this process's native id (`readProcessLocalSessionIds()`: platform-selected
 * `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`, none when an inherited id
 * contradicts the other) is a native UUID, it is stamped as `session_uuid`
 * (a process-local witness, overriding any input value); otherwise an input
 * `session_uuid` is kept and validated. When the semantic file is
 * occupied by another repo and a `session_uuid` is set, the check-in is written
 * ONCE more under `checkin/<session_uuid>.json` — `session` stays the semantic
 * id. Every refusal emits `orchestrator.fleet.checkin_rejected` with
 * `{ session, repo, reason: 'occupied'|'changed', fallback: 'uuid'|'none' }`
 * (best-effort, never changes the exit code).
 *
 * stdout: one JSON line
 * `{ ok, path, key, key_fallback, navigator_state, navigator_adresse, fallback_due_at, event }`.
 * `key` is the file key actually used (the semantic id or the UUID),
 * `key_fallback` is true when it is the UUID.
 * `navigator_adresse` is the active lease's `adresse` exactly as
 * `readNavigatorLease()` validated it (a ListAgents peer name), else `null` — no
 * active lease, no address in it, or one the validator refused. It is the only
 * value the caller may address a hint to; an unvalidated string never reaches it.
 * `fallback_due_at` is `fallbackDueAt(zeit, navigator_state)`: when the
 * Standard-Auflagen apply if no `auflagen/` file has appeared by then. It is
 * stdout only — the check-in FILE schema, which the navigator reads, is unchanged.
 *
 * Exit codes:
 *   0 — check-in written (an event failure only WARNs; `event: false` on stdout)
 *   1 — write error
 *   2 — invalid input (no write/event), or the semantic session ID refused
 *       (occupied by another repo, or changed during the check) with no UUID
 *       fallback written (no write; only the `checkin_rejected` event)
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitEvent } from './lib/events.mjs';
import {
  checkinPath,
  fleetIntegrationEnabled,
  fallbackDueAt,
  isNativeUuid,
  navigatorDir,
  readNavigatorLease,
  utcSecondsTimestamp,
  validateCheckin,
} from './lib/fleet-protocol.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { openNoFollow } from './lib/no-follow-open.mjs';
import { readProcessLocalSessionIds } from './lib/session-identity/own-session.mjs';

const PREFIX = 'fleet-checkin:';

/** @returns {Promise<string>} */
async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Create `<navigatorDir>/checkin/` (0700) and write `record` atomically to
 * `target` (0600). Refuses a `checkin/` that is not a real directory, so a
 * planted symlink cannot redirect the chmod or the write.
 * @param {string} target
 * @param {object} record
 * @param {object} [options]
 * @param {typeof openNoFollow} [options.open] opener for the ownership read.
 *   Injectable only so tests can reach the fail-closed `ERR_FILE_CHANGED`
 *   branch, which `openNoFollow` never takes on POSIX; production passes nothing.
 * @param {(reason: 'occupied'|'changed') => void} [options.onRefused] called
 *   with the refusal reason right before returning false (#1839).
 * @returns {Promise<boolean>} false when another repo already owns the target,
 *   or the target changed during the ownership check
 */
export async function writeCheckinFile(target, record, { open = openNoFollow, onRefused } = {}) {
  const checkinDir = path.dirname(target);
  await fs.mkdir(navigatorDir(), { recursive: true, mode: 0o700 });
  await fs.mkdir(checkinDir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(checkinDir);
  if (!st.isDirectory()) throw new Error(`${checkinDir} is not a directory`);
  // mkdir's mode does not apply to a directory that already existed.
  await fs.chmod(checkinDir, 0o700);

  const tmp = path.join(checkinDir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    // `wx`: never follow or reuse a pre-existing path at the tmp name.
    await fs.writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // The creation mode is filtered through the umask; pin it explicitly.
    await fs.chmod(tmp, 0o600);
    let existing;
    try {
      // Never follow a symlink at the target and never block on a FIFO; the
      // helper also covers platforms without O_NOFOLLOW (win32, #1744).
      const handle = await open(target);
      try {
        const stat = await handle.stat();
        const limit = 64 * 1024;
        // Check-ins are small: non-files and larger targets are unreadable for
        // this guard and fail-open. Bound reads even if the file grows after stat.
        if (stat.isFile() && stat.size <= limit) {
          const buffer = Buffer.alloc(limit);
          let length = 0;
          while (length < limit) {
            const { bytesRead } = await handle.read(buffer, length, limit - length, length);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          if ((await handle.stat()).size <= limit) {
            existing = JSON.parse(buffer.subarray(0, length).toString('utf8'));
          }
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      // A target swapped during the check may hide a foreign check-in: fail closed.
      if (err?.code === 'ERR_FILE_CHANGED') {
        await fs.rm(tmp, { force: true });
        process.stderr.write(`${PREFIX} check-in target ${path.basename(target)} changed during the safety check; refusing to overwrite\n`);
        onRefused?.('changed');
        return false;
      }
      // Fail-open otherwise: a missing (first write), symlinked, non-regular,
      // unreadable or invalid-JSON target gives the navigator no readable
      // check-in to preserve. `rename` replaces a symlink itself, never follows it.
    }
    if (typeof existing?.repo === 'string' && existing.repo !== record.repo) {
      await fs.rm(tmp, { force: true });
      process.stderr.write(`${PREFIX} check-in key ${path.basename(target, '.json')} (session ${record.session}) is already occupied by another repo: ${JSON.stringify(existing.repo)}\n`);
      onRefused?.('occupied');
      return false;
    }
    // BV-004 ceiling: protects an already-visible foreign check-in, not concurrent
    // writers between read and rename; revisit with atomic coordination when a
    // simultaneous cross-repo collision is observed.
    await fs.rename(tmp, target);
    return true;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** @returns {Promise<number>} exit code */
async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.stderr.write(`${PREFIX} stdin is not valid JSON\n`);
    return 2;
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    process.stderr.write(`${PREFIX} stdin must be a JSON object\n`);
    return 2;
  }

  const record = { ...input, zeit: utcSecondsTimestamp() };
  // A process-local witness replaces a shared one (#1839). The platform-selected
  // reader yields nothing when an inherited Claude id contradicts a Codex one.
  // BV-004 ceiling: a non-harness child that inherits ONLY CLAUDE_CODE_SESSION_ID
  // still stamps its parent's UUID (the repo check confines any mix-up to one
  // repo); revisit when a harness without its own id env runs this CLI.
  const [nativeId] = readProcessLocalSessionIds();
  if (isNativeUuid(nativeId)) record.session_uuid = nativeId;
  const errors = validateCheckin(record);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`${PREFIX} ${e}\n`);
    return 2;
  }

  if (!fleetIntegrationEnabled()) {
    process.stdout.write(JSON.stringify({
      ok: true,
      skipped: 'no-fleet',
      path: null,
      key: null,
      key_fallback: false,
      navigator_state: 'none',
      navigator_adresse: null,
      fallback_due_at: null,
      event: false,
    }) + '\n');
    return 0;
  }

  const repoRoot = (process.env.CLAUDE_PROJECT_DIR || '').trim() || process.cwd();
  /** @param {string} reason @param {'uuid'|'none'} fallback */
  const emitRejected = async (reason, fallback) => {
    try {
      await emitEvent(
        'orchestrator.fleet.checkin_rejected',
        { session: record.session, repo: record.repo, reason, fallback },
        { repoRoot },
      );
    } catch (err) {
      process.stderr.write(
        `${PREFIX} WARN: checkin_rejected event emission failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  let key = record.session;
  let target = checkinPath(key);
  /** @type {'occupied'|'changed'|null} */
  let refused = null;
  try {
    if (!await writeCheckinFile(target, record, { onRefused: (r) => { refused = r; } })) {
      const reason = refused ?? 'occupied';
      let fallbackOk = false;
      if (reason === 'occupied' && typeof record.session_uuid === 'string') {
        key = record.session_uuid;
        target = checkinPath(key);
        fallbackOk = await writeCheckinFile(target, record);
      }
      refused = null;
      await emitRejected(reason, fallbackOk ? 'uuid' : 'none');
      if (!fallbackOk) return 2;
    }
  } catch (err) {
    // A retry that throws after a refusal still counts the refusal.
    if (refused) await emitRejected(refused, 'none');
    process.stderr.write(`${PREFIX} write failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const navigator = await readNavigatorLease();
  const navigatorState = navigator.state;
  // readNavigatorLease() returns a lease only when it passed validation, its
  // `adresse` included (an invalid one makes the whole lease `unreadable`).
  const navigatorAdresse =
    navigator.state === 'active' && typeof navigator.lease.adresse === 'string' ? navigator.lease.adresse : null;

  let event = true;
  try {
    await emitEvent(
      'orchestrator.fleet.checkin',
      {
        session: record.session,
        repo: record.repo,
        modus: record.modus,
        kandidaten: record.kandidaten,
        navigator_state: navigatorState,
      },
      { repoRoot },
    );
  } catch (err) {
    event = false;
    process.stderr.write(
      `${PREFIX} WARN: check-in written but event emission failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Report the path with `~` for the home prefix: stdout lands in transcripts.
  const home = os.homedir();
  const shownPath = target.startsWith(`${home}${path.sep}`) ? `~${target.slice(home.length)}` : target;
  process.stdout.write(
    JSON.stringify({
      ok: true,
      path: shownPath,
      key,
      key_fallback: key !== record.session,
      navigator_state: navigatorState,
      navigator_adresse: navigatorAdresse,
      fallback_due_at: fallbackDueAt(record.zeit, navigatorState),
      event,
    }) + '\n',
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`${PREFIX} ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
