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
 *   lines: Record<string, number>, malformed: number }>}
 */
export async function readRunTurns(jsonlPath) {
  const byKey = new Map();
  const unkeyed = [];
  /** Raw assistant lines per model, BEFORE the streaming dedup. */
  const lines = {};
  let malformed = 0;
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
  return { turns: [...byKey.values(), ...unkeyed], lines, malformed };
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
      runs.push({ agentType: readAgentType(file), ...s });
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
  return out.join('\n');
}
