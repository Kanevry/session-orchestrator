/**
 * git-config-drift.mjs — the invisible half of a contaminated working copy.
 *
 * ## The incident this exists for (2026-08-19)
 *
 * A diagnostic command exported `GIT_DIR="$PWD/.git"` to run a pre-push hook
 * "the way git runs it". The export outlived the command and applied to
 * everything downstream, including the test suite. `GIT_DIR` outranks `-C`, so
 * every `git -C <tmpdir> …` in every fixture helper retargeted at the REAL
 * repository. Three consequences landed, in ascending cost:
 *
 *  1. HEAD went detached (a fixture ran `checkout --detach`).
 *  2. Three fixture commits landed in the real `.git`.
 *  3. **Three entries landed in `.git/config`** — a fixture remote
 *     (`git@gitlab.example.com:…`), a fixture identity (`user.email`
 *     `test@example.com`, `user.name` `Test`) and `commit.gpgsign=false`.
 *
 * Item 3 was by far the most expensive, for one reason: **`git status` cannot
 * see it.** The first recovery pass checked HEAD, the index and all 1614
 * tracked files and reported the tree clean; the config entries were found two
 * hours later, by an agent measuring something unrelated. By then two commits
 * had been pushed with the fixture author to both GitLab and the public GitHub
 * mirror, where branch protection refuses the force-push that would fix them —
 * the correction now lives in `.mailmap` permanently. The fixture remote would
 * additionally have pointed every `glab -R` call of that session at a
 * non-existent instance, because `REMOTE_PREFERENCE.gitlab` in
 * `scripts/lib/vcs-repo-spec.mjs` prefers the platform-named remote over
 * `origin`.
 *
 * This probe is the cheap symptom detector for that class: one `git config
 * --local --list` per session, matched against an expectation list.
 *
 * ## Named ceiling (BV-004) — read this before trusting a `null`
 *
 * This is an EXPECTATION LIST, not a semantic analysis of git configuration.
 * It catches a fixture-shaped remote and a fixture-shaped identity. It does
 * **NOT** catch:
 *
 *  - a plausibly-named remote pointing at a real foreign host
 *    (`git@gitlab.internal.acme/…` reads as legitimate here);
 *  - anything an operator set deliberately — a per-repo work identity and a
 *    fixture identity are indistinguishable from the config file alone, so a
 *    deliberate override is reported and must be read, not silenced;
 *  - contamination in files other than `.git/config` (fixture commits, a
 *    detached HEAD, stray refs) — `git status` and `git log` cover those, and
 *    duplicating them here would buy nothing;
 *  - a `.git/config` written AFTER this probe ran. It is a session-start
 *    snapshot, not a watcher.
 *
 * **Revisit trigger (identity / remote / gpgsign only):** if an operator
 * reports a standing false positive on a deliberate local override of one of
 * those three, add an explicit allow-list (a `[sessionOrchestrator]`
 * local-config key naming the accepted keys) — do NOT widen or delete a rule,
 * which would re-open the exact hole the probe was built to close.
 *
 * `hooks-path` is no longer in that bucket (#1158, 2026-08-28): a
 * `core.hooksPath` outside `.husky/_` is accepted when the repo DECLARES it —
 * `git ls-files -- <hooksPath>` returns at least one TRACKED file DIRECTLY
 * under the hooksPath whose BASENAME is a real git hook name (see
 * `GIT_HOOK_NAMES`, sourced from `git help hooks`), the same "declared beats
 * guessed" shape `isFixtureHost` already applies to the remote finding. A
 * tracked `.githooks/pre-commit` with `core.hooksPath=.githooks` is a
 * deliberate setup, not drift, and stops flagging without any config key. An
 * untracked or out-of-repo hooksPath still flags exactly as before — that is
 * still the incident class this probe exists for (a fixture that rewrote
 * hooksPath to somewhere nothing is tracked).
 *
 * **Narrowed 2026-08-28 (review, #1158/#1159 N1):** the first cut of this
 * acceptance rule asked only "does `git ls-files` return anything at all
 * under the hooksPath" — which accepted `core.hooksPath=scripts` the moment
 * ANY file under `scripts/` was tracked, including an UNTRACKED executable
 * literally named `pre-commit` planted alongside ordinary tracked source
 * (measured exploit: `git ls-files -- scripts` returns 456 tracked files in
 * this repo, none of them a hook, and the old check accepted it on count
 * alone). `hooksPathIsTracked` now requires a tracked file DIRECTLY under the
 * hooksPath whose basename git itself would invoke as a hook — a tracked
 * directory of unrelated source no longer counts as a declaration.
 *
 * ## Fail-open is forbidden here
 *
 * A failed query is NOT a clean repo. That fold — `null` meaning both "asked
 * and clean" and "could not ask" — is the defect class this whole session
 * worked against; see `isQueryFailure` in `scripts/lib/vcs-repo-spec.mjs:485`
 * for the canonical statement, and `mirror-issues-banner.mjs`'s `degraded`
 * field for the same discipline in the banner contract. A query failure here
 * returns a `warn` result carrying `degraded`, never `null`.
 *
 * Plain-JS — no Zod dependency. Never throws. Synchronous, so it can sit in a
 * session-start phase alongside the other probes without an await.
 *
 * Mirrors the Phase 4 banner contract (`scripts/lib/loop-readiness-banner.mjs`,
 * `scripts/lib/mirror-issues-banner.mjs`): a single `checkXxx()` entry point
 * returning `null` or `{ severity, message, ... }`.
 *
 * Cross-references:
 *  - `scripts/lib/validate/check-test-git-config-target.mjs` — the static
 *    counterpart, which finds the test call sites that can cause this.
 *  - `scripts/lib/validate/check-banner-parity.mjs:59-63` — prior art for the
 *    filtered git environment reproduced below.
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site.
 */

import { spawnSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';

/** Default timeout in ms for each `git config` invocation. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Closed set of `degraded` reasons. A degraded result means the local config
 * was NOT successfully read — never that it is clean.
 *
 * `config-unreadable` is a deliberate fifth member rather than a fold into
 * `not-a-git-repo`: git exits 128 for BOTH a missing repository and a
 * syntactically broken `.git/config`, and the second is a corruption signal in
 * exactly this probe's neighbourhood. Labelling it "not a git repo" would send
 * the operator looking in the wrong place.
 *
 * @type {readonly ['git-unavailable','not-a-git-repo','config-unreadable','timeout','git-error']}
 */
export const DEGRADED_REASONS = Object.freeze([
  'git-unavailable',
  'not-a-git-repo',
  'config-unreadable',
  'timeout',
  'git-error',
]);

/**
 * Closed set of finding kinds, frozen so consumers can switch on it.
 *
 *  - `ambient-git-env`  — `GIT_DIR`/`GIT_WORK_TREE` present in the process
 *    environment. Not a config entry at all, but the PROXIMATE CAUSE of the
 *    incident above, and free to detect. Reported first because it makes every
 *    other git command in the session suspect.
 *  - `local-identity`   — a local `user.email`/`user.name` overriding the
 *    global identity. The costliest entry of the incident.
 *  - `local-gpgsign`    — a local `commit.gpgsign` differing from the global.
 *  - `fixture-remote`   — a remote URL on a reserved/fixture host.
 *  - `hooks-path`       — a local `core.hooksPath` not pointing at `.husky/_`
 *    and not DECLARED by the repo — no tracked file directly under it is a
 *    real git hook name; see `hooksPathIsTracked` / `GIT_HOOK_NAMES`.
 *
 * @type {readonly ['ambient-git-env','local-identity','local-gpgsign','fixture-remote','hooks-path']}
 */
export const FINDING_KINDS = Object.freeze([
  'ambient-git-env',
  'local-identity',
  'local-gpgsign',
  'fixture-remote',
  'hooks-path',
]);

/**
 * Environment variables that redirect git's repository discovery. Their mere
 * presence is a finding — `GIT_DIR` outranks `-C`, which is precisely why the
 * incident's fixture helpers, all of which passed a correct `-C <tmpdir>`,
 * still wrote into the real repository.
 */
const REPO_REDIRECT_ENV_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']);

/**
 * The only environment variables forwarded to the `git` child. Everything else
 * — `GIT_DIR` above all — is dropped, so this probe cannot be redirected at a
 * foreign repository by the very contamination it is looking for. Same
 * allowlist as `check-banner-parity.mjs:63`; deliberately duplicated rather
 * than lifted into a shared module, because a 6-entry constant is cheaper to
 * copy than a new module is to maintain (BV-001).
 */
const GIT_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']);

/**
 * Host suffixes reserved for documentation and testing, plus loopback. These
 * are MEASURED against this repo's own fixtures rather than guessed: on
 * 2026-08-19 a census of `tests/` (`grep -rhoE '(git@|ssh://|https?://)[A-Za-z0-9.@_-]+'`)
 * returned `gitlab.example.com` (189), `github.example.com` (25),
 * `example.com` (19), `example.test` (11), `127.0.0.1` (7), `gitlab.example`
 * (4), plus `test.local` from the fixture identities. `.invalid` is included
 * from RFC 2606 for completeness though this repo has no instance of it.
 *
 * `.local` is the most false-positive-prone member (an operator MAY have a
 * genuine mDNS/LAN git host) — it stays in because a WARN naming the remote
 * costs one glance, and because `test.local` is a shape this repo's own
 * fixtures produce.
 */
const FIXTURE_HOST_SUFFIXES = Object.freeze([
  '.example.com',
  '.example.org',
  '.example.net',
  '.example',
  '.test',
  '.invalid',
  '.local',
  '.localhost',
]);

/** Exact hosts treated as fixture/loopback targets. */
const FIXTURE_HOSTS = Object.freeze([
  'example.com',
  'example.org',
  'example.net',
  'example',
  'localhost',
  '127.0.0.1',
  '::1',
]);

/** The only `core.hooksPath` this repo expects, matched as a path tail. */
const EXPECTED_HOOKS_PATH_TAIL = '.husky/_';

/**
 * Every hook name git itself recognizes under a `core.hooksPath` directory.
 * Source: `git help hooks`. A tracked file below a declared hooksPath whose
 * BASENAME is not one of these is not a hook git will ever invoke — accepting
 * it as a "declaration" would accept an arbitrary tracked file, which is the
 * #1158 review finding this list closes (see the module header's Narrowed
 * note).
 */
const GIT_HOOK_NAMES = Object.freeze([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
]);

/**
 * Build the filtered child environment. See {@link GIT_ENV_ALLOWLIST}.
 *
 * @param {Record<string, string|undefined>} sourceEnv
 * @returns {Record<string, string>}
 */
function filteredGitEnv(sourceEnv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = sourceEnv?.[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Run one `git config` query.
 *
 * @param {string[]} args argv after the leading `git`
 * @param {{repoRoot: string, env: Record<string,string|undefined>, timeoutMs: number, spawn: Function}} ctx
 * @returns {{ok: true, stdout: string} | {ok: false, reason: 'git-unavailable'|'not-a-git-repo'|'config-unreadable'|'timeout'|'git-error', status: number|null}}
 */
function runGitConfig(args, ctx) {
  const res = ctx.spawn('git', ['-C', ctx.repoRoot, ...args], {
    encoding: 'utf8',
    timeout: ctx.timeoutMs,
    env: filteredGitEnv(ctx.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (res?.error) {
    const code = /** @type {any} */ (res.error).code;
    if (code === 'ENOENT') return { ok: false, reason: 'git-unavailable', status: null };
    if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout', status: null };
    return { ok: false, reason: 'git-error', status: null };
  }
  if (res?.signal) return { ok: false, reason: 'timeout', status: null };

  const status = typeof res?.status === 'number' ? res.status : null;
  if (status === 0) return { ok: true, stdout: String(res?.stdout ?? '') };

  // 128 covers BOTH "not a git repository" and "bad config line in
  // .git/config". Discriminate on stderr so a corrupted config is not
  // mislabelled as a missing repo — see DEGRADED_REASONS.
  if (status === 128) {
    const stderr = String(res?.stderr ?? '').toLowerCase();
    if (stderr.includes('bad config') || stderr.includes('bad numeric config')) {
      return { ok: false, reason: 'config-unreadable', status };
    }
    return { ok: false, reason: 'not-a-git-repo', status };
  }
  return { ok: false, reason: 'git-error', status };
}

/**
 * Parse `git config --list -z` output: NUL-separated entries, each `key\nvalue`
 * (a valueless boolean key has no `\n`).
 *
 * The `-z` form is deliberate: the plain `--list` form is `key=value` split on
 * newlines, which mis-parses any multi-line config value — and a multi-line
 * value in a remote URL is exactly the corrupted-config shape this probe is
 * most likely to meet.
 *
 * @param {string} stdout
 * @returns {Array<{key: string, value: string}>}
 */
export function parseNulConfigList(stdout) {
  /** @type {Array<{key: string, value: string}>} */
  const entries = [];
  for (const record of String(stdout ?? '').split('\0')) {
    if (record === '') continue;
    const nl = record.indexOf('\n');
    if (nl === -1) entries.push({ key: record, value: '' });
    else entries.push({ key: record.slice(0, nl), value: record.slice(nl + 1) });
  }
  return entries;
}

/**
 * Extract the host from a git remote URL — both the `scheme://[user@]host/…`
 * and the scp-like `[user@]host:path` forms.
 *
 * @param {string} url
 * @returns {string|null} lowercased host, or null when no host is discernible
 *   (a local path remote, which is never a fixture-host finding)
 */
export function remoteHost(url) {
  const raw = String(url ?? '').trim();
  if (raw === '') return null;

  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(raw);
  if (schemeMatch) {
    const authority = schemeMatch[1];
    const afterUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
    return afterUserinfo.replace(/:\d+$/, '').toLowerCase() || null;
  }

  // scp-like: `[user@]host:path`. A Windows drive letter (`C:\…`) and an
  // absolute/relative local path have no `@` and no dot-bearing host, so they
  // fall through to null rather than being reported as a fixture host.
  const scp = /^([^/\\:]+):(?!\/\/)/.exec(raw);
  if (scp) {
    const host = scp[1].slice(scp[1].lastIndexOf('@') + 1).toLowerCase();
    return host.includes('.') || host === 'localhost' ? host : null;
  }
  return null;
}

/**
 * @param {string|null} host
 * @returns {boolean} true when `host` is a reserved documentation/testing or
 *   loopback host per {@link FIXTURE_HOST_SUFFIXES} / {@link FIXTURE_HOSTS}.
 */
export function isFixtureHost(host) {
  if (typeof host !== 'string' || host === '') return false;
  if (FIXTURE_HOSTS.includes(host)) return true;
  return FIXTURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * @param {string} value a `core.hooksPath` value
 * @returns {boolean} true when it points at `.husky/_` (absolute or relative)
 */
function hooksPathIsExpected(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === EXPECTED_HOOKS_PATH_TAIL || normalized.endsWith(`/${EXPECTED_HOOKS_PATH_TAIL}`);
}

/**
 * @param {string} pathspec repo-relative hooksPath (posix separators, no
 *   trailing slash) already resolved to sit inside `repoRoot`
 * @param {string} trackedLine one line of `git ls-files` output (repo-relative;
 *   git prints `/`-separated paths even on Windows, but this normalizes `\`
 *   too in case a future caller feeds it something else)
 * @returns {boolean} true when `trackedLine` sits DIRECTLY under `pathspec`
 *   (not in a nested subdirectory) and its basename is a recognized git hook
 *   name — see {@link GIT_HOOK_NAMES}. A tracked file two levels deep, or a
 *   tracked file with an unrelated name, is deliberately NOT a declaration.
 */
function isDeclaredHookFile(pathspec, trackedLine) {
  const line = String(trackedLine ?? '').replace(/\\/g, '/');
  const slash = line.lastIndexOf('/');
  const dir = slash === -1 ? '' : line.slice(0, slash);
  const base = slash === -1 ? line : line.slice(slash + 1);
  return dir === pathspec && GIT_HOOK_NAMES.includes(base);
}

/**
 * @param {string} value a `core.hooksPath` value that already failed
 *   {@link hooksPathIsExpected}
 * @param {{repoRoot: string, env: Record<string,string|undefined>, timeoutMs: number, spawn: Function}} ctx
 *   the same context {@link runGitConfig} uses — same filtered env, same `-C`
 *   seam, so this query cannot be redirected any more than the config read can
 * @returns {boolean} true when the path is DECLARED as a hook by the repo:
 *   `git ls-files -- <path>` returns at least one TRACKED file DIRECTLY under
 *   it whose basename is a real git hook name (#1158 review — a tracked
 *   directory of ordinary source files is not itself a declaration; see
 *   {@link GIT_HOOK_NAMES} / {@link isDeclaredHookFile}). An absolute value is
 *   resolved relative to `repoRoot` first; a value outside the repo root can
 *   never be tracked and returns `false` without spawning git. Any spawn
 *   failure (missing git, timeout, non-zero exit) also returns `false` — this
 *   helper only ever WIDENS acceptance, so a query it cannot answer must fall
 *   back to "not declared", never the reverse.
 */
function hooksPathIsTracked(value, ctx) {
  const raw = String(value ?? '').trim();
  if (raw === '') return false;

  let pathspec = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  if (isAbsolute(raw)) {
    const rel = relative(ctx.repoRoot, raw);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false; // outside repo root
    pathspec = rel.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  const res = ctx.spawn('git', ['-C', ctx.repoRoot, 'ls-files', '--', pathspec], {
    encoding: 'utf8',
    timeout: ctx.timeoutMs,
    env: filteredGitEnv(ctx.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (res?.error || res?.signal) return false;
  if (typeof res?.status !== 'number' || res.status !== 0) return false;

  const lines = String(res?.stdout ?? '').split('\n').filter((l) => l.length > 0);
  return lines.some((line) => isDeclaredHookFile(pathspec, line));
}

/**
 * Build the degraded result. Distinct from `null` on purpose — see the header.
 *
 * @param {string} reason
 * @returns {{severity:'warn', message:string, degraded:string, findings:[]}}
 */
function degradedResult(reason) {
  return {
    severity: 'warn',
    message:
      `⚠ git-config-drift: .git/config konnte nicht gelesen werden (${reason}) ` +
      `— Zustand unbekannt, nicht "sauber". \`git config --local --list\` von Hand prüfen.`,
    degraded: reason,
    findings: [],
  };
}

/**
 * Inspect `.git/config` (and the ambient git environment) for fixture-shaped
 * contamination.
 *
 * Return contract — three states, not two:
 *  - `null` when the query SUCCEEDED and matched the expectation list.
 *  - `{ severity:'warn', message, findings: [...] }` when at least one
 *    expectation is violated.
 *  - `{ severity:'warn', message, degraded, findings: [] }` when the local
 *    config could not be read. `degraded` is present ONLY in this case, so its
 *    absence proves the config was actually read.
 *
 * Never throws.
 *
 * @param {{repoRoot?: string, env?: Record<string,string|undefined>, timeoutMs?: number}} [opts]
 * @param {{spawn?: Function}} [deps] DI for tests only.
 * @returns {null | {severity:'warn', message:string, findings: Array<{kind:string, key:string, value:string, detail:string}>, degraded?: string}}
 */
export function checkGitConfigDrift(opts = {}, deps = {}) {
  try {
    const { repoRoot, env, timeoutMs = DEFAULT_TIMEOUT_MS } = opts ?? {};
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const activeEnv = env && typeof env === 'object' ? env : process.env;
    const spawn = deps?.spawn ?? spawnSync;
    const ctx = { repoRoot, env: activeEnv, timeoutMs, spawn };

    /** @type {Array<{kind:string, key:string, value:string, detail:string}>} */
    const findings = [];

    // Finding 0 — the proximate cause. Checked BEFORE the query, because a set
    // GIT_DIR makes every OTHER git command of this session suspect, including
    // ones this probe never sees.
    for (const name of REPO_REDIRECT_ENV_VARS) {
      const value = activeEnv?.[name];
      if (typeof value === 'string' && value !== '') {
        findings.push({
          kind: 'ambient-git-env',
          key: name,
          value,
          detail:
            `${name} ist gesetzt (${value}) — es schlägt \`-C\` und \`cwd\`, ` +
            `jedes git-Kommando dieser Sitzung kann ein fremdes Repo treffen.`,
        });
      }
    }

    const local = runGitConfig(['config', '--local', '--list', '-z'], ctx);
    if (!local.ok) return degradedResult(local.reason);

    // Best-effort global read, for the identity/gpgsign comparison only. Its
    // failure never degrades the result — the local query, which IS the
    // measurement, succeeded.
    const globalRes = runGitConfig(['config', '--global', '--list', '-z'], ctx);
    /** @type {Map<string,string>} */
    const globals = new Map();
    if (globalRes.ok) {
      for (const { key, value } of parseNulConfigList(globalRes.stdout)) {
        globals.set(key.toLowerCase(), value);
      }
    }

    for (const { key, value } of parseNulConfigList(local.stdout)) {
      const lower = key.toLowerCase();

      if (lower === 'user.email' || lower === 'user.name') {
        const globalValue = globals.get(lower);
        if (globalValue === value) continue; // local restates the global — no override
        findings.push({
          kind: 'local-identity',
          key,
          value,
          detail:
            `lokales ${key}=${value} überschreibt die Identität` +
            (globalValue === undefined
              ? ' (global nicht gesetzt)'
              : ` (global: ${globalValue})`) +
            ' — Commits dieses Repos tragen den lokalen Wert.',
        });
        continue;
      }

      if (lower === 'commit.gpgsign') {
        const globalValue = globals.get(lower);
        if (globalValue === value) continue;
        findings.push({
          kind: 'local-gpgsign',
          key,
          value,
          detail:
            `lokales ${key}=${value} weicht vom globalen Wert ab` +
            (globalValue === undefined ? ' (global nicht gesetzt)' : ` (${globalValue})`) +
            '.',
        });
        continue;
      }

      if (/^remote\..+\.url$/i.test(key)) {
        const host = remoteHost(value);
        if (isFixtureHost(host)) {
          findings.push({
            kind: 'fixture-remote',
            key,
            value,
            detail:
              `${key} zeigt auf den Fixture-/Loopback-Host ${host} — ` +
              `ein plattformbenanntes Remote wird von REMOTE_PREFERENCE VOR origin gewählt.`,
          });
        }
        continue;
      }

      if (lower === 'core.hookspath' && !hooksPathIsExpected(value) && !hooksPathIsTracked(value, ctx)) {
        findings.push({
          kind: 'hooks-path',
          key,
          value,
          detail:
            `core.hooksPath=${value} zeigt nicht auf ${EXPECTED_HOOKS_PATH_TAIL} und ist im Repo ` +
            `nicht als getrackter Pfad deklariert — Hooks laufen möglicherweise nicht.`,
        });
      }
    }

    if (findings.length === 0) return null;

    const plural = findings.length === 1 ? 'Eintrag' : 'Einträge';
    return {
      severity: 'warn',
      message:
        `⚠ git-config-drift: ${findings.length} unerwartete(r) ${plural} in der lokalen ` +
        `git-Konfiguration — für \`git status\` unsichtbar: ` +
        findings.map((f) => f.detail).join(' '),
      findings,
    };
  } catch {
    // Defensive catch-all: a session-start probe must never break the session.
    // Distinct from the degraded path above — this is an internal defect, not a
    // failed query, and there is nothing truthful left to report.
    return null;
  }
}

export default checkGitConfigDrift;
