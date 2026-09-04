/**
 * telemetry/schema.mjs — usage-ping v1 schema, whitelist projection, roster
 * filter, and payload builder for anonymous usage telemetry (Epic #841, S2 /
 * GitLab #843; PRD docs/prd/2026-07-20-anonymous-usage-telemetry.md §3-FA2).
 *
 * Privacy is the raison d'être of this module. It mirrors the data-minimization
 * pattern of scripts/lib/eval/schema.mjs (SUBMISSION_FIELDS + projectSubmission):
 * a FROZEN field whitelist plus a data-driven projection so nothing outside the
 * whitelist can ever reach the wire — no paths, repo names, prompts, args, git
 * remotes, or hostnames. Skill/command names are additionally projected against
 * the shipped plugin roster: any name not in the roster becomes the opaque token
 * "other", so custom/third-party names never leave the machine.
 *
 * ── USAGE-PING RECORD (schema_version: 1, record_kind: "usage-ping") ─────────
 *   record_kind      'usage-ping'
 *   schema_version   1
 *   anon_id          set downstream by ensureAnonId (anon-id.mjs) — NOT here
 *   sent_at          ISO 8601 string (passed in as `now`)
 *   plugin_version   package.json version at SO_PLUGIN_ROOT, or 'unknown'
 *   platform         claude|codex|cursor|pi (+ 'other' fallback)
 *   os               normalizeOs(process.platform) — closed set, else 'other'
 *   arch             normalizeArch(process.arch) — closed set, else 'other'
 *   node_major       integer major version of the running Node
 *   ci               boolean — running under CI
 *   fleet            boolean — operator fleet mode (owner.yaml telemetry.enabled)
 *   session_type     housekeeping|feature|deep (+ 'other' fallback)
 *   duration_bucket  '<15m'|'15-60m'|'1-3h'|'>3h'
 *   skills           roster-filtered, deduped, sorted string[] (≤100)
 *   commands         roster-filtered, deduped, sorted string[] (≤100)
 *
 * The builder returns the record WITHOUT anon_id — the caller sets it via
 * ensureAnonId so the ID-rotation concern stays isolated in anon-id.mjs.
 *
 * This module reads files (package.json, the roster surface dirs) but writes
 * none and holds no mutable runtime state.
 */

import { getPlatform, getPluginRoot } from '../platform.mjs';
import { enumerateSurface } from '../sunset/walker.mjs';
import { readPluginVersionFromPackageJson } from '../bootstrap-lock-freshness.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current usage-ping schema version. Additive-only within a version. */
export const USAGE_PING_SCHEMA_VERSION = 1;

/**
 * FROZEN whitelist of the ONLY fields a usage-ping may carry. projectUsagePing is
 * fully data-driven from this list: a field absent here is dropped. Widening this
 * list is the intended fake-regression tripwire — adding a leaky field (e.g.
 * 'repo') turns the data-minimization projection test RED.
 */
export const USAGE_PING_FIELDS = Object.freeze([
  'record_kind',
  'schema_version',
  'anon_id',
  'sent_at',
  'plugin_version',
  'platform',
  'os',
  'arch',
  'node_major',
  'ci',
  'fleet',
  'session_type',
  'duration_bucket',
  'skills',
  'commands',
]);

/** Exact duration-bucket tokens (ASCII, stable wire values). */
export const DURATION_BUCKETS = Object.freeze(['<15m', '15-60m', '1-3h', '>3h']);

/** Roster-projection guardrails. */
const ROSTER_OTHER = 'other';
const MAX_NAME_LENGTH = 64;
const MAX_NAMES = 100;

/** Enum fallbacks. */
const VALID_PLATFORMS = Object.freeze(['claude', 'codex', 'cursor', 'pi']);
const VALID_SESSION_TYPES = Object.freeze(['housekeeping', 'feature', 'deep']);
const PLATFORM_OTHER = 'other';
const SESSION_TYPE_OTHER = 'other';

/**
 * Closed sets for os/arch client-side normalization. A value outside the set —
 * including a future Node os/arch string — degrades to 'other', so the client
 * never sends a value the server's enum would reject with a 400. These MUST
 * mirror the server's OS/ARCH enums (server/validate.mjs); a loong64 client
 * therefore sends 'loong64' (in-set → accepted with a signal), while a
 * hypothetical unknown value degrades safely.
 */
const OS_VALUES = Object.freeze(['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android']);
const ARCH_VALUES = Object.freeze([
  'arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64',
]);
const OS_OTHER = 'other';
const ARCH_OTHER = 'other';

/** Prefix under which skills are recorded in skill-invocations.jsonl. */
const SKILL_PREFIX = 'session-orchestrator:';

const MS_PER_SECOND = 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Whitelist projection (Data-Minimization)
// ---------------------------------------------------------------------------

/**
 * Project an arbitrary object onto the usage-ping whitelist (USAGE_PING_FIELDS).
 * Fully data-driven: any key not on the whitelist — paths, repo names, prompts,
 * args, hostnames, rogue extras — is dropped. Array fields (skills, commands) are
 * copied as NEW arrays so no caller reference leaks into the projection.
 *
 * @param {object} input
 * @returns {object} whitelist-safe projection
 */
export function projectUsagePing(input) {
  if (!isPlainObject(input)) return {};
  const out = {};
  for (const key of USAGE_PING_FIELDS) {
    if (key in input) {
      const v = input[key];
      out[key] = Array.isArray(v) ? [...v] : v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Roster loader
// ---------------------------------------------------------------------------

/**
 * Load the shipped plugin roster (skills + commands) from the on-disk surface.
 * Uses enumerateSurface() against SO_PLUGIN_ROOT (never process.cwd()) so the
 * roster reflects the INSTALLED plugin, not the operator's working directory.
 *
 * skills are returned prefixed with 'session-orchestrator:' (matching the names
 * recorded in skill-invocations.jsonl); commands are bare.
 *
 * Fail-closed: if the surface directory is missing (e.g. a partial npm install)
 * or enumeration throws, this returns EMPTY sets and a stderr WARN — an empty
 * roster means every name projects to "other", never a leak.
 *
 * @param {{pluginRoot?: string}} [opts]
 * @returns {{skills: Set<string>, commands: Set<string>}}
 */
export function loadRoster({ pluginRoot } = {}) {
  const root = (typeof pluginRoot === 'string' && pluginRoot.trim() !== '')
    ? pluginRoot
    : getPluginRoot();

  if (!isNonEmptyString(root)) {
    process.stderr.write(
      "[telemetry] WARN: plugin root unresolved — roster empty, all skill/command names project to 'other'\n",
    );
    return { skills: new Set(), commands: new Set() };
  }

  try {
    const surface = enumerateSurface(root);
    const skills = new Set((surface.skills ?? []).map((name) => `${SKILL_PREFIX}${name}`));
    const commands = new Set(surface.commands ?? []);
    if (skills.size === 0 && commands.size === 0) {
      process.stderr.write(
        `[telemetry] WARN: roster surface empty at ${root} — all skill/command names project to 'other'\n`,
      );
    }
    return { skills, commands };
  } catch (err) {
    process.stderr.write(
      `[telemetry] WARN: roster enumeration failed (${err?.message ?? err}) — all names project to 'other'\n`,
    );
    return { skills: new Set(), commands: new Set() };
  }
}

// ---------------------------------------------------------------------------
// Roster name filter
// ---------------------------------------------------------------------------

/**
 * Project a list of raw names onto the roster: a name present in `rosterSet` is
 * kept verbatim; anything else (off-roster, non-string, or longer than
 * MAX_NAME_LENGTH chars) becomes the opaque token "other". The result is
 * deduplicated and sorted, "other" appears at most once, and the list is capped
 * at MAX_NAMES entries.
 *
 * @param {string[]} names
 * @param {Set<string>} rosterSet
 * @returns {string[]} deduped, sorted, roster-safe names (≤ MAX_NAMES)
 */
export function filterRosterNames(names, rosterSet) {
  const roster = rosterSet instanceof Set ? rosterSet : new Set();
  const raw = Array.isArray(names) ? names : [];
  const mapped = [];
  for (const name of raw) {
    if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      mapped.push(ROSTER_OTHER);
      continue;
    }
    mapped.push(roster.has(name) ? name : ROSTER_OTHER);
  }
  const deduped = [...new Set(mapped)].sort();
  return deduped.slice(0, MAX_NAMES);
}

/**
 * Classify a single raw invocation name into the skills or commands bucket.
 *
 * The Skill tool surfaces slash-commands that have NO backing `skills/` directory
 * under the same plugin-prefixed name form as real skills (e.g.
 * `session-orchestrator:session` for `commands/session.md`). `roster.skills` holds
 * PREFIXED names, `roster.commands` holds BARE ones — so a prefixed command name
 * matches neither set and used to be bucketed to 'other' (GitLab #1189: commands
 * was `[]` in 345/345 usage pings).
 *
 * Decision order (skill roster wins on a spelling collision such as
 * `memory-cleanup`, which is both a skill dir and a command file):
 *   1. name in rosterSkills                     → {kind:'skill',   name}  (verbatim)
 *   2. name is PREFIXED and its bare form is in rosterCommands
 *                                               → {kind:'command', bare}
 *   3. otherwise                                → {kind:'skill',   name}  (verbatim)
 *
 * Case 2 REQUIRES the plugin prefix (session-reviewer W2 finding, 2026-09-02).
 * Without that requirement, a BARE third-party or personal skill name that
 * happens to collide with one of our shipped command names (`test`, `close`,
 * `go`, `release`, `portfolio` are all plausible foreign skill names) would be
 * recorded as OUR command — a data-integrity defect, and the same rule made
 * `memory-cleanup` reach BOTH buckets in one ping (bare → commands, prefixed →
 * skills), double-counting a single surface. Requiring the prefix removes both:
 * a bare arrival can only ever be a skill-path name, so an unknown one becomes
 * 'other'. Cost: the one genuine bare `memory-cleanup` record is recorded as
 * 'other' rather than as the command.
 *
 * Case 3 keeps foreign/third-party names on the SKILLS path only, where
 * filterRosterNames projects them to the opaque token 'other' — an unclassified
 * name is never duplicated into `commands`, preserving the privacy invariant.
 *
 * @param {unknown} name raw invocation name
 * @param {Set<string>} rosterSkills prefixed shipped-skill names
 * @param {Set<string>} rosterCommands bare shipped-command names
 * @returns {{kind: 'skill'|'command', name: unknown}}
 */
export function classifyInvocationName(name, rosterSkills, rosterCommands) {
  const skills = rosterSkills instanceof Set ? rosterSkills : new Set();
  const commands = rosterCommands instanceof Set ? rosterCommands : new Set();
  if (typeof name !== 'string') return { kind: 'skill', name };
  if (skills.has(name)) return { kind: 'skill', name };
  if (!name.startsWith(SKILL_PREFIX)) return { kind: 'skill', name };
  const bare = name.slice(SKILL_PREFIX.length);
  if (commands.has(bare)) return { kind: 'command', name: bare };
  return { kind: 'skill', name };
}

// ---------------------------------------------------------------------------
// Duration bucketing
// ---------------------------------------------------------------------------

/**
 * Map a session duration to a coarse bucket. Boundaries (seconds):
 *   <900        → '<15m'
 *   [900, 3600) → '15-60m'
 *   [3600, 10800] → '1-3h'   (exactly 1h and exactly 3h both land here)
 *   >10800      → '>3h'
 *
 * Fail-safe: an unparsable, missing, or negative duration returns the most
 * conservative bucket '<15m' (never throws).
 *
 * @param {string} startedAtISO
 * @param {string} completedAtISO
 * @returns {'<15m'|'15-60m'|'1-3h'|'>3h'}
 */
export function deriveDurationBucket(startedAtISO, completedAtISO) {
  const start = typeof startedAtISO === 'string' ? Date.parse(startedAtISO) : NaN;
  const end = typeof completedAtISO === 'string' ? Date.parse(completedAtISO) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return '<15m';

  const seconds = (end - start) / MS_PER_SECOND;
  if (!Number.isFinite(seconds) || seconds < 0) return '<15m';
  if (seconds < 900) return '<15m';
  if (seconds < 3600) return '15-60m';
  if (seconds <= 10800) return '1-3h';
  return '>3h';
}

// ---------------------------------------------------------------------------
// Field derivation helpers
// ---------------------------------------------------------------------------

/**
 * Plugin version from package.json at SO_PLUGIN_ROOT; 'unknown' on any failure.
 * Single-sourced through readPluginVersionFromPackageJson (bootstrap-lock-freshness.mjs),
 * whose null return (missing/unparseable package.json or non-string version) maps to 'unknown'.
 */
function resolvePluginVersion() {
  const root = getPluginRoot();
  if (!isNonEmptyString(root)) return 'unknown';
  return readPluginVersionFromPackageJson(root) ?? 'unknown';
}

/** Normalize the detected platform to the closed enum (+ 'other' fallback). */
function normalizePlatform(platform) {
  return VALID_PLATFORMS.includes(platform) ? platform : PLATFORM_OTHER;
}

/** Normalize the session type to the closed enum (+ 'other' fallback). */
function normalizeSessionType(sessionType) {
  return VALID_SESSION_TYPES.includes(sessionType) ? sessionType : SESSION_TYPE_OTHER;
}

/**
 * Normalize an OS identifier (process.platform) against the closed OS_VALUES set.
 * An in-set value is kept verbatim; anything else degrades to 'other' — mirrors
 * normalizePlatform / normalizeSessionType so the client never emits a raw value
 * the server enum would 400 on.
 * @param {unknown} os
 * @returns {string}
 */
export function normalizeOs(os) {
  return OS_VALUES.includes(os) ? os : OS_OTHER;
}

/**
 * Normalize a CPU arch identifier (process.arch) against the closed ARCH_VALUES
 * set. In-set kept verbatim (e.g. 'loong64' survives); anything else → 'other'.
 * @param {unknown} arch
 * @returns {string}
 */
export function normalizeArch(arch) {
  return ARCH_VALUES.includes(arch) ? arch : ARCH_OTHER;
}

/**
 * CI detection from the env: a non-empty CI value that is not '0' and not (case-
 * insensitively) 'false' counts as running under CI.
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function deriveCi(env) {
  const raw = env?.CI;
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  if (v === '' || v === '0' || v.toLowerCase() === 'false') return false;
  return true;
}

/** Distinct non-empty string values of `field` across a list of records. */
function distinctField(records, field) {
  const seen = new Set();
  for (const rec of records) {
    if (!isPlainObject(rec)) continue;
    const value = rec[field];
    if (isNonEmptyString(value)) seen.add(value);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

/**
 * Build a usage-ping record from local telemetry inputs. The returned record is
 * whitelist-clean but does NOT carry `anon_id` — the caller sets it via
 * ensureAnonId (anon-id.mjs), keeping ID rotation isolated there.
 *
 * The distinct `.skill` and `.command` values of `skillInvocations` go through a
 * single classifyInvocationName pass that routes each name to skills or commands
 * (the `.command` field carries nothing today; it is honored so a future direct
 * command-telemetry stream feeds in without a signature change). Both buckets are
 * then roster-filtered — off-roster names become "other" — deduped, sorted, and
 * capped. No frequencies are recorded (v1 decision).
 *
 * @param {{
 *   sessionRecord: object,
 *   skillInvocations: object[],
 *   ownerConfig?: object,
 *   env?: NodeJS.ProcessEnv,
 *   now?: string,
 *   roster?: {skills: Set<string>, commands: Set<string>}
 * }} args
 * @returns {object} usage-ping record (without anon_id)
 */
export function buildUsagePing({
  sessionRecord,
  skillInvocations,
  ownerConfig,
  env = process.env,
  now = new Date().toISOString(),
  roster,
} = {}) {
  const session = isPlainObject(sessionRecord) ? sessionRecord : {};
  const invocations = Array.isArray(skillInvocations) ? skillInvocations : [];
  const rst = roster ?? loadRoster();
  const rosterSkills = rst?.skills instanceof Set ? rst.skills : new Set();
  const rosterCommands = rst?.commands instanceof Set ? rst.commands : new Set();

  // ONE classification pass over the union of both producer fields: today only
  // `.skill` is written by hooks/skill-invocation-telemetry.mjs, `.command` is
  // kept for the forward-compat producer documented above.
  //
  // `.command` records carry the BARE name, and classifyInvocationName requires
  // the plugin prefix before it will route anything to the commands bucket (see
  // its doc comment). So a `.command` name is normalized to the prefixed form
  // first — the field itself is the "this is one of ours" signal that a bare
  // `.skill` arrival lacks. Without this the forward-compat producer would be
  // wired but dead: every record it writes would silently become 'other'.
  const skillNames = [];
  const commandNames = [];
  const rawNames = [
    ...distinctField(invocations, 'skill'),
    ...distinctField(invocations, 'command').map((n) => (n.startsWith(SKILL_PREFIX) ? n : `${SKILL_PREFIX}${n}`)),
  ];
  for (const raw of rawNames) {
    const { kind, name } = classifyInvocationName(raw, rosterSkills, rosterCommands);
    (kind === 'command' ? commandNames : skillNames).push(name);
  }

  return {
    record_kind: 'usage-ping',
    schema_version: USAGE_PING_SCHEMA_VERSION,
    sent_at: now,
    plugin_version: resolvePluginVersion(),
    platform: normalizePlatform(getPlatform()),
    os: normalizeOs(process.platform),
    arch: normalizeArch(process.arch),
    node_major: parseInt(process.versions.node, 10),
    ci: deriveCi(env),
    fleet: ownerConfig?.telemetry?.enabled === true,
    session_type: normalizeSessionType(session.session_type),
    duration_bucket: deriveDurationBucket(session.started_at, session.completed_at),
    skills: filterRosterNames(skillNames, rosterSkills),
    commands: filterRosterNames(commandNames, rosterCommands),
  };
}
