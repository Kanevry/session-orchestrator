/**
 * agent-cap.mjs — the agent caps of the fleet conditions ("Auflagen") and the
 * memory emergency brake, as code (#1959). Logic for `hooks/pre-agent-cap.mjs`.
 *
 * Before #1959 both existed only as prose (`skills/_shared/fleet-protocol.md`
 * § Standard-Auflagen, `wave-loop-dispatch.md`). Measured 2026-11-05: 0 of 6
 * build sessions held the cap (peaks of 3–5 concurrent background agents per
 * session); the M4 went 14.3 GB into swap. A cap in prose is a rule, not a gate.
 *
 * ## What counts as "running"
 *
 * - STARTED: an `agent-<id>.meta.json` sidecar under
 *   `<dirname(transcript)>/<session>/subagents/` — the same started-signal as
 *   `wave-loop-dispatch.md` § Started-Set Verification, never the launch ack.
 *   The sidecar carries `agentType` and `toolUseId`.
 * - FINISHED: decided by an injected `isFinished(entry)` probe. The hook passes
 *   `makeFinishedProbe()` of `hooks/pre-task-scope-disjoint.mjs` — one liveness
 *   reading for both dispatch guards (terminal `<task-notification>` carrier,
 *   synchronous `tool_result`, SendMessage resume re-opens; no evidence → 30 min
 *   TTL on the sidecar's own age).
 * - CLAIMED: a dispatch this hook allowed whose sidecar does not exist yet.
 *   Several `Agent` calls in ONE assistant message run their PreToolUse hooks
 *   before any of them has launched, so sidecars alone let a batch of 4 pass a
 *   cap of 2. Allowed dispatches are therefore recorded in a per-session claim
 *   file (see {@link liveClaims}) and count until their sidecar appears or
 *   {@link CLAIM_TTL_MS} passes.
 *
 * Foreground (synchronous) dispatches count exactly like background ones while
 * they run: both are a live process tree on this host, and the sidecar exists
 * for both (`requestShape`). The difference is only how completion is read,
 * which the liveness probe already handles.
 *
 * ## Cap sources (`skills/_shared/fleet-protocol.md`)
 *
 * 1. No fleet integration (`fleetIntegrationEnabled()` false) → NO Auflagen cap
 *    (§ Verhalten ohne Flotte). Only the emergency brake applies.
 * 2. An ACCEPTED Auflagen file of this session (`readAuflagen()`, repo-checked)
 *    → its `caps.prozessstartend` / `caps.lesend` (field names measured
 *    2026-11-05: 1238 of 1238 files in the navigator dir carry exactly these two
 *    numeric keys plus a prose `grundlage`). A missing or invalid count falls
 *    back to the Standard value for that class.
 * 3. Otherwise the Standard-Auflagen (default 6 + 6, configurable: see
 *    `scripts/lib/config/agent-caps.mjs`) once `fallback_due_at` has passed
 *    (`fallbackDueAt(checkin.zeit, lease state)`). Before the deadline: no cap —
 *    the navigator may still write one. No check-in at all → the Standard-
 *    Auflagen apply at once: without a check-in no navigator knows the session,
 *    so nobody will ever write its file (same reasoning as § Verhalten ohne
 *    Navigator).
 *
 * ## Emergency brake
 *
 * Below {@link BRAKE_ENGAGE_PCT} % free memory (default, configurable, `off`
 * disables it) no NEW process-starting agent is allowed, fleet or not.
 * Hysteresis: once engaged, the brake releases only above
 * {@link BRAKE_RELEASE_PCT} % (no hysteresis existed in the repo to reuse; this
 * is a plain re-arm band). Unmeasurable memory never counts as free, but
 * it never holds the brake on its own either: an engaged brake keeps holding
 * only for {@link BRAKE_UNMEASURABLE_HOLD_MS} after its last measured
 * confirmation, and a deny names „nicht messbar".
 * Measurement follows HR-102: `memory_pressure_pct_free` (macOS), else
 * `ram_available_gb` as a share of total RAM, else — off macOS, where it is
 * accurate — `os.freemem()`.
 *
 * Nothing here kills anything (HR-101): the hook only refuses new starts.
 */

import path from 'node:path';
import os from 'node:os';
import { readFileSync, readdirSync, statSync } from 'node:fs';

/** Agent class: may start processes (has Edit/Write, or unknown). */
export const CLASS_STARTING = 'prozessstartend';
/** Agent class: read-only (no Edit/Write in its tool set). */
export const CLASS_READING = 'lesend';

/** Standard-Auflagen caps (`skills/_shared/fleet-protocol.md` § Standard-Auflagen). */
export const STANDARD_CAPS = Object.freeze({ [CLASS_STARTING]: 6, [CLASS_READING]: 6 });

/** Brake engages below this free-memory percentage (PRESSURE_HARD_PCT of resource-probe). */
export const BRAKE_ENGAGE_PCT = 15;
/** An engaged brake releases only above this free-memory percentage. */
export const BRAKE_RELEASE_PCT = 20;

/** The `origin` of a setting nobody configured. */
export const ORIGIN_DEFAULT = 'Standardwert';

/** Start of the `origin` of a value taken from the repo's committed Session Config. */
export const ORIGIN_SESSION_CONFIG = 'Session Config';

/**
 * @typedef {object} CapSettings
 * @property {{ prozessstartend: number, lesend: number }} caps — `Infinity` = this class has no cap
 * @property {{ engagePct: number|null, releasePct: number|null }} brake — `engagePct: null` = brake off
 * @property {{ prozessstartend: string, lesend: string, engagePct: string, releasePct: string }} origins
 */

/** Settings when nothing is configured. Resolved by `scripts/lib/config/agent-caps.mjs`. */
export const DEFAULT_CAP_SETTINGS = Object.freeze({
  caps: STANDARD_CAPS,
  brake: Object.freeze({ engagePct: BRAKE_ENGAGE_PCT, releasePct: BRAKE_RELEASE_PCT }),
  origins: Object.freeze({
    [CLASS_STARTING]: ORIGIN_DEFAULT,
    [CLASS_READING]: ORIGIN_DEFAULT,
    engagePct: ORIGIN_DEFAULT,
    releasePct: ORIGIN_DEFAULT,
  }),
});

/**
 * How long an allowed dispatch counts without its sidecar. A background launch
 * writes the sidecar within about a second of the PreToolUse decision; 120 s is
 * generous headroom. Ceiling (BV-004): a dispatch another PreToolUse hook denies
 * after this one allowed it still holds a slot for up to 120 s. Revisit if that
 * shows up as false denials in practice.
 */
export const CLAIM_TTL_MS = 120_000;

/** Bound on the sidecars read per decision — a session with more is pathological. */
const MAX_SIDECARS = 2000;

/** Bound on stored claims. */
const MAX_CLAIMS = 64;

/**
 * An agent whose last activity (its own `agent-<id>.jsonl`, else its sidecar)
 * is older than this is NOT running, whatever the parent transcript says. The
 * parent transcript alone keeps an acked or SendMessage-resumed agent that
 * never reports in LIVE_RUNNING forever (crash, `--resume`, a resumed agent
 * ending without a notification), which denied every later dispatch.
 * A live subagent appends to its transcript after every tool result and writes
 * nothing while a single tool call runs (measured 2026-11-06: mtime frozen for
 * the 65 s of one call, then advanced). Its longest legitimate silence is
 * therefore its longest single tool call: a foreground Bash is capped at
 * 600 000 ms, so 45 min leaves margin. A Monitor watch is only armed by its
 * call and does not hold it open.
 * Ceiling: a live agent silent longer than this (e.g. waiting > 45 min on a
 * permission prompt, or a host-raised Bash timeout) stops counting and the cap
 * under-counts by one. Revisit if a live agent is ever measured silent > 30 min.
 */
export const STALE_RUNNING_MS = 45 * 60_000;

/** A last-activity time further in the future than this is clock skew: unknown, not "fresh". */
const ACTIVITY_SKEW_MS = 5 * 60_000;

/**
 * Built-in agent types whose tool set has no Edit/Write (Claude Code, as of
 * 2026-11-05). `general-purpose` and anything unlisted counts as process-starting.
 */
export const READ_ONLY_BUILTINS = Object.freeze(new Set(['Explore', 'Plan', 'claude-code-guide']));

/** Tool names that make an agent process-starting. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Plugin namespace this repo's agents are registered under. */
const OWN_PLUGIN_PREFIX = 'session-orchestrator:';

/** Agent type names safe to use as one file-name component. */
const AGENT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Read-only test of a frontmatter `tools:` value: true when it names no write
 * tool. An absent value means the agent inherits every tool → not read-only.
 *
 * @param {string|null|undefined} toolsValue
 * @returns {boolean}
 */
export function toolsAreReadOnly(toolsValue) {
  if (typeof toolsValue !== 'string' || toolsValue.trim() === '') return false;
  const tokens = toolsValue
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, '').replace(/\(.*$/, ''));
  return !tokens.some((t) => WRITE_TOOLS.has(t));
}

/**
 * The `tools:` line of a Markdown agent file's YAML frontmatter, or null.
 * @param {string} text
 * @returns {string|null}
 */
function frontmatterTools(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const line = /^tools:\s*(.*)$/m.exec(m[1]);
  return line ? line[1] : null;
}

/**
 * Classify an agent type as process-starting or reading.
 *
 * Read-only means: the tool set has no Edit/Write. Sources, in order: the
 * built-in list above; for `session-orchestrator:<name>` this plugin's
 * `agents/<name>.md`; for a bare `<name>` the project's then the user's
 * `.claude/agents/<name>.md`. Everything else — other plugins' agents, a
 * missing or unparsable file, no `tools:` line — is process-starting (fail
 * toward the cap).
 *
 * CEILING (BV-004): "no Edit/Write" is a proxy, not a measurement. The
 * reviewer agents carry `Bash` and CAN start processes (a reviewer that runs
 * `vitest` costs as much as an implementer); the issue defines them as reading
 * and this follows it. Revisit if reading agents show up as the memory driver
 * in a swap incident — then classify on Bash too.
 *
 * @param {string|null|undefined} agentType — `subagent_type` / sidecar `agentType`
 * @param {{ pluginRoot: string, projectDir?: string|null, homeDir?: string|null,
 *   readFn?: (p: string, enc: string) => string, cache?: Map<string, string> }} ctx
 * @returns {'prozessstartend'|'lesend'}
 */
export function classifyAgentType(agentType, ctx) {
  const type = typeof agentType === 'string' && agentType.trim() !== '' ? agentType.trim() : 'general-purpose';
  const cache = ctx.cache;
  if (cache?.has(type)) return /** @type {any} */ (cache.get(type));
  const readFn = ctx.readFn ?? readFileSync;
  let cls = CLASS_STARTING;
  if (READ_ONLY_BUILTINS.has(type)) {
    cls = CLASS_READING;
  } else {
    /** @type {string[]} */
    const candidates = [];
    if (type.startsWith(OWN_PLUGIN_PREFIX)) {
      const name = type.slice(OWN_PLUGIN_PREFIX.length);
      if (AGENT_NAME_RE.test(name)) candidates.push(path.join(ctx.pluginRoot, 'agents', `${name}.md`));
    } else if (!type.includes(':') && AGENT_NAME_RE.test(type)) {
      if (ctx.projectDir) candidates.push(path.join(ctx.projectDir, '.claude', 'agents', `${type}.md`));
      if (ctx.homeDir) candidates.push(path.join(ctx.homeDir, '.claude', 'agents', `${type}.md`));
    }
    for (const file of candidates) {
      let text;
      try { text = readFn(file, 'utf8'); } catch { continue; }
      cls = toolsAreReadOnly(frontmatterTools(text)) ? CLASS_READING : CLASS_STARTING;
      break;
    }
  }
  cache?.set(type, cls);
  return cls;
}

/**
 * The directory holding a session's subagent sidecars, derived from the main
 * transcript path exactly like `resolveSubagentSidecar()` does per agent.
 * @param {string|null|undefined} transcriptPath
 * @returns {string|null}
 */
export function subagentsDirOf(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') return null;
  const base = path.basename(transcriptPath).replace(/\.jsonl$/i, '');
  if (!base || base === '.' || base === '..') return null;
  return path.join(path.dirname(transcriptPath), base, 'subagents');
}

/**
 * Every agent this session has STARTED, from its `agent-<id>.meta.json` sidecars.
 * A missing directory is an empty list; an unreadable sidecar is skipped.
 * `lastActivityMs` is the mtime of the agent's own `agent-<id>.jsonl` beside
 * the sidecar, or the sidecar's mtime when that transcript is absent/unstattable.
 *
 * @param {string|null|undefined} transcriptPath — the main session transcript
 * @param {{ readdirFn?: (p: string) => string[], readFn?: (p: string, enc: string) => string,
 *   statFn?: (p: string) => { mtimeMs: number } }} [io]
 * @returns {Array<{ agentId: string, agentType: string, useId: string, desc: string, at: string,
 *   lastActivityMs: number }>}
 */
export function listStartedAgents(transcriptPath, io = {}) {
  const dir = subagentsDirOf(transcriptPath);
  if (dir === null) return [];
  const readdirFn = io.readdirFn ?? readdirSync;
  const readFn = io.readFn ?? readFileSync;
  const statFn = io.statFn ?? statSync;
  let names;
  try { names = readdirFn(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^agent-([A-Za-z0-9_-]{1,64})\.meta\.json$/.exec(name);
    if (!m) continue;
    if (out.length >= MAX_SIDECARS) break;
    const file = path.join(dir, name);
    let meta;
    let mtimeMs;
    try {
      meta = JSON.parse(readFn(file, 'utf8'));
      mtimeMs = statFn(file).mtimeMs;
    } catch {
      continue;
    }
    if (meta === null || typeof meta !== 'object') continue;
    let lastActivityMs = mtimeMs;
    try {
      lastActivityMs = statFn(path.join(dir, `agent-${m[1]}.jsonl`)).mtimeMs;
    } catch { /* no own transcript yet → the sidecar's mtime */ }
    out.push({
      agentId: m[1],
      agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
      useId: typeof meta.toolUseId === 'string' ? meta.toolUseId : '',
      desc: typeof meta.description === 'string' ? meta.description : '',
      at: new Date(mtimeMs).toISOString(),
      lastActivityMs,
    });
  }
  return out;
}

/**
 * Claims still counting: younger than {@link CLAIM_TTL_MS} and not yet backed
 * by a sidecar (a sidecar with the same `toolUseId` takes over the count).
 * The dispatch being decided (`selfUseId`) is never its own predecessor: a
 * re-evaluated PreToolUse for the same call must not count itself.
 *
 * @param {unknown} claims — stored claim list (may be corrupt)
 * @param {Set<string>} sidecarUseIds
 * @param {number} now
 * @param {string} [selfUseId]
 * @returns {Array<{ useId: string, cls: string, at: string }>}
 */
export function liveClaims(claims, sidecarUseIds, now, selfUseId = '') {
  if (!Array.isArray(claims)) return [];
  return claims.filter((c) => {
    if (c === null || typeof c !== 'object') return false;
    if (c.cls !== CLASS_STARTING && c.cls !== CLASS_READING) return false;
    const at = Date.parse(c.at);
    if (!Number.isFinite(at) || now - at > CLAIM_TTL_MS || at - now > CLAIM_TTL_MS) return false;
    if (typeof c.useId === 'string' && c.useId !== '' && c.useId === selfUseId) return false;
    return !(typeof c.useId === 'string' && c.useId !== '' && sidecarUseIds.has(c.useId));
  }).slice(-MAX_CLAIMS);
}

/**
 * Count running agents per class.
 *
 * With a finite `now`, an entry whose `lastActivityMs` is older than
 * {@link STALE_RUNNING_MS} is not running regardless of `isFinished`. A
 * missing, non-finite or future-dated (beyond clock skew) `lastActivityMs`
 * leaves the decision to `isFinished` alone. Without `now` the bound is off.
 *
 * @param {Array<{ agentType: string, useId: string, desc: string, at: string, lastActivityMs?: number }>} started
 * @param {Array<{ cls: string }>} claims — from {@link liveClaims}
 * @param {{ isFinished: (entry: object) => boolean, classify: (type: string) => string, now?: number }} fns
 * @returns {{ prozessstartend: number, lesend: number }}
 */
export function countRunning(started, claims, { isFinished, classify, now }) {
  const counts = { [CLASS_STARTING]: 0, [CLASS_READING]: 0 };
  for (const entry of started) {
    const last = entry?.lastActivityMs;
    if (Number.isFinite(now) && Number.isFinite(last) && last <= now + ACTIVITY_SKEW_MS
      && now - last > STALE_RUNNING_MS) continue;
    let finished;
    try { finished = isFinished(entry) === true; } catch { finished = false; }
    if (finished) continue;
    counts[classify(entry.agentType) === CLASS_READING ? CLASS_READING : CLASS_STARTING] += 1;
  }
  for (const claim of claims) counts[claim.cls === CLASS_READING ? CLASS_READING : CLASS_STARTING] += 1;
  return /** @type {any} */ (counts);
}

/** @param {unknown} v */
function isCount(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Resolve the cap for this session.
 *
 * @param {object} input
 * @param {boolean} input.fleetEnabled — `fleetIntegrationEnabled()`
 * @param {Record<string, unknown>|null} input.auflagen — the ACCEPTED Auflagen object, or null
 * @param {string|null} input.fallbackDueAt — `fallbackDueAt(checkin.zeit, lease)`, or null when no check-in exists
 * @param {boolean} [input.isLead] — the ACTIVE navigator lease names one of this
 *   process's raw session ids (#1971). The lead writes no check-in and dispatches
 *   review banks of 7+ agents, so it gets no count cap; an accepted Auflagen file
 *   still wins over it, and the memory brake still applies (decideDispatch).
 * @param {number} input.now
 * @param {CapSettings} [input.settings] — the configured values behind the Standard-Auflagen
 * @returns {{ caps: { prozessstartend: number, lesend: number } | null, source: string, fileClasses?: string[] }}
 *   `fileClasses` only for a partial Auflagen file: the classes the file itself set
 */
export function resolveCaps({ fleetEnabled, auflagen, fallbackDueAt, isLead = false, now, settings = DEFAULT_CAP_SETTINGS }) {
  const standard = settings.caps;
  if (!fleetEnabled) {
    // Without a fleet there is nothing to coordinate, so the default binds
    // nobody. A number the user set himself does: otherwise the keys would be
    // inert for exactly the solo users they are documented for.
    const own = (/** @type {'prozessstartend'|'lesend'} */ cls) => (settings.origins[cls] === ORIGIN_DEFAULT ? Infinity : standard[cls]);
    const caps = { [CLASS_STARTING]: own(CLASS_STARTING), [CLASS_READING]: own(CLASS_READING) };
    if (caps[CLASS_STARTING] === Infinity && caps[CLASS_READING] === Infinity) {
      return { caps: null, source: 'keine Flottenintegration' };
    }
    return { caps: /** @type {any} */ (caps), source: 'Konfiguration (ohne Flotte)' };
  }
  if (auflagen !== null && typeof auflagen === 'object') {
    const raw = /** @type {any} */ (auflagen).caps;
    const c = raw !== null && typeof raw === 'object' ? raw : {};
    return {
      caps: {
        [CLASS_STARTING]: isCount(c[CLASS_STARTING]) ? c[CLASS_STARTING] : standard[CLASS_STARTING],
        [CLASS_READING]: isCount(c[CLASS_READING]) ? c[CLASS_READING] : standard[CLASS_READING],
      },
      source: isCount(c[CLASS_STARTING]) && isCount(c[CLASS_READING])
        ? 'Auflagen-Datei'
        : 'Auflagen-Datei, fehlende Werte aus den Standard-Auflagen',
      ...(isCount(c[CLASS_STARTING]) && isCount(c[CLASS_READING])
        ? {}
        : { fileClasses: [CLASS_STARTING, CLASS_READING].filter((cls) => isCount(c[cls])) }),
    };
  }
  if (isLead === true) return { caps: null, source: 'Lead-Session (Navigator-Lease)' };
  if (standard[CLASS_STARTING] === Infinity && standard[CLASS_READING] === Infinity) {
    return { caps: null, source: 'Deckel abgeschaltet' };
  }
  if (fallbackDueAt === null) {
    return { caps: { ...standard }, source: 'Standard-Auflagen (kein Check-in)' };
  }
  const due = Date.parse(fallbackDueAt);
  if (Number.isFinite(due) && now < due) {
    return { caps: null, source: `Frist bis ${fallbackDueAt} läuft` };
  }
  return { caps: { ...standard }, source: 'Standard-Auflagen' };
}

/**
 * How long a brake engaged by a MEASURED value keeps holding while memory is
 * unmeasurable. Ceiling: a probe that times out under swap (1.5 s each) often
 * coincides with real pressure, so a fresh engagement keeps holding briefly;
 * past this bound the brake no longer holds on its own and only the cap
 * decides ("unmeasurable keeps the file cap", never "unmeasurable keeps the
 * brake forever"). Revisit if fleets report dispatches into a thrashing host
 * right after the hold expires.
 */
export const BRAKE_UNMEASURABLE_HOLD_MS = 10 * 60_000;

/**
 * Brake state with hysteresis. Unmeasurable memory does not judge: an engaged
 * brake keeps holding only while its last MEASURED confirmation (`confirmedAtMs`)
 * is younger than {@link BRAKE_UNMEASURABLE_HOLD_MS}; otherwise it releases and
 * the cap alone decides.
 *
 * @param {number|null} pctFree
 * @param {boolean} wasEngaged
 * @param {{ confirmedAtMs?: number|null, now?: number, engagePct?: number|null, releasePct?: number|null }} [opts]
 *   `confirmedAtMs` = time of the last measurement that kept the brake engaged;
 *   `engagePct: null` = brake switched off
 * @returns {boolean} engaged now
 */
export function nextBrakeState(pctFree, wasEngaged, {
  confirmedAtMs = null, now = Date.now(), engagePct = BRAKE_ENGAGE_PCT, releasePct = BRAKE_RELEASE_PCT,
} = {}) {
  if (engagePct === null) return false;
  if (typeof pctFree !== 'number' || !Number.isFinite(pctFree)) {
    if (!wasEngaged || typeof confirmedAtMs !== 'number' || !Number.isFinite(confirmedAtMs)) return false;
    const age = now - confirmedAtMs;
    return age >= 0 && age < BRAKE_UNMEASURABLE_HOLD_MS;
  }
  if (pctFree < engagePct) return true;
  if (wasEngaged && pctFree <= /** @type {number} */ (releasePct)) return true;
  return false;
}

/**
 * Free memory in percent, best available signal first (HR-102).
 *
 * @param {{ platform?: string, pressurePctFree?: () => Promise<number|null>,
 *   ramAvailableGb?: () => Promise<number|null>, totalmem?: () => number, freemem?: () => number }} probes
 * @returns {Promise<{ pct: number|null, source: string }>}
 */
export async function measureMemory(probes) {
  const platform = probes.platform ?? process.platform;
  const totalmem = probes.totalmem ?? os.totalmem;
  if (platform === 'darwin') {
    try {
      const p = await probes.pressurePctFree?.();
      if (typeof p === 'number' && Number.isFinite(p)) return { pct: p, source: 'memory_pressure' };
    } catch { /* next signal */ }
    try {
      const gb = await probes.ramAvailableGb?.();
      const total = totalmem();
      if (typeof gb === 'number' && Number.isFinite(gb) && total > 0) {
        return { pct: Math.round((gb * 1024 ** 3 * 100) / total), source: 'vm_stat' };
      }
    } catch { /* unmeasurable */ }
    // os.freemem() reads only "Pages free" on macOS — misleading, never used here.
    return { pct: null, source: 'nicht messbar' };
  }
  try {
    const total = totalmem();
    const free = (probes.freemem ?? os.freemem)();
    if (total > 0 && Number.isFinite(free)) return { pct: Math.round((free * 100) / total), source: 'os.freemem' };
  } catch { /* unmeasurable */ }
  return { pct: null, source: 'nicht messbar' };
}

/**
 * Settings the repo's committed Session Config made weaker than the default.
 * A repo a user merely cloned can carry them, so the hook names them visibly.
 * A LOWER cap is stricter, not weaker, and is not listed.
 *
 * @param {CapSettings} settings
 * @param {{ includeCaps: boolean }} opts — false when the count caps are not in
 *   force anyway (no fleet, an Auflagen file, the lead session)
 * @returns {string[]} one `key = value (Standard n)` per weakened field
 */
export function describeRepoWeakening(settings, { includeCaps }) {
  const fromRepo = (/** @type {string} */ field) => settings.origins[field].startsWith(ORIGIN_SESSION_CONFIG);
  const out = [];
  if (includeCaps) {
    for (const [cls, key] of [[CLASS_STARTING, 'process-starting'], [CLASS_READING, 'reading']]) {
      if (fromRepo(cls) && settings.caps[cls] > STANDARD_CAPS[cls]) {
        out.push(`${key} = ${settings.caps[cls] === Infinity ? 'off' : settings.caps[cls]} (Standard ${STANDARD_CAPS[cls]})`);
      }
    }
  }
  const { engagePct, releasePct } = settings.brake;
  if (fromRepo('engagePct') && (engagePct === null || engagePct < BRAKE_ENGAGE_PCT)) {
    out.push(`brake-engage-pct = ${engagePct ?? 'off'} (Standard ${BRAKE_ENGAGE_PCT})`);
  }
  // A release value derived from the engage value carries the engage origin.
  if (settings.origins.releasePct.endsWith('brake-release-pct') && fromRepo('releasePct')
    && releasePct !== null && releasePct < BRAKE_RELEASE_PCT) {
    out.push(`brake-release-pct = ${releasePct} (Standard ${BRAKE_RELEASE_PCT})`);
  }
  return out;
}

/**
 * Where a cap's value comes from and who changes it, for a deny message. The
 * reader of a deny is the model: naming the setting must not read as an
 * invitation to loosen its own limit.
 *
 * @param {'prozessstartend'|'lesend'} cls
 * @param {{ source: string, fileClasses?: string[] }} cap
 * @param {CapSettings} settings
 * @returns {string}
 */
function capHint(cls, cap, settings) {
  if (cap.source === 'Auflagen-Datei' || cap.fileClasses?.includes(cls)) {
    return 'Diese Grenze setzt die Auflagen-Datei des Navigators, sie geht der Konfiguration vor.';
  }
  const [envName, key] = cls === CLASS_READING
    ? ['SO_AGENT_CAP_READING', 'reading']
    : ['SO_AGENT_CAP_PROCESS_STARTING', 'process-starting'];
  return `Wert aus: ${settings.origins[cls]}. Das ändert der Nutzer, nicht der Agent (${envName} oder agent-caps.${key} in owner.yaml oder der Session Config).`;
}

/**
 * The verdict for one dispatch. Pure.
 *
 * @param {object} input
 * @param {'prozessstartend'|'lesend'} input.cls — class of the agent being dispatched
 * @param {{ prozessstartend: number, lesend: number }} input.running
 * @param {{ caps: { prozessstartend: number, lesend: number } | null, source: string }} input.cap
 * @param {{ pct: number|null, source: string } | null} input.memory — null when not measured (reading dispatch)
 * @param {boolean} input.brakeEngaged
 * @param {CapSettings} [input.settings] — names the values and their origin in a deny
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export function decideDispatch({ cls, running, cap, memory, brakeEngaged, settings = DEFAULT_CAP_SETTINGS }) {
  const memoryText = memory === null
    ? null
    : memory.pct === null
      ? 'Speicher: nicht messbar'
      : `Speicher: ${memory.pct} % frei (Quelle: ${memory.source})`;
  const reasons = [];
  if (cap.caps !== null && running[cls] >= cap.caps[cls]) {
    const noun = cls === CLASS_READING ? 'lesenden' : 'prozessstartenden';
    reasons.push(
      `${running[cls]} von ${cap.caps[cls]} ${noun} Agents belegt (Quelle: ${cap.source}) — ` +
        `warte auf eine Benachrichtigung (task-notification) eines laufenden Agents, dann erneut dispatchen. ${capHint(cls, cap, settings)}`,
    );
  }
  if (cls === CLASS_STARTING && brakeEngaged) {
    const measured = memory?.pct === null || memory === null
      ? 'nicht messbar'
      : `${memory.pct} % frei (Quelle: ${memory.source})`;
    reasons.push(
      `Notbremse: Speicher ${measured}, Grenze unter ${settings.brake.engagePct} % — kein neuer prozessstartender Agent, ` +
        `bis wieder über ${settings.brake.releasePct} % frei ist. Lesende Agents bleiben erlaubt. ` +
        `Wert aus: ${settings.origins.engagePct}. Das ändert der Nutzer, nicht der Agent ` +
        '(SO_AGENT_BRAKE_ENGAGE_PCT oder agent-caps.brake-engage-pct in owner.yaml oder der Session Config).',
    );
  }
  if (reasons.length === 0) return { allow: true };
  if (memoryText !== null && !(cls === CLASS_STARTING && brakeEngaged)) reasons.push(memoryText);
  return { allow: false, reason: `Agent-Deckel (#1959): ${reasons.join(' ')}` };
}
