/**
 * agent-usage-census.mjs — which agent types ran, on which model, at what cost
 * shape (#1617). Read-only, stdlib only.
 *
 * ## Why the transcripts and not the ledger
 *
 * `.orchestrator/metrics/subagents.jsonl` sees only dispatches from sessions in
 * THIS repo, carries no observed model on most records and no effort at all, and
 * ~87% of its stop records are the #939 phantom class with no type. The fleet
 * dispatches from 20+ repos. The Claude Code transcripts are the source that
 * holds all of it:
 *
 *   <root>/<project>/<session>/subagents/**\/agent-<id>.meta.json   → agentType
 *   <root>/<project>/<session>/subagents/**\/agent-<id>.jsonl       → message.model + usage
 *
 * (`**` because Workflow agents nest one level deeper, under
 * `subagents/workflows/<wf-id>/`.)
 *
 * ## Definitions (the numbers are only comparable if these hold)
 *
 *   run      one `agent-<id>.jsonl` whose FIRST turn falls inside the window.
 *            Window membership by first turn, not by file mtime, so a run is
 *            never split across two weekly censuses.
 *   turn     one API response. Streaming writes several assistant lines per
 *            response; they are collapsed on `requestId`, else `message.id`, last
 *            usage block wins — the same recipe as hooks/subagent-telemetry.mjs
 *            extractTranscriptUsage() (#950/#963). A line carrying neither key is
 *            its own turn. The turn's timestamp is its FIRST line (request time).
 *            Only lines with a `message.model` count as turns. The raw line
 *            count is reported beside it as `assistant_lines` /
 *            `models_by_lines` — the unit the #1617 discovery measured.
 *   rebuild  a cache re-creation after an idle gap: the gap to the previous turn
 *            exceeds GAP_SECONDS AND this turn's cache_creation exceeds
 *            REBUILD_MIN_CREATION AND its cache_read is below its cache_creation.
 *   start    input + cache_creation + cache_read of the run's first turn.
 *   pre-edit tool calls before the run's first Edit/Write/MultiEdit/NotebookEdit
 *            call (#2170). Tool calls are the `tool_use` blocks of assistant
 *            lines only (the copies in `api-request-blob` lines are skipped by the type
 *            filter, which is the dedupe that real transcripts need), merged on
 *            block id, in file order. Each call is classified
 *            by classifyToolCall(); a Bash call that writes a file (`edit`
 *            class) is counted separately as `pre_change`, which stops at the
 *            first edit tool OR Bash write, so both definitions are reported.
 *
 * ## Unreadable lines
 *
 * Every line is parsed; a line that does not parse is skipped AND counted in
 * `malformed_lines` (measurement-discipline.md § Unlesbare JSONL-Zeilen). A
 * meta.json that is missing or unreadable puts the run under `(no-meta)` /
 * `(unreadable-meta)` rather than dropping it.
 *
 * Memory: transcripts are streamed line by line (readline). Per file only the
 * turn map of that one run is held, so a multi-GB window stays bounded by the
 * largest single run.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const SCHEMA = 'agent-usage-census/1';
export const GAP_SECONDS = 300;
export const REBUILD_MIN_CREATION = 20_000;
export const DEFAULT_DAYS = 14;

const AGENT_FILE_RE = /^agent-[A-Za-z0-9_-]+\.jsonl$/;

const clamp = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** Median of a numeric array; null for an empty one. */
export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile (p in 0..100); null for an empty array. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// ── Tool-call classification (#2170) ─────────────────────────────────────────

/** Classes a pre-edit tool call can fall into, plus `edit` (the stop marker). */
export const TOOL_CLASSES = ['search', 'read', 'install', 'check', 'other'];
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOOL_NAME_CLASS = { Read: 'read', Grep: 'search', Glob: 'search', LSP: 'search' };

// Priority when one Bash call chains several commands: the call gets the
// highest class any of its commands has, in this order. `cd x && pnpm install
// && pnpm test` is install, never search; `cd x && git status && rg foo` is
// search, because `other` ranks lowest.
const PRIORITY = ['edit', 'install', 'check', 'search', 'read', 'other'];

// Wrappers skipped before the command word: env assignments, `env`, `time`,
// `timeout [-k N] N`, `nice`, `sudo`, `command`, `exec`, and runner shims that
// prefix the real tool (`pnpm exec`, `npx`, `uv run`, …).
const WRAPPERS = new Set(['env', 'time', 'nice', 'sudo', 'command', 'exec', 'builtin', 'nohup',
  '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
// package-manager flags that take a value (`pnpm --filter x test`)
const PM_VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '-w', '--workspace', '--cwd']);

const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'ls', 'tree', 'locate', 'glob']);
const READ = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'wc', 'nl', 'jq', 'awk', 'sed', 'diff', 'stat', 'file']);
const CHECK = new Set(['tsc', 'tsgo', 'eslint', 'vitest', 'jest', 'mocha', 'pytest', 'mypy', 'ruff', 'biome', 'prettier', 'playwright']);
const PM = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const PM_INSTALL = new Set(['install', 'i', 'add', 'ci']);
const PM_CHECK = /^(test|lint|typecheck|type-check|check|build|tsc|vitest|eslint)(:|$)/;
const TMP_TARGET = /^(\/dev\/|\/tmp\/|\/private\/tmp\/|(\/private)?\/var\/folders\/|"?\$\{?TMPDIR)/;

/**
 * Neutralise quoted strings and cut heredoc bodies, so operators inside quotes
 * (`rg "a;b"`, `awk '$1 > 5'`, `node -e "…"`) and file contents written through
 * `cat > f <<EOF` are never read as shell syntax. A quoted string keeps only its
 * path-like characters (so `> "/tmp/x"` still reads as a temp target); escapes
 * inside double quotes are honoured; nested quoting is not modelled.
 */
function maskShell(cmd) {
  let out = '';
  const heredocs = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== c) j += c === '"' && cmd[j] === '\\' ? 2 : 1;
      out += cmd.slice(i + 1, j).replace(/[^\w./${}-]/g, '_') || 'Q';
      i = j;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) {
        heredocs.push(m[2]);
        out += '<<H';
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '\n' && heredocs.length) {
      // skip the bodies of every heredoc opened on this line
      let rest = i + 1;
      for (const tag of heredocs) {
        const end = cmd.slice(rest).search(new RegExp(`^\\s*${tag}\\s*$`, 'm'));
        if (end === -1) return out; // unterminated: drop the rest
        const lineEnd = cmd.indexOf('\n', rest + end);
        rest = lineEnd === -1 ? cmd.length : lineEnd;
      }
      heredocs.length = 0;
      out += '\n';
      i = rest;
      continue;
    }
    out += c;
  }
  return out;
}

/** True when a masked segment writes a file outside /dev and the temp dirs. */
function writesFile(seg) {
  // `>`/`>>` with an optional fd, excluding fd duplication (`2>&1`, `>&2`).
  for (const m of seg.matchAll(/(?:^|[^<>&=])\d*>>?\|?(?!&)\s*([^\s;&|()<>]+)/g)) {
    if (!TMP_TARGET.test(m[1])) return true;
  }
  for (const m of seg.matchAll(/(?:^|\|)\s*tee\b([^|;&]*)/g)) {
    const targets = m[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
    if (targets.some((t) => !TMP_TARGET.test(t))) return true;
  }
  return false;
}

/** Class of one simple command (the first stage of a pipeline). */
function classifyCommand(seg) {
  if (writesFile(seg)) return 'edit';
  const words = seg.split('|')[0].trim().replace(/^[({]\s*/, '').split(/\s+/).filter(Boolean);
  let i = 0;
  const skipWrappers = () => {
    for (;;) {
      const w = words[i];
      if (w === undefined) return;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) i++;
      else if (w === 'timeout') {
        i++;
        while (words[i]?.startsWith('-')) i += words[i] === '-k' || words[i] === '-s' ? 2 : 1;
        i++; // the duration
      } else if (w === 'npx' || w === 'bunx' || ((w === 'pnpm' || w === 'yarn') && (words[i + 1] === 'exec' || words[i + 1] === 'dlx'))
        || (w === 'uv' && words[i + 1] === 'run')) {
        i += w === 'npx' || w === 'bunx' ? 1 : 2;
        while (words[i]?.startsWith('-')) i++;
      } else return;
    }
  };
  skipWrappers();
  const cmd = words[i]?.replace(/^.*\//, '');
  if (!cmd) return 'other';
  const args = words.slice(i + 1);
  if (cmd === 'sed' || cmd === 'perl') {
    // `-i`, `-i.bak`, `-i ''`, `-ni`, `--in-place`: an in-place edit, not a read
    if (args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a) && !a.startsWith('-M'))) return 'edit';
    return cmd === 'sed' ? 'read' : 'other';
  }
  if (SEARCH.has(cmd)) return 'search';
  if (READ.has(cmd)) return 'read';
  if (CHECK.has(cmd)) return 'check';
  if (cmd === 'git') {
    let j = 0;
    while (args[j]?.startsWith('-')) j += args[j] === '-C' || args[j] === '-c' ? 2 : 1;
    const sub = args[j];
    if (sub === 'grep' || sub === 'ls-files') return 'search';
    if (['show', 'log', 'diff', 'blame', 'cat-file'].includes(sub)) return 'read';
    if (sub === 'apply') {
      // `--check` / `--stat` / `--numstat` / `--summary` only test or report a patch;
      // `--apply` next to them still writes (`git apply --stat --apply`).
      const rest = args.slice(j + 1);
      const dry = rest.some((a) => ['--check', '--stat', '--numstat', '--summary'].includes(a));
      return dry && !rest.includes('--apply') ? 'read' : 'edit';
    }
    return 'other';
  }
  if (PM.has(cmd)) {
    let j = 0;
    // `-w` takes a value only for npm (`--workspace`); pnpm/yarn/bun: boolean workspace-root flag
    while (args[j]?.startsWith('-')) j += PM_VALUE_FLAGS.has(args[j]) && !(args[j] === '-w' && cmd !== 'npm') ? 2 : 1;
    const sub = args[j];
    if (PM_INSTALL.has(sub)) return 'install';
    const script = sub === 'run' ? args[j + 1] : sub;
    if (script && PM_CHECK.test(script)) return 'check';
    return 'other';
  }
  if (cmd === 'uv' || cmd === 'pip' || cmd === 'pip3' || cmd === 'brew') {
    const sub = args.find((a) => !a.startsWith('-'));
    return sub === 'install' || sub === 'sync' || sub === 'add' || (sub === 'pip' && args.includes('install'))
      ? 'install' : 'other';
  }
  if (cmd === 'node' && args.includes('--test')) return 'check';
  if ((cmd === 'cargo' || cmd === 'go' || cmd === 'swift') && ['test', 'check', 'clippy', 'vet', 'build'].includes(args[0])) {
    return 'check';
  }
  return 'other';
}

/**
 * Classify one Bash command line.
 *
 * Rule: mask quotes and heredoc bodies, split on `&&`, `||`, `;` and newlines,
 * drop `cd`/`pushd`/`export`/`set`/`source` segments, classify each remaining
 * segment by the first stage of its pipeline (after wrappers such as `VAR=x`,
 * `timeout N`, `npx`, `pnpm exec`), and return the highest class by PRIORITY.
 *
 * `edit` = the command writes a file: `sed -i`/`perl -i`, `git apply`, a `>`/`>>`
 * redirect or `tee` into a path outside /dev and the temp dirs. Ceiling both
 * ways: `mv`, `cp`, `eslint --fix`, codemods and scripts that write files are
 * NOT detected, while every non-temp redirect IS, including report and scratch
 * files under the repo or a `$VAR` dir — so the Bash-write figures (`pre_change`,
 * `runs_bash_write_first`) are an upper bound, which is why `pre_edit` stops at
 * edit tools only. Revisit if Bash-made source edits need an exact count.
 *
 * @param {string} command
 * @returns {'search'|'read'|'install'|'check'|'other'|'edit'}
 */
export function classifyBash(command) {
  if (typeof command !== 'string' || !command.trim()) return 'other';
  const segments = maskShell(command)
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[({]?\s*(cd|pushd|popd|export|set|source|\.)(\s|$)/.test(s));
  let best = 'other';
  for (const seg of segments) {
    const c = classifyCommand(seg);
    if (PRIORITY.indexOf(c) < PRIORITY.indexOf(best)) best = c;
  }
  return best;
}

/**
 * Classify one tool call. Edit tools return `edit` (`other` when the target is
 * a temp path); Read → read; Grep/Glob/LSP
 * → search; Bash/Monitor → classifyBash(input.command); everything else
 * (Agent, Task, TodoWrite, WebFetch, …) → other.
 *
 * @param {string} name
 * @param {unknown} input
 */
export function classifyToolCall(name, input) {
  if (EDIT_TOOLS.has(name)) {
    // A Write/Edit into a temp dir is a scratch file, not a change (same rule as
    // the Bash redirect side): measured 2026-11-20, 412 of 1266 general-purpose
    // edit runs had a temp-path Write as their first edit tool call.
    const target = input && typeof input === 'object' ? (input.file_path ?? input.notebook_path) : undefined;
    return typeof target === 'string' && TMP_TARGET.test(target) ? 'other' : 'edit';
  }
  if (TOOL_NAME_CLASS[name]) return TOOL_NAME_CLASS[name];
  if (name === 'Bash' || name === 'Monitor') {
    return classifyBash(input && typeof input === 'object' ? input.command : undefined);
  }
  return 'other';
}

/**
 * Pre-edit figures of one run from its classified tool-call sequence.
 * `editToolAt`: index of the first edit tool call (null if none);
 * `bashWriteFirst`: a Bash write came before any edit tool.
 * @param {Array<{ cls: string, tool: boolean }>} calls  tool=true for edit tools
 */
export function summarizeToolCalls(calls) {
  const editToolAt = calls.findIndex((c) => c.tool);
  const changeAt = calls.findIndex((c) => c.cls === 'edit');
  let byClass = null;
  if (editToolAt !== -1) {
    // `bash_write` = Bash calls that wrote a file before the first edit tool;
    // they stay inside the pre-edit total so it matches the tool-only count.
    byClass = Object.fromEntries([...TOOL_CLASSES, 'bash_write'].map((k) => [k, 0]));
    for (const c of calls.slice(0, editToolAt)) byClass[c.cls === 'edit' ? 'bash_write' : c.cls]++;
  }
  return {
    toolCalls: calls.length,
    preEdit: editToolAt === -1 ? null : editToolAt,
    preEditByClass: byClass,
    preChange: changeAt === -1 ? null : changeAt,
    bashWriteFirst: changeAt !== -1 && !calls[changeAt].tool,
  };
}

/**
 * List every subagent transcript under `root` whose mtime is at or after
 * `cutoffMs` (a cheap pre-filter: a file untouched since the cutoff cannot hold
 * a first turn inside the window). Unreadable directories are skipped and
 * counted.
 *
 * @param {string} root
 * @param {number} cutoffMs
 * @returns {{ files: string[], unreadable_dirs: number }}
 */
export function findSubagentTranscripts(root, cutoffMs) {
  const files = [];
  let unreadableDirs = 0;
  const list = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadableDirs++;
      return [];
    }
  };
  const walkSubagents = (dir) => {
    for (const e of list(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkSubagents(p);
      else if (e.isFile() && AGENT_FILE_RE.test(e.name)) {
        try {
          if (fs.statSync(p).mtimeMs >= cutoffMs) files.push(p);
        } catch {
          // vanished between readdir and stat — not part of the window
        }
      }
    }
  };
  for (const project of list(root)) {
    if (!project.isDirectory()) continue;
    for (const session of list(path.join(root, project.name))) {
      if (!session.isDirectory()) continue;
      const sub = path.join(root, project.name, session.name, 'subagents');
      // lstat, not existsSync: a `subagents` symlink is skipped like every
      // other symlink in this walk (Dirent types do not follow links).
      let subStat;
      try {
        subStat = fs.lstatSync(sub);
      } catch {
        continue;
      }
      if (subStat.isDirectory()) walkSubagents(sub);
    }
  }
  files.sort();
  return { files, unreadable_dirs: unreadableDirs };
}

/**
 * Agent type from the sibling meta.json.
 * @param {string} jsonlPath
 * @returns {string} agentType, or '(no-meta)' / '(unreadable-meta)'
 */
export function readAgentType(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  let raw;
  try {
    raw = fs.readFileSync(metaPath, 'utf8');
  } catch {
    return '(no-meta)';
  }
  try {
    const t = JSON.parse(raw)?.agentType;
    return typeof t === 'string' && t.trim() ? t : '(no-meta)';
  } catch {
    return '(unreadable-meta)';
  }
}

/**
 * Stream one subagent transcript into a run summary.
 *
 * @param {string} jsonlPath
 * @returns {Promise<{ turns: Array<{ model: string, ts: number|null, input: number,
 *   cacheCreation: number, cacheRead: number, output: number }>,
 *   lines: Record<string, number>, malformed: number,
 *   calls: Array<{ cls: string, tool: boolean }> }>}
 */
export async function readRunTurns(jsonlPath) {
  const byKey = new Map();
  const unkeyed = [];
  /** Raw assistant lines per model, BEFORE the streaming dedup. */
  const lines = {};
  let malformed = 0;
  /** Classified tool calls in file order, deduped on tool_use block id. */
  const calls = [];
  const callIndexById = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (obj?.type !== 'assistant') continue;
    const msg = obj.message;
    // Tool calls: classified on the spot so no command text is held or emitted.
    if (Array.isArray(msg?.content)) {
      for (const b of msg.content) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
        const cls = classifyToolCall(b.name, b.input);
        const call = { cls, tool: cls === 'edit' && EDIT_TOOLS.has(b.name) };
        if (typeof b.id === 'string' && b.id) {
          // A repeated block keeps the first position and takes the later copy's class:
          // streaming copies only grow, so the last one carries the fullest input.
          const at = callIndexById.get(b.id);
          if (at !== undefined) {
            calls[at] = call;
            continue;
          }
          callIndexById.set(b.id, calls.length);
        }
        calls.push(call);
      }
    }
    const model = typeof msg?.model === 'string' && msg.model ? msg.model : null;
    if (model === null) continue;
    lines[model] = (lines[model] ?? 0) + 1;
    const u = msg.usage && typeof msg.usage === 'object' ? msg.usage : {};
    const ts = Date.parse(obj.timestamp);
    const snap = {
      model,
      input: clamp(u.input_tokens),
      cacheCreation: clamp(u.cache_creation_input_tokens),
      cacheRead: clamp(u.cache_read_input_tokens),
      output: clamp(u.output_tokens),
    };
    const key =
      typeof obj.requestId === 'string' && obj.requestId
        ? `r:${obj.requestId}`
        : typeof msg.id === 'string' && msg.id
          ? `m:${msg.id}`
          : null;
    if (key === null) {
      unkeyed.push({ ...snap, ts: Number.isFinite(ts) ? ts : null });
      continue;
    }
    const prev = byKey.get(key);
    // Last usage block wins; the timestamp stays the FIRST one (request time).
    byKey.set(key, { ...snap, ts: prev ? prev.ts : Number.isFinite(ts) ? ts : null });
  }
  return { turns: [...byKey.values(), ...unkeyed], lines, malformed, calls };
}

/**
 * Derive the per-run metrics from its turns (in file order).
 * @param {Array<{ model: string, ts: number|null, input: number, cacheCreation: number,
 *   cacheRead: number, output: number }>} turns
 */
export function summarizeRun(turns) {
  const ordered = [...turns].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const models = {};
  let output = 0;
  let rebuilds = 0;
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    models[t.model] = (models[t.model] ?? 0) + 1;
    output += t.output;
    const prev = ordered[i - 1];
    if (prev && prev.ts !== null && t.ts !== null && (t.ts - prev.ts) / 1000 > GAP_SECONDS
      && t.cacheCreation > REBUILD_MIN_CREATION && t.cacheRead < t.cacheCreation) {
      rebuilds++;
    }
  }
  const first = ordered[0];
  return {
    firstTs: first?.ts ?? null,
    turns: ordered.length,
    models,
    output,
    rebuilds,
    startContext: first ? first.input + first.cacheCreation + first.cacheRead : null,
  };
}

const shareMap = (counts, total, unit = 'turns') =>
  Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => [m, { [unit]: n, share: total ? +(n / total).toFixed(4) : 0 }]),
  );

/**
 * Pre-edit figures of one agent type (#2170). Runs without tool-call data
 * (older callers of aggregate()) count as runs without an edit.
 * @param {Array<Partial<ReturnType<typeof summarizeToolCalls>>>} runs
 */
function preEditFigures(runs) {
  const edited = runs.filter((r) => Number.isInteger(r.preEdit));
  const changed = runs.filter((r) => Number.isInteger(r.preChange));
  const totals = edited.map((r) => r.preEdit);
  return {
    tool_calls_per_run_median: median(runs.map((r) => r.toolCalls ?? 0)),
    runs_with_edit: edited.length,
    median: median(totals),
    p90: percentile(totals, 90),
    median_by_class: Object.fromEntries(
      [...TOOL_CLASSES, 'bash_write'].map((k) => [k, median(edited.map((r) => r.preEditByClass[k]))]),
    ),
    // Sums over all edit runs: the medians of rare classes are 0, the sums show their weight.
    total_by_class: Object.fromEntries(
      [...TOOL_CLASSES, 'bash_write'].map((k) => [k, edited.reduce((s, r) => s + r.preEditByClass[k], 0)]),
    ),
    runs_with_change: changed.length,
    pre_change_median: median(changed.map((r) => r.preChange)),
    runs_bash_write_first: runs.filter((r) => r.bashWriteFirst).length,
  };
}

/**
 * Fold run summaries into the per-type census.
 * @param {Array<{ agentType: string } & ReturnType<typeof summarizeRun>>} runs
 */
export function aggregate(runs) {
  const groups = new Map();
  const allModels = {};
  let totalTurns = 0;
  for (const r of runs) {
    let g = groups.get(r.agentType);
    if (!g) {
      g = { runs: [], models: {} };
      groups.set(r.agentType, g);
    }
    g.runs.push(r);
    for (const [m, n] of Object.entries(r.models)) {
      g.models[m] = (g.models[m] ?? 0) + n;
      allModels[m] = (allModels[m] ?? 0) + n;
      totalTurns += n;
    }
  }
  const byType = [...groups.entries()].map(([agentType, g]) => {
    const turns = g.runs.reduce((s, r) => s + r.turns, 0);
    return {
      agent_type: agentType,
      dispatches: g.runs.length,
      turns,
      models: shareMap(g.models, turns),
      turns_per_run_median: median(g.runs.map((r) => r.turns)),
      output_tokens_per_run_median: median(g.runs.map((r) => r.output)),
      cache_rebuilds: g.runs.reduce((s, r) => s + r.rebuilds, 0),
      runs_with_cache_rebuild: g.runs.filter((r) => r.rebuilds > 0).length,
      start_context_median: median(g.runs.map((r) => r.startContext).filter((v) => v !== null)),
      pre_edit: preEditFigures(g.runs),
    };
  });
  byType.sort((a, b) => b.turns - a.turns || a.agent_type.localeCompare(b.agent_type));
  return { turns: totalTurns, models: shareMap(allModels, totalTurns), by_agent_type: byType };
}

/**
 * Run the census over a transcript root.
 *
 * @param {{ root: string, days?: number, now?: number, concurrency?: number }} opts
 */
export async function runCensus({ root, days = DEFAULT_DAYS, now = Date.now(), concurrency = 4 }) {
  const cutoffMs = now - days * 86_400_000;
  const { files, unreadable_dirs } = findSubagentTranscripts(root, cutoffMs);
  const runs = [];
  let malformed = 0;
  let unreadableFiles = 0;
  let outsideWindow = 0;
  let emptyRuns = 0;
  const lineModels = {};
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      let res;
      try {
        res = await readRunTurns(file);
      } catch {
        unreadableFiles++;
        continue;
      }
      malformed += res.malformed;
      if (res.turns.length === 0) {
        emptyRuns++;
        continue;
      }
      const s = summarizeRun(res.turns);
      if (s.firstTs === null || s.firstTs < cutoffMs || s.firstTs > now) {
        outsideWindow++;
        continue;
      }
      runs.push({ agentType: readAgentType(file), ...s, ...summarizeToolCalls(res.calls) });
      for (const [m, n] of Object.entries(res.lines)) lineModels[m] = (lineModels[m] ?? 0) + n;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return {
    schema: SCHEMA,
    measured_at: new Date(now).toISOString(),
    root,
    window_days: days,
    cutoff: new Date(cutoffMs).toISOString(),
    definition: {
      turn: 'assistant response with message.model, deduped on requestId else message.id (last usage wins)',
      run_in_window: 'first turn timestamp >= cutoff',
      cache_rebuild: `gap > ${GAP_SECONDS}s, cache_creation > ${REBUILD_MIN_CREATION}, cache_read < cache_creation`,
      start_context: 'input + cache_creation + cache_read of the first turn',
      pre_edit: 'tool_use blocks (deduped on id, file order) before the first Edit/Write/MultiEdit/NotebookEdit outside temp dirs; per class via classifyToolCall()',
      pre_change: 'same, but stopping at the first edit tool OR Bash file write (sed -i, perl -i, git apply, > / >> / tee outside temp dirs)',
    },
    files_scanned: files.length,
    runs: runs.length,
    runs_outside_window: outsideWindow,
    runs_without_turns: emptyRuns,
    unreadable_files: unreadableFiles,
    unreadable_dirs,
    malformed_lines: malformed,
    ...aggregate(runs),
    // Raw streaming lines, not API turns: the #1617 discovery counted these
    // (349,519 in 14 days); one response is ~1.9 lines. Kept for comparability.
    assistant_lines: Object.values(lineModels).reduce((a, b) => a + b, 0),
    models_by_lines: shareMap(lineModels, Object.values(lineModels).reduce((a, b) => a + b, 0), 'lines'),
  };
}

const pct = (s) => `${(s * 100).toFixed(1)}%`;
const fmt = (v) => (v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Human-readable table of a census result. */
export function formatTable(result, { top = 25 } = {}) {
  const out = [];
  out.push(
    `agent-usage-census: ${result.runs} runs / ${result.turns} turns, last ${result.window_days} days ` +
      `(${result.files_scanned} files, malformed_lines ${result.malformed_lines}, ` +
      `unreadable_files ${result.unreadable_files})`,
  );
  out.push(
    'models: ' +
      Object.entries(result.models)
        .map(([m, v]) => `${m} ${pct(v.share)} (${v.turns})`)
        .join(' · '),
  );
  out.push(
    `raw assistant lines ${result.assistant_lines}: ` +
      Object.entries(result.models_by_lines)
        .slice(0, 3)
        .map(([m, v]) => `${m} ${pct(v.share)}`)
        .join(' · '),
  );
  out.push('');
  const head = ['agent_type', 'runs', 'turns', 'models', 'turns/run', 'out/run', 'rebuilds', 'start_ctx'];
  const rows = result.by_agent_type.slice(0, top).map((t) => [
    t.agent_type,
    String(t.dispatches),
    String(t.turns),
    Object.entries(t.models)
      .slice(0, 3)
      .map(([m, v]) => `${m.replace(/^claude-/, '')} ${pct(v.share)}`)
      .join(', '),
    fmt(t.turns_per_run_median),
    fmt(t.output_tokens_per_run_median),
    `${t.cache_rebuilds}/${t.runs_with_cache_rebuild}`,
    fmt(t.start_context_median),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  out.push(line(head));
  for (const r of rows) out.push(line(r));
  if (result.by_agent_type.length > top) out.push(`… ${result.by_agent_type.length - top} more types (--json for all)`);
  out.push('');
  out.push('rebuilds = cache rebuild events / runs with ≥1; medians per run.');
  out.push('');
  out.push(formatPreEditTable(result, { top }));
  return out.join('\n');
}

/** Pre-edit section (#2170): orientation cost before the first edit, per type. */
export function formatPreEditTable(result, { top = 25 } = {}) {
  const out = ['Tool calls before the first edit (runs with an Edit/Write/MultiEdit/NotebookEdit outside temp dirs):'];
  const head = ['agent_type', 'calls/run', 'edit_runs', 'pre_med', 'pre_p90', 'search', 'read', 'install', 'check',
    'other', 'bash_wr', 'chg_runs', 'chg_med', 'bash_1st'];
  const types = result.by_agent_type.filter((t) => t.pre_edit).slice(0, top);
  const rows = types.map((t) => {
    const p = t.pre_edit;
    return [
      t.agent_type,
      fmt(p.tool_calls_per_run_median),
      String(p.runs_with_edit),
      fmt(p.median),
      fmt(p.p90),
      ...[...TOOL_CLASSES, 'bash_write'].map((k) => fmt(p.median_by_class[k])),
      String(p.runs_with_change),
      fmt(p.pre_change_median),
      String(p.runs_bash_write_first),
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  out.push(line(head));
  for (const r of rows) out.push(line(r));
  out.push('');
  out.push('pre_med/pre_p90 over edit_runs (p90 is noise for small n); per-class medians do not sum to pre_med');
  out.push('(the per-class sums are in --json as pre_edit.total_by_class).');
  out.push('bash_wr = Bash calls that wrote a file before the first edit tool (inside pre_med).');
  out.push('chg_* = stop at the first edit tool OR Bash write; bash_1st = runs whose first change was a Bash write.');
  return out.join('\n');
}
