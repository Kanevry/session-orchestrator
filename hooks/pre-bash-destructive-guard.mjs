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
import { commandMatchesBlocked } from '../scripts/lib/hardening.mjs';
import { readConfigFile } from '../scripts/lib/config.mjs';
import { readJson } from '../scripts/lib/common.mjs';
import fs, { existsSync } from 'node:fs';
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
 * Parse the first non-flag argument from an `rm -rf` command.
 * Returns the path string or null if unparseable.
 * e.g. "rm -rf src/" → "src/"
 *      "rm -rf -- .orchestrator/tmp/foo" → ".orchestrator/tmp/foo"
 */
function parseRmTarget(command) {
  // Strip the "rm" verb and all flags, return first non-flag arg
  const parts = command.trim().split(/\s+/);
  let seenDashDash = false;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!seenDashDash && part === '--') {
      seenDashDash = true;
      continue;
    }
    if (!seenDashDash && part.startsWith('-')) continue;
    return part;
  }
  return null;
}

/**
 * Return true when a path should be allowed for `rm -rf` (safe targets).
 * Safe: .orchestrator/tmp (any depth) or node_modules (any depth).
 */
function isRmPathAllowed(targetPath, projectDir) {
  if (!targetPath) return false;

  // Normalise to absolute for consistent comparison
  const abs = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(projectDir || process.cwd(), targetPath);

  const base = projectDir || process.cwd();

  const safeAbsolute = [
    path.join(base, '.orchestrator', 'tmp'),
    path.join(base, 'node_modules'),
  ];

  for (const safe of safeAbsolute) {
    // The target must be the safe dir itself or a child of it
    if (abs === safe || abs.startsWith(safe + path.sep)) return true;
  }

  return false;
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

    if (!commandMatchesBlocked(command, pattern)) continue;

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
        const target = parseRmTarget(command);
        if (isRmPathAllowed(target, projectDir)) {
          // Safe path (e.g. .orchestrator/tmp or node_modules) — allow
          continue;
        }
        // target null → block (conservative)
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
