/**
 * plugin-update-banner.mjs — "is the plugin that is RUNNING behind the plugin
 * that is PUBLISHED?" (#nnn, d7 R2).
 *
 * ── The gap this closes (measured 2026-09-06) ────────────────────────────────
 * The operator's host ran the marketplace-cache copy at **3.19.0**, installed
 * 2026-08-09, while the repo and npm stood at the **3.24** line — five minors, four
 * weeks, and not one warning. Three independent reasons, none of which is a
 * bug in isolation:
 *
 *   1. session-start Phase 4's plugin-freshness probe shells out to
 *      `git -C <plugin-dir> log -1`. A marketplace cache is a FILE COPY, so it
 *      answers `fatal: not a git repository` (and 28 d < the 30 d threshold
 *      anyway).
 *   2. `classifyVersionMismatch()` in `bootstrap-lock-freshness.mjs` downgrades
 *      everything below a MAJOR jump to `info` — five minors is "no action
 *      required" BY DESIGN.
 *   3. `bootstrap.lock`'s `refreshed-plugin-version` was stamped from the
 *      CHECKOUT's package.json while 3.19.0 was the code actually loaded.
 *
 * All three share one root: **no code anywhere compared installed against
 * available.** Measured the same day —
 * `grep -rln "registry.npmjs.org\|dist-tags" scripts/ hooks/ skills/` returned
 * exactly one file, `scripts/release.mjs`, which is the PUBLISHER.
 *
 * ── Two contract rules that are load-bearing ─────────────────────────────────
 * **Fail silent, never optimistic (#1031).** Offline, non-2xx, malformed JSON,
 * timeout, unusable cache — every one of them returns `null`, which means "no
 * statement". None of them may collapse into "you are up to date": five
 * distinct failure states rendering as one all-clear is the exact defect #1031
 * names, and here it would re-create the four silent weeks above.
 *
 * **Installed = the code that is RUNNING, not the checkout.** `pluginRoot`
 * defaults to this module's own package root (`../..` from `scripts/lib/`), so
 * the answer cannot disagree with the loaded bytes. Reading
 * `$CLAUDE_PLUGIN_ROOT` instead is what produced reason (3) above: it resolved
 * to the checkout while the cache copy was executing.
 *
 * @module scripts/lib/plugin-update-banner
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeJsonAtomicSync } from './io.mjs';
import { readPluginVersionFromPackageJson } from './bootstrap-lock-freshness.mjs';

/** npm registry document for the `latest` dist-tag of this package. */
export const REGISTRY_URL = 'https://registry.npmjs.org/session-orchestrator/latest';

/** Filename of the per-repo latest-version cache inside `cacheDir`. */
export const CACHE_FILENAME = 'plugin-latest.json';

/** Cache lifetime: one fetch per day per repo, at most. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Registry request budget. A session start must never wait on the network. */
export const FETCH_TIMEOUT_MS = 2000;

/**
 * Env kill-switches, in the order they are checked.
 *
 * `SO_DISABLE_UPDATE_CHECK` is this probe's own switch; the other two are the
 * standard offline flags the telemetry path already honours
 * (`scripts/lib/telemetry/consent.mjs`, `.claude/rules/cross-session-messaging.md`
 * § CSM-005). This probe talks to a PUBLIC REGISTRY on session start, so it has
 * to be at least as easy to silence as telemetry is — an operator who set
 * `DO_NOT_TRACK` did not consent to a per-session npm request either.
 */
export const KILL_SWITCH_ENV_KEYS = [
  'SO_DISABLE_UPDATE_CHECK',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
];

/**
 * Truthiness for an env kill-switch: set, non-empty, not `0`, not `false`.
 *
 * Deliberately a local four-liner rather than an import: the equivalent in
 * `telemetry/consent.mjs` is module-private (not exported), and widening its
 * visibility to reuse four lines would couple this probe to the telemetry
 * module's internals for no gain.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function isTruthyFlag(raw) {
  if (raw === undefined || raw === null) return false;
  const t = String(raw).trim();
  if (t === '' || t === '0') return false;
  return t.toLowerCase() !== 'false';
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {string|null} the name of the first kill-switch that is set, else null.
 */
function firstActiveKillSwitch(env) {
  for (const key of KILL_SWITCH_ENV_KEYS) {
    if (isTruthyFlag(env?.[key])) return key;
  }
  return null;
}

/**
 * Is the update check switched off for this process?
 *
 * Exported because the SessionStart hook gates the `plugin_version_latest`
 * event field on it as well: one switch, one meaning. An operator who sets
 * `SO_DISABLE_UPDATE_CHECK=1` has turned the FEATURE off, not merely the
 * request — reading a leftover cache file into the session record afterwards
 * would be the same surprise as a "disabled" telemetry path that still writes.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function isUpdateCheckDisabled(env = process.env) {
  return firstActiveKillSwitch(env) !== null;
}

/**
 * Parse a semver-ish string into `[major, minor, patch]`.
 * @param {unknown} v
 * @returns {[number, number, number]|null} null when unparseable.
 */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * The default `pluginRoot`: the package root of the module that is executing.
 *
 * `scripts/lib/plugin-update-banner.mjs` → `../..`. See the module docstring
 * for why this is NOT `$CLAUDE_PLUGIN_ROOT`.
 *
 * @returns {string}
 */
function ownPluginRoot() {
  return resolve(import.meta.dirname, '..', '..');
}

/**
 * The version of the plugin that is RUNNING.
 *
 * Exported so the SessionStart hook can stamp `plugin_version_installed` on
 * every `orchestrator.session.started` record without re-deriving "which root
 * is the running one" — the question reason (3) in the module docstring got
 * wrong. Delegates to `bootstrap-lock-freshness.mjs`'s reader rather than
 * opening package.json a second time.
 *
 * @param {string} [pluginRoot]  Override for tests / callers that already know
 *   a specific install root.
 * @returns {string|null} null when package.json is absent or unparseable.
 */
export function readInstalledPluginVersion(pluginRoot) {
  const root = typeof pluginRoot === 'string' && pluginRoot.length > 0 ? pluginRoot : ownPluginRoot();
  return readPluginVersionFromPackageJson(root);
}

/**
 * Read the cached latest-version record, honouring the 24 h TTL.
 *
 * Exported because the SessionStart hook needs the resolved `latest` for the
 * `orchestrator.session.started` event even on the runs where
 * {@link checkPluginUpdate} returns `null` — most importantly the
 * installed-equals-latest run, which is the DENOMINATOR of the probe's firing
 * rate (`.claude/rules/host-resources.md` HR-105). A verdict whose non-firing
 * case leaves no record is unfalsifiable, which is how the old rule set fired
 * on 99% of starts for four months undetected.
 *
 * @param {{cacheDir?: string, now?: number}} [opts]
 * @returns {{version: string, fetchedAt: string}|null} null when absent, stale,
 *   unreadable, or malformed — never throws.
 */
export function readCachedLatest({ cacheDir, now = Date.now() } = {}) {
  if (typeof cacheDir !== 'string' || cacheDir.length === 0) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, CACHE_FILENAME), 'utf8'));
    if (typeof parsed?.version !== 'string' || typeof parsed?.fetched_at !== 'string') return null;
    const fetchedMs = Date.parse(parsed.fetched_at);
    if (Number.isNaN(fetchedMs)) return null;
    // A future-dated stamp (clock skew, hand-edited file) is treated as stale
    // rather than trusted forever: `now - fetchedMs` would be negative and pass
    // the TTL test for as long as the skew lasts.
    const ageMs = now - fetchedMs;
    if (ageMs < 0 || ageMs >= CACHE_TTL_MS) return null;
    return { version: parsed.version, fetchedAt: parsed.fetched_at };
  } catch {
    return null;
  }
}

/**
 * Resolve the published `latest` version: fresh cache first, network second.
 *
 * @param {{cacheDir: string, now: number, fetchImpl: Function}} opts
 * @returns {Promise<string|null>} null on ANY failure (see the module docstring).
 */
async function resolveLatestVersion({ cacheDir, now, fetchImpl }) {
  const cached = readCachedLatest({ cacheDir, now });
  if (cached !== null) return cached.version;

  // Declared without an initialiser on purpose: every path out of the try
  // either returns or assigns, so a `= null` seed would be dead (no-useless-assignment).
  let version;
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res || res.ok !== true) return null;
    const body = await res.json();
    if (typeof body?.version !== 'string' || body.version.length === 0) return null;
    version = body.version;
  } catch {
    // Offline, DNS failure, timeout, malformed JSON — all indistinguishable
    // here and all equally NOT a statement about freshness. Nothing is written:
    // a failed fetch must never leave a cache entry a later run would read as
    // an answer (#1031).
    return null;
  }

  // Best-effort persistence. A write failure costs one extra request next
  // session; it must not discard a verdict we already measured correctly.
  writeJsonAtomicSync(
    join(cacheDir, CACHE_FILENAME),
    { version, fetched_at: new Date(now).toISOString() },
    { tmpPrefix: '.plugin-latest.tmp' },
  );

  return version;
}

/**
 * The four platforms this probe has a SOURCED update recipe for. Each string
 * is quoted from the doc that actually documents it, never invented:
 *
 *   - claude: README.md §"Upgrade" (`/plugin update ...`).
 *   - codex:  docs/codex-setup.md §"Refresh and Explicit Cache Invalidation" —
 *             the short-form marketplace install path, labelled Recommended
 *             there (`codex plugin marketplace upgrade` + `codex plugin add`).
 *   - cursor: README.md's per-platform install row + docs/cursor-setup.md —
 *             re-running the same install script is the documented recipe
 *             (README §"Upgrade": "...followed by the same install
 *             script you originally ran").
 *   - pi:     the PRIMARY install path is `pi install npm:session-orchestrator`
 *             (docs/pi-setup.md §"Option 1", `docs/pi-setup.md:16`), not the
 *             checkout — so the instruction leads with re-running that exact
 *             documented command. There is still no separately-documented
 *             `pi update`/upgrade subcommand anywhere in this repo (checked
 *             again here), so this is a repeat of the documented INSTALL
 *             command, never an invented one — same honesty bar as the rest
 *             of this table. `--settings-only` only rewrites
 *             `.pi/settings.json`; it never touches an npm-installed copy, so
 *             the checkout + `pi-install.mjs --settings-only` recipe (README
 *             §"Upgrade", docs/pi-setup.md §"Option 2/3") is named only as the
 *             fallback for a dev-fallback registration, never as the primary
 *             remedy.
 *
 * @type {Record<"claude"|"codex"|"cursor"|"pi", string>}
 */
const PLATFORM_UPDATE_INSTRUCTIONS = {
  claude: '/plugin update session-orchestrator@kanevry, then restart Claude Code',
  codex:
    'run `codex plugin marketplace upgrade kanevry && codex plugin add session-orchestrator@kanevry` ' +
    '(docs/codex-setup.md), then restart Codex',
  cursor:
    'run `git pull && npm install && node scripts/cursor-install.mjs <project-dir>` ' +
    '(docs/cursor-setup.md), then reload Cursor',
  pi:
    'run `pi install npm:session-orchestrator` again (docs/pi-setup.md, the primary path); ' +
    'dev-fallback checkout installs instead run ' +
    '`git pull && npm install && node scripts/pi-install.mjs <project-dir> --settings-only`, ' +
    'then restart Pi',
};

/**
 * Fallback instruction for any platform value this probe has no sourced
 * recipe for — a future harness, a malformed override, or (see
 * {@link resolvePlatformFromEnv}) an environment with no platform signal at
 * all reaching a code path other than the default. Never omits an actionable
 * step: the one universal truth about this package is that it publishes to
 * npm (`docs/npm-publish` runbook), so that is what the fallback names.
 * @type {string}
 */
const GENERIC_UPDATE_INSTRUCTION = 'run `npm update -g session-orchestrator`';

/**
 * Best-effort platform guess from environment variables alone — the first
 * two precedence steps of `scripts/lib/platform.mjs`'s `detectPlatform()`
 * (an explicit `SO_PLATFORM` override, then each harness's own compatibility
 * env var), duplicated locally rather than imported.
 *
 * Deliberately NOT an import: this module sits behind the SessionStart
 * hook's own lazy `await import()`, and `hooks/_lib/hook-import-set.json`
 * tracks its closure — adding platform.mjs as a dependency here is a
 * wave-scope change, not a two-line addition, so the fallback stays local
 * exactly like `isTruthyFlag` above (same rationale, same precedent).
 * `detectPlatform()`'s third step — a filesystem walk from `cwd` for marker
 * directories — is left out on purpose: it needs `node:fs`/`node:path`
 * traversal this probe has no other reason to carry, and every non-Claude
 * harness already sets its own compat env var, so the walk would only ever
 * re-confirm the same `'claude'` default this function already falls back to.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {"claude"|"codex"|"cursor"|"pi"}
 */
function resolvePlatformFromEnv(env) {
  const explicit = String(env?.SO_PLATFORM ?? '').trim().toLowerCase();
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'cursor' || explicit === 'pi') {
    return explicit;
  }
  if (String(env?.CLAUDE_PLUGIN_ROOT ?? '').trim() !== '') return 'claude';
  if (String(env?.CODEX_PLUGIN_ROOT ?? '').trim() !== '') return 'codex';
  if (String(env?.CURSOR_RULES_DIR ?? '').trim() !== '') return 'cursor';
  if (String(env?.PI_PLUGIN_ROOT ?? '').trim() !== '') return 'pi';
  return 'claude';
}

/**
 * Compare the running plugin version against the published `latest` and, when
 * it is a MINOR or MAJOR behind, produce one operator-facing banner line.
 *
 * Patch-only drift is deliberately silent: a patch is by definition a fix with
 * no surface change, and a banner that fires on every patch release is a
 * banner an operator learns to skip (`.claude/rules/host-resources.md` HR-101 —
 * a signal may only warn if it is rare).
 *
 * The message is English by default (this package's docs — README, CHANGELOG
 * — are English; German is an `owner.yaml` per-operator tonality signal, not a
 * package default, and this probe reaches third-party npm/marketplace
 * consumers who never opted into either) and its remedy instruction is
 * platform-aware: a Codex/Cursor/Pi consumer has no `/plugin update` command,
 * so the CLAUDE-only remedy text is wrong for three of the four harnesses
 * that reach this probe.
 *
 * @param {object} [opts]
 * @param {string} [opts.pluginRoot]  Package root to read `version` from.
 *   Defaults to the RUNNING module's own root — see the module docstring.
 * @param {string} [opts.cacheDir]  Directory holding `plugin-latest.json`,
 *   normally `<repoRoot>/.orchestrator/runtime`. Absent → `null`, no request:
 *   without a cache this probe would issue one npm request per session start.
 * @param {Record<string,string|undefined>} [opts.env]  Defaults to `process.env`.
 * @param {number} [opts.now]  Injected clock (ms). Defaults to `Date.now()`.
 * @param {Function} [opts.fetchImpl]  Injected fetch. Defaults to `globalThis.fetch`.
 * @param {"claude"|"codex"|"cursor"|"pi"} [opts.platform]  The harness driving
 *   this session, when the caller already knows it (the SessionStart hook
 *   computes this once and could pass it straight through). Falls back to
 *   {@link resolvePlatformFromEnv} on `opts.env` when omitted OR when the value
 *   is not one of the four keys above — never throws,
 *   never leaves the instruction generic just because the caller didn't wire
 *   the parameter through yet.
 * @returns {Promise<{severity: 'warn', message: string, installed: string, latest: string}|null>}
 *   `null` means NO STATEMENT — never "up to date".
 */
export async function checkPluginUpdate({
  pluginRoot,
  cacheDir,
  env = process.env,
  now = Date.now(),
  fetchImpl,
  platform,
} = {}) {
  if (isUpdateCheckDisabled(env)) return null;
  if (typeof cacheDir !== 'string' || cacheDir.length === 0) return null;

  const installed = readInstalledPluginVersion(pluginRoot);
  const installedParts = parseSemver(installed);
  if (installedParts === null) return null;

  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetcher !== 'function') return null;

  const latest = await resolveLatestVersion({ cacheDir, now, fetchImpl: fetcher });
  const latestParts = parseSemver(latest);
  if (latestParts === null) return null;

  const [instMajor, instMinor] = installedParts;
  const [latestMajor, latestMinor] = latestParts;

  let count;
  let unit;
  if (latestMajor > instMajor) {
    count = latestMajor - instMajor;
    unit = count === 1 ? 'Major' : 'Majors';
  } else if (latestMajor === instMajor && latestMinor > instMinor) {
    count = latestMinor - instMinor;
    unit = count === 1 ? 'Minor' : 'Minors';
  } else {
    // Equal, patch-only drift, or the installed build is AHEAD of the registry
    // (a local checkout between releases — the normal state in this repo).
    return null;
  }

  // Allowlist, not "any non-empty string": only a value this table actually has
  // a recipe for may pre-empt env resolution — a typo or a future harness name
  // (`'CLAUDE'`, `'clade'`) falls through to the env signal instead of silently
  // degrading to the generic instruction. `Object.hasOwn`, never `in`: `in`
  // would accept prototype keys (`'toString'`) as platforms.
  const resolvedPlatform =
    typeof platform === 'string' && Object.hasOwn(PLATFORM_UPDATE_INSTRUCTIONS, platform)
      ? platform
      : resolvePlatformFromEnv(env);
  const instruction = PLATFORM_UPDATE_INSTRUCTIONS[resolvedPlatform] ?? GENERIC_UPDATE_INSTRUCTION;

  return {
    severity: 'warn',
    message:
      `⚠ session-orchestrator ${installed} installed, ${latest} available ` +
      `(${count} ${unit} behind) — ${instruction}.`,
    installed,
    latest,
  };
}
