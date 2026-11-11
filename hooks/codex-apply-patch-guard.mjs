#!/usr/bin/env node
/**
 * codex-apply-patch-guard.mjs — PreToolUse `apply_patch` + `Bash` hook for Codex
 * (GitLab #1913, #1914): runs the Edit/Write guards on every file a Codex patch touches.
 *
 * Codex writes files through its freeform `apply_patch` tool; the PreToolUse
 * payload carries the patch text, not the `tool_input.file_path` the Edit/Write
 * guards read. This adapter parses the patch (`scripts/lib/codex/apply-patch-parse.mjs`,
 * which also records what of the payload shape is measured and what is not),
 * turns each touched file into the Claude-shaped Edit or Write call the guards
 * understand, and runs the four guards on it:
 *
 *   enforce-scope → config-protection → pre-edit-sessions-ledger-guard → pre-tool-state-md-path-guard
 *
 * Mapping per file: Add → Write `{file_path, content}`; Delete → Write with
 * `content: ''`; Update → a Write of the WHOLE file Codex would produce; Move →
 * the source as a Delete AND the destination as a Write of the moved content
 * (see `toToolCalls` for why whole-file Writes, not per-hunk Edits).
 *
 * The guards end through `emitAllow`/`emitDeny`, which call `process.exit`, so
 * each runs as its own child process (`spawnSync(process.execPath, …)`) with
 * the synthesized payload on stdin. The first deny envelope is forwarded with
 * ` [apply_patch: <path>]` appended to its reason.
 *
 * ## Two routes (measured codex-cli 0.160.1, macOS, `codex exec`, 2026-11-02, #1914)
 *
 * 1. Tool route: matcher `apply_patch`, `tool_name: "apply_patch"`,
 *    `tool_input: { command: "<patch>" }` (`extractPatchText`).
 * 2. Shell route: the model writes `apply_patch <<'EOF' … EOF` through its shell
 *    tool. Only the `Bash` matcher fires (`tool_name: "Bash"`, the heredoc in
 *    `tool_input.command`), no PostToolUse; Codex recognises the heredoc itself
 *    (tree-sitter query `(#any-of? @apply_name "apply_patch" "applypatch")`) and
 *    applies the patch without running a shell. So this hook is registered on
 *    `Bash` too: `extractShellApplyPatch` reads the heredoc and the patch runs
 *    the same path as on the tool route. A Bash command that does not name
 *    apply_patch allows at once after a cheap text test, with no guard child
 *    and no further module load. A command that may name it is read with the
 *    shared tokenizer in `scripts/lib/command-blocker.mjs` (loaded only then,
 *    #1917): every statement of the chain, every verb reading behind
 *    assignments and wrappers (`x=1`, `time`, `exec`, `sudo`, `nice -n 5`, both
 *    readings of an unknown option such as `sudo -X val`), `$( )` and backtick
 *    bodies, the string of `bash|sh|zsh|dash|ksh|su -c` and `eval`, and the
 *    literal data a shell reads from stdin (`printf 'S' | sh`, `sh <<< 'S'`,
 *    `printf 'S' | xargs -0 sh -c`, the blocker's `pipedShellData`, #2003). The
 *    command word counts after quotes, backslashes and `$'…'` are undone; a
 *    word left unexpanded (`apply_${p}atch`) counts when it carries the name or
 *    what remains of it. A quoted argument (`git commit -m "fix; apply_patch"`)
 *    or a heredoc body is not an invocation and allows; `command -v` and
 *    `which` look the name up and allow. Only the plain heredoc
 *    `apply_patch <<'EOF'` … `EOF` (optionally behind `command`/`env VAR=x`) is
 *    read; every other invocation (prefixed heredoc, pipe, file redirect,
 *    `cd … &&`, `bash -c`, a quoted or masked name, text after the heredoc)
 *    denies: Codex might still apply it internally, past the guards. A
 *    tokenizer that cannot load or throws denies too.
 *
 *    CEILING (BV-004): the tokenizer reads the command text only. A name that
 *    exists only at run time (`$CMD < p.diff` with `CMD=apply_patch`, a name
 *    read from a file or variable, data piped into a shell from a file), an
 *    expansion pattern other than a
 *    bare `${x}`/`$x`/`$( )` inside the name, and another interpreter that runs
 *    it (`xargs apply_patch`, `find -exec`, `python -c`, `perl -e`) are not
 *    seen and allow. Revisit trigger: one such invocation in a real Codex
 *    session.
 *
 *    MEASURED (codex-cli 0.160.1, 2026-11-02): a `Bash` PreToolUse deny stops
 *    Codex's INTERNAL heredoc application completely (file unchanged, no
 *    file_change event; the model gets "Command blocked by PreToolUse hook:
 *    <reason>"), for all three deny forms (permissionDecision "deny",
 *    `{"decision":"block"}`, exit 2 with stderr).
 *
 *    CEILING: the shell route protects only with the guards the host profile
 *    switches on. Under profile `standard`, `pre-tool-state-md-path-guard` is
 *    off (STANDARD_OFF_HOOKS), so a heredoc patch on `.orchestrator/STATE.md`
 *    goes through, as with Claude Edit/Write.
 *
 * ## Fail closed
 *
 * Unlike the single-purpose guards (which allow on internal error), this hook
 * is the ONLY route by which Codex file writes reach those guards. So every
 * failure denies: unparsable stdin, an unrecognised `tool_input` shape, a patch
 * outside the grammar, a guard that exits non-zero, times out or cannot be
 * spawned, an exhausted time budget, and any internal error. A payload whose
 * `tool_name` is not `apply_patch` allows only when its `tool_input` does not
 * read as a patch (see `main`).
 *
 * Time: Codex gives the hook 5 s (`hooks/hooks-codex.json`). The children share
 * a 4.5 s budget; a patch too large to judge in it is denied, not waved through,
 * and the deny names the way out: split the patch. All `*** Update File:`
 * sections of one path fold into one judged Write (`foldPatchFiles`, #1914),
 * so the child count grows with the files a patch touches, not its hunks.
 *
 * ## Override
 *
 *   SO_DISABLED_HOOKS=codex-apply-patch-guard   (whole adapter)
 *   SO_DISABLED_HOOKS=<guard name>               (one guard; honoured by the child)
 *   SO_HOOK_PROFILE=minimal|off
 */

import { readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
import { spawnSync } from '../scripts/lib/native-command.mjs';

/** This hook's name — the `SO_DISABLED_HOOKS` key. */
const HOOK_NAME = 'codex-apply-patch-guard';

/** Guards run per touched file, in this order. Resolved next to this file, never via cwd. */
const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EDIT_GUARDS = Object.freeze([
  'enforce-scope.mjs',
  'config-protection.mjs',
  'pre-edit-sessions-ledger-guard.mjs',
  'pre-tool-state-md-path-guard.mjs',
]);

/** Shared wall-clock budget for all guard children (Codex hook timeout is 5 s). */
const BUDGET_MS = 4500;

/** Appended to a deny caused by the time budget: the way out for the operator (#1914). */
const SPLIT_HINT = ' — Patch teilen (weniger Dateien je apply_patch)';

/** Way out named in every shell-route deny for a form this hook cannot read. */
const SHELL_WAY_OUT = " — Heredoc-Form `apply_patch <<'EOF'` … `EOF` als ganzes Kommando oder das apply_patch-Tool verwenden";

/** Cheap pre-test: a command without either name never invokes apply_patch. */
const MENTIONS_APPLY_PATCH = /apply_?patch/;

/**
 * Verbs whose `-c` string (shells) or words (`eval`) are a command line read again:
 * the blocker's `DASH_C_SHELLS` plus `eval` (#1999 point 7; parity enforced by
 * tests/hooks/dash-c-shells-parity.test.mjs).
 */
const PAYLOAD_VERBS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'su', 'runuser', 'sg', 'eval']);

/** su-like verbs read by the blocker's su grammar (#1944 F4); `SU_LIKE_SHELLS` in command-blocker.mjs. */
const SU_LIKE_VERBS = new Set(['su', 'runuser', 'sg']);

/** Nesting depth of `bash -c`/`eval` payloads read before failing closed. */
const MAX_PAYLOAD_DEPTH = 4;

/**
 * Whether the command may name apply_patch at all, decided before any module
 * load. The shell drops `\` and quotes inside a word (`a\pply_patch`,
 * `ap''ply_patch`) and an expansion can sit inside the name (`apply_${p}atch`,
 * `$'apply_\x70atch'`), so a command carrying one of `\ ' " $ \`` gets a wider
 * test; a command without them (`ls -la`) costs one more character scan.
 *
 * @param {string} command
 * @returns {boolean}
 */
function mayNameApplyPatch(command) {
  if (MENTIONS_APPLY_PATCH.test(command)) return true;
  if (!/[\\'"$`]/.test(command)) return false;
  if (/[$`]/.test(command) && /appl|atch/.test(command)) return true;
  return MENTIONS_APPLY_PATCH.test(command.replace(/[\\'"]/g, ''));
}

/**
 * Whether a resolved verb word runs apply_patch: the name itself (quotes,
 * backslashes and `$'…'` already undone by the tokenizer, a directory prefix
 * cut), or a word left unexpanded (`$`, `` ` ``, `(`) that carries the name or
 * what is left of it around the expansion (`apply_${x}atch`, `$(echo apply_patch)`).
 *
 * @param {string} word
 * @returns {boolean}
 */
function isApplyPatchWord(word) {
  const name = word.replace(/^.*\//, '');
  if (name === 'apply_patch' || name === 'applypatch') return true;
  if (!/[$`(]/.test(word)) return false;
  if (MENTIONS_APPLY_PATCH.test(word)) return true;
  const rest = word.replace(/\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$[A-Za-z0-9_]+/g, '').replace(/[^a-z_]/g, '');
  if (rest.length < 4) return false;
  let at = 0;
  for (const ch of 'apply_patch') if (ch === rest[at]) at++;
  return at === rest.length;
}

/**
 * Whether some statement of `command` runs apply_patch, read with the shared
 * tokenizer: every statement of the chain, every verb reading behind wrappers
 * and assignments (`x=1`, `time`, `nice -n 5`, both readings of `sudo -X val`),
 * `$( )`/backtick bodies, and the command string of `bash|sh|zsh|dash|ksh|ash|fish|su -c`
 * and `eval`, tokenized again. A quoted argument (`git commit -m "fix; apply_patch"`)
 * or a heredoc body is a word of another command, not an invocation;
 * `command -v`/`-V` looks the name up and runs nothing.
 *
 * @param {typeof import('../scripts/lib/command-blocker.mjs')} blocker
 * @param {string} command
 * @param {number} [depth]
 * @returns {boolean}
 */
function invokesApplyPatch(blocker, command, depth = 0) {
  if (depth > MAX_PAYLOAD_DEPTH) return true;
  for (const segment of blocker.splitChainSegments(blocker.tokenizeCommand(command))) {
    for (const { verb, index } of blocker.resolveSegmentVerb(segment).readings) {
      if (typeof verb !== 'string') continue;
      if (isApplyPatchWord(verb)) {
        const before = segment.slice(0, index);
        const lookup = before.some((t, i) => !t.quoted && t.text === 'command' && before.slice(i + 1).some((o) => /^-[a-zA-Z]*[vV]/.test(o.text)));
        if (!lookup) return true;
        continue;
      }
      if (!PAYLOAD_VERBS.has(verb)) continue;
      const words = blocker.argvWordsWithoutRedirects(segment, index + 1);
      // #1944: su runs its `-c` string behind a user name too (`su root -c S`),
      // where the shell grammar reads none — the blocker's su reading does.
      // fish reads `-c`/`--command=`/`-C`/`--init-command=`; the blocker routes
      // its fish grammar through suCommandStrings(words, 'fish').
      // #2003 point 5: zsh and ksh read their option groups with their own
      // grammar (`zsh -cO 'P' x` runs P, `ksh -copipefail 'P'` runs P), as the
      // blocker's dashCPayloads reads them; the bash reading stays in the union,
      // so no string read before is lost.
      const payloads = verb === 'eval' ? [words.map((t) => t.text).join(' ')]
        : SU_LIKE_VERBS.has(verb) || verb === 'fish' ? blocker.suCommandStrings(words, verb)
          : [blocker.shellCommandString(words), blocker.shellCommandString(words, { zsh: verb === 'zsh', ksh: verb === 'ksh' })];
      if (payloads.some((payload) => payload !== null && mayNameApplyPatch(payload) && invokesApplyPatch(blocker, payload, depth + 1))) return true;
    }
    // #2003 point 4: literal data a stdin-reading shell runs (`printf 'S' | sh`,
    // `sh <<< 'S'`, `printf 'S' | xargs -0 sh -c`), read by the blocker's
    // pipedShellData as the ledger guard and the staging fence read it (#1999).
    // Data it marks unreadable fails closed: this level already may name
    // apply_patch (mayNameApplyPatch before every recursion).
    const piped = blocker.pipedShellData(segment);
    if (piped.unreadable) return true;
    if (piped.some((line) => mayNameApplyPatch(line) && invokesApplyPatch(blocker, line, depth + 1))) return true;
  }
  return false;
}

/**
 * The one form read as a whole command: optional `command`/`env` prefix, the
 * name, a heredoc `<<[-]` with an optionally quoted delimiter, the body, and the
 * delimiter line closing the command (only whitespace after it).
 */
const HEREDOC_FORM = /^\s*(?:command\s+|env\s+(?:\S+=\S*\s+)*)?(?:apply_patch|applypatch)\s*<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z0-9_.-]+))[ \t]*\n([\s\S]*)$/;

/**
 * Read an `apply_patch` heredoc out of a Codex shell command (#1914 shell route).
 *
 * @param {unknown} command  `tool_input.command` of a `Bash` payload
 * @returns {Promise<null | { ok: true, text: string } | { ok: false, reason: string }>}
 *   `null`: the command does not invoke apply_patch (allow, nothing to judge);
 *   `ok: true`: the patch text from the heredoc body; `ok: false`: it invokes
 *   apply_patch in a form this hook cannot read, or could not be read (deny).
 */
export async function extractShellApplyPatch(command) {
  if (typeof command !== 'string' || !mayNameApplyPatch(command)) return null;
  const unreadable = { ok: false, reason: `apply_patch-Form nicht lesbar${SHELL_WAY_OUT}` };
  // Loaded only here, so a plain Bash call never loads the tokenizer. Fail
  // closed: a tokenizer that cannot load or read the command decides nothing.
  try {
    const blocker = await import('../scripts/lib/command-blocker.mjs');
    // #2032: a line past the size bound is not split (no verdict past the
    // harness's kill would let it through); it may name apply_patch, so deny.
    const oversized = blocker.oversizedCommand(command);
    if (oversized !== null) return { ok: false, reason: `apply_patch-Form nicht lesbar: ${oversized}${SHELL_WAY_OUT}` };
    if (!invokesApplyPatch(blocker, command)) return null;
  } catch {
    return unreadable;
  }
  // Every invocation other than the plain heredoc (behind `nice -n 5`, `sudo`,
  // `x=1`; a quoted or masked name; a redirect, pipe, `cd … &&`, `bash -c`,
  // `$( )`) denies: Codex's recogniser reads only the plain form, and
  // `env -C dir`/`sudo -D dir` would move the base directory.
  const m = HEREDOC_FORM.exec(command);
  if (!m) return unreadable;
  const [, dash, single, double, bare, rest] = m;
  const delimiter = single ?? double ?? bare;
  const strip = (line) => (dash ? line.replace(/^\t+/, '') : line);
  const lines = rest.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0 || strip(lines[lines.length - 1]).trimEnd() !== delimiter) {
    return { ok: false, reason: `apply_patch-Form nicht lesbar: kein abschließendes ${delimiter} am Ende des Kommandos${SHELL_WAY_OUT}` };
  }
  const body = lines.slice(0, -1).map(strip);
  if (body.some((line) => line === delimiter)) {
    return { ok: false, reason: `apply_patch-Form nicht lesbar: Text nach dem Heredoc${SHELL_WAY_OUT}` };
  }
  return { ok: true, text: `${body.join('\n')}\n` };
}

/** Payload fields carried over from the incoming Codex payload unchanged. */
const CARRIED_FIELDS = ['cwd', 'session_id', 'hook_event_name', 'transcript_path', 'turn_id', 'tool_use_id'];

/**
 * Write a deny envelope. Prefers the shared `emitDeny` (same shape every guard
 * writes); if `io.mjs` cannot load, writes the envelope directly so a broken
 * module still denies.
 *
 * @param {string} reason
 */
async function deny(reason) {
  try {
    const { emitDeny } = await import('../scripts/lib/io.mjs');
    emitDeny(reason);
  } catch {
    writeSync(1, `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      systemMessage: `⛔ ${reason.split('\n')[0]}`,
    })}\n`);
  }
}

/**
 * Read a file the patch refers to, relative to the session cwd. `null` when absent/unreadable.
 *
 * @param {string} cwd
 * @param {string} rel
 * @returns {string | null}
 */
function readTarget(cwd, rel) {
  try {
    return readFileSync(path.resolve(cwd, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Turn one parsed patch file into the Claude-shaped tool calls the guards judge.
 *
 * Every call is a WHOLE-FILE Write (#1913 security review). Codex locates a
 * hunk leniently (one trailing `\r` dropped, whitespace trimmed, Unicode
 * punctuation folded), while config-protection skips an Edit whose
 * `old_string` is not a verbatim substring of the file, so per-hunk Edits let a
 * loosening through. The adapter instead computes the file Codex would write
 * (`applyHunksToText`, same match passes) and hands all four guards that
 * content: a Write is compared against the full current file, so lenient
 * matching cannot hide a change. One shape for all four guards is the simpler
 * choice; the path-only guards read just `file_path`. A hunk whose context
 * matches nowhere, or an Update/Move of an unreadable file, denies the patch.
 *
 * Codex applies a relative patch path against the session cwd, while the
 * guards resolve a relative `file_path` against the repository root (or test
 * the bare suffix). So every synthesized `file_path` is ABSOLUTE against cwd,
 * the form a Claude Edit/Write always carries (#1913 review F1). `path` keeps
 * the spelling from the patch for the deny suffix.
 *
 * @param {import('../scripts/lib/codex/apply-patch-parse.mjs').PatchFile} file
 * @param {string} cwd
 * @param {typeof import('../scripts/lib/codex/apply-patch-parse.mjs').applyHunksToText} applyHunksToText
 * @returns {{ calls: Array<{ path: string, tool_name: 'Write', tool_input: Record<string, string> }> } | { deny: string, path: string }}
 */
export function toToolCalls(file, cwd, applyHunksToText) {
  const write = (p, content) => ({ path: p, tool_name: /** @type {const} */ ('Write'), tool_input: { file_path: path.resolve(cwd, p), content } });
  if (file.op === 'add') return { calls: [write(file.path, file.content)] };
  if (file.op === 'delete') return { calls: [write(file.path, '')] };
  const current = readTarget(cwd, file.path);
  if (current === null) return { deny: `cannot read ${file.path} to apply the update`, path: file.path };
  const updated = applyHunksToText(current, file.hunks);
  if (!updated.ok) return { deny: `${updated.reason} in ${file.path}`, path: file.path };
  if (file.op === 'move') return { calls: [write(file.path, ''), write(file.to, updated.content)] };
  return { calls: [write(file.path, updated.content)] };
}

/**
 * Run one guard child on one synthesized payload. Exported for the budget
 * deny test; `deadline` is an absolute `Date.now()` value.
 *
 * @param {string} guard
 * @param {object} payload
 * @param {string} cwd
 * @param {number} deadline
 * @returns {{ verdict: 'allow', warning?: string } | { verdict: 'deny', envelope?: object, reason: string }}
 */
export function runGuard(guard, payload, cwd, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { verdict: 'deny', reason: `time budget of ${BUDGET_MS} ms exhausted before ${guard}${SPLIT_HINT}` };
  const result = spawnSync(process.execPath, [path.join(HOOKS_DIR, guard)], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: process.env,
    timeout: remaining,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    const code = result.error.code ?? result.error.message;
    return { verdict: 'deny', reason: `${guard} could not run: ${code}${code === 'ETIMEDOUT' ? SPLIT_HINT : ''}` };
  }
  if (result.status !== 0) return { verdict: 'deny', reason: `${guard} exited ${result.status ?? result.signal}` };
  let warning;
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.hookSpecificOutput?.permissionDecision === 'deny') return { verdict: 'deny', envelope: parsed, reason: '' };
    if (typeof parsed?.systemMessage === 'string' && warning === undefined) warning = parsed.systemMessage;
  }
  return { verdict: 'allow', warning };
}

/**
 * Decide one patch. Returns the stdout line to write (deny envelope or
 * warning), or `null` for a silent allow.
 *
 * @param {any} input  the Codex payload (`cwd` and the carried fields)
 * @param {string} text  the patch text
 * @param {'tool' | 'shell'} route
 * @returns {Promise<{ deny: string } | { line: string | null }>}
 */
async function decide(input, text, route) {
  const { parseApplyPatch, applyHunksToText, foldPatchFiles } = await import('../scripts/lib/codex/apply-patch-parse.mjs');
  const parsed = parseApplyPatch(text);
  if (!parsed.ok) return { deny: `apply_patch blocked: patch not understood (${parsed.reason}, route: ${route})` };

  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const base = {};
  for (const key of CARRIED_FIELDS) if (key in input) base[key] = input[key];

  const deadline = Date.now() + BUDGET_MS;
  const warnings = [];
  for (const file of foldPatchFiles(parsed.files)) {
    const mapped = toToolCalls(file, cwd, applyHunksToText);
    if ('deny' in mapped) return { deny: `apply_patch blocked: ${mapped.deny} [apply_patch: ${mapped.path}]` };
    for (const call of mapped.calls) {
      const payload = { ...base, tool_name: call.tool_name, tool_input: call.tool_input };
      for (const guard of EDIT_GUARDS) {
        const outcome = runGuard(guard, payload, cwd, deadline);
        if (outcome.verdict === 'deny') {
          const suffix = ` [apply_patch: ${call.path}]`;
          if (!outcome.envelope) return { deny: `apply_patch blocked (fail closed): ${outcome.reason}${suffix}` };
          const env = outcome.envelope;
          env.hookSpecificOutput.permissionDecisionReason = `${env.hookSpecificOutput.permissionDecisionReason ?? ''}${suffix}`;
          return { line: JSON.stringify(env) };
        }
        if (outcome.warning) warnings.push(outcome.warning);
      }
    }
  }
  return { line: warnings.length > 0 ? JSON.stringify({ systemMessage: warnings.join('\n') }) : null };
}

async function main() {
  const { readStdin, isShellCommandTool } = await import('../scripts/lib/io.mjs');
  let input;
  try {
    input = await readStdin();
  } catch (e) {
    return deny(`apply_patch blocked: payload unreadable (${e?.message || e})`);
  }
  if (!input || typeof input !== 'object') return deny('apply_patch blocked: empty or non-object payload');
  let outcome;
  if (input.tool_name === 'apply_patch') {
    const { extractPatchText } = await import('../scripts/lib/codex/apply-patch-parse.mjs');
    const extracted = extractPatchText(input.tool_input);
    if (!extracted.ok) return deny(`apply_patch blocked: unreadable payload (${extracted.reason})`);
    outcome = await decide(input, extracted.text, 'tool');
  } else {
    const command = input.tool_input?.command;
    // Shared predicate (Bash, Monitor; never PowerShell): POSIX heredocs only.
    const shell = isShellCommandTool(input.tool_name) ? await extractShellApplyPatch(command) : null;
    if (shell === null) {
      // Fail closed on a patch under a foreign name (#1914): should the patch
      // tool arrive under another name, a silent allow would let every Codex
      // file write past the guards, while a deny costs one visible retry. The
      // substring pre-test keeps the parser off the Bash hot path.
      if (typeof command !== 'string' || !command.includes('*** Begin Patch')) return;
      const { parseApplyPatch } = await import('../scripts/lib/codex/apply-patch-parse.mjs');
      if (!parseApplyPatch(command).ok) return;
      return deny(`apply_patch blocked: apply_patch-Patch unter fremdem tool_name ${JSON.stringify(String(input.tool_name).slice(0, 40))}`);
    }
    if (!shell.ok) return deny(`apply_patch blocked: ${shell.reason}`);
    // `command` is the only measured key of a Codex shell payload; another key
    // (e.g. `workdir`) could move the base directory the patch applies against.
    const extra = Object.keys(input.tool_input).find((key) => key !== 'command');
    if (extra !== undefined) return deny(`apply_patch blocked: unreadable payload (tool_input carries an unrecognised key '${extra.slice(0, 40)}')${SHELL_WAY_OUT}`);
    outcome = await decide(input, shell.text, 'shell');
  }
  if ('deny' in outcome) return deny(outcome.deny);
  if (outcome.line) writeSync(1, `${outcome.line}\n`);
}

// Entry guard (#1393): run only as the node script the harness execs — a bare
// `import()` must run no handler and must not exit the importing process.
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook(HOOK_NAME)) process.exit(0);

  // Fail CLOSED on any internal error: this hook is the only route by which a
  // Codex patch reaches the Edit/Write guards.
  main()
    .then(() => process.exit(0))
    .catch(async (e) => {
      process.stderr.write(`⚠ ${HOOK_NAME}: internal error — ${e?.message || e}\n`);
      await deny(`apply_patch blocked: ${HOOK_NAME} internal error`);
      process.exit(0);
    });
}
