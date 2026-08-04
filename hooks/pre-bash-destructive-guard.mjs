#!/usr/bin/env node
/**
 * pre-bash-destructive-guard.mjs — PreToolUse hook: blocks destructive Bash commands
 * at the MAIN SESSION level.
 *
 * Motivation: on 2026-04-19 the main session ran `git reset --hard HEAD~1` and
 * destroyed concurrent WIP. The rule (.claude/rules/parallel-sessions.md, PSA-003)
 * existed but had no executable guard. This hook is that guard.
 *
 * Part of issue #155 (deliverable 2). Node 20+, ESM, no bash-isms.
 *
 * Decision flow:
 *   G1 tool filter — only Bash is gated
 *   G2 command present + string
 *   G3 bypass: allow-destructive-ops: true in Session Config → exit 0
 *   G4 policy load: .orchestrator/policy/blocked-commands.json
 *      #972 floor/overlay merge (scripts/lib/blocked-commands-policy.mjs):
 *      pluginRoot policy = floor, cwd/projectDir policy = overlay (add or
 *      escalate only). Overlay failures fail-to-floor; only "no usable policy
 *      anywhere" keeps the historical fail-open (exit 0 + warn).
 *   G5 rule evaluation per rule in policy.rules
 *      severity:"block" → deny envelope on stdout via emitDeny, exit 0 (#906)
 *      severity:"warn"  → emit warning, exit 0 (allow)
 *      Special cases:
 *        git-stash-any: only warn when stash is non-empty
 *        rm-rf-destructive: path exception for .orchestrator/tmp and node_modules
 *        rule.type === 'redirect-truncate' (#983): decided by redirect TARGET
 *          via redirectRuleMatches (target-denylist globs), NEVER by the
 *          generic pattern path — its `pattern: ">"` would FP-match nearly
 *          every redirect. Unresolved targets (variable/substitution) warn
 *          on stderr (fail-visible) and never block.
 *   G6 no match → exit 0
 *
 * Telemetry (Epic #803 process-safety dimension): best-effort
 * `orchestrator.destructive_guard.blocked` / `orchestrator.destructive_guard.warned`
 * events are appended to events.jsonl on the block/warn paths. Payload never
 * includes the raw command — only a truncated sha256 `command_hash`. Emission
 * is wrapped in try/catch and happens BEFORE the block/warn outcome is
 * finalized; a telemetry failure never changes the guard's decision.
 */

import { readStdin, emitAllow, emitDeny } from '../scripts/lib/io.mjs';
import { resolveProjectDir, resolvePluginRoot } from '../scripts/lib/platform.mjs';
// Single direct import from the source module (W4 B6): the hardening.mjs
// barrel re-exports tokenizeCommand/commandMatchesBlocked from this very
// module (same instance either way) but deliberately does NOT re-export the
// #982/#983 primitives — one import path keeps the hook's dependency edge
// unambiguous. The barrel itself is unchanged.
import {
  tokenizeCommand,
  commandMatchesBlocked,
  extractRedirectTargets,
  redirectRuleMatches,
  resolveSegmentVerb,
  splitChainSegments,
} from '../scripts/lib/command-blocker.mjs';
import { readConfigFile } from '../scripts/lib/config.mjs';
import { loadEffectivePolicy } from '../scripts/lib/blocked-commands-policy.mjs';
import { isSessionConfigHeading } from '../scripts/lib/config/section-extractor.mjs';
import { emitEvent } from '../scripts/lib/events.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('pre-bash-destructive-guard')) process.exit(0);

// Module-level per-path policy cache (issue #250, extended for the #972
// floor/overlay merge: one Map entry per policy path instead of a single-path
// triple, so floor and overlay invalidate independently on mtime advance).
// Safe because each hook invocation runs as an isolated Node subprocess —
// state is fresh per process, never shared across calls.
const _policyCache = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * sha256(command) truncated to 16 hex chars — mirrors loop-guard.mjs
 * hashArgs(). Never emit the raw command into telemetry (privacy).
 *
 * @param {string} command
 * @returns {string}
 */
function hashCommand(command) {
  return crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
}

/**
 * Resolve a session id for event payloads. Precedence mirrors
 * loop-guard.mjs resolveSessionKey(): session_id → parent_session_id →
 * null (field omitted from the payload when unavailable).
 *
 * @param {object|null} input
 * @returns {string|null}
 */
function resolveSessionId(input) {
  if (input) {
    if (typeof input.session_id === 'string' && input.session_id.length > 0) {
      return input.session_id;
    }
    if (typeof input.parent_session_id === 'string' && input.parent_session_id.length > 0) {
      return input.parent_session_id;
    }
  }
  return null;
}

/**
 * Block a command: emit the PreToolUse deny envelope via emitDeny (exit 0).
 *
 * Until #906 this used a raw `process.exit(2)` plus its own stdout write,
 * justified by a claim that the multi-line message "required by the spec"
 * could not go through emitDeny. That claim was false in both halves:
 *   - Claude Code DISCARDS stdout on exit 2 and reads stderr instead — and
 *     this function wrote nothing to stderr, so the operator saw only
 *     `hook error: … No stderr output`, i.e. what looks like a crash. This
 *     was the single worst instance of that symptom in the repo.
 *   - emitDeny preserves multi-line reasons verbatim: JSON.stringify escapes
 *     the newlines, so the exact 4-line reason below round-trips unchanged
 *     inside `permissionDecisionReason` on ONE stdout line (verified against
 *     this very reason string). The operator additionally gets the first line
 *     as the `systemMessage` headline.
 *
 * Emits a best-effort `orchestrator.destructive_guard.blocked` telemetry
 * event BEFORE denying. Emission failure (e.g. unwritable events.jsonl path)
 * must NEVER change the block outcome — the guard's block-decision is
 * strictly independent of telemetry success. emitDeny never returns, so it
 * MUST stay the last statement here.
 *
 * @returns {Promise<never>}
 */
async function blockCommand(pattern, ruleId, rationale, command, sessionId) {
  const reason = [
    `Destructive command blocked: '${pattern}' (rule: ${ruleId})`,
    `Reason: ${rationale}`,
    `Override: Set \`allow-destructive-ops: true\` in Session Config if intentional.`,
    `See: issue #155, .claude/rules/parallel-sessions.md (PSA-003)`,
  ].join('\n');

  try {
    await emitEvent('orchestrator.destructive_guard.blocked', {
      ...(sessionId ? { session_id: sessionId } : {}),
      rule: ruleId,
      command_hash: hashCommand(command),
    });
  } catch {
    // Best-effort — telemetry must never block or alter the guard decision.
  }

  // Structured deny for the Claude Code PreToolUse hook protocol. Never returns.
  emitDeny(reason);
}

/**
 * Check whether git stash is non-empty by running `git stash list`.
 * Returns true if non-empty (should warn), false if empty (silent allow).
 * On any error returns true (conservative).
 */
async function isGitStashNonEmpty(projectDir) {
  try {
    const { $: zx$ } = await import('zx');
    zx$.verbose = false;
    zx$.quiet = true;
    const cwd = projectDir || process.cwd();
    const result = await zx$`git -C ${cwd} stash list`;
    return result.stdout.trim().length > 0;
  } catch {
    // On git failure → conservative: warn
    return true;
  }
}

/**
 * Given a redirect token at `segment[i]`, return the index of the LAST token
 * belonging to that redirect (the operand word, when one exists). Redirect
 * operators and their operands name IO targets, not command arguments —
 * `rm -rf /tmp/ok > out.log` must not collect `>` or `out.log` as rm targets
 * (#983 FP fix). `dup` (`2>&1`) carries no operand word.
 *
 * @param {Array<{ text: string, quoted: boolean, redirect?: object }>} segment
 * @param {number} i — index of the redirect token
 * @returns {number}
 */
function redirectSpanEnd(segment, i) {
  const tok = segment[i];
  // `dup` (2>&1) carries its target inline; `heredoc` consumes its delimiter in
  // the lexer (the body arrives as a separate QUOTED token) — neither owns an
  // operand word, and claiming one would swallow the next real token.
  const hasOperandWord = tok.redirect.mode !== 'dup' && tok.redirect.mode !== 'heredoc';
  if (hasOperandWord && i + 1 < segment.length && !segment[i + 1].redirect) {
    return i + 1;
  }
  return i;
}

/**
 * Parse ALL non-flag path arguments from every `rm` invocation in a command.
 *
 * Hardened over the previous single-target parser (#641): handles `-r -f`,
 * `-fr`, `-rf`, `--` end-of-options ordering, multiple targets per `rm`, and
 * chained commands (`rm -rf /tmp/x; rm -rf src/`). Quote-aware via
 * tokenizeCommand so a path with spaces inside quotes is one target.
 *
 * Wrapper-aware (#982 T2): the segment verb resolves through the transparent
 * wrappers in WRAPPER_UNWRAP via resolveSegmentVerb — `sudo rm -rf /tmp/ok`,
 * `timeout 5 rm -rf /x`, `nohup rm -rf …` parse their REAL targets instead of
 * falling back to the empty-target conservative block. Redirect tokens and
 * their operands are skipped (#983): they are IO targets, not rm targets.
 *
 * Returns BOTH halves of the operand/redirect split (merge of the two
 * 2026-08-03 guard sessions — the two protection layers are complementary):
 *   - `targets` — the rm operands (what gets deleted). Judged against the
 *     rule's `path-allowlist` by the caller.
 *   - `writeTargets` — the files each WRITE redirect (`truncate` or `append`
 *     mode) in the same invocation clobbers-or-creates. Read redirects,
 *     here-docs/here-strings and fd duplications (`2>&1`) contribute nothing.
 *     The caller holds these to the SAME allowlist (with `/dev/null` carved
 *     out via isNullSink), because `rm -rf /tmp/ok > src/important.ts` empties
 *     a project file on the strength of an allowlisted rm operand. This is the
 *     rm-context layer; protected artefacts (`> CLAUDE.md` — `> AGENTS.md` on
 *     Codex CLI, the same truncation class) are ADDITIONALLY
 *     denied command-independently by the `redirect-truncate-protected`
 *     policy rule (rule 14).
 *
 * The caller treats the rm-rf rule as "allowed" only when EVERY operand and
 * EVERY write-redirect target passes its respective check — a segment whose
 * pattern matched but whose verb does NOT resolve to `rm` (e.g. an interpreter
 * payload) contributes no targets and stays fail-closed.
 *
 * @param {string} command
 * @returns {{targets: string[], writeTargets: string[]}}
 */
function parseRmTargets(command) {
  const targets = [];
  const writeTargets = [];

  for (const segment of splitChainSegments(tokenizeCommand(command))) {
    const { verb, index } = resolveSegmentVerb(segment);
    if (verb !== 'rm') continue;

    let seenDashDash = false;
    for (let i = index + 1; i < segment.length; i++) {
      const tok = segment[i];
      if (tok.redirect) {
        const end = redirectSpanEnd(segment, i);
        const mode = tok.redirect.mode;
        if ((mode === 'truncate' || mode === 'append') && end > i) {
          const operand = segment[end];
          if (operand && !(!operand.quoted && /^(;|&&|\|\||\||&)$/.test(operand.text))) {
            writeTargets.push(operand.text);
          }
        }
        i = end;
        continue;
      }
      if (!seenDashDash && tok.text === '--') { seenDashDash = true; continue; }
      // A flag is unquoted and starts with '-' (and is not the bare '-' stdin marker).
      if (!seenDashDash && !tok.quoted && tok.text.startsWith('-') && tok.text !== '-') continue;
      targets.push(tok.text);
    }
  }

  return { targets, writeTargets };
}

/**
 * `/dev/null` is the one write-redirect destination that destroys nothing: it is
 * a character device, so `>` on it neither truncates nor creates a file. It is
 * also the single most common rm-plumbing target (`rm -rf /tmp/x 2> /dev/null`).
 *
 * Deliberately NOT folded into isRmPathAllowed: `rm -rf /dev/null` must stay
 * blocked — deleting the device node is destructive, writing to it is not.
 *
 * @param {string} targetPath
 * @returns {boolean}
 */
function isNullSink(targetPath) {
  return Boolean(targetPath)
    && path.isAbsolute(targetPath)
    && path.normalize(targetPath) === path.join(path.sep, 'dev', 'null');
}

/**
 * Detect whether the command contains an UNQUOTED `rm` invocation carrying BOTH
 * recursive (`-r`/`-R`/`--recursive`) AND force (`-f`/`--force`) semantics,
 * including combined/short forms (`-rf`, `-fr`, `-r -f`) and the long-flag pair
 * (`--recursive --force`). This catches flag-form variants the literal "rm -rf"
 * pattern misses (#641 gap closure) while staying consistent with the
 * quoted-payload guard: an `rm` that appears only inside a quoted token is NOT
 * treated as an invocation here.
 *
 * Wrapper-aware (#982 T2) + redirect-skip (#983) — same segment mechanics as
 * parseRmTargets above.
 *
 * Redirect operators and their targets are skipped for the same reason as in
 * parseRmTargets: a redirect target is a filename the shell consumes, so
 * `rm -r /tmp/x > -f` must not read `-f` as rm's force flag.
 *
 * This walker deliberately DISCARDS redirect spans entirely. Its question is
 * only "does this command contain a recursive+force rm at all", i.e. whether
 * the rm-rf rule MATCHES — it never decides allow-vs-deny. Write-redirect
 * targets are judged once, by the `redirect-truncate-protected` policy rule
 * (rule 14), never here — a second collector would give the guard a silently
 * divergent opinion about the same fact.
 *
 * @param {string} command
 * @returns {boolean}
 */
function commandHasRecursiveForceRm(command) {
  for (const segment of splitChainSegments(tokenizeCommand(command))) {
    const { verb, index } = resolveSegmentVerb(segment);
    if (verb !== 'rm' || segment[index].quoted) continue;

    let recursive = false;
    let force = false;
    let seenDashDash = false;
    for (let i = index + 1; i < segment.length; i++) {
      const t = segment[i];
      if (t.redirect) { i = redirectSpanEnd(segment, i); continue; }
      if (!seenDashDash && t.text === '--') { seenDashDash = true; continue; }
      if (!seenDashDash && !t.quoted && t.text.startsWith('-') && t.text !== '-') {
        if (t.text === '--recursive') recursive = true;
        else if (t.text === '--force') force = true;
        else if (/^-[a-zA-Z]+$/.test(t.text)) {
          // Bundled short flags: -rf, -fr, -Rf, etc.
          if (/[rR]/.test(t.text)) recursive = true;
          if (/f/.test(t.text)) force = true;
        }
      }
      // non-flag arg (a target) — skip
    }
    if (recursive && force) return true;
  }
  return false;
}

/** Probe operator per redirect mode — see findMatchedRedirectEntry. */
const REDIRECT_PROBE_OPS = { truncate: '>', append: '>>', read: '<' };

/**
 * Identify WHICH resolved redirect entry a matched redirect-truncate rule hit,
 * so the deny reason can name the target (#983). redirectRuleMatches returns
 * only a boolean and its glob matcher is internal to command-blocker.mjs —
 * rather than duplicate the glob logic here (it would be the third copy), each
 * candidate target is re-probed through redirectRuleMatches with a minimal
 * single-redirect command. Resolved targets are guaranteed free of `$` and
 * backticks (those are reported `unresolved`), so the quoted probe round-trips
 * the target text exactly.
 *
 * `repoRoot` MUST be the same value the deciding redirectRuleMatches call used
 * (#988 T1): an absolute/`~` target only matches when the root is supplied, so
 * dropping it here would leave `hit === null` for exactly the targets the new
 * resolution added and the deny reason would silently fall back to the pattern.
 *
 * @param {object} rule — the redirect-truncate policy rule
 * @param {Array<{ target: string|null, mode: string, unresolved?: boolean }>} entries
 * @param {string} repoRoot — absolute repo root, forwarded to redirectRuleMatches
 * @returns {{ target: string, mode: string }|null}
 */
function findMatchedRedirectEntry(rule, entries, repoRoot) {
  for (const entry of entries) {
    if (entry.unresolved) continue;
    const op = REDIRECT_PROBE_OPS[entry.mode] ?? '>';
    const probe = `${op} "${entry.target.replace(/[\\"]/g, '\\$&')}"`;
    if (redirectRuleMatches(rule, probe, { repoRoot })) return entry;
  }
  return null;
}

/**
 * Expand a LEADING `$TMPDIR` / `${TMPDIR}` reference in an rm target token.
 *
 * The hook is a PreToolUse gate: it sees the raw, UNEXPANDED shell string.
 * `rm -rf "${TMPDIR}"scratch` therefore arrives as the token `${TMPDIR}scratch`,
 * which `path.isAbsolute()` reads as a RELATIVE path — so the #641 `wasAbsolute`
 * gate (correctly, on its own terms) refuses to match it against any /tmp-class
 * prefix, and the path is instead resolved against the PROJECT dir. A legitimate
 * temp cleanup is blocked (#935 cause 1). Substituting the value the shell would
 * have substituted, BEFORE absoluteness is judged, is the narrow fix.
 *
 * This does NOT by itself widen the safe set: the expansion result still has to
 * land under a CONFINED allowlist prefix (see resolveAllowlistPrefixes), so an
 * inherited `TMPDIR=/etc` expands to `/etc/...` and is still blocked (#642).
 *
 * Deliberately narrow: only TMPDIR, only in leading position, only when its
 * value is absolute, and byte-for-byte as the shell would splice it (no invented
 * separator — `TMPDIR=/tmp` + `${TMPDIR}x` really is `/tmpx`, not `/tmp/x`).
 * A generic env-expander would be a far larger attack surface.
 *
 * @param {string} targetPath
 * @returns {string}
 */
function expandTmpdirToken(targetPath) {
  const m = /^\$(?:TMPDIR\b|\{TMPDIR\})/.exec(targetPath);
  if (!m) return targetPath;
  const value = process.env.TMPDIR || os.tmpdir();
  if (!value || !path.isAbsolute(value)) return targetPath;
  return value + targetPath.slice(m[0].length);
}

/**
 * Canonicalise `absPath` by realpath-ing the deepest EXISTING ancestor and
 * re-attaching the non-existent suffix.
 *
 * `fs.realpathSync.native` throws ENOENT on a path that does not exist — which
 * is the NORMAL case here: `rm -rf` frequently targets something already gone,
 * and a policy prefix (`$TMPDIR` of another boot session) need not exist either.
 * The upward walk mirrors the identical pattern in hooks/enforce-scope.mjs
 * (SECURITY-REQ-03) rather than inventing a second one.
 *
 * Any other fs error → return the lexical input unchanged. That is the fail-safe
 * direction: the caller then compares lexically, i.e. exactly the pre-#935
 * behaviour, never a broader one.
 *
 * @param {string} absPath
 * @returns {string}
 */
function canonicalizeAncestors(absPath) {
  let ancestor = absPath;
  const segments = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(ancestor);
      return segments.length ? path.join(real, ...segments.reverse()) : real;
    } catch (err) {
      // ENOENT: nothing at this level yet. ENOTDIR: a FILE sits in the chain.
      // Both mean "keep walking up"; anything else (ELOOP, EACCES) → lexical.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return absPath;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return absPath; // reached the fs root, nothing existed
      segments.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * Canonical LOCATION of an `rm` target.
 *
 * `rm -rf X` removes X ITSELF: when X is a symlink the link is unlinked and what
 * it points at is untouched. So the final segment must NOT be symlink-resolved —
 * only its parent chain. Resolving the leaf would be both wrong about what rm
 * does and unsafe: `<project>/link-to-tmp` would canonicalise to /private/tmp and
 * read as a safe temp target while the delete lands on project content.
 *
 * Canonicalising the parent chain keeps the judgement honest in both directions:
 *   - `/tmp/link-to-etc/x` canonicalises OUT of the temp allowlist → blocked.
 *     The pre-#935 literal prefix match allowed it (measured, real hole).
 *   - `$TMPDIR/x` and its `/private/var/folders/...` canonical spelling collapse
 *     onto the same string → both allowed, no literal-form guessing.
 *
 * @param {string} abs — already `path.normalize`d absolute path
 * @returns {string}
 */
function canonicalizeRmTarget(abs) {
  const parent = path.dirname(abs);
  if (parent === abs) return abs; // filesystem root
  return path.join(canonicalizeAncestors(parent), path.basename(abs));
}

/**
 * Return true when a single path is a safe `rm -rf` target.
 *
 * Safe targets:
 *   - <projectRoot>/.orchestrator/tmp (any depth)
 *   - <projectRoot>/node_modules (any depth)
 *   - /tmp/ (any depth)                    — agent-owned scratch
 *   - /private/tmp/ (any depth)            — macOS canonical /tmp
 *   - resolved os.tmpdir() / $TMPDIR (any depth), in either spelling
 *
 * The /tmp-class prefixes come from the rule's optional `path-allowlist` and are
 * resolved at runtime here.
 *
 * @param {string} targetPath
 * @param {string} projectDir
 * @param {string[]} ruleAllowlist — `path-allowlist` entries (e.g. "/tmp/", "$TMPDIR")
 * @returns {boolean}
 */
function isRmPathAllowed(targetPath, projectDir, ruleAllowlist = []) {
  if (!targetPath) return false;

  const base = projectDir || process.cwd();
  // Restore the shell's own substitution before judging absoluteness (#935).
  const effective = expandTmpdirToken(targetPath);
  const wasAbsolute = path.isAbsolute(effective);

  // Project-relative safe dirs (always allowed, independent of the rule allowlist).
  // Deliberately LEXICAL: a project-relative candidate is never symlink-resolved,
  // otherwise a link inside the project pointing at /tmp would read as safe and
  // `rm -rf <that link>` — which destroys project content — would be allowed.
  const abs = wasAbsolute
    ? path.normalize(effective)
    : path.resolve(base, effective);

  const safeProjectDirs = [
    path.join(base, '.orchestrator', 'tmp'),
    path.join(base, 'node_modules'),
  ];
  for (const safe of safeProjectDirs) {
    if (abs === safe || abs.startsWith(safe + path.sep)) return true;
  }

  // Rule-driven absolute prefixes (/tmp/, /private/tmp/, $TMPDIR).
  // Apply ONLY to targets that were ABSOLUTE in the command. A bare relative
  // target (e.g. "src/") is project-relative and must NEVER be allowlisted by a
  // /tmp prefix just because the project dir itself happens to live under /tmp
  // (the case on CI runners where os.tmpdir() === /tmp). #641.
  if (wasAbsolute) {
    // Compare CANONICAL forms on both sides. Literal matching made the verdict
    // depend on which spelling of the same directory was typed (`/var/folders/…`
    // allowed, `/private/var/folders/…` blocked — #935 cause 2) and let a symlink
    // under /tmp launder a non-temp destination into the allowlist.
    const canonTarget = canonicalizeRmTarget(abs);
    for (const prefix of resolveAllowlistPrefixes(ruleAllowlist)) {
      // The target must be the prefix dir itself or a descendant of it.
      if (canonTarget === prefix || canonTarget.startsWith(prefix + path.sep)) return true;
    }
  }

  return false;
}

/**
 * Resolve the rule's `path-allowlist` entries into concrete absolute directory
 * prefixes. `$TMPDIR` expands to env.TMPDIR (if set) and os.tmpdir(); literal
 * paths are normalised. Trailing slashes are stripped for prefix comparison.
 *
 * Every prefix is emitted in BOTH its lexical and its canonical (realpath)
 * spelling, because the target it is compared against is canonicalised too
 * (see canonicalizeRmTarget) — and when realpath is unavailable both sides fall
 * back to lexical together, so the pair never drifts apart.
 *
 * @param {string[]} ruleAllowlist
 * @returns {string[]} normalised absolute prefixes (no trailing slash)
 */
function resolveAllowlistPrefixes(ruleAllowlist) {
  const out = new Set();
  const strip = (p) => path.normalize(p).replace(/[/\\]+$/, '');

  // Canonical macOS spellings are listed EXPLICITLY next to their symlink form:
  // /tmp → /private/tmp and /var/folders → /private/var/folders. A TMPDIR handed
  // to us already canonicalised (what fs.realpath returns on macOS) previously
  // failed this confinement check and contributed NO prefix at all, so EVERY
  // $TMPDIR target was blocked (#935 cause 2).
  const tempRoots = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
    .map((p) => path.normalize(p));
  const underTempRoot = (p) =>
    tempRoots.some((root) => p === root || p.startsWith(root + path.sep));

  // Operator-authored, VCS-reviewed policy literals (`/tmp/`, `/private/tmp/`).
  const add = (p) => {
    if (!p) return;
    const lex = strip(p);
    if (!lex) return;
    out.add(lex);
    const canon = strip(canonicalizeAncestors(lex));
    if (canon) out.add(canon);
  };

  // Environment-derived (`$TMPDIR`) — attacker-influencable, hence DOUBLE
  // confinement: the value must sit under a temp root both as written AND after
  // symlink resolution. Checking only the lexical form would let a `TMPDIR`
  // pointing at a symlink under /tmp (e.g. /tmp/evil → <project>) promote the
  // project itself to an allowlisted prefix (#642 confinement, extended).
  const addTemp = (p) => {
    if (!p || !path.isAbsolute(p)) return;
    const lex = strip(p);
    if (!lex || !underTempRoot(lex)) return;
    const canon = strip(canonicalizeAncestors(lex));
    if (!canon || !underTempRoot(canon)) return;
    out.add(lex);
    out.add(canon);
  };

  for (const entry of Array.isArray(ruleAllowlist) ? ruleAllowlist : []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (entry === '$TMPDIR' || entry === '${TMPDIR}') {
      if (process.env.TMPDIR) addTemp(process.env.TMPDIR);
      addTemp(os.tmpdir());
      continue;
    }
    if (path.isAbsolute(entry)) add(entry);
  }

  return [...out];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — only Bash is gated
  if (input.tool_name !== 'Bash') return emitAllow();

  // G2 — command must be a non-empty string
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  const projectDir = resolveProjectDir();
  const sessionId = resolveSessionId(input);

  // G3 — bypass: allow-destructive-ops: true in Session Config
  // Note: parseSessionConfig only returns known fields; allow-destructive-ops is
  // a new field, so we parse the raw markdown for it directly.
  try {
    const mdContent = await readConfigFile(projectDir);
    // Look for "allow-destructive-ops: true" in the Session Config block.
    // Simple line-based scan: find lines under ## Session Config, stop at next ##.
    const lines = mdContent.split(/\r?\n/);
    let inConfig = false;
    for (const line of lines) {
      // SSOT predicate (#968) — never re-derive this comparison. A local copy
      // that drifts LOOSER than the extractor silently disagrees with the
      // runtime about where the config block starts.
      if (isSessionConfigHeading(line)) { inConfig = true; continue; }
      if (inConfig && /^## /.test(line)) break;
      if (inConfig) {
        const m = line.match(/^\s*(?:-\s+\*\*)?allow-destructive-ops(?::\*\*)?\s*:\s*(\S+)/);
        if (m && m[1].toLowerCase() === 'true') {
          process.stderr.write('ℹ destructive-guard bypassed\n');
          return emitAllow();
        }
      }
    }
  } catch {
    // No config file or parse error — proceed to policy check
  }

  // G4 — policy load (#972: floor/overlay merge, not first-hit-wins).
  // The plugin-root policy is the FLOOR; a cwd/projectDir policy is an OVERLAY
  // that can only add rules or escalate severity — an empty or malformed
  // consumer policy fails TO THE FLOOR instead of silently disarming the guard.
  // Only when NO usable policy exists at all does the guard keep its documented
  // fail-open (rules === null → emitAllow with a stderr warning).
  const { rules, warnings } = await loadEffectivePolicy({
    cwd: process.cwd(),
    projectDir,
    pluginRoot: resolvePluginRoot(),
    cache: _policyCache,
  });
  for (const warning of warnings) {
    process.stderr.write(`⚠ pre-bash-destructive-guard: ${warning}\n`);
  }
  if (!Array.isArray(rules)) return emitAllow();

  // G5 — rule evaluation
  for (const rule of rules) {
    const { id, pattern, severity, rationale = '' } = rule;

    // #983 — redirect-truncate rules are decided by redirect TARGET via
    // redirectRuleMatches, NEVER by the generic pattern path below: their
    // `pattern: ">"` substring-matches virtually every redirect (measured
    // interim FP: `bash -c 'echo a > b'` denied), so this branch must fully
    // shadow the pattern match for this rule class.
    if (rule.type === 'redirect-truncate') {
      const modes = new Set(
        Array.isArray(rule.modes) && rule.modes.length > 0 ? rule.modes : ['truncate']
      );
      const collected = extractRedirectTargets(command);
      const entries = collected.filter((e) => modes.has(e.mode));
      // Recursion-cap markers (#988 T2) carry `mode: null` by construction — a
      // bare `modes.has(e.mode)` filter drops them, which would make the new
      // marker unobservable here. Keep them alongside the mode-matching ones.
      const unresolved = collected.filter(
        (e) => e.unresolved && (e.mode === null || modes.has(e.mode))
      );
      if (unresolved.length > 0) {
        // Variable/substitution operands are never match candidates (#641 FP
        // class) — surface them instead of guessing; never block on a guess.
        // Same for a payload subtree a recursion cap cut off: the cap stays,
        // its effect stops being silent.
        const reasons = [
          ...new Set(unresolved.map((e) => e.reason ?? 'variable/substitution')),
        ].join(', ');
        process.stderr.write(
          `⚠ pre-bash-destructive-guard: unresolved redirect target (${reasons}) — not matched (fail-visible)\n`
        );
      }
      if (!redirectRuleMatches(rule, command, { repoRoot: projectDir })) continue;
      if (severity !== 'block') {
        process.stderr.write(
          `⚠ pre-bash-destructive-guard: redirect target matched (rule: ${id}) — ${rationale}\n`
        );
        continue;
      }
      // Reason stays short (stdout-budget): operator + target, never the command.
      const hit = findMatchedRedirectEntry(rule, entries, projectDir);
      const label = hit ? `${REDIRECT_PROBE_OPS[hit.mode] ?? '>'} ${hit.target}` : pattern;
      await blockCommand(label, id, rationale, command, sessionId);
      continue; // unreachable (blockCommand never returns) — kept for clarity
    }

    // The rm-rf-destructive rule also fires for recursive+force rm flag variants
    // the literal "rm -rf" pattern misses (`rm -r -f`, `rm -fr`) — #641 gap closure.
    const matched = id === 'rm-rf-destructive'
      ? (commandMatchesBlocked(command, pattern) || commandHasRecursiveForceRm(command))
      : commandMatchesBlocked(command, pattern);
    if (!matched) continue;

    if (severity === 'warn') {
      // Special: git-stash-any — only warn when stash is non-empty
      if (id === 'git-stash-any') {
        const nonEmpty = await isGitStashNonEmpty(projectDir);
        if (!nonEmpty) {
          // Empty stash — silent allow
          continue;
        }
      }
      process.stderr.write(
        `⚠ pre-bash-destructive-guard: '${pattern}' (rule: ${id}) — ${rationale}\n`
      );
      // Best-effort telemetry — must never affect the warn/allow outcome.
      try {
        await emitEvent('orchestrator.destructive_guard.warned', {
          ...(sessionId ? { session_id: sessionId } : {}),
          rule: id,
          command_hash: hashCommand(command),
        });
      } catch {
        // Best-effort — telemetry must never block or alter the guard decision.
      }
      // warn → allow (exit 0), continue checking remaining rules
      continue;
    }

    if (severity === 'block') {
      // Special: rm-rf-destructive — path exception
      if (id === 'rm-rf-destructive') {
        const ruleAllowlist = Array.isArray(rule['path-allowlist']) ? rule['path-allowlist'] : [];
        const { targets, writeTargets } = parseRmTargets(command);
        // Allow ONLY when there is at least one target AND every target is
        // allowlisted. An unparseable command (no targets) or any non-allowlisted
        // target → block (conservative). This makes mixed chains like
        // `rm -rf /tmp/x; rm -rf src/` block on the src/ target.
        //
        // Every WRITE-redirect target of the same invocation must clear the SAME
        // allowlist (with /dev/null carved out): `>` truncates its target before
        // rm ever runs, so without this the allow path waved through
        // `rm -rf /tmp/ok > src/important.ts` on the strength of an allowlisted
        // rm operand. Protected artefacts (`> CLAUDE.md`) are ADDITIONALLY
        // covered command-independently by rule 14 (redirect-truncate-protected)
        // — two complementary layers from the two 2026-08-03 guard sessions.
        const allAllowed =
          targets.length > 0 &&
          targets.every((t) => isRmPathAllowed(t, projectDir, ruleAllowlist)) &&
          writeTargets.every(
            (t) => isNullSink(t) || isRmPathAllowed(t, projectDir, ruleAllowlist)
          );
        if (allAllowed) {
          // Safe paths only (.orchestrator/tmp, node_modules, /tmp, $TMPDIR) — allow
          continue;
        }
      }
      await blockCommand(pattern, id, rationale, command, sessionId);
    }
    // Unknown severity → skip (conservative allow for unknown future severities)
  }

  // G6 — no blocking match
  return emitAllow();
}

// Top-level error handler — never let exit 1 leak
main().catch((e) => {
  process.stderr.write(
    `⚠ pre-bash-destructive-guard: internal error — ${e?.message || e}\n`
  );
  process.exit(0); // fail-open on internal errors to avoid blocking legitimate work
});
