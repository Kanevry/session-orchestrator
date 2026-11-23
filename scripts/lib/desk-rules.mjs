/**
 * desk-rules.mjs — reader for the optional presence and rules files written by
 * a companion app (#2176).
 *
 * Contract: Schema 1, defined by the companion app. It writes
 * `<navigator>/desk/anwesenheit.json` and `<navigator>/desk/regeln.json`; this
 * module ports the companion app's reference reader, and
 * `tests/fixtures/desk-vertrag/` carries the contract's test cases unchanged.
 * The contract identifiers (`desk/`, `quelle: 'desk-app'`) stay as they are,
 * and so do this module's export names, which other code imports (#2176, #2227).
 *
 * Rules only ever RESTRICT. A caller keeps today's gate and applies the rule
 * on top: `inaktiv` (both files absent) means "as today"; any present but
 * broken, stale or stopped state yields `held` for everything except `read`.
 *
 * @module desk-rules
 */

import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { navigatorDir } from './fleet-protocol.mjs';
import { writeJsonAtomicSync } from './io.mjs';

export const PRESENCE_STATES = Object.freeze(['desk', 'away', 'night', 'vacation']);
export const RULES = Object.freeze(['read', 'tidy', 'unblock', 'merge', 'online', 'mail', 'mail_reply']);
export const VALUES = Object.freeze(['do', 'tell', 'ask', 'reach', 'held', 'never']);
const STANDS = Object.freeze(['vorgabe', 'owner']);
const STRICTNESS = Object.freeze({ do: 0, tell: 1, ask: 2, reach: 2, held: 3, never: 4 });

const PRESENCE_FIELDS = ['schema', 'quelle', 'geschrieben_am', 'gueltig_bis', 'gewaehlt', 'gewaehlt_seit',
  'nachtplan', 'wirksam', 'wirksam_bis', 'zurueck_am', 'agenten_gestoppt'];
const RULES_FIELDS = ['schema', 'quelle', 'geschrieben_am', 'stand', 'regeln'];
const MAX_VALID_MS = 3_600_000;
/** Clock skew tolerated between the app and a reader on the same Mac. */
const MAX_AHEAD_MS = 60_000;
const READ_MARK_INTERVAL_MS = 60_000;
/** `<repo> <version>` for desk/gelesen, as the contract example shows. */
const READER_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return `session-orchestrator ${pkg.version}`;
  } catch {
    return 'session-orchestrator';
  }
})();

function hasExactly(v, fields) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === fields.length && fields.every((f) => keys.includes(f));
}

const oneOf = (v, values) => typeof v === 'string' && values.includes(v);

function isUtc(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === `${v.slice(0, -1)}.000Z`;
}

const isCalendarDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && isUtc(`${v}T00:00:00Z`);

/** @returns {object|null} the presence record when it has exactly the Schema-1 form */
export function checkPresence(v) {
  if (!hasExactly(v, PRESENCE_FIELDS)) return null;
  if (v.schema !== 1 || v.quelle !== 'desk-app' || !isUtc(v.geschrieben_am) || !isUtc(v.gueltig_bis)
    || Date.parse(v.gueltig_bis) <= Date.parse(v.geschrieben_am)
    || Date.parse(v.gueltig_bis) - Date.parse(v.geschrieben_am) > MAX_VALID_MS
    || !oneOf(v.gewaehlt, PRESENCE_STATES)
    || (v.gewaehlt_seit !== null && !isUtc(v.gewaehlt_seit))
    || typeof v.nachtplan !== 'boolean'
    || !oneOf(v.wirksam, PRESENCE_STATES)
    || typeof v.agenten_gestoppt !== 'boolean') {
    return null;
  }
  const hasEnd = v.wirksam === 'night' || v.wirksam === 'vacation';
  if (hasEnd ? !isUtc(v.wirksam_bis) : v.wirksam_bis !== null) return null;
  if (v.wirksam === 'vacation' ? !isCalendarDay(v.zurueck_am) : v.zurueck_am !== null) return null;
  return v;
}

/** @returns {object|null} the rules record when it has exactly the Schema-1 form */
export function checkRules(v) {
  if (!hasExactly(v, RULES_FIELDS) || v.schema !== 1 || v.quelle !== 'desk-app'
    || !isUtc(v.geschrieben_am) || !oneOf(v.stand, STANDS) || !hasExactly(v.regeln, PRESENCE_STATES)) {
    return null;
  }
  const complete = PRESENCE_STATES.every((state) => {
    const row = v.regeln[state];
    return hasExactly(row, RULES) && RULES.every((rule) => oneOf(row[rule], VALUES))
      && (state !== 'vacation' || (row.online === 'never' && row.mail === 'never' && row.mail_reply === 'never'));
  });
  return complete ? v : null;
}

/**
 * The validated presence of a reading, or null when it is absent, broken,
 * stale, written in the future or stopped (all of which mean "held").
 *
 * @param {{presence: unknown, rules: unknown}} reading
 * @param {Date} now
 * @returns {object|null}
 */
export function effectivePresence(reading, now) {
  if (!Number.isFinite(now?.getTime?.())) return null;
  const presence = checkPresence(reading.presence);
  const rules = checkRules(reading.rules);
  if (!presence || !rules) return null;
  if (now.getTime() > Date.parse(presence.gueltig_bis)) return null;
  if (Date.parse(presence.geschrieben_am) > now.getTime() + MAX_AHEAD_MS) return null;
  if (presence.agenten_gestoppt) return null;
  return { wirksam: presence.wirksam, rules: rules.regeln[presence.wirksam] };
}

/**
 * Value of one rule — the reference reader's `wert()`.
 * @param {string} rule - one of RULES
 * @param {{presence: unknown, rules: unknown}} reading - `undefined` = file absent
 * @param {Date} now
 * @returns {'inaktiv'|'do'|'tell'|'ask'|'reach'|'held'|'never'}
 */
export function ruleValue(rule, reading, now) {
  if (reading.presence === undefined && reading.rules === undefined) return 'inaktiv';
  const eff = effectivePresence(reading, now);
  if (!eff) return rule === 'read' ? 'do' : 'held';
  return eff.rules[rule];
}

/** The stricter of two values (`do` < `tell` < `reach` = `ask` < `held` < `never`). */
export function stricter(a, b) {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return err?.code === 'ENOENT' ? undefined : { unreadable: true };
  }
}

/**
 * Read both desk files fresh (call right before the effect, never at plan time).
 * @param {{dir?: string}} [opts] - navigator dir; defaults to `navigatorDir()`
 * @returns {{presence: unknown, rules: unknown}}
 */
export function readDeskFiles({ dir = navigatorDir() } = {}) {
  return {
    presence: readJson(path.join(dir, 'desk', 'anwesenheit.json')),
    rules: readJson(path.join(dir, 'desk', 'regeln.json')),
  };
}

/**
 * `readDeskRule(handlung)` from #2176: read fresh, then evaluate.
 * @param {string} rule
 * @param {{dir?: string, now?: Date}} [opts]
 */
export function readDeskRule(rule, { dir = navigatorDir(), now = new Date() } = {}) {
  return ruleValue(rule, readDeskFiles({ dir }), now);
}

/**
 * Record that this reader read the files (`desk/gelesen/<reader>.json`), at most
 * once per minute, atomically. Only when the desk directory exists — a missing
 * contract stays invisible. Never throws: the mark is advisory.
 *
 * @param {string} reader - fixed name: `so-session-end` | `so-notify`
 * @param {string} result - the rule value the reader acted on (`inaktiv` or one of VALUES)
 * @param {{dir?: string, now?: Date, version?: string}} [opts]
 */
export function markRead(reader, result, { dir = navigatorDir(), now = new Date(), version = READER_VERSION } = {}) {
  try {
    const deskDir = path.join(dir, 'desk');
    statSync(deskDir);
    const markDir = path.join(deskDir, 'gelesen');
    const file = path.join(markDir, `${reader}.json`);
    try {
      if (now.getTime() - statSync(file).mtimeMs < READ_MARK_INTERVAL_MS) return false;
    } catch { /* first mark */ }
    mkdirSync(markDir, { recursive: true, mode: 0o700 });
    const zeit = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    return writeJsonAtomicSync(file, { schema: 1, leser: reader, zeit, version, ergebnis: result }, { indent: 0, mode: 0o600 }).ok;
  } catch {
    return false;
  }
}

/**
 * Append one `tell` line to `desk/mitteilungen.jsonl` (English, short, no names).
 * Never throws; returns whether the line was written.
 *
 * @param {{rule: string, wirksam: string, session: string, repo: string, ref: string, text: string}} entry
 * @param {{dir?: string, now?: Date}} [opts]
 */
export function appendDeskNotice(entry, { dir = navigatorDir(), now = new Date() } = {}) {
  try {
    const deskDir = path.join(dir, 'desk');
    statSync(deskDir);
    const zeit = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const line = JSON.stringify({ schema: 1, zeit, regel: entry.rule, wirksam: entry.wirksam, session: entry.session, repo: entry.repo, ref: entry.ref, text: entry.text });
    if (Buffer.byteLength(line) > 2048) return false;
    writeFileSync(path.join(deskDir, 'mitteilungen.jsonl'), `${line}\n`, { flag: 'a', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a waiting-for-input notification may be shown now. Contract §
 * Zustellung: only at the desk; when away only for a stuck agent and
 * `unblock = reach` — a Notification hook fires because an agent waits on
 * the owner, which is that case. Night, vacation, a broken or stale file: no.
 * Both files absent: as today (show).
 *
 * @param {{presence: unknown, rules: unknown}} reading
 * @param {Date} now
 * @returns {{show: boolean, result: string}}
 */
export function notificationAllowed(reading, now) {
  if (reading.presence === undefined && reading.rules === undefined) return { show: true, result: 'inaktiv' };
  const eff = effectivePresence(reading, now);
  if (!eff) return { show: false, result: 'held' };
  if (eff.wirksam === 'desk') return { show: true, result: 'desk' };
  if (eff.wirksam === 'away' && eff.rules.unblock === 'reach') return { show: true, result: 'away-reach' };
  return { show: false, result: eff.wirksam };
}

/**
 * session-end Phase 4a decision for a clean auto-promoted worktree (#2176).
 * Today's gate (clean, no `--force`, destructive guard) stays; the desk rule
 * can only hold it back. `tell` removes as today and adds a notice line;
 * `ask`/`reach`/`held`/`never` leave the worktree in place and say so.
 *
 * BV-004: `tidy` in the contract reads "moved to the bin, nothing is deleted";
 * Phase 4a still runs `git worktree remove` (branch kept, clean tree only).
 * Revisit when the restorable bin path lands (follow-up of #2176).
 *
 * @param {{presence: unknown, rules: unknown}} reading
 * @param {Date} now
 * @returns {{action: 'remove'|'keep', notice: boolean, value: string, wirksam: string|null}}
 */
export function tidyDecision(reading, now) {
  const value = ruleValue('tidy', reading, now);
  const wirksam = effectivePresence(reading, now)?.wirksam ?? null;
  if (value === 'inaktiv' || value === 'do') return { action: 'remove', notice: false, value, wirksam };
  if (value === 'tell') return { action: 'remove', notice: true, value, wirksam };
  return { action: 'keep', notice: false, value, wirksam };
}
