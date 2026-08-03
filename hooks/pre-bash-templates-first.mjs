#!/usr/bin/env node
/**
 * pre-bash-templates-first.mjs — PreToolUse hook: blocks `gh|glab pr|mr|issue
 * create|new` invocations when no matching template was Read earlier in the
 * session.
 *
 * Implements Pattern 3 of "gsd Pattern Adoption Quick-Wins" (#519; archived in
 * the private Meta-Vault). Companion to pre-bash-destructive-guard.mjs (issue
 * #155); both share the PreToolUse Bash matcher and run sequentially.
 *
 * Decision flow:
 *   G1 tool filter — only Bash is gated; other tools pass through.
 *   G2 command is a non-empty string.
 *   G3 regex match against /^\s*(gh|glab)\s+(pr|mr|issue)\s+(create|new)\b/.
 *      No match → exit 0 (the call is not a create/new operation).
 *   G4 policy load: .orchestrator/policy/templates-policy.json.
 *      Missing → exit 0 + stderr warning. Malformed → exit 0 + stderr warning.
 *   G5 bypass-pattern check: any entry in policy.bypass_patterns that the
 *      command starts with → exit 0.
 *   G6 acknowledgement-file check: if the file under the resolved acknowledgement
 *      path contains an entry for the current session_id, exit 0.
 *   G7 transcript inspection via hooks/_lib/transcript-history.mjs.
 *      If any prior Read tool call matches one of the host-specific template
 *      paths from the policy, exit 0.
 *   G8 fall-through: emit the PreToolUse deny envelope on stdout via emitDeny
 *      (exit 0) with the template-path list + ack hint inside the reason.
 *
 * Fail-safe posture: any internal exception is swallowed in main().catch and
 * the hook exits 0 (allow). Rationale matches pre-bash-destructive-guard.mjs:
 * a templates-first hook that crashes should not block legitimate work; the
 * worst case is a missed enforcement, not a wedged session.
 *
 * Exit codes:
 *   0  — every path. Pass-through (G1-G3 short-circuits, bypass match,
 *        acknowledgement, Read found, error) emits nothing; G8 emits the deny
 *        envelope on stdout. Exit 2 is NEVER used: Claude Code discards stdout
 *        on exit 2, which would throw away the deny envelope entirely (#906).
 */

import { readStdin, emitAllow, emitDeny } from '../scripts/lib/io.mjs';
import { resolveProjectDir, resolvePluginRoot } from '../scripts/lib/platform.mjs';
import { readJson } from '../scripts/lib/common.mjs';
import { hasReadInSession } from './_lib/transcript-history.mjs';
import { resolveHost, matchesBypass } from './_lib/vcs-create-matcher.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

// #519: opt-in via profile/env. Default profile "full" enables this hook;
// minimal/off disable. SO_DISABLED_HOOKS=pre-bash-templates-first opts out
// per session.
if (!shouldRunHook('pre-bash-templates-first')) process.exit(0);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The `gh`/`glab` create matcher (`CREATE_REGEX`, `resolveHost`,
 * `matchesBypass`) now lives in `hooks/_lib/vcs-create-matcher.mjs` so the
 * sibling issue-budget hook parses create commands with byte-identical
 * semantics instead of a diverging copy. Behaviour here is unchanged.
 */

/**
 * Default acknowledgement path, relative to project root. Used when the
 * policy omits the `acknowledgement_file` key.
 */
const DEFAULT_ACK_PATH = '.orchestrator/runtime/templates-acknowledged.json';

/**
 * Ceiling (in characters) for the raw bash command echoed into the deny reason.
 *
 * ## Why this file needs its own bound at all (#919, follow-up to #906)
 *
 * `command` is the ONE attacker/agent-controlled term in the reason — every
 * other line is fixed text or a repo-derived path list. Echoing it unbounded
 * made this hook the shortest path to the failure mode #906 was repaired for:
 * a reason large enough to push the stdout envelope past the 65 536-byte kernel
 * pipe buffer, where a truncated envelope reads as "no decision" and the tool
 * call is ALLOWED. `emitDeny`'s {@link DENY_REASON_MAX} clamp (16 000) now
 * stands in that path, but a consumer that respects the bound itself is the
 * more robust shape — defence in depth, not reliance on the single downstream
 * clamp.
 *
 * The clamp alone is also NOT sufficient here, which is the concrete bug this
 * constant fixes rather than merely hardens against. `Command:` is line 2 of 6;
 * the template-path list and the `/templates-ack` hint are lines 3-6. A
 * 200 000-char command therefore consumed the entire 16 000-char budget and cut
 * the remedy off the end — the deny still bit, but PRD § 3 Gherkin Pattern 3's
 * required content never reached the reader.
 *
 * ## Why 512 and not the 80 used at the two stderr sites below
 *
 * This file already truncates `command` twice (bypass-matched and
 * no-templates-found), both at `slice(0, 80)`. Those are one-line **stderr log**
 * lines, where 80 is the terminal-width convention — a different consumer class.
 * The repo's precedent for bounding a bash command inside a **structured record
 * field** is `hooks/pre-bash-staging-fence.mjs` (`staged_paths[].command`,
 * `slice(0, 512)`), and `permissionDecisionReason` is exactly that: a structured
 * field, not a log line. Reusing 512 follows the matching house convention
 * instead of inventing a third number. Reusing 80 would clip a realistic
 * `gh pr create --title … --body …` mid-flag, defeating the recognisability the
 * line exists to provide.
 *
 * Bound check: the fixed part of this reason measures 348 chars (see the
 * call-site table in `scripts/lib/io.mjs`), so the worst case is 348 + 512 +
 * the path list — ~19× below `DENY_REASON_MAX` and ~76× below the pipe buffer.
 * This hook no longer contributes an unbounded term to the envelope at all.
 */
const COMMAND_ECHO_MAX = 512;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clip the echoed command to {@link COMMAND_ECHO_MAX}, marking the cut so the
 * reader can tell the command was truncated rather than ending there.
 *
 * The marker is budgeted INSIDE the ceiling — mirroring `_clampReason` in
 * `scripts/lib/io.mjs` — so the returned string never exceeds it and the
 * worst-case reason length stays a fixed, auditable number.
 *
 * @param {string} command
 * @returns {string}
 */
function clipCommand(command) {
  if (command.length <= COMMAND_ECHO_MAX) return command;
  const marker = `… [truncated: showing ${COMMAND_ECHO_MAX} of ${command.length} characters]`;
  return command.slice(0, COMMAND_ECHO_MAX - marker.length) + marker;
}

/**
 * Block the create command: emit the PreToolUse deny envelope via emitDeny
 * (exit 0). Mirrors pre-bash-destructive-guard.mjs blockCommand() so downstream
 * Claude Code rendering is consistent.
 *
 * PRD § 3 Gherkin Pattern 3 requires the template-path list plus the
 * `/templates-ack` hint to reach the reader. That requirement is UNCHANGED —
 * only the channel moved (#906). Until #906 this text was written to stderr AND
 * duplicated into an `exit 2` stdout envelope, the mixed form the hook docs
 * forbid ("choose one approach per hook, not both"). Under exit 0, stderr is
 * only surfaced in the debug log — invisible to both operator and model — so a
 * stderr write would look alive while being dead. The full multi-line text
 * therefore travels as the emitDeny `reason`, landing in
 * `permissionDecisionReason`, which is fed to **Claude** — the actor that has
 * to read the template or run `/templates-ack`. The operator sees the first
 * line via the derived `systemMessage` headline.
 *
 * The echoed `command` is bounded by {@link COMMAND_ECHO_MAX} before it enters
 * the reason: it is the only agent-controlled term here, and left unbounded it
 * both risked the pipe-buffer fail-open #906 repaired AND pushed the template
 * list plus the ack hint past `emitDeny`'s clamp — i.e. truncated away exactly
 * the content the PRD requires. See that constant for the full rationale.
 *
 * @param {{ host: string, command: string, templatePaths: string[],
 *           ackFile: string }} ctx
 * @returns {never}
 */
function blockCreate(ctx) {
  const { host, command, templatePaths, ackFile } = ctx;
  const pathList = templatePaths.length > 0
    ? templatePaths.map((p) => `  - ${p}`).join('\n')
    : '  (none configured)';
  const reason = [
    `pre-bash-templates-first: ${host} create call detected without prior template Read.`,
    `Command: ${clipCommand(command)}`,
    `Found templates:`,
    pathList,
    `Read one of these first, OR run \`/templates-ack\` (writes ${ackFile}) to bypass for this session.`,
    `See: issue #519, "gsd Pattern Adoption Quick-Wins" (archived in the private Meta-Vault) (Pattern 3)`,
  ].join('\n');

  // Single channel: the full multi-line reason (template paths + ack hint)
  // rides in permissionDecisionReason. Never returns.
  emitDeny(reason);
}

/**
 * Resolve the policy file path, searching in priority order. Mirrors the
 * resolution chain in pre-bash-destructive-guard.mjs so administrators only
 * have to maintain a single mental model for policy locations.
 *
 * @param {string|null} projectDir
 * @returns {string|null}
 */
function resolvePolicyPath(projectDir) {
  const candidates = [
    path.join(
      process.cwd(),
      '.orchestrator',
      'policy',
      'templates-policy.json',
    ),
  ];

  if (projectDir && projectDir !== process.cwd()) {
    candidates.push(
      path.join(projectDir, '.orchestrator', 'policy', 'templates-policy.json'),
    );
  }

  const pluginRoot = resolvePluginRoot();
  if (pluginRoot) {
    candidates.push(
      path.join(pluginRoot, '.orchestrator', 'policy', 'templates-policy.json'),
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Check the acknowledgement file for the current session_id. Best-effort:
 * any read or parse error means "no acknowledgement" (returns false) so the
 * subsequent transcript-history check still runs. The acknowledgement file
 * schema is intentionally minimal:
 *
 *   { "<session_id>": { "acknowledgedAt": "<ISO timestamp>" } }
 *
 * A future /templates-ack command writes this file; the hook only reads it.
 *
 * @param {string} ackFilePath
 * @param {string|null} sessionId
 * @returns {Promise<boolean>}
 */
async function isAcknowledged(ackFilePath, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return false;
  if (!existsSync(ackFilePath)) return false;
  try {
    const data = await readJson(ackFilePath);
    if (!data || typeof data !== 'object') return false;
    const entry = data[sessionId];
    return Boolean(entry && typeof entry === 'object' && entry.acknowledgedAt);
  } catch {
    return false;
  }
}

/**
 * Pull the session_id from the hook stdin payload, with a single fallback
 * to the persisted file written by on-session-start.mjs. Returns null when
 * neither source yields a string.
 *
 * @param {object|null} input
 * @param {string|null} projectDir
 * @returns {Promise<string|null>}
 */
async function resolveSessionId(input, projectDir) {
  const fromStdin = input?.session_id ?? input?.sessionId ?? null;
  if (typeof fromStdin === 'string' && fromStdin.length > 0) return fromStdin;

  if (!projectDir) return null;
  const persisted = path.join(projectDir, '.orchestrator', 'current-session.json');
  if (!existsSync(persisted)) return null;
  try {
    const data = await readJson(persisted);
    if (data && typeof data === 'object') {
      const sid = data.session_id ?? data.sessionId ?? null;
      if (typeof sid === 'string' && sid.length > 0) return sid;
    }
  } catch {
    // ignore — null below
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — only Bash is gated.
  if (input.tool_name !== 'Bash') return emitAllow();

  // G2 — command must be a non-empty string.
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  // G3 — regex gate. Non-matching commands pass through unconditionally.
  const host = resolveHost(command);
  if (!host) return emitAllow();

  const projectDir = resolveProjectDir();

  // G4 — policy load.
  const policyPath = resolvePolicyPath(projectDir);
  if (!policyPath) {
    process.stderr.write(
      '⚠ pre-bash-templates-first: policy file not found ' +
        '(.orchestrator/policy/templates-policy.json) — skipping guard\n',
    );
    return emitAllow();
  }

  let policy;
  try {
    policy = await readJson(policyPath);
  } catch {
    process.stderr.write(
      '⚠ pre-bash-templates-first: policy file is malformed (invalid JSON) — skipping guard\n',
    );
    return emitAllow();
  }

  if (!policy || typeof policy !== 'object') {
    process.stderr.write(
      '⚠ pre-bash-templates-first: policy file empty or non-object — skipping guard\n',
    );
    return emitAllow();
  }

  // Enforcement off → allow without inspection.
  if (policy.enforcement === 'off') return emitAllow();

  // G5 — bypass-pattern check.
  if (matchesBypass(command, policy.bypass_patterns)) {
    process.stderr.write(
      `ℹ pre-bash-templates-first: bypass-pattern matched, allowing '${command.slice(0, 80)}'\n`,
    );
    return emitAllow();
  }

  // Resolve the acknowledgement file path (policy override or default).
  const ackRel =
    typeof policy.acknowledgement_file === 'string' && policy.acknowledgement_file.length > 0
      ? policy.acknowledgement_file
      : DEFAULT_ACK_PATH;
  const ackFile = path.isAbsolute(ackRel)
    ? ackRel
    : path.join(projectDir || process.cwd(), ackRel);

  // G6 — acknowledgement-file check.
  const sessionId = await resolveSessionId(input, projectDir);
  if (await isAcknowledged(ackFile, sessionId)) {
    return emitAllow();
  }

  // G7 — transcript inspection.
  // The hook stdin payload carries `transcript_path` per Claude Code's hook
  // contract. When absent (older harness, Codex/Cursor port, manual smoke
  // test) we treat it as "no evidence of prior Read" and fall through to
  // deny — that is the default-deny safety posture for this gate.
  const hostBlock = policy.hosts?.[host] ?? {};
  const templatePathsConfigured = Array.isArray(hostBlock.template_paths)
    ? hostBlock.template_paths.filter((p) => typeof p === 'string' && p.length > 0)
    : [];

  // Resolve configured paths to ACTUAL files on disk in the project.
  // - File pattern (e.g. .github/PULL_REQUEST_TEMPLATE.md) → include if exists.
  // - Directory pattern (e.g. .gitlab/merge_request_templates/) → expand to
  //   all *.md files inside (and inside immediate subdirs for ISSUE_TEMPLATE/).
  // If NO templates resolve, nothing to enforce → allow.
  const projectBase = projectDir || process.cwd();
  const templatePaths = [];
  for (const p of templatePathsConfigured) {
    const abs = path.isAbsolute(p) ? p : path.join(projectBase, p);
    if (!existsSync(abs)) continue;
    let stat;
    try {
      const lstat = lstatSync(abs);
      if (lstat.isSymbolicLink()) {
        process.stderr.write(`⚠ pre-bash-templates-first: template path is a symlink (${p}) — rejected for security\n`);
        continue;
      }
      stat = lstat;
    } catch { continue; }
    if (stat.isFile()) {
      templatePaths.push(p);
      continue;
    }
    if (stat.isDirectory()) {
      let entries;
      try { entries = readdirSync(abs); } catch { continue; }
      const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const entryAbs = path.join(abs, entry);
        let estat;
        try {
          const elstat = lstatSync(entryAbs);
          if (elstat.isSymbolicLink()) {
            // Silent skip: symlinks inside template directories are not enforced templates.
            continue;
          }
          estat = elstat;
        } catch { continue; }
        if (estat.isFile() && (entry.endsWith('.md') || entry.endsWith('.yml') || entry.endsWith('.yaml'))) {
          templatePaths.push(`${trimmed}/${entry}`);
        }
      }
    }
  }

  if (templatePaths.length === 0) {
    process.stderr.write(
      `ℹ pre-bash-templates-first: no ${host} template files found in repo — allowing '${command.slice(0, 80)}'\n`,
    );
    return emitAllow();
  }

  const transcriptPath =
    typeof input.transcript_path === 'string' && input.transcript_path.length > 0
      ? input.transcript_path
      : null;

  if (transcriptPath && templatePaths.length > 0) {
    const result = await hasReadInSession(templatePaths, transcriptPath);
    if (result.matched) return emitAllow();
  }

  // G8 — deny.
  blockCreate({
    host,
    command,
    templatePaths,
    ackFile,
  });
}

// Top-level error handler — never let exit 1 leak. Same posture as
// pre-bash-destructive-guard.mjs: fail-open on internal errors to avoid
// blocking legitimate work.
main().catch((e) => {
  process.stderr.write(
    `⚠ pre-bash-templates-first: internal error — ${e?.message || e}\n`,
  );
  process.exit(0);
});
