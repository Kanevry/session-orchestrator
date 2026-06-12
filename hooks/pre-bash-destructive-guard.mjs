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
 *      Missing → exit 0 (warn). Malformed → exit 0 (warn).
 *   G5 rule evaluation per rule in policy.rules
 *      severity:"block" → exit 2 with deny message
 *      severity:"warn"  → emit warning, exit 0 (allow)
 *      Special cases:
 *        git-stash-any: only warn when stash is non-empty
 *        rm-rf-destructive: path exception for .orchestrator/tmp and node_modules
 *   G6 no match → exit 0
 */

import { readStdin, emitAllow } from '../scripts/lib/io.mjs';
import { resolveProjectDir, resolvePluginRoot } from '../scripts/lib/platform.mjs';
import { commandMatchesBlocked, tokenizeCommand } from '../scripts/lib/hardening.mjs';
import { readConfigFile } from '../scripts/lib/config.mjs';
import { readJson } from '../scripts/lib/common.mjs';
import fs, { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('pre-bash-destructive-guard')) process.exit(0);

// Module-level policy cache (issue #250). Safe because each hook invocation runs as
// an isolated Node subprocess — state is fresh per process, never shared across calls.
// Cache is invalidated on:
//   (a) resolved policy path changes (different projectDir/CWD)
//   (b) file mtime advances (user edited the policy)
// Any stat/read error → skip cache + fall back to uncached read (fail-safe).
let _cachedPolicy = null;
let _cachedPolicyPath = null;
let _cachedPolicyMtimeMs = null;

async function loadPolicyCached(policyPath) {
  try {
    const stat = await fs.promises.stat(policyPath);
    const mtimeMs = stat.mtimeMs;
    if (
      _cachedPolicy !== null &&
      _cachedPolicyPath === policyPath &&
      _cachedPolicyMtimeMs === mtimeMs
    ) {
      return _cachedPolicy;
    }
    const fresh = await readJson(policyPath);
    _cachedPolicy = fresh;
    _cachedPolicyPath = policyPath;
    _cachedPolicyMtimeMs = mtimeMs;
    return fresh;
  } catch {
    // On any error (stat failure, read failure), re-throw to let caller's existing
    // try/catch handle the "malformed policy" branch. Do NOT poison the cache.
    return readJson(policyPath);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Block a command: write structured deny JSON to stdout + exit 2.
 * Uses raw process.exit(2) rather than emitDeny to emit the exact
 * multi-line message format required by the spec.
 */
function blockCommand(pattern, ruleId, rationale) {
  const reason = [
    `Destructive command blocked: '${pattern}' (rule: ${ruleId})`,
    `Reason: ${rationale}`,
    `Override: Set \`allow-destructive-ops: true\` in Session Config if intentional.`,
    `See: issue #155, .claude/rules/parallel-sessions.md (PSA-003)`,
  ].join('\n');
  // Structured deny for Claude Code hook protocol
  process.stdout.write(JSON.stringify({ permissionDecision: 'deny', reason }) + '\n');
  process.exit(2);
}

/**
 * Resolve the policy file path, searching in priority order:
 *   1. <CWD>/.orchestrator/policy/blocked-commands.json
 *   2. <CLAUDE_PROJECT_DIR>/.orchestrator/policy/blocked-commands.json
 *   3. <CLAUDE_PLUGIN_ROOT>/.orchestrator/policy/blocked-commands.json
 * Returns the first existing path, or null if none found.
 */
function resolvePolicyPath(projectDir) {
  const candidates = [
    path.join(process.cwd(), '.orchestrator', 'policy', 'blocked-commands.json'),
  ];

  if (projectDir && projectDir !== process.cwd()) {
    candidates.push(path.join(projectDir, '.orchestrator', 'policy', 'blocked-commands.json'));
  }

  const pluginRoot = resolvePluginRoot();
  if (pluginRoot) {
    candidates.push(path.join(pluginRoot, '.orchestrator', 'policy', 'blocked-commands.json'));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
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
 * Parse ALL non-flag path arguments from every `rm` invocation in a command.
 *
 * Hardened over the previous single-target parser (#641): handles `-r -f`,
 * `-fr`, `-rf`, `--` end-of-options ordering, multiple targets per `rm`, and
 * chained commands (`rm -rf /tmp/x; rm -rf src/`). Quote-aware via
 * tokenizeCommand so a path with spaces inside quotes is one target.
 *
 * Returns an array of target path strings (possibly empty). The caller treats
 * the rm-rf rule as "allowed" only when EVERY returned target is allowlisted.
 *
 * @param {string} command
 * @returns {string[]}
 */
function parseRmTargets(command) {
  const tokens = tokenizeCommand(command);
  const targets = [];
  let i = 0;

  while (i < tokens.length) {
    const verb = tokens[i].text.replace(/^.*\//, ''); // basename
    const isOperator = !tokens[i].quoted && /^(;|&&|\|\||\||&)$/.test(tokens[i].text);
    if (isOperator) { i++; continue; }
    if (verb !== 'rm') { i++; continue; }

    // Consume this `rm` invocation's args until the next chain operator.
    i++; // skip `rm`
    let seenDashDash = false;
    while (i < tokens.length) {
      const tok = tokens[i];
      // Stop at unquoted chain operators — they delimit the next command.
      if (!tok.quoted && /^(;|&&|\|\||\||&)$/.test(tok.text)) break;
      if (!seenDashDash && tok.text === '--') { seenDashDash = true; i++; continue; }
      // A flag is unquoted and starts with '-' (and is not the bare '-' stdin marker).
      if (!seenDashDash && !tok.quoted && tok.text.startsWith('-') && tok.text !== '-') {
        i++;
        continue;
      }
      targets.push(tok.text);
      i++;
    }
  }

  return targets;
}

/**
 * Detect whether the command contains an UNQUOTED `rm` invocation carrying BOTH
 * recursive (`-r`/`-R`/`--recursive`) AND force (`-f`/`--force`) semantics,
 * including combined/short forms (`-rf`, `-fr`, `-r -f`). This catches flag-form
 * variants the literal "rm -rf" pattern misses (#641 gap closure) while staying
 * consistent with the quoted-payload guard: an `rm` that appears only inside a
 * quoted token is NOT treated as an invocation here.
 *
 * @param {string} command
 * @returns {boolean}
 */
function commandHasRecursiveForceRm(command) {
  const tokens = tokenizeCommand(command);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const verb = tok.text.replace(/^.*\//, ''); // basename
    if (tok.quoted || verb !== 'rm') { i++; continue; }

    // Scan this rm invocation's flags until the next unquoted chain operator.
    i++; // skip `rm`
    let recursive = false;
    let force = false;
    let seenDashDash = false;
    while (i < tokens.length) {
      const t = tokens[i];
      if (!t.quoted && /^(;|&&|\|\||\||&)$/.test(t.text)) break;
      if (!seenDashDash && t.text === '--') { seenDashDash = true; i++; continue; }
      if (!seenDashDash && !t.quoted && t.text.startsWith('-') && t.text !== '-') {
        if (t.text === '--recursive') recursive = true;
        else if (t.text === '--force') force = true;
        else if (/^-[a-zA-Z]+$/.test(t.text)) {
          // Bundled short flags: -rf, -fr, -Rf, etc.
          if (/[rR]/.test(t.text)) recursive = true;
          if (/f/.test(t.text)) force = true;
        }
        i++;
        continue;
      }
      i++; // non-flag arg (a target) — skip
    }
    if (recursive && force) return true;
  }
  return false;
}

/**
 * Return true when a single path is a safe `rm -rf` target.
 *
 * Safe targets:
 *   - <projectRoot>/.orchestrator/tmp (any depth)
 *   - <projectRoot>/node_modules (any depth)
 *   - /tmp/ (any depth)                    — agent-owned scratch
 *   - /private/tmp/ (any depth)            — macOS canonical /tmp
 *   - resolved os.tmpdir() / $TMPDIR (any depth)
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
  const wasAbsolute = path.isAbsolute(targetPath);

  // Project-relative safe dirs (always allowed, independent of the rule allowlist).
  const abs = wasAbsolute
    ? path.normalize(targetPath)
    : path.resolve(base, targetPath);

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
    for (const prefix of resolveAllowlistPrefixes(ruleAllowlist)) {
      // The target must be the prefix dir itself or a descendant of it.
      if (abs === prefix || abs.startsWith(prefix + path.sep)) return true;
    }
  }

  return false;
}

/**
 * Resolve the rule's `path-allowlist` entries into concrete absolute directory
 * prefixes. `$TMPDIR` expands to env.TMPDIR (if set) and os.tmpdir(); literal
 * paths are normalised. Trailing slashes are stripped for prefix comparison.
 *
 * @param {string[]} ruleAllowlist
 * @returns {string[]} normalised absolute prefixes (no trailing slash)
 */
function resolveAllowlistPrefixes(ruleAllowlist) {
  const out = new Set();
  const add = (p) => {
    if (!p) return;
    const norm = path.normalize(p).replace(/[/\\]+$/, '');
    if (norm) out.add(norm);
  };
  const tempRoots = ['/tmp', '/private/tmp', '/var/folders'].map((p) => path.normalize(p));
  const addTemp = (p) => {
    if (!p || !path.isAbsolute(p)) return;
    const norm = path.normalize(p).replace(/[/\\]+$/, '');
    if (tempRoots.some((root) => norm === root || norm.startsWith(root + path.sep))) {
      out.add(norm);
    }
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
      if (line === '## Session Config') { inConfig = true; continue; }
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

  // G4 — policy load
  const policyPath = resolvePolicyPath(projectDir);
  if (!policyPath) {
    process.stderr.write(
      '⚠ pre-bash-destructive-guard: policy file not found ' +
      '(.orchestrator/policy/blocked-commands.json) — skipping guard\n'
    );
    return emitAllow();
  }

  let policy;
  try {
    policy = await loadPolicyCached(policyPath);
  } catch {
    process.stderr.write(
      '⚠ pre-bash-destructive-guard: policy file is malformed (invalid JSON) — skipping guard\n'
    );
    return emitAllow();
  }

  if (!policy || !Array.isArray(policy.rules)) {
    process.stderr.write(
      '⚠ pre-bash-destructive-guard: policy file missing .rules array — skipping guard\n'
    );
    return emitAllow();
  }

  // G5 — rule evaluation
  for (const rule of policy.rules) {
    const { id, pattern, severity, rationale = '' } = rule;

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
      // warn → allow (exit 0), continue checking remaining rules
      continue;
    }

    if (severity === 'block') {
      // Special: rm-rf-destructive — path exception
      if (id === 'rm-rf-destructive') {
        const ruleAllowlist = Array.isArray(rule['path-allowlist']) ? rule['path-allowlist'] : [];
        const targets = parseRmTargets(command);
        // Allow ONLY when there is at least one target AND every target is
        // allowlisted. An unparseable command (no targets) or any non-allowlisted
        // target → block (conservative). This makes mixed chains like
        // `rm -rf /tmp/x; rm -rf src/` block on the src/ target.
        const allAllowed =
          targets.length > 0 &&
          targets.every((t) => isRmPathAllowed(t, projectDir, ruleAllowlist));
        if (allAllowed) {
          // Safe paths only (.orchestrator/tmp, node_modules, /tmp, $TMPDIR) — allow
          continue;
        }
        blockCommand(pattern, id, rationale);
      }
      blockCommand(pattern, id, rationale);
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
