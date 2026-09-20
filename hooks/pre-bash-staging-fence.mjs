#!/usr/bin/env node
/**
 * pre-bash-staging-fence.mjs — PreToolUse Bash hook
 *
 * PSA-004 sub-mode C — staging-fence intent log for cross-agent `git add` race
 * detection (issue #552). Companion to hooks/wave-scope-commit-guard.mjs
 * (sub-mode B). Together the two guards cover:
 *
 *   sub-mode B  — lint-staged sweep that re-stages files outside wave-scope
 *                 (the existing guard, caught at pre-commit time).
 *   sub-mode C  — concurrent `git add` from two wave-agents on the same repo
 *                 (this hook records intent; the commit-guard reconciles at
 *                 commit time).
 *
 * Fence file
 * ----------
 * Path:  .orchestrator/staging-fence/<agent-id>.json
 * Shape:
 *   {
 *     "agent_id":    "string",          // ${SO_WAVE_AGENT}-${pid}-${rnd}
 *     "pid":         12345,
 *     "host":        "string",
 *     "started_at":  "2026-05-23T21:30:00.000Z",
 *     "staged_paths": [
 *       { "paths": ["src/foo.ts"], "command_hash": "a635c66ec7e7bf56",
 *         "timestamp": "2026-…" },
 *       ...
 *     ]
 *   }
 *
 * The entry records the PATH OPERANDS, never the command text (#1404): a
 * staging command can carry a secret (`GIT_TOKEN=… git add x`), and the raw
 * string was persisted verbatim to disk — the same defect 8f15f77b removed
 * from hooks/enforce-commands.mjs. Paths are what the only reader
 * (hooks/wave-scope-commit-guard.mjs) actually needs; `command_hash` keeps
 * the entry countable and groupable without the text.
 *
 * `paths: ["*"]` means "stages a set no operand names" (`git add -A`, `.`,
 * `-u`) and overlaps EVERY staged path — the case the reader's old raw-text
 * regex could not see at all, because `-A` contains no path to match.
 *
 * Decision flow (G1-G6 early-return ladder):
 *   G1  tool filter — Bash only
 *   G2  command must be a non-empty string
 *   G3  cheap regex PRE-FILTER — skip the tokenizer for plainly unrelated
 *       commands (see GIT_ADD_REGEX; it does not decide the question)
 *   G4  context gate — isWaveAgentContext(); exit 0 immediately for
 *       coordinator/manual commits (AC5 safe-default no-op)
 *   G4b tokenize + extract path operands; exit 0 when no `git add` statement
 *       resolves (a pre-filter false positive writes nothing)
 *   G5  derive agent_id, build fence dir + path
 *   G6  read-modify-write the fence file (append the staging-intent entry).
 *       Errors are warned + swallowed — the hook NEVER blocks the Bash call.
 *
 * Bypass / disable
 * ----------------
 *   - SO_DISABLED_HOOKS=pre-bash-staging-fence  → exits 0 immediately
 *   - SO_HOOK_PROFILE=minimal|off               → exits 0 immediately
 *   - Coordinator-thread invocations            → exits 0 immediately (G4)
 *   - `git commit --no-verify`                  → bypasses the commit-guard
 *     entirely; sub-mode C reconciliation never runs (PSA-001/PSA-003 risk
 *     remains; the operator is opting out by name).
 *
 * Fail-safe posture: never blocks the Bash call, even on internal errors.
 * Worst case is a missed enforcement, not a wedged session.
 */

import { readStdin, emitAllow, writeJsonAtomicSync } from '../scripts/lib/io.mjs';
import { isWaveAgentContext } from '../scripts/lib/wave-context.mjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
import { stableHostname } from '../scripts/lib/host-identity.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cheap PRE-FILTER for the staging-command gate (G3). It answers "is it worth
 * loading the tokenizer for this command?", never "is this a staging
 * command?" — since #1404 that verdict belongs to {@link extractStagedPaths},
 * which resolves the verb and subcommand properly.
 *
 * `git` and `add` must sit in the same statement (the negated class stops at
 * `;`, `&`, `|` and newline) within 120 characters of each other, so global
 * flags between them are tolerated: `git -C sub add x` reaches the extractor,
 * where `\bgit\s+add\b` used to drop it silently. `\badd\b` keeps
 * `git addremote` out.
 *
 * False positives are cheap AND inert: `git commit -m "add x"` matches here,
 * resolves to no `git add` statement, and writes nothing (G4b).
 */
const GIT_ADD_REGEX = /\bgit\b[^;&|\n]{0,120}\badd\b/;

/**
 * Recorded in place of a path list when the staging command names NO explicit
 * path operand but stages a set we cannot enumerate — `git add -A`,
 * `git add .`, `git add -u`, `git add --pathspec-from-file=<f>`. The reader
 * (hooks/wave-scope-commit-guard.mjs) treats it as "overlaps every staged
 * path". This is the case the previous raw-command regex silently MISSED:
 * `-A` contains no path text, so `pathRegex(ours).test('git add -A')` was
 * always false and the widest staging command of all fenced nothing.
 */
const ALL_PATHS_MARKER = '*';

/** git GLOBAL flags (before the subcommand) that consume the NEXT token. */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env',
]);

/** `git add` flags that consume the NEXT token as their value. */
const GIT_ADD_VALUE_FLAGS = new Set(['--chmod']);

/** `git add` long flags that stage a set no path operand names. */
const GIT_ADD_ALL_FLAGS = new Set(['--all', '--no-ignore-removal', '--update']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * sha256(command) truncated to 16 hex chars.
 *
 * DELIBERATE DUPLICATE of hooks/enforce-commands.mjs (itself a copy of
 * hooks/pre-bash-destructive-guard.mjs) — see the 8f15f77b commit message:
 * the three guards stay import-free of each other on purpose, so a shared
 * helper is NOT introduced. The hash keeps a fence entry COUNTABLE and
 * GROUPABLE without persisting command text that may carry a secret
 * (`GIT_TOKEN=… git add x`) — issue #1404.
 *
 * @param {string} command
 * @returns {string}
 */
function hashCommand(command) {
  return crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
}

/**
 * Normalise a path token so writer and reader compare the same spelling.
 *
 * DELIBERATE DUPLICATE of the identically-named function in
 * hooks/wave-scope-commit-guard.mjs — the reader is a husky pre-commit hook
 * outside the Claude-Code hook import set, and the two must agree byte for
 * byte. Change one, change both.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeStagedPath(raw) {
  let p = String(raw).trim();
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Extract the PATH OPERANDS of every `git add` statement in a Bash command.
 *
 * Reuses the repo's own shell tokenizer (scripts/lib/command-blocker.mjs) —
 * no second shell grammar is invented here. The import is LAZY: this hook
 * runs on every Bash call of every session, and only a `git add` command
 * (G3) ever reaches this function, so the tokenizer's module graph must not
 * be paid for by the other 99% of calls.
 *
 * Handled: `git add -- a b`, quoted operands with spaces, `git -C <dir> add x`
 * (relative `-C` is prefixed onto the operand), chained statements
 * (`cd x && git add y` — each statement is its own segment), leading env
 * assignments, and the enumerate-nothing flags that yield ALL_PATHS_MARKER.
 *
 * NAMED CEILINGS (BV-004):
 *  - Operands are recorded as WRITTEN, relative to the invoking cwd. A
 *    `cd subdir && git add foo.ts` records `foo.ts` while the staged path is
 *    `subdir/foo.ts` → a miss. This is exactly the pre-#1404 behaviour (the
 *    raw-command regex missed it too), not a new gap; revisit if a wave agent
 *    is ever observed staging from a subdirectory.
 *  - An ABSOLUTE operand (or an absolute `-C`) is recorded verbatim and will
 *    not match a repo-relative staged path. Same ceiling, same trigger.
 *  - A command the tokenizer resolves to no `git add` statement (`echo "git
 *    add x"` — G3's documented, tolerated false positive) yields an EMPTY
 *    list, never the marker: over-reporting here would turn a log line into a
 *    blocked commit, which the hook's fail-safe posture forbids.
 *
 * @param {string} command
 * @returns {Promise<{ recognised: boolean, paths: string[] }>}
 */
async function extractStagedPaths(command) {
  let tokenizeCommand, splitChainSegments, resolveSegmentVerb, segments;
  try {
    ({ tokenizeCommand, splitChainSegments, resolveSegmentVerb } =
      await import('../scripts/lib/command-blocker.mjs'));
    segments = splitChainSegments(tokenizeCommand(command));
  } catch {
    return { recognised: false, paths: [] };
  }

  const paths = new Set();
  let recognised = false;

  for (const segment of segments) {
    const { verb, index } = resolveSegmentVerb(segment);
    if (verb !== 'git' || index < 0) continue;

    let i = index + 1;
    let chdir = null;

    // git GLOBAL flags sit between `git` and the subcommand.
    while (i < segment.length) {
      const tok = segment[i];
      if (tok.quoted || !tok.text.startsWith('-') || tok.text === '-') break;
      if (GIT_GLOBAL_VALUE_FLAGS.has(tok.text)) {
        if (tok.text === '-C' && i + 1 < segment.length) chdir = segment[i + 1].text;
        i += 2;
        continue;
      }
      i += 1; // boolean global flag, or attached `--git-dir=<p>`
    }

    if (i >= segment.length || segment[i].quoted || segment[i].text !== 'add') continue;
    recognised = true;
    i += 1;

    let endOfFlags = false;
    let stagesAll = false;

    for (; i < segment.length; i++) {
      const tok = segment[i];
      const text = tok.text;

      if (!endOfFlags && !tok.quoted && text.startsWith('-') && text !== '-') {
        if (text === '--') { endOfFlags = true; continue; }
        if (GIT_ADD_VALUE_FLAGS.has(text)) { i += 1; continue; }
        if (text === '--pathspec-from-file' || text.startsWith('--pathspec-from-file=')) {
          stagesAll = true;
          if (text === '--pathspec-from-file') i += 1;
          continue;
        }
        if (GIT_ADD_ALL_FLAGS.has(text)) { stagesAll = true; continue; }
        // Short-flag cluster: `-A`, `-u`, `-An`, `-vu` all stage a set no
        // operand names.
        if (!text.startsWith('--') && /[Au]/.test(text.slice(1))) stagesAll = true;
        continue;
      }

      if (text === '.' || text === './') { stagesAll = true; continue; }
      const operand = chdir && !chdir.startsWith('/') ? `${chdir}/${text}` : text;
      const normalised = normalizeStagedPath(operand);
      if (normalised.length > 0) paths.add(normalised);
    }

    if (stagesAll) paths.add(ALL_PATHS_MARKER);
  }

  return { recognised, paths: [...paths] };
}

/**
 * Derive a per-agent identifier for the fence filename.
 *
 * Composition: `${SO_WAVE_AGENT}-${pid}-${rnd6hex}`.
 * - SO_WAVE_AGENT is always "1" inside a wave-agent context (per
 *   wave-context.mjs strict-equality contract), so the prefix is fixed.
 * - PID disambiguates concurrent agents on the same host.
 * - 6 hex chars (24 bits) defends against PID reuse within a long-running
 *   session, even though that race is vanishingly rare.
 *
 * The same PID may invoke `git add` repeatedly in one wave; the hook reads
 * the existing fence file (matched by composing the same agent_id), appends,
 * and rewrites. The random suffix is therefore frozen per process via
 * lazy-init: the first call computes it; subsequent calls reuse it.
 *
 * NOTE: Because each hook subprocess is a fresh Node process, the random
 * suffix is unique per `git add` invocation — there is no in-process cache
 * to reuse. We accept N fence files per agent (one per `git add` call) and
 * the commit-guard scans ALL fence files at commit time.
 *
 * @returns {string}
 */
function deriveAgentId() {
  const waveAgent = process.env.SO_WAVE_AGENT ?? '1';
  const pid = process.pid;
  const rnd = crypto.randomBytes(3).toString('hex');
  return `${waveAgent}-${pid}-${rnd}`;
}

/**
 * Resolve the project directory the hook should operate against. Mirrors
 * pre-bash-memory-propose-audit.mjs resolution: prefer CLAUDE_PROJECT_DIR /
 * CODEX_PROJECT_DIR env-vars, fall back to cwd.
 *
 * @returns {string}
 */
function resolveProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR
    ?? process.env.CODEX_PROJECT_DIR
    ?? process.cwd();
}

/**
 * Append a staging-intent entry to the fence file. Reads the existing file
 * (if any), appends the entry, and rewrites atomically via the shared
 * {@link writeJsonAtomicSync} helper from scripts/lib/io.mjs (extracted in
 * #558 M1). The first call for a given agent_id creates the file with a
 * fresh body.
 *
 * @param {{ fenceFile: string, agentId: string, command: string, paths: string[] }} args
 * @returns {{ ok: true } | { ok: false, reason: 'fs-error', error: string }}
 */
function appendIntent({ fenceFile, agentId, command, paths }) {
  const timestamp = new Date().toISOString();

  let body;
  if (existsSync(fenceFile)) {
    try {
      const raw = readFileSync(fenceFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.staged_paths)) {
        body = parsed;
      }
    } catch {
      // Malformed existing fence file — overwrite with a fresh one.
      body = undefined;
    }
  }

  if (!body) {
    body = {
      agent_id: agentId,
      pid: process.pid,
      // `host` raw + `host_id` normalised (#1072 — os.hostname() flips spelling
      // on a single machine, so a raw value is not comparable across writes).
      host: os.hostname(),
      host_id: stableHostname(),
      started_at: timestamp,
      staged_paths: [],
    };
  }

  // #1404 — persist what the READER needs (path operands), never the command
  // text: a staging command can carry a secret in a leading env assignment.
  // The hash keeps the entry countable/groupable, mirroring enforce-commands.
  body.staged_paths.push({
    paths,
    command_hash: hashCommand(command),
    timestamp,
  });

  return writeJsonAtomicSync(fenceFile, body, { tmpPrefix: '.fence.tmp' });
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

  // G3 — cheap regex PRE-FILTER. Commands that cannot possibly be a staging
  // command pass through without loading the tokenizer.
  if (!GIT_ADD_REGEX.test(command)) return emitAllow();

  // G4 — context gate. Coordinator/manual commits are not fenced.
  if (!isWaveAgentContext()) return emitAllow();

  // G4b — the PRECISE gate (#1404). The tokenizer, not the regex, decides
  // whether this command really stages anything: a pre-filter hit with no
  // resolvable `git add` statement (`git commit -m "add x"`) writes NO fence
  // file, where the pre-#1404 hook logged its raw text.
  const { recognised, paths } = await extractStagedPaths(command);
  if (!recognised) return emitAllow();

  // G5 — derive paths.
  const projectDir = resolveProjectDir();
  const agentId = deriveAgentId();
  const fenceFile = path.join(
    projectDir,
    '.orchestrator',
    'staging-fence',
    `${agentId}.json`,
  );

  // G6 — append intent. Never blocks the Bash call on failure.
  const result = appendIntent({ fenceFile, agentId, command, paths });
  if (!result.ok) {
    process.stderr.write(
      `⚠ pre-bash-staging-fence: failed to write fence file — ${result.error}\n`,
    );
  }

  return emitAllow();
}

// Entry guard (#1393): run only as the node script the harness execs — a bare
// `import()` must run no handler and must not exit the importing process.
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook('pre-bash-staging-fence')) process.exit(0);

  // Top-level error handler — never let exit 1 leak. Fail-open on internal
  // errors to avoid blocking legitimate work (mirrors the destructive-guard
  // posture).
  main().catch((e) => {
    process.stderr.write(
      `⚠ pre-bash-staging-fence: internal error — ${e?.message || e}\n`,
    );
    process.exit(0);
  });
}
