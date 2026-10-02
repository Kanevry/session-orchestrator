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
 *
 * stdout: one JSON line `{ ok, path, navigator_state, navigator_adresse, event }`.
 * `navigator_adresse` is the active lease's `adresse` exactly as
 * `readNavigatorLease()` validated it (a ListAgents peer name), else `null` — no
 * active lease, no address in it, or one the validator refused. It is the only
 * value the caller may address a hint to; an unvalidated string never reaches it.
 *
 * Exit codes:
 *   0 — check-in written (an event failure only WARNs; `event: false` on stdout)
 *   1 — write error
 *   2 — invalid input (not JSON, not an object, or validation errors; no file)
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitEvent } from './lib/events.mjs';
import {
  checkinPath,
  navigatorDir,
  readNavigatorLease,
  utcSecondsTimestamp,
  validateCheckin,
} from './lib/fleet-protocol.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

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
 */
async function writeCheckinFile(target, record) {
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
    await fs.rename(tmp, target);
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
  const errors = validateCheckin(record);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`${PREFIX} ${e}\n`);
    return 2;
  }

  const target = checkinPath(record.session);
  try {
    await writeCheckinFile(target, record);
  } catch (err) {
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
    const repoRoot = (process.env.CLAUDE_PROJECT_DIR || '').trim() || process.cwd();
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
      navigator_state: navigatorState,
      navigator_adresse: navigatorAdresse,
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
