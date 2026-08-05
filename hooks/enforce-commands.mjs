#!/usr/bin/env node
/**
 * enforce-commands.mjs — PreToolUse hook: blocks dangerous Bash commands.
 *
 * Node.js port of hooks/enforce-commands.sh. Part of v3.0.0 migration
 * (Epic #124, issue #138). ESM, Node 20+, no external dependencies beyond stdlib.
 *
 * Decision flow (8 gates, early-exit):
 *   G1 tool filter — only Bash tool is gated
 *   G2 command present + string
 *   G3 wave-scope.json exists
 *   G4 command-guard gate enabled
 *   G5 enforcement != "off"
 *   G6 blocked pattern match against .blockedCommands[], or
 *      fallback safety list when .blockedCommands is empty
 *   G7 strict → deny; warn → stderr + allow; otherwise allow
 *
 * DECISION CHANNEL (post-#906): a deny is signalled by the single nested
 *   PreToolUse JSON envelope emitDeny() writes to stdout, with exit **0** —
 *   NOT by exit 2. The docs forbid the mixed form ("Exit 2 … Claude Code
 *   ignores stdout and any JSON in it"), which silently discarded the reason
 *   and surfaced to the operator as a crash. Do not reintroduce `exit 2` here.
 *   Corollary: exit 0 alone no longer distinguishes allow from deny — the
 *   envelope's presence does, and a malformed envelope fails OPEN.
 *
 * SECURITY-REQ-01: try/catch on main(). emitDeny on any unhandled error —
 *   fail-closed, never a bare exit 1. Null-guard readStdin() return.
 * SECURITY-REQ-07: FALLBACK_BLOCKED includes 'git push -f' and 'drop table'
 *   (short form + case variant gaps in the original Bash fallback list).
 * SECURITY-REQ-08: scope file read exactly once per invocation.
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('enforce-commands')) process.exit(0);

import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// #993 — late-bound repo dependencies
//
// These used to be STATIC imports. A SyntaxError in any of them failed at ESM
// LINK time, before the first statement here ran: node exited 1 with 0 bytes on
// stdout, and the `main().catch(...)` handler at the bottom of this file was
// structurally unreachable (it only covers runtime errors inside `main()`).
// Under the exit-0 PreToolUse protocol (#906) that crash is, on the only
// decision-bearing channel, INDISTINGUISHABLE from an explicit `emitAllow()` —
// the guard failed open and SILENTLY. This is the sibling defect #992 fixed for
// pre-bash-destructive-guard; #993 generalises the same repair here.
//
// Binding them late (dynamic `import()` inside `bootstrap()`, below) turns that
// link-time crash into a catchable runtime error, which is what makes the
// GUARD INACTIVE banner in `_lib/guard-source-loader.mjs` reachable at all.
//
// `profile-gate.mjs` stays static on purpose — it has ZERO imports of its own
// and gates whether this hook runs at all.
// ---------------------------------------------------------------------------
/** @type {typeof import('../scripts/lib/io.mjs').readStdin} */ let readStdin;
/** @type {typeof import('../scripts/lib/io.mjs').emitAllow} */ let emitAllow;
/** @type {typeof import('../scripts/lib/io.mjs').emitDeny} */ let emitDeny;
/** @type {typeof import('../scripts/lib/io.mjs').emitWarn} */ let emitWarn;
let resolveProjectDir;
let readJson;
let findScopeFile;
let extractBashWriteTargets;
let pathMatchesPattern;
/**
 * The `command-blocker.mjs` namespace, imported DIRECTLY (not via the
 * hardening.mjs barrel — which does not carry the `headFallback` recovery, and
 * which transitively imports command-blocker via scope-gate.mjs, so it fails
 * anyway when command-blocker breaks). Mirrors the direct binding in
 * pre-bash-destructive-guard / sessions-ledger-guard. Held as ONE object so the
 * required-export list lives in exactly one place: the `requires` array on the
 * `blocker` spec passed to `armGuard`.
 *
 * @type {Record<string, Function>|null}
 */
let blocker = null;

/**
 * Module labels `armGuard` recovered from HEAD because the working-tree copy
 * failed (parse error OR shape check). Non-empty ⇒ this hook is armed against
 * COMMITTED source. Surfaced on the visible stdout channel by {@link flushNotices}
 * (#1001) — the stderr DEGRADED banner alone is discarded under the exit-0
 * protocol, which made a degraded ALLOW indistinguishable from a healthy one.
 *
 * @type {string[]}
 */
let degradedLabels = [];

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/** This hook's name — threaded into the guard banner (#993: no hard-wired literal). */
const HOOK_NAME = 'enforce-commands';

/**
 * The consequence block spliced VERBATIM into the DEGRADED and GUARD INACTIVE
 * banners (#993), naming the enforcement this hook's outage stops applying.
 */
const GUARD_CONSEQUENCE = {
  degraded: [
    '    Consequence: command enforcement IS still armed, but it is evaluating the',
    '    COMMITTED (HEAD) command-blocker — any uncommitted change to it is NOT in effect.',
  ],
  inactive: [
    '    Consequence: blocked Bash commands (rm -rf, git push --force, git reset',
    '    --hard, and the wave blockedCommands list) are NOT being screened. This is',
    '    a BROKEN GUARD, not a policy decision — do not route around it, repair it.',
  ],
};

/**
 * Project dir for banner keying, resolved WITHOUT `platform.mjs` — that module
 * is one of the ones that may have failed to load.
 *
 * @returns {string}
 */
function bannerProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Bind every repo dependency late, making a load failure VISIBLE (GUARD INACTIVE
 * banner) instead of a silent exit-1 / 0-byte disarm. Throws on any load failure;
 * the entry-point catch banners.
 *
 * `hardening.mjs` is bound (no headFallback — it carries relative imports) for
 * `findScopeFile` / `extractBashWriteTargets` / `pathMatchesPattern`; the two
 * command-matching primitives come from the direct `blocker` namespace, which is
 * the only entry that opts into the `git show HEAD:` recovery. Because hardening
 * transitively imports command-blocker (via scope-gate.mjs), a broken command-blocker
 * fails hardening FIRST (it arms before the headFallback entry) — so that case
 * degrades straight to GUARD INACTIVE, git or no git.
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  const lib = (...seg) => pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', ...seg)).href;

  const { armGuard } = await import('./_lib/guard-source-loader.mjs');
  const { modules, degraded } = await armGuard(
    {
      io: { specifier: lib('io.mjs') },
      platform: { specifier: lib('platform.mjs') },
      common: { specifier: lib('common.mjs') },
      hardening: { specifier: lib('hardening.mjs') },
      blocker: {
        specifier: lib('command-blocker.mjs'),
        headFallback: true,
        requires: ['commandMatchesBlocked', 'suggestForCommandBlock'],
      },
    },
    {
      hookName: HOOK_NAME,
      repoRoot: PLUGIN_ROOT,
      projectDir: bannerProjectDir(),
      consequence: GUARD_CONSEQUENCE,
    }
  );

  ({ readStdin, emitAllow, emitDeny, emitWarn } = modules.io);
  ({ resolveProjectDir } = modules.platform);
  ({ readJson } = modules.common);
  ({ findScopeFile, extractBashWriteTargets, pathMatchesPattern } = modules.hardening);
  blocker = modules.blocker;
  degradedLabels = degraded;
}

/**
 * Flush the aggregated allow-with-notice channel (#1001).
 *
 * Notices raised during gate evaluation accumulate in `notices` and are emitted
 * ONCE, here, on the VISIBLE stdout channel via `emitWarn` (allow-with-notice) —
 * else a plain `emitAllow`. Both exit 0 and never return, so this is always the
 * LAST statement on an allow path.
 *
 * Why aggregate instead of `emitWarn`-ing inline at the degraded site: `emitWarn`
 * is `@returns never` (scripts/lib/io.mjs), so an inline call before the G6
 * blocked-pattern loop would exit BEFORE any pattern was matched — turning every
 * would-be DENY into an ALLOW-with-notice for the whole degraded session. A deny,
 * when it fires, exits via `emitDeny` and these notices are simply dropped: DENY
 * wins, and armGuard's stderr banner remains for CI/debug.
 *
 * @param {string[]} notices
 * @returns {never}
 */
function flushNotices(notices) {
  return notices.length > 0 ? emitWarn(notices.join('\n')) : emitAllow();
}

// Fallback safety list — applied when scope.blockedCommands is empty.
// Keep in sync with hooks/enforce-commands.sh; v3 additions (#138, SECURITY-REQ-07)
// cover the short-form git push and the lowercase SQL variant the Bash version missed.
const FALLBACK_BLOCKED = [
  'rm -rf',
  'git push --force',
  'git push -f',
  'git reset --hard',
  'DROP TABLE',
  'drop table',
  'git checkout -- .',
];

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — only Bash is gated
  if (input.tool_name !== 'Bash') return emitAllow();

  // G2 — command must be a non-empty string
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  // #1001 — aggregated allow-with-notice channel, opened only AFTER G1/G2 (a
  // non-Bash tool call or an empty command is not this hook's business, and must
  // stay a bare allow so the notice does not ride every unrelated tool call).
  // Flushed ONCE at the end of whichever allow path is taken; see flushNotices
  // for why an inline emitWarn here would disarm the G6 deny below.
  const notices = [];
  // A guard armed from HEAD (working-tree module unparseable or shape-invalid) is
  // a visible-channel concern: the DEGRADED banner rides stderr only, which exit 0
  // discards. armGuard already fired that banner once per session; surface it on
  // stdout too so a degraded ALLOW is not silently indistinguishable from a
  // healthy one.
  if (degradedLabels.length > 0) {
    notices.push(
      `${HOOK_NAME}: DEGRADED — guard module(s) loaded from HEAD, not your working tree ` +
        `(${degradedLabels.join(', ')}); uncommitted changes to them are NOT in effect. See #992.`
    );
  }

  const projectRoot = resolveProjectDir();

  // G3 — no scope file → allow
  const scopePath = findScopeFile(projectRoot);
  if (!scopePath) return flushNotices(notices);

  // SECURITY-REQ-08: read scope file exactly once; use the parsed object
  // for all subsequent gate checks.
  let scope;
  try {
    scope = await readJson(scopePath);
  } catch {
    scope = {};
  }
  const enforcement = scope.enforcement || 'strict';
  const blockedCommands = Array.isArray(scope.blockedCommands)
    ? scope.blockedCommands
    : [];
  const gateOn = scope?.gates?.['command-guard'] !== false;

  // bash-write-guard (#800) — OPT-IN, WARN-ONLY, default OFF.
  //
  // INVERTED DEFAULT (deliberate divergence from the command-guard convention
  // above, where a MISSING gates entry means ENABLED): this gate runs ONLY when
  // `gates['bash-write-guard'] === true` is EXPLICITLY set. Conservative shell-
  // write parsing carries a real false-positive risk (quoting, `>$VAR`, process
  // substitution, pipes), so it stays off unless a wave opts in. It never denies
  // and never changes the exit path — it only writes advisory stderr lines — so
  // it is safe to run before the command-guard gate/enforcement early-returns.
  // Skipped under enforcement:off (nothing is enforced there). See #800.
  if (enforcement !== 'off' && scope?.gates?.['bash-write-guard'] === true) {
    runBashWriteGuard(command, scope, projectRoot);
  }

  // G4 — gate disabled → allow
  if (!gateOn) return flushNotices(notices);
  // G5 — enforcement "off" → allow
  if (enforcement === 'off') return flushNotices(notices);

  // G6 — determine which list to check
  const useFallback = blockedCommands.length === 0;
  const patternsToCheck = useFallback ? FALLBACK_BLOCKED : blockedCommands;

  for (const pattern of patternsToCheck) {
    if (blocker.commandMatchesBlocked(command, pattern)) {
      const prefix = useFallback
        ? 'Blocked by fallback safety list'
        : 'Blocked command';
      const reason = `${prefix}: '${pattern}' found in command`;
      const suggestion = blocker.suggestForCommandBlock(pattern);
      if (enforcement === 'strict') {
        return emitDeny(reason, suggestion);
      }
      // Aggregated, not inline: when the guard is DEGRADED the notice list is
      // non-empty and both lines ride ONE envelope (a second emitWarn would be
      // unreachable — emitWarn never returns). Undegraded, notices is empty and
      // this stays the single-line warn it has always been.
      notices.push(`${reason} — ${suggestion}`);
      return flushNotices(notices);
    }
  }

  // G7 — no match → allow
  return flushNotices(notices);
}

/**
 * bash-write-guard (#800) — advisory, side-effecting stderr warner.
 *
 * Extracts likely Bash write targets from `command`, relativises each against the
 * project root where possible, and WARNS (stderr only) for every target that is
 * NOT covered by the wave's allowedPaths. NEVER denies, NEVER changes the exit
 * code — v1 is warn-only by design (#800). No event infra is pulled in: this hook
 * has no emitEvent import, so warnings are plain stderr lines per the #800 contract.
 *
 * @param {string} command — raw Bash command string
 * @param {object} scope — parsed wave-scope.json
 * @param {string} projectRoot — absolute project root
 */
function runBashWriteGuard(command, scope, projectRoot) {
  const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];
  const targets = extractBashWriteTargets(command);
  for (const target of targets) {
    if (!targetInWaveScope(target, allowedPaths, projectRoot)) {
      process.stderr.write(`bash-write-guard: ${target} outside wave scope (warn-only, #800)\n`);
    }
  }
}

/**
 * Is a write target covered by the wave's allowedPaths? Reuses the same
 * `pathMatchesPattern` matcher the enforce-scope path gate uses (no bespoke
 * matching). Absolute targets inside the project root are relativised first;
 * both the relative and raw forms are tried so an in-scope target never warns.
 *
 * @param {string} target — verbatim write target from extractBashWriteTargets
 * @param {string[]} allowedPaths — wave allowedPaths union
 * @param {string} projectRoot — absolute project root
 * @returns {boolean}
 */
function targetInWaveScope(target, allowedPaths, projectRoot) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return false;
  let rel = target;
  if (path.isAbsolute(target)) {
    const fromRoot = path.relative(projectRoot, target);
    if (fromRoot && !fromRoot.startsWith('..') && !path.isAbsolute(fromRoot)) {
      rel = fromRoot;
    }
  }
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '');
  return allowedPaths.some(
    (p) => pathMatchesPattern(norm, p) || pathMatchesPattern(target, p),
  );
}

// ---------------------------------------------------------------------------
// Entry point (#993)
//
// TWO distinct failure classes, two distinct handlers — do NOT merge them:
//
//   1. LOAD failure (`bootstrap()` throws): the guard never armed. Under the
//      exit-0 protocol a bare exit-1 crash with 0 bytes of stdout is, on the
//      only decision-bearing channel, indistinguishable from an allow. Now it
//      exits 0 (still fail-OPEN — a broken module must not brick the session,
//      and emitDeny itself may be the module that failed to load) but SAYS SO,
//      loudly: GUARD INACTIVE.
//   2. RUNTIME failure inside `main()`: pre-existing behaviour, unchanged. The
//      guard armed and then tripped over a specific command; that fails CLOSED
//      via emitDeny (SECURITY-REQ-01). The two paths MUST stay separate.
// ---------------------------------------------------------------------------
try {
  await bootstrap();
} catch (loadError) {
  try {
    const { emitGuardInactiveBanner } = await import('./_lib/guard-source-loader.mjs');
    // hookName is threaded explicitly (#993 — no hard-wired literal in the loader).
    emitGuardInactiveBanner({ hookName: HOOK_NAME, error: loadError, consequence: GUARD_CONSEQUENCE });
  } catch {
    // Last resort: even the banner helper failed to load. Emit unconditionally —
    // repeated noise beats a silent disarm.
    process.stderr.write(
      '🚨 enforce-commands: GUARD INACTIVE — module load failed ' +
        `(${String(loadError?.message || loadError).split('\n')[0]}). ` +
        'Blocked Bash commands are NOT being screened. See issue #993.\n'
    );
  }
  process.exit(0); // fail-open, but no longer fail-silent
}

// SECURITY-REQ-01 (F-03): top-level try/catch — never let exit 1 leak.
main().catch((e) => {
  emitDeny('Internal hook error — request blocked for safety', `${e?.message || e}`);
});
