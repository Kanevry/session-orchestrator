/**
 * guard-source-loader.mjs — degradation-VISIBLE module loading for deny-capable hooks.
 *
 * ## The defect this closes (#992)
 *
 * `hooks/hooks.json` runs `sh run-node.sh <hook>.mjs`, which `exec node "$@"`.
 * A deny-capable hook that STATICALLY imports a repo module inherits that
 * module's parse failure at ESM LINK time — before the first statement of the
 * hook body runs. Consequences, all measured:
 *
 *   - the hook's own `main().catch(...)` handler is structurally unreachable
 *     (it only covers runtime errors inside `main()`),
 *   - node terminates with EXIT 1, **stdout 0 bytes**, stderr = a SyntaxError
 *     stack trace.
 *
 * Under the exit-0 PreToolUse protocol (#906) the exit code no longer carries a
 * decision: ALLOW is `exit 0` + empty stdout, DENY is `exit 0` + exactly one
 * `hookSpecificOutput` line. A crashed hook produces 0 bytes on stdout and is
 * therefore, ON THE ONLY DECISION-BEARING CHANNEL, indistinguishable from an
 * explicit `emitAllow()`. `git reset --hard` runs through. One broken
 * `scripts/lib/command-blocker.mjs` silently disarms 4 of the 7 deny-capable
 * hooks at once (destructive-guard, enforce-scope, enforce-commands,
 * sessions-ledger-guard) — Bash *and* Edit/Write enforcement.
 *
 * ## The two parts, and why the banner is the base
 *
 * 1. **Loud once-per-session banner on EVERY load failure.** The damage was not
 *    "no fallback", it was an *invisible* outage: an ambiguous harness error
 *    line that wave agents read as a crash rather than a policy block, and
 *    began routing around. The banner therefore names the CONSEQUENCE ("guard
 *    INACTIVE" / "running against HEAD, not your working tree"), not just a
 *    file path.
 * 2. **`git show HEAD:<path>` fallback — for dependency-free modules ONLY.** A
 *    module whose every import is a `node:*` builtin is `data:`-URL loadable, so
 *    its committed source can be re-imported from HEAD. Deliberately NOT
 *    generalised to modules with RELATIVE imports, which a `data:` URL cannot
 *    resolve — that would need its own recursive resolver. Opt-in per module via
 *    `headFallback: true`, gated by {@link HEAD_FALLBACK_ALLOWLIST}; for every
 *    other module part 1 (banner) stands alone.
 *
 * ## Generalised across all four deny-capable hooks (#993)
 *
 * This started life hard-wired to `pre-bash-destructive-guard` +
 * `command-blocker.mjs` (the banner text, the required-export list, and the
 * repo-relative path were all module constants). {@link armGuard} lifts every
 * one of those into a PARAMETER — `hookName`, per-spec `requires`, per-spec
 * `headFallback`, and the `consequence` prose — so `enforce-scope`,
 * `enforce-commands` and `sessions-ledger-guard` bind their own repo
 * dependencies through the same loader without re-freezing this hook's name into
 * a banner literal. `hookName` is MANDATORY on both public exports: a default
 * would silently reintroduce exactly the drift #993 removes.
 *
 * **The coupling is mandatory: the fallback must never fire silently.** A
 * successful HEAD fallback banners too ("running against HEAD, not the working
 * tree"), otherwise a visible hole is traded for an invisible semantic drift.
 *
 * **The HEAD fallback presupposes a git checkout.** It shells out to
 * `git show HEAD:<path>` in the PLUGIN ROOT (not the project dir). For an
 * npm-installed plugin — or any tarball/vendored copy without a `.git` — that
 * command fails by construction, so half of this module is structurally
 * unavailable there: EVERY load failure degrades straight to the GUARD INACTIVE
 * banner below. That is the designed fail-loud direction, not a regression, but
 * it means the banner is the ONLY protection npm consumers get.
 *
 * ## Why the marker is not a mute switch (post-#992 hardening)
 *
 * The once-per-session throttle used to key on the mere EXISTENCE of a
 * predictably-named tmp file, and it gated BOTH banner classes. Measured: an
 * agent could `touch` that path (not a destructive command), then append a
 * syntax error to a `scripts/lib/` module (not on any redirect denylist) and the
 * total-outage banner went silent while the decision channel said ALLOW —
 * strictly worse than the pre-#992 crash, which at least printed a stack trace.
 * Two changes close it:
 *
 *   - **The `inactive` (total-outage) banner is NOT throttled at all.** Once per
 *     call, every call. Throttling is for the *degraded* case (guard armed,
 *     evaluating HEAD); a guard that is OFF must keep saying so. Noise there is
 *     strictly cheaper than a silent disarm.
 *   - **Where the marker remains (`head-fallback`), CONTENT decides, not
 *     existence**: a scoped payload (magic + kind + banner key + projectDir
 *     digest + boot epoch) that an empty `touch` cannot forge, opened
 *     `O_CREAT|O_EXCL|O_NOFOLLOW` for write and `O_NOFOLLOW` for read — so the
 *     marker path can no longer be aimed at an arbitrary file via a symlink,
 *     and a foreign or stale file makes the banner REPEAT rather than vanish.
 *
 * Honest residual: an attacker who runs as the same uid and reproduces the
 * payload format can still suppress the `head-fallback` banner. That is why the
 * class that actually means "unprotected" no longer depends on the marker.
 *
 * Measured cost: `git show` median 4.2 ms (n=21) against a hook allow-path
 * median of 61 ms (n=15) — +11 ms, and only in the defect case. Zero in normal
 * operation: nothing here runs unless an import already threw.
 *
 * ## Hard constraint on this file
 *
 * Everything below runs on the error path of a module-loading failure, so it
 * MUST NOT import any repo module that could itself be the broken one —
 * `node:*` builtins only. Keep it that way. An on-disk source cache under
 * `.orchestrator/runtime/` was considered and REJECTED: its cold-start failure
 * mode is exactly the target scenario (a fresh worktree mid-merge), and it
 * creates a deletable trust anchor inside the writable repo.
 *
 * Known, accepted gap: a COMMITTED conflict marker breaks the HEAD copy too —
 * then only the banner fires. That is why the banner is the base and the
 * fallback the topping.
 *
 * Issue: #992.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/** TTL for the session-id-less marker fallback, mirroring `run-node.sh` (6h). */
const BANNER_TTL_MS = 6 * 60 * 60 * 1000;

/** Marker payload discriminator — an empty `touch` matches none of it. */
const MARKER_MAGIC = 'session-orchestrator/guard-banner';
const MARKER_VERSION = 1;

/** Bucket width for the boot-epoch field (seconds), and its accepted drift. */
const BOOT_BUCKET_S = 10;

/**
 * The ONLY module basenames a `git show HEAD:` fallback is sound for.
 *
 * The fallback re-imports committed source through a `data:` URL (see
 * {@link importFromSource}), and a `data:` URL has NO base against which a
 * RELATIVE import specifier could resolve. So the fallback is correct only for a
 * module whose every import is a `node:*` builtin (or which imports nothing at
 * all). This set is that dependency-free allowlist; a `headFallback: true` on a
 * module NOT in it (e.g. `hardening.mjs` / `platform.mjs`, which carry relative
 * imports) would silently produce an unloadable `data:` module — so
 * {@link armGuard} rejects it as a hard CONFIG error rather than arming a guard
 * whose fallback can never fire.
 *
 * Keyed on BASENAME deliberately: it is the `git show HEAD:<relPath>` leaf, and
 * a dependency-free file keeps that property wherever in the tree it sits. To
 * add a module, verify its import list is `node:*`-only first.
 */
const HEAD_FALLBACK_ALLOWLIST = new Set([
  'command-blocker.mjs',
  'io.mjs',
  'path-utils.mjs',
  'common.mjs',
  'plugin-root.mjs',
]);

/**
 * Resolve the once-per-session banner key.
 *
 * At ESM link-time failure stdin has NOT been read yet, so the payload's
 * `session_id` is unavailable — and `readStdin` lives in `io.mjs`, which may
 * itself be the broken module. So the id is read with `node:fs` alone from
 * `.orchestrator/session.lock`; when that fails we fall back to a time-TTL
 * marker exactly like `run-node.sh` does.
 *
 * ## Why the id alone is not the key (#998.3)
 *
 * There is exactly ONE `session.lock` per working copy, so two parallel sessions
 * in the SAME working copy resolve the same `session_id` — and the second one
 * never sees its own degradation banner, because the first already wrote the
 * marker. The key is therefore composed with a per-session PROCESS identity.
 *
 * **`ppid`, deliberately not `pid`.** Every hook invocation is its own short-lived
 * node process, so a `pid`-keyed marker would be unique per tool call and the
 * banner would fire on every call — the noisy-flood class the throttle exists to
 * prevent, not the shared-marker class it is fixing. `ppid` is the harness
 * process that spawns the hooks and is stable for the session's life:
 * `hooks/run-node.sh` uses `exec node` on every branch, so no intermediate shell
 * survives to become the parent and the ppid IS the harness. This is load-bearing
 * — an added non-exec branch in `run-node.sh` would silently re-break the key.
 *
 * Total key length stays ≤ 64 (48-char id slice + `-pNNNNN`). Markers written in
 * the old (id-only) format live at different paths and are simply never consulted
 * — no migration, the worst case is one extra banner.
 *
 * @param {string} projectDir
 * @returns {{key: string, ttl: boolean}} `ttl: true` means "key is not
 *   session-scoped — apply the 6h time TTL instead of pure existence".
 */
function resolveBannerKey(projectDir) {
  const proc = `p${typeof process.ppid === 'number' ? process.ppid : 0}`;
  try {
    const raw = fs.readFileSync(path.join(projectDir, '.orchestrator', 'session.lock'), 'utf8');
    const id = JSON.parse(raw)?.session_id;
    if (typeof id === 'string' && id.length > 0) {
      return { key: `${id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)}-${proc}`, ttl: false };
    }
  } catch {
    /* no lock, unreadable, or malformed — fall through to the time TTL */
  }
  return { key: `ttl-${proc}`, ttl: true };
}

/** Per-project marker scope — the digest half of the marker file name. */
function markerScope(projectDir) {
  return crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
}

/**
 * Coarse boot epoch (unix seconds, bucketed), used to invalidate markers left
 * behind by a previous boot in a persistent `/tmp`. Bucketing absorbs the
 * sub-second jitter between two `os.uptime()` reads; the reader additionally
 * accepts ±1 bucket, so a call straddling a bucket edge is not a false miss.
 */
function bootEpochBucket() {
  return Math.round((Date.now() / 1000 - os.uptime()) / BOOT_BUCKET_S);
}

/**
 * Absolute path of the marker file that makes the banner once-per-session.
 *
 * Lives in the OS temp dir, NOT in the repo: the error path must not presuppose
 * repo write access, and a marker inside the repo would be another deletable
 * trust anchor. Built with `path.join(os.tmpdir(), …)` rather than string
 * concatenation on `$TMPDIR` — that env var carries a trailing slash on macOS
 * and is unset on a Linux container.
 *
 * The path is intentionally still derivable (it must be, across processes) —
 * which is exactly why the path alone no longer decides anything: see
 * `readMarker` for the payload the file has to carry.
 *
 * @param {string} scope - `markerScope(projectDir)`, so parallel repos (and
 *   per-test fixture dirs) never share a marker.
 * @param {string} kind - banner class (`head-fallback`).
 * @param {string} key
 * @returns {string}
 */
function bannerMarkerPath(scope, kind, key) {
  return path.join(os.tmpdir(), `session-orchestrator-guard-${kind}-${scope}-${key}`);
}

/**
 * Read + VALIDATE a marker. Returns its write time, or `null` for "no marker of
 * ours here" — which makes the banner fire.
 *
 * Every rejection path is deliberately the fail-LOUD one. A file that exists but
 * does not carry this exact payload (an empty `touch`, a foreign file, a marker
 * from another project, kind, session, or boot) is NOT a suppression signal.
 *
 * `O_NOFOLLOW` matters on both halves of the marker lifecycle: without it the
 * predictable path is an arbitrary-file-write primitive (aim a symlink at any
 * file the session can write, and the marker write truncates it) and an
 * arbitrary-file-READ oracle.
 *
 * @param {string} marker
 * @param {{kind: string, key: string, scope: string}} expected
 * @returns {{at: number}|null}
 */
function readMarker(marker, expected) {
  let fd;
  try {
    fd = fs.openSync(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    // Regular file, single link, owned by us. A hard link or a foreign-uid file
    // means somebody else controls this path — never honour it.
    if (!st.isFile() || st.nlink !== 1) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;

    const raw = fs.readFileSync(fd, 'utf8');
    const rec = JSON.parse(raw);
    if (rec?.magic !== MARKER_MAGIC || rec?.v !== MARKER_VERSION) return null;
    if (rec.kind !== expected.kind || rec.key !== expected.key || rec.scope !== expected.scope) {
      return null;
    }
    if (Math.abs(Number(rec.boot) - bootEpochBucket()) > 1) return null;

    const at = Date.parse(rec.at);
    if (!Number.isFinite(at) || at > Date.now() + 60_000) return null; // no future stamps
    return { at };
  } catch {
    return null; // absent, symlinked (ELOOP), unreadable, or malformed
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* nothing to do on the error path */ }
    }
  }
}

/**
 * Create the marker exclusively. Never overwrites: `O_EXCL` fails when anything
 * already sits at the path, and a pre-planted file is therefore left alone —
 * the banner then simply repeats on every call, which is the safe direction.
 *
 * @param {string} marker
 * @param {{kind: string, key: string, scope: string}} fields
 */
function writeMarker(marker, fields) {
  let fd;
  try {
    fd = fs.openSync(
      marker,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    fs.writeSync(
      fd,
      `${JSON.stringify({
        magic: MARKER_MAGIC,
        v: MARKER_VERSION,
        ...fields,
        boot: bootEpochBucket(),
        at: new Date().toISOString(),
      })}\n`
    );
  } catch {
    /* unwritable tmp / already present: emit anyway, repeatedly if need be */
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* nothing to do on the error path */ }
    }
  }
}

/**
 * Write stderr unconditionally. stdout is NEVER an option here: stdout is the
 * decision channel and an allow REQUIRES an empty stdout (see
 * `tests/_helpers/hook-decision.mjs`) — a banner there would corrupt every
 * decision this hook makes.
 *
 * @param {string} message
 */
function writeBanner(message) {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

/**
 * Write a guard-DEGRADATION banner to stderr, at most once per session.
 *
 * Throttling is confined to the degraded class on purpose: there the guard is
 * still armed, so a per-call banner is pure noise an operator learns to ignore.
 * The total-outage banner does NOT come through here — see
 * `emitGuardInactiveBanner`.
 *
 * @param {{projectDir: string, kind: string, message: string}} opts
 * @returns {boolean} whether the banner was emitted this call.
 */
function emitGuardBannerOnce({ projectDir, kind, message }) {
  const { key, ttl } = resolveBannerKey(projectDir);
  const scope = markerScope(projectDir);
  const marker = bannerMarkerPath(scope, kind, key);
  const fields = { kind, key, scope };

  const existing = readMarker(marker, fields);
  if (existing) {
    if (!ttl) return false; // session-keyed: already bannered this session
    if (Date.now() - existing.at < BANNER_TTL_MS) return false;
    // Session-id-less TTL expiry: our own marker, verified above — refresh it.
    try { fs.unlinkSync(marker); } catch { /* keep going; the write may still fail */ }
  }

  writeMarker(marker, fields);
  writeBanner(message);
  return true;
}

/**
 * Read a repo file's committed content via `git show HEAD:<relPath>`.
 *
 * ## Why the git env is scrubbed here (#998.1 — defense in depth)
 *
 * The bytes this returns are handed straight to {@link importFromSource}, i.e.
 * IMPORTED as code inside a deny-capable hook. `-C <repoRoot>` only sets the
 * child's cwd; it does NOT win against `GIT_DIR`, which overrides repository
 * discovery outright. With `GIT_DIR=<foreign repo>/.git` in the environment the
 * call returns a FOREIGN repository's blob at the same relative path, and that
 * blob is then executed — one env var plus one broken module away from code
 * execution in the guard itself. Measured on this loader: without `GIT_DIR`
 * 57,446 bytes of real source, with a foreign `GIT_DIR` 128 bytes of
 * attacker-controlled content. **No vector is currently known by which a Bash
 * command sets the LATER hook process's environment — this is defense in depth,
 * not a fix for a reachable exploit.** It is applied at this single
 * trust-sensitive shell-out rather than at {@link armGuard} entry, because this
 * is the only place whose output becomes code.
 *
 * The listed keys are set to `undefined`, which Node OMITS when building the
 * child env — a DELETION, never an empty-string assignment (`GIT_DIR=` is itself
 * a discovery override, so `''` would re-open the hole it closes).
 * `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` need no enumeration: they are inert
 * without `GIT_CONFIG_COUNT`, which is scrubbed. `PATH`/`HOME`/`TMPDIR` are kept
 * deliberately — git must still be findable and runnable.
 *
 * @param {string} repoRoot
 * @param {string} relPath - POSIX, repo-relative.
 * @returns {string} file content at HEAD.
 * @throws when git is absent, the dir is not a repo, or the path is not at HEAD.
 */
function readFromHead(repoRoot, relPath) {
  return execFileSync('git', ['-C', repoRoot, 'show', `HEAD:${relPath}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_NAMESPACE: undefined,
      GIT_CONFIG_GLOBAL: undefined,
      GIT_CONFIG_SYSTEM: undefined,
      GIT_CONFIG_COUNT: undefined,
    },
  });
}

/**
 * Import an ESM module from an in-memory source string.
 *
 * Only sound for a DEPENDENCY-FREE module (or one importing `node:*` only): a
 * `data:` URL has no base for relative specifier resolution. `command-blocker.mjs`
 * qualifies — its single import is `node:path`.
 *
 * @param {string} source
 * @returns {Promise<object>} the module namespace.
 */
function importFromSource(source) {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
}

/**
 * Derive a module's repo-relative POSIX path from its import `specifier`,
 * relative to `repoRoot`. This is what `git show HEAD:<relPath>` consumes and
 * what the banners name — it REPLACES the former hard-wired `COMMAND_BLOCKER_REL`
 * constant, so a second `headFallback` module needs no new constant.
 *
 * Accepts a `file:` URL (the shape `pathToFileURL(...).href` produces) or an
 * absolute path; a bare relative specifier is returned verbatim (it cannot be
 * resolved against `repoRoot` without guessing the importing module's dir, and
 * `headFallback` callers always pass an absolute `file:` URL).
 *
 * @param {string} specifier
 * @param {string} repoRoot
 * @returns {string} repo-relative POSIX path
 */
function deriveRelPath(specifier, repoRoot) {
  let absPath;
  if (typeof specifier === 'string' && specifier.startsWith('file:')) {
    absPath = fileURLToPath(specifier);
  } else if (typeof specifier === 'string' && path.isAbsolute(specifier)) {
    absPath = specifier;
  } else {
    return specifier;
  }
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

/**
 * Assert a loaded module namespace exports every name in `requires` as a
 * function. A partial namespace is not a degraded guard — it is a guard that
 * throws on the first call and fails open with an `internal error` line, so it
 * must surface here, at the one place that can still fall back or banner.
 *
 * `requires` is passed PER MODULE by the call site — it replaces the former
 * module-wide `COMMAND_BLOCKER_EXPORTS`, which was both hard-wired to one module
 * and already INCOMPLETE (it listed 6 of the 8 exports command-blocker.mjs
 * actually ships). When a spec entry omits `requires`, the shape check is
 * skipped by construction: correct for a module (io.mjs, events.mjs, …) whose
 * missing export surfaces as a plain TypeError at its single call site, with no
 * half-armed fallback to guard against.
 *
 * Why the check must cover ALL required names: it used to assert 2 of 6, so a
 * HEAD copy OLDER than the working tree — the normal case when a newly added
 * export is the very thing that broke (#982/#983/#988 history) — passed as
 * "DEGRADED, enforcement IS still armed" and then allowed every command with an
 * `⚠ internal error — <fn> is not a function` line.
 *
 * @param {object} mod
 * @param {string} origin - human label for the banner ("working-tree copy" | "HEAD copy")
 * @param {string[]} requires - export names that must be functions
 * @param {string} relPath - repo-relative path, for the error message
 * @throws {Error} naming every missing export.
 */
function assertShape(mod, origin, requires, relPath) {
  const missing = requires.filter((name) => typeof mod?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `${origin} of ${relPath} is missing required export(s): ${missing.join(', ')}`
    );
  }
}

/**
 * Arm a deny-capable hook's repo dependencies, making every load failure VISIBLE
 * and — for the dependency-free modules that opt in — recoverable from HEAD.
 *
 * The generalised successor to the former `loadCommandBlocker` (#993): the hook
 * name, the required-export set, and which modules get a HEAD fallback are ALL
 * parameters now, so `enforce-scope`, `enforce-commands` and
 * `sessions-ledger-guard` share this one loader without each re-hard-wiring
 * `pre-bash-destructive-guard` into a banner literal.
 *
 * ## The frozen contract (A2/A3 build on this — #993)
 *
 * @param {Record<string, {specifier: string, headFallback?: boolean, requires?: string[]}>} specMap
 *   One entry per module the hook binds, keyed by a stable LABEL the caller reads
 *   back from the returned `modules`. `specifier` is the normal-operation import
 *   URL (an absolute `file:` URL for `headFallback` entries — a relative one
 *   cannot be resolved from this module). `headFallback: true` opts a
 *   DEPENDENCY-FREE module into the `git show HEAD:` recovery (legal only for a
 *   {@link HEAD_FALLBACK_ALLOWLIST} basename — a hard error otherwise).
 *   `requires` lists the export names that must be functions; omit it to skip the
 *   shape check for that module.
 * @param {{hookName: string, repoRoot: string, projectDir: string, consequence?: {degraded?: string[], inactive?: string[]}}} opts
 *   `hookName` is MANDATORY — no default, because a default would re-freeze the
 *   #993 drift. `repoRoot` is where `git show` runs; `projectDir` keys the
 *   once-per-session degradation banner; `consequence.degraded` is spliced,
 *   verbatim, into the DEGRADED banner.
 * @returns {Promise<{modules: Record<string, object>, degraded: string[]}>}
 *   `modules` maps each label to its namespace; `degraded` lists the labels that
 *   loaded from HEAD (empty in the healthy path).
 * @throws the ORIGINAL working-tree error (with `.headFallbackError` attached
 *   when a HEAD fallback also failed) so the caller's catch can banner GUARD
 *   INACTIVE with the real cause.
 */
export async function armGuard(specMap, { hookName, repoRoot, projectDir, consequence } = {}) {
  if (typeof hookName !== 'string' || hookName.length === 0) {
    throw new Error(
      'armGuard: hookName is required and has no default — a default would reintroduce the exact #993 drift this refactor removes.'
    );
  }

  // Insertion order, EXCEPT headFallback entries move LAST: the cheap plain
  // imports fail first, so a broken dep-free module never pays for a pointless
  // `git show` on a headFallback module that would have loaded fine.
  const entries = Object.entries(specMap);
  entries.sort(([, a], [, b]) => (a.headFallback ? 1 : 0) - (b.headFallback ? 1 : 0));

  const modules = {};
  const degraded = [];

  for (const [label, spec] of entries) {
    const { specifier, headFallback = false, requires } = spec;
    const relPath = deriveRelPath(specifier, repoRoot);

    if (!headFallback) {
      // No fallback: a missing export or parse error is a plain throw the caller
      // banners as GUARD INACTIVE. No `git show`, no half-arming to guard.
      const module = await import(specifier);
      if (Array.isArray(requires)) assertShape(module, 'working-tree copy', requires, relPath);
      modules[label] = module;
      continue;
    }

    // headFallback is sound ONLY for a dependency-free (node:*-only) module — a
    // data: URL cannot resolve the relative imports of e.g. hardening.mjs, so a
    // headFallback:true there would produce a silently-unloadable fallback. Fail
    // LOUD on the misconfiguration instead of arming a guard that can never
    // recover.
    if (!HEAD_FALLBACK_ALLOWLIST.has(path.posix.basename(relPath))) {
      throw new Error(
        `armGuard: headFallback:true is only sound for a dependency-free module ` +
          `(a data: URL cannot resolve relative imports); '${relPath}' is not on the allowlist ` +
          `[${[...HEAD_FALLBACK_ALLOWLIST].join(', ')}].`
      );
    }

    try {
      const module = await import(specifier);
      // The shape check runs on BOTH paths. A working-tree copy that parses but
      // lost an export is the same defect class as a stale HEAD copy: without
      // this it would arm "successfully" and then fail open per command.
      if (Array.isArray(requires)) assertShape(module, 'working-tree copy', requires, relPath);
      modules[label] = module;
    } catch (workingTreeError) {
      let headMod;
      try {
        headMod = await importFromSource(readFromHead(repoRoot, relPath));
        // A HEAD copy that parses but lost part of the API is NOT a usable
        // fallback — treat it as a total failure rather than half-arming.
        if (Array.isArray(requires)) assertShape(headMod, 'HEAD copy', requires, relPath);
      } catch (headError) {
        workingTreeError.headFallbackError = headError;
        throw workingTreeError;
      }

      emitGuardBannerOnce({
        projectDir,
        kind: 'head-fallback',
        message: [
          '',
          `⚠️  ${hookName}: DEGRADED — running against HEAD, not your working tree.`,
          `    ${relPath} failed to load from the working tree:`,
          `      ${String(workingTreeError?.message || workingTreeError).split('\n')[0]}`,
          ...(consequence?.degraded ?? []),
          `    Fix: repair ${relPath} (conflict markers? partial edit?) and re-run.`,
          '    See: issue #992.',
          '',
        ].join('\n'),
      });

      modules[label] = headMod;
      degraded.push(label);
    }
  }

  return { modules, degraded };
}

/**
 * Banner for the total-failure case: no usable module, guard NOT armed.
 *
 * **Deliberately NOT throttled** — this is the one message that must survive
 * every attempt to quiet it. Its predecessor went through the once-per-session
 * marker, and because that marker was suppressible by a bare `touch` on a
 * derivable path, the loudest signal in the system had the weakest lock on it:
 * plant the file, break a module, and an unarmed guard said nothing at all
 * while the decision channel said ALLOW. There is nothing to key on here
 * anyway — every call after the first is equally unprotected, so every call
 * has equal right to say so. Repetition is the point.
 *
 * `hookName` is MANDATORY and has no default (see {@link armGuard}) — a default
 * would silently reintroduce the #993 drift, naming one hook in every hook's
 * banner. `consequence.inactive` is spliced verbatim, so each hook states the
 * concrete commands its outage stops blocking. `projectDir` is accepted for
 * signature symmetry with the degraded banner; it deliberately gates nothing.
 *
 * @param {{hookName: string, projectDir?: string, error: unknown, consequence?: {inactive?: string[]}}} opts
 */
export function emitGuardInactiveBanner({ hookName, error, consequence } = {}) {
  if (typeof hookName !== 'string' || hookName.length === 0) {
    throw new Error(
      'emitGuardInactiveBanner: hookName is required and has no default (see armGuard — a default would reintroduce the #993 drift).'
    );
  }
  const primary = String(error?.message || error).split('\n')[0];
  const secondary = error?.headFallbackError
    ? String(error.headFallbackError.message || error.headFallbackError).split('\n')[0]
    : null;

  writeBanner(
    [
      '',
      `🚨 ${hookName}: GUARD INACTIVE — this session is NOT protected.`,
      `    Module load failed: ${primary}`,
      ...(secondary ? [`    HEAD fallback also failed: ${secondary}`] : []),
      ...(consequence?.inactive ?? []),
      '    Fix: repair the failing module under scripts/lib/, then re-run.',
      '    See: issue #992, .claude/rules/parallel-sessions.md (PSA-003).',
      '',
    ].join('\n')
  );
}
