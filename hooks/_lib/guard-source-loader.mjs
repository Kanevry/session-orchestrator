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
 * 2. **`git show HEAD:<path>` fallback — for `command-blocker.mjs` ONLY.** That
 *    module is dependency-free (its single import is `node:path`) and hence
 *    `data:`-URL loadable. Deliberately NOT generalised to the guard's other 6
 *    repo imports: those were never audited for RELATIVE imports, which a
 *    `data:` URL cannot resolve — that would need its own recursive resolver.
 *    For those modules part 1 (banner) stands alone.
 *
 * **The coupling is mandatory: the fallback must never fire silently.** A
 * successful HEAD fallback banners too ("running against HEAD, not the working
 * tree"), otherwise a visible hole is traded for an invisible semantic drift.
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
import { execFileSync } from 'node:child_process';

/** TTL for the session-id-less marker fallback, mirroring `run-node.sh` (6h). */
const BANNER_TTL_MS = 6 * 60 * 60 * 1000;

/** Repo-relative path of the one module that gets the HEAD fallback. */
export const COMMAND_BLOCKER_REL = 'scripts/lib/command-blocker.mjs';

/**
 * Resolve the once-per-session banner key.
 *
 * At ESM link-time failure stdin has NOT been read yet, so the payload's
 * `session_id` is unavailable — and `readStdin` lives in `io.mjs`, which may
 * itself be the broken module. So the id is read with `node:fs` alone from
 * `.orchestrator/session.lock`; when that fails we fall back to a time-TTL
 * marker exactly like `run-node.sh` does.
 *
 * @param {string} projectDir
 * @returns {{key: string, ttl: boolean}} `ttl: true` means "key is not
 *   session-scoped — apply the 6h time TTL instead of pure existence".
 */
export function resolveBannerKey(projectDir) {
  try {
    const raw = fs.readFileSync(path.join(projectDir, '.orchestrator', 'session.lock'), 'utf8');
    const id = JSON.parse(raw)?.session_id;
    if (typeof id === 'string' && id.length > 0) {
      return { key: id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64), ttl: false };
    }
  } catch {
    /* no lock, unreadable, or malformed — fall through to the time TTL */
  }
  return { key: 'ttl', ttl: true };
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
 * @param {string} projectDir - keyed per project so parallel repos (and
 *   per-test fixture dirs) never share a marker.
 * @param {string} kind - banner class (`head-fallback` | `inactive`).
 * @param {string} key
 * @returns {string}
 */
export function bannerMarkerPath(projectDir, kind, key) {
  const digest = crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `session-orchestrator-guard-${kind}-${digest}-${key}`);
}

/**
 * Write a guard-degradation banner to **stderr**, at most once per session.
 *
 * stderr, never stdout: stdout is the decision channel, and an allow REQUIRES
 * an empty stdout (see `tests/_helpers/hook-decision.mjs`). A banner on stdout
 * would corrupt every decision this hook makes.
 *
 * Marker IO failures are swallowed on purpose — a banner that cannot record
 * itself repeats, which is the fail-LOUD direction.
 *
 * @param {{projectDir: string, kind: string, message: string}} opts
 * @returns {boolean} whether the banner was emitted this call.
 */
export function emitGuardBannerOnce({ projectDir, kind, message }) {
  const { key, ttl } = resolveBannerKey(projectDir);
  const marker = bannerMarkerPath(projectDir, kind, key);

  try {
    const stat = fs.statSync(marker);
    if (!ttl) return false; // session-keyed: already banners this session
    if (Date.now() - stat.mtimeMs < BANNER_TTL_MS) return false;
  } catch {
    /* no marker yet — emit */
  }

  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch {
    /* unwritable tmp: emit anyway, repeatedly if need be */
  }

  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  return true;
}

/**
 * Read a repo file's committed content via `git show HEAD:<relPath>`.
 *
 * @param {string} repoRoot
 * @param {string} relPath - POSIX, repo-relative.
 * @returns {string} file content at HEAD.
 * @throws when git is absent, the dir is not a repo, or the path is not at HEAD.
 */
export function readFromHead(repoRoot, relPath) {
  return execFileSync('git', ['-C', repoRoot, 'show', `HEAD:${relPath}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 8 * 1024 * 1024,
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
export function importFromSource(source) {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
}

/**
 * Load `command-blocker.mjs`, falling back to its HEAD version, never silently.
 *
 * @param {{specifier: string, repoRoot: string, projectDir: string}} opts
 *   `specifier` is the import URL/path used in normal operation; `repoRoot` is
 *   where `git show` runs; `projectDir` keys the banner marker.
 * @returns {Promise<{module: object, degraded: 'head'|null}>}
 * @throws the ORIGINAL working-tree error when the HEAD fallback also fails, so
 *   the caller's catch can banner "guard INACTIVE" with the real cause.
 */
export async function loadCommandBlocker({ specifier, repoRoot, projectDir }) {
  try {
    return { module: await import(specifier), degraded: null };
  } catch (workingTreeError) {
    let mod;
    try {
      mod = await importFromSource(readFromHead(repoRoot, COMMAND_BLOCKER_REL));
      // Shape check: a HEAD copy that parses but lost the API is NOT a usable
      // fallback — treat it as a total failure rather than half-arming.
      if (typeof mod.tokenizeCommand !== 'function' || typeof mod.commandMatchesBlocked !== 'function') {
        throw new Error('HEAD copy of command-blocker.mjs is missing its expected exports', {
          cause: workingTreeError,
        });
      }
    } catch (headError) {
      workingTreeError.headFallbackError = headError;
      throw workingTreeError;
    }

    emitGuardBannerOnce({
      projectDir,
      kind: 'head-fallback',
      message: [
        '',
        '⚠️  pre-bash-destructive-guard: DEGRADED — running against HEAD, not your working tree.',
        `    ${COMMAND_BLOCKER_REL} failed to load from the working tree:`,
        `      ${String(workingTreeError?.message || workingTreeError).split('\n')[0]}`,
        '    Consequence: destructive-command enforcement IS still armed, but it is evaluating the',
        '    COMMITTED (HEAD) command lexer — any uncommitted change to that file is NOT in effect.',
        `    Fix: repair ${COMMAND_BLOCKER_REL} (conflict markers? partial edit?) and re-run.`,
        '    See: issue #992.',
        '',
      ].join('\n'),
    });

    return { module: mod, degraded: 'head' };
  }
}

/**
 * Banner for the total-failure case: no usable module, guard NOT armed.
 *
 * @param {{projectDir: string, error: unknown}} opts
 */
export function emitGuardInactiveBanner({ projectDir, error }) {
  const primary = String(error?.message || error).split('\n')[0];
  const secondary = error?.headFallbackError
    ? String(error.headFallbackError.message || error.headFallbackError).split('\n')[0]
    : null;

  emitGuardBannerOnce({
    projectDir,
    kind: 'inactive',
    message: [
      '',
      '🚨 pre-bash-destructive-guard: GUARD INACTIVE — this session is NOT protected.',
      `    Module load failed: ${primary}`,
      ...(secondary ? [`    HEAD fallback also failed: ${secondary}`] : []),
      '    Consequence: destructive Bash commands (git reset --hard, rm -rf, git push --force,',
      '    git stash, redirect-truncate of protected artefacts) are NOT being blocked. This is a',
      '    BROKEN GUARD, not a policy decision — do not route around it, repair it.',
      '    Fix: repair the failing module under scripts/lib/, then re-run.',
      '    See: issue #992, .claude/rules/parallel-sessions.md (PSA-003).',
      '',
    ].join('\n'),
  });
}
