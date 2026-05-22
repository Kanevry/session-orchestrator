#!/usr/bin/env node
/**
 * pre-bash-templates-first.mjs — PreToolUse hook: blocks `gh|glab pr|mr|issue
 * create|new` invocations when no matching template was Read earlier in the
 * session.
 *
 * Implements Pattern 3 of PRD docs/prd/2026-05-22-gsd-pattern-adoption-quickwins.md
 * (issue #519). Companion to pre-bash-destructive-guard.mjs (issue #155); both
 * share the PreToolUse Bash matcher and run sequentially.
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
 *   G8 fall-through: emit deny via stdout JSON + structured stderr listing the
 *      template paths, and exit 2.
 *
 * Fail-safe posture: any internal exception is swallowed in main().catch and
 * the hook exits 0 (allow). Rationale matches pre-bash-destructive-guard.mjs:
 * a templates-first hook that crashes should not block legitimate work; the
 * worst case is a missed enforcement, not a wedged session.
 *
 * Exit codes:
 *   0  — pass-through (G1-G3 short-circuits, bypass match, acknowledgement, Read found, error)
 *   2  — deny + structured JSON on stdout (PRD § 3 Gherkin Pattern 3)
 */

import { readStdin, emitAllow } from '../scripts/lib/io.mjs';
import { resolveProjectDir, resolvePluginRoot } from '../scripts/lib/platform.mjs';
import { readJson } from '../scripts/lib/common.mjs';
import { hasReadInSession } from './_lib/transcript-history.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// #519: opt-in via profile/env. Default profile "full" enables this hook;
// minimal/off disable. SO_DISABLED_HOOKS=pre-bash-templates-first opts out
// per session.
if (!shouldRunHook('pre-bash-templates-first')) process.exit(0);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matches the canonical `gh` / `glab` issue/PR/MR creation invocations.
 * Anchored at start (^) with optional leading whitespace to catch indented
 * shell snippets. Word-boundary at the end avoids false positives on tokens
 * like `created` or `news`. Edit operations (`gh pr edit`, `glab mr edit`)
 * are deliberately out of scope per PRD § 2 Out-of-Scope.
 */
const CREATE_REGEX = /^\s*(gh|glab)\s+(pr|mr|issue)\s+(create|new)\b/;

/**
 * Default acknowledgement path, relative to project root. Used when the
 * policy omits the `acknowledgement_file` key.
 */
const DEFAULT_ACK_PATH = '.orchestrator/runtime/templates-acknowledged.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Block the create command: write structured deny JSON to stdout + exit 2.
 * Mirrors the exact format from pre-bash-destructive-guard.mjs blockCommand()
 * so downstream Claude Code rendering is consistent.
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
    `Command: ${command}`,
    `Found templates:`,
    pathList,
    `Read one of these first, OR run \`/templates-ack\` (writes ${ackFile}) to bypass for this session.`,
    `See: issue #519, PRD docs/prd/2026-05-22-gsd-pattern-adoption-quickwins.md (Pattern 3)`,
  ].join('\n');

  // PRD § 3 Gherkin Pattern 3 spec: stderr lists template paths + ack hint.
  // We emit BOTH stderr (human-readable per spec) AND the structured stdout
  // JSON envelope (machine-readable for Claude Code hook protocol).
  process.stderr.write(reason + '\n');
  process.stdout.write(
    JSON.stringify({ permissionDecision: 'deny', reason }) + '\n',
  );
  process.exit(2);
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
 * Determine which host the command targets by inspecting the CREATE_REGEX
 * capture. `gh` → "github", `glab` → "gitlab".
 *
 * @param {string} command
 * @returns {"github"|"gitlab"|null}
 */
function resolveHost(command) {
  const m = command.match(CREATE_REGEX);
  if (!m) return null;
  return m[1] === 'gh' ? 'github' : 'gitlab';
}

/**
 * True when the command starts with any of the bypass patterns. Bypass match
 * is a prefix check with a word/EOL boundary on the trailing edge — this
 * prevents trivial bypass via prefix-inclusion (e.g. policy entry
 * "gh issue create --label bot" must not match "gh issue create --label botanical").
 *
 * @param {string} command
 * @param {string[]} bypassPatterns
 * @returns {boolean}
 */
function matchesBypass(command, bypassPatterns) {
  if (!Array.isArray(bypassPatterns) || bypassPatterns.length === 0) {
    return false;
  }
  const stripped = command.replace(/^\s+/, '');
  for (const pat of bypassPatterns) {
    if (typeof pat !== 'string' || pat.length === 0) continue;
    if (!stripped.startsWith(pat)) continue;
    // Boundary check: next character must be whitespace, EOL, or absent.
    // This prevents "gh foo --label bot" from matching policy "gh foo --label botanical".
    const nextChar = stripped.charAt(pat.length);
    if (nextChar === '' || /\s/.test(nextChar)) return true;
  }
  return false;
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
    try { stat = statSync(abs); } catch { continue; }
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
        try { estat = statSync(entryAbs); } catch { continue; }
        if (estat.isFile() && entry.endsWith('.md')) {
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
