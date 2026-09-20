#!/usr/bin/env node
/**
 * skill-evidence-window.mjs — the INPUT the skill-applied judge reasons over
 * (issue #1399).
 *
 * `scripts/lib/skill-judge.mjs` has carried a `transcriptTail = ''` default
 * since #645 and nothing in the tree ever produced that string. Measured
 * 2026-09-19 at `8f15f77b`: `buildJudgePrompt(['<one skill>'], '', <32-hex
 * nonce>)` is 1387 characters = 346 estimated tokens, comfortably under
 * `DEFAULT_BUDGET.input` (8000) — so the budget gate PASSED the empty fence and
 * the judge was dispatched to judge a transcript it had never seen. This module
 * is the missing producer.
 *
 * Why not reuse `readTranscriptTail` (`hooks/_lib/subagent-transcript.mjs`):
 * it concatenates the `text` blocks of the last N **assistant** records and
 * drops `tool_use` entirely — which is exactly where a skill invocation lives
 * (`{name:"Skill", input:{skill:"…"}}`). The last-N-records window also has no
 * reason to contain the invocation at all: a `/session deep` fires at record 21
 * of 4000.
 *
 * Shape of the answer: a WINDOW, not a tail. For each judged skill we locate
 * its anchors (the invocation itself), then render bounded excerpts around the
 * first anchor, the last anchor, and the end of the skill's attribution span,
 * plus ONE shared excerpt of the session's closing records. Excerpts are joined
 * with `\n[…]\n` so the judge can see that material was elided.
 *
 * Layering: pure cores first (`locateSkillAnchors`, `renderEvidence`), a thin
 * IO layer after (`readTranscriptRecords`, `buildSkillEvidence`). The cores
 * take records, never paths, so the tests need no filesystem; the IO layer
 * takes `transcriptPath` / `projectsDir` as dependency-injection parameters.
 *
 * Substrate, measured 2026-09-19 over the 57 transcripts in
 * `~/.claude/projects/<encoded-repo>/` (188 skill invocations in 46 files):
 *   (a) assistant `tool_use` `{name:"Skill", input:{skill:"<plugin>:<name>"}}`
 *       — 179 prefixed, 9 bare, hence the prefix-tolerant match below;
 *   (b) a user record carrying `<command-name>/<plugin>:<name></command-name>`;
 *   (c) the body arrives as the following `isMeta` record — WITH the header
 *       "Base directory for this skill:" for form (a) (169 of 188), and
 *       WITHOUT it for 91 of 101 slash-command bodies. Keying body detection on
 *       that header is what made the #1399 study builder drop them;
 *   (d) a failed call shows as `tool_result.is_error` on the anchor's id;
 *   (e) subagent invocations live in `<uuid>/subagents/agent-*.jsonl`;
 *   (f) assistant records carry an undocumented optional `attributionSkill`
 *       string (7843 occurrences) — used ONLY as an additional hint for where a
 *       skill's section ENDS, never as the anchor itself.
 *
 * Read-only by contract: nothing here writes a file.
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { readLock, isLockLive } from './session-lock.mjs';

// ---------------------------------------------------------------------------
// Constants (every ceiling named, per .claude/rules/build-value.md BV-004)
// ---------------------------------------------------------------------------

/** Default total character budget for the rendered evidence text. */
export const DEFAULT_BUDGET_CHARS = 30_500;

/** Characters reserved ONCE for the shared session-closing excerpt. */
export const DEFAULT_CLOSING_CHARS = 3000;

/** A skill rendered with less than this is not worth rendering — report instead. */
export const DEFAULT_MIN_PER_SKILL_CHARS = 1500;

/**
 * Share of the per-skill pool that SUBAGENT-ONLY skills may take when
 * coordinator-anchored skills are also present (#1412).
 *
 * Why a cap at all: with `includeSubagents: true` the record count grows ~4.4x
 * (measured 2026-09-20 over 3 sessions) and admits a second class of judged
 * skill. Under ONE shared pool that class both shrinks every coordinator
 * skill's excerpt and can push one out over the `minPerSkillChars` floor —
 * purely by its position in the requested-skills array. The cap plus the
 * coordinator-first ordering below bound that: coordinator skills keep at
 * least 1 - this share of the pool, and whatever does not fit is the NEWLY
 * admitted material, reported in `skipped` with `truncated: true`.
 *
 * Ceiling: 0.25 is a proportion, not a measurement — the whole pool is 27,500
 * characters by default and the largest window measured to date is 6,021, so
 * the cap binds only under a caller-shrunk budget or a large judged set.
 * Revisit if a real session ever reports a subagent-only skill skipped as
 * `budget-insufficient` while the coordinator sections sit far under budget.
 */
export const DEFAULT_SUBAGENT_POOL_SHARE = 0.25;

/** Cap for a single `tool_use` input / `tool_result` payload inside an excerpt. */
export const DEFAULT_TOOL_TEXT_MAX = 1500;

/**
 * Per-block read-time cap. Skill bodies measured at median 39,667 and max
 * 129,144 characters; a 24 MB transcript holds hundreds of them, so keeping
 * them whole in memory buys nothing — the first heading, the only part we
 * render, sits in the first few hundred characters. 4000 is 2.6x the
 * `toolTextMax` cap above, so no rendered excerpt is ever clipped by THIS
 * limit first. Revisit if an excerpt form ever needs more than 4000 characters
 * of a single block.
 */
export const DEFAULT_MAX_BLOCK_CHARS = 4000;

/** Records rendered before / after an anchor record. */
const CONTEXT_BEFORE = 1;
const CONTEXT_AFTER = 3;

/** How far past an anchor to look for its `isMeta` body record. */
const BODY_LOOKAHEAD = 4;

/** Records in the shared session-closing excerpt. */
const CLOSING_RECORDS = 12;

/** Separator between two non-adjacent excerpts. */
const ELISION = '\n[…]\n';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The bare skill name — everything after the last `:`. `session-orchestrator:plan`
 * and a bare `plan` name the same skill in a transcript (9 of 188 measured
 * invocations carry no plugin prefix), so both spellings must match.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function bareSkillName(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  const idx = s.lastIndexOf(':');
  return idx === -1 ? s : s.slice(idx + 1);
}

/**
 * Prefix-tolerant skill match. Exact equality wins; otherwise the bare names
 * are compared. Ceiling: two plugins exporting the same bare name would match
 * each other. Accepted — the consequence is a slightly wider evidence window,
 * never a missing anchor, and the alternative (exact-only) silently loses the
 * 9-of-188 bare-call form.
 *
 * @param {unknown} candidate
 * @param {unknown} skill
 * @returns {boolean}
 */
export function skillMatches(candidate, skill) {
  if (typeof candidate !== 'string' || typeof skill !== 'string') return false;
  const a = candidate.trim();
  const b = skill.trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return bareSkillName(a) === bareSkillName(b);
}

/** @param {unknown} rec @returns {Array<Record<string, unknown>>} */
function contentBlocks(rec) {
  const content = rec?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/** Concatenated plain text of a record's `text` blocks (thinking excluded). */
function recordText(rec) {
  const parts = [];
  for (const b of contentBlocks(rec)) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** @param {string} s @param {number} max @returns {string} */
function clip(s, max) {
  const str = typeof s === 'string' ? s : String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…[+${str.length - max} chars]`;
}

/** First markdown heading of a body, else its first non-empty line. */
function firstHeading(text) {
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) return line.trim();
  }
  for (const line of lines) {
    if (line.trim()) return clip(line.trim(), 120);
  }
  return '(empty body)';
}

/**
 * Is this record a SUBAGENT record? `_subagent` is stamped by
 * `readTranscriptRecords` for `<uuid>/subagents/agent-*.jsonl`; `isSidechain`
 * is stamped by the harness itself. ONE definition, because two consumers read
 * it: the anchor classifier below and the budget split in `renderEvidence`.
 *
 * @param {unknown} rec
 * @returns {boolean}
 */
function isSubagentRecord(rec) {
  return rec?._subagent === true || rec?.isSidechain === true;
}

/** `<command-name>/session-orchestrator:close</command-name>` → the name. */
function commandNames(text) {
  const out = [];
  const re = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Core 1 — locateSkillAnchors
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SkillAnchor
 * @property {'skill-call'|'slash-command'|'subagent-skill-call'} kind
 * @property {number} recordIndex — index into `records` of the invoking record
 * @property {boolean} errored — the matching `tool_result` carried `is_error: true`
 * @property {number|null} bodyRecordIndex — index of the following `isMeta` body record
 */

/**
 * @typedef {Object} SkillLocation
 * @property {boolean} found
 * @property {SkillAnchor[]} anchors
 * @property {number} invocations
 * @property {number|null} spanEndIndex — last record with `attributionSkill === skill`
 */

/**
 * Locate every invocation anchor of every requested skill. PURE — takes
 * records, returns indices; reads no file and renders no text.
 *
 * A record is treated as a subagent record when it carries `_subagent: true`
 * (stamped by `readTranscriptRecords`) or `isSidechain: true`.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {string[]} skills
 * @returns {Record<string, SkillLocation>} keyed by the REQUESTED skill spelling
 */
export function locateSkillAnchors(records, skills) {
  /** @type {Record<string, SkillLocation>} */
  const out = Object.create(null);
  const wanted = Array.isArray(skills)
    ? skills.filter((s) => typeof s === 'string' && s.trim())
    : [];
  for (const skill of wanted) {
    out[skill] = { found: false, anchors: [], invocations: 0, spanEndIndex: null };
  }
  if (!Array.isArray(records) || wanted.length === 0) return out;

  /** tool_use id → the anchor object awaiting its tool_result verdict. */
  const pendingByToolUseId = new Map();

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec || typeof rec !== 'object') continue;
    const isSubagent = isSubagentRecord(rec);

    for (const block of contentBlocks(rec)) {
      if (block?.type === 'tool_use' && block.name === 'Skill') {
        const called = block?.input?.skill;
        for (const skill of wanted) {
          if (!skillMatches(called, skill)) continue;
          /** @type {SkillAnchor} */
          const anchor = {
            kind: isSubagent ? 'subagent-skill-call' : 'skill-call',
            recordIndex: i,
            errored: false,
            bodyRecordIndex: null,
          };
          out[skill].anchors.push(anchor);
          if (typeof block.id === 'string') {
            const list = pendingByToolUseId.get(block.id) ?? [];
            list.push(anchor);
            pendingByToolUseId.set(block.id, list);
          }
        }
      } else if (block?.type === 'tool_result' && block.is_error === true) {
        const list = pendingByToolUseId.get(block.tool_use_id);
        if (list) for (const a of list) a.errored = true;
      }
    }

    // Slash-command form. The `<command-name>` marker lives in a plain-text
    // user record; the body follows as the next `isMeta` record, usually with
    // NO "Base directory for this skill:" header.
    const text = recordText(rec);
    if (text.includes('<command-name>')) {
      for (const name of commandNames(text)) {
        for (const skill of wanted) {
          if (!skillMatches(name, skill)) continue;
          out[skill].anchors.push({
            kind: 'slash-command',
            recordIndex: i,
            errored: false,
            bodyRecordIndex: null,
          });
        }
      }
    }

    // (f) attributionSkill — the END of the skill's section, never the anchor.
    if (typeof rec.attributionSkill === 'string') {
      for (const skill of wanted) {
        if (skillMatches(rec.attributionSkill, skill)) out[skill].spanEndIndex = i;
      }
    }
  }

  // Body record per anchor: the next `isMeta` record carrying text, header or not.
  for (const skill of wanted) {
    const loc = out[skill];
    for (const anchor of loc.anchors) {
      for (let k = anchor.recordIndex + 1; k <= anchor.recordIndex + BODY_LOOKAHEAD; k += 1) {
        const rec = records[k];
        if (!rec || typeof rec !== 'object') continue;
        if (rec.isMeta !== true) continue;
        if (!recordText(rec).trim()) continue;
        anchor.bodyRecordIndex = k;
        break;
      }
    }
    loc.invocations = loc.anchors.length;
    loc.found = loc.anchors.length > 0;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Core 2 — renderEvidence
// ---------------------------------------------------------------------------

/**
 * Render ONE record as a single evidence line. Thinking blocks are dropped
 * (they are the largest and the least evidential part of a transcript);
 * `tool_use` / `tool_result` payloads are clipped at `toolTextMax`; a skill
 * body collapses to `[skill body: <name>] <first heading>`.
 *
 * @param {Record<string, unknown>} rec
 * @param {number} index
 * @param {{toolTextMax: number, bodyOf?: string|null}} opts
 * @returns {string}
 */
function renderRecord(rec, index, { toolTextMax, bodyOf = null }) {
  const role = typeof rec?.type === 'string' ? rec.type : 'unknown';
  if (bodyOf) {
    return `#${index} ${role} [skill body: ${bodyOf}] ${firstHeading(recordText(rec))}`;
  }
  const parts = [];
  for (const block of contentBlocks(rec)) {
    const t = block?.type;
    if (t === 'thinking' || t === 'redacted_thinking') continue;
    if (t === 'text' && typeof block.text === 'string') {
      if (block.text.trim()) parts.push(clip(block.text.trim(), toolTextMax));
    } else if (t === 'tool_use') {
      let input;
      try {
        input = JSON.stringify(block.input ?? {});
      } catch {
        input = '(uninspectable input)';
      }
      parts.push(`[tool_use ${String(block.name ?? '?')}] ${clip(input, toolTextMax)}`);
    } else if (t === 'tool_result') {
      const payload =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
            : '';
      const flag = block.is_error === true ? ' is_error=true' : '';
      parts.push(`[tool_result${flag}] ${clip(payload, toolTextMax)}`);
    }
  }
  if (parts.length === 0) return '';
  return `#${index} ${role} ${parts.join(' | ')}`;
}

/** Merge overlapping/adjacent `{start,end}` windows. */
function mergeWindows(windows) {
  const sorted = windows
    .filter((w) => w && w.end >= w.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 1) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}

/**
 * Render ONE window backwards from its last record, so the budget is spent on
 * the records CLOSEST to the end. Used for the shared closing excerpt, whose
 * whole job is to show how the session finished: a forward fill spends the
 * budget on whatever tool spam happens to sit at the window's start and never
 * reaches the last record at all (observed with 12 clipped 1500-character
 * `tool_use` lines against a 3000-character closing budget).
 */
function renderWindowFromEnd(records, window, { toolTextMax, budget, bodyIndexes }) {
  const lines = [];
  let used = 0;
  let truncated = false;
  const start = Math.max(0, window.start);
  const end = Math.min(records.length - 1, window.end);
  for (let i = end; i >= start; i -= 1) {
    const line = renderRecord(records[i], i, { toolTextMax, bodyOf: bodyIndexes.get(i) ?? null });
    if (!line) continue;
    if (used + line.length + 1 > budget) {
      truncated = true;
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), truncated };
}

/** Render merged windows into elision-joined text, stopping at `budget`. */
function renderWindows(records, windows, { toolTextMax, budget, bodyIndexes }) {
  const chunks = [];
  let used = 0;
  let truncated = false;
  for (const w of windows) {
    const lines = [];
    for (let i = Math.max(0, w.start); i <= Math.min(records.length - 1, w.end); i += 1) {
      const line = renderRecord(records[i], i, {
        toolTextMax,
        bodyOf: bodyIndexes.get(i) ?? null,
      });
      if (!line) continue;
      if (used + line.length + 1 > budget) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length > 0) chunks.push(lines.join('\n'));
    if (truncated) break;
  }
  return { text: chunks.join(ELISION), truncated };
}

/**
 * @typedef {Object} EvidenceRender
 * @property {string} text
 * @property {number} chars
 * @property {boolean} truncated
 * @property {Array<{skill: string, found: boolean, invocations: number, chars: number, anchorIndexes: number[]}>} perSkill
 * @property {Array<{skill: string, reason: string}>} skipped
 */

/**
 * Render the evidence text from the located anchors. PURE — no filesystem.
 *
 * Budget split: the shared closing excerpt is paid ONCE, the rest is divided
 * evenly across the skills that were actually found. A skill that cannot get
 * `minPerSkillChars` is NOT silently squeezed — it is reported in `skipped`
 * with reason `budget-insufficient` and `truncated` is set, so the caller can
 * see that the judge is reasoning over a partial set.
 *
 * SOURCE SPLIT (#1412): once subagent transcripts are read in, the found set
 * carries two classes. Skills with at least one COORDINATOR anchor are
 * allotted first and from their own pool; SUBAGENT-ONLY skills share at most
 * `DEFAULT_SUBAGENT_POOL_SHARE` of the pool — unless there are no coordinator
 * skills at all, in which case they get all of it (the whole point of #1412 is
 * that a subagent-only skill must be judgeable). With no subagent-only skill
 * present the split is a no-op and the numbers are identical to before.
 *
 * `mainRecordCount` bounds the shared closing excerpt to the MAIN transcript.
 * Subagent records are CONCATENATED after it, so without the bound the section
 * headed "session closing" renders the tail of the last subagent file instead
 * — mislabelled evidence, which is worse for a judge than none.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {Record<string, SkillLocation>} located
 * @param {{budgetChars?: number, closingChars?: number, minPerSkillChars?: number, toolTextMax?: number, subagentPoolShare?: number, mainRecordCount?: number}} [opts]
 * @returns {EvidenceRender}
 */
export function renderEvidence(records, located, opts = {}) {
  const budgetChars = Number.isFinite(opts.budgetChars) ? opts.budgetChars : DEFAULT_BUDGET_CHARS;
  const closingChars = Number.isFinite(opts.closingChars)
    ? opts.closingChars
    : DEFAULT_CLOSING_CHARS;
  const minPerSkillChars = Number.isFinite(opts.minPerSkillChars)
    ? opts.minPerSkillChars
    : DEFAULT_MIN_PER_SKILL_CHARS;
  const toolTextMax = Number.isFinite(opts.toolTextMax) ? opts.toolTextMax : DEFAULT_TOOL_TEXT_MAX;
  const subagentPoolShare = Number.isFinite(opts.subagentPoolShare)
    ? Math.min(1, Math.max(0, opts.subagentPoolShare))
    : DEFAULT_SUBAGENT_POOL_SHARE;

  const recs = Array.isArray(records) ? records : [];
  const mainRecordCount = Number.isFinite(opts.mainRecordCount)
    ? Math.min(recs.length, Math.max(0, opts.mainRecordCount))
    : recs.length;
  const loc = located && typeof located === 'object' ? located : {};
  const skills = Object.keys(loc);

  /** @type {Array<{skill: string, reason: string}>} */
  const skipped = [];
  const foundSkills = [];
  for (const skill of skills) {
    if (loc[skill]?.found) foundSkills.push(skill);
    else skipped.push({ skill, reason: 'not-found' });
  }

  // Body-record index → the skill whose body it is (for the collapsed render).
  const bodyIndexes = new Map();
  for (const skill of foundSkills) {
    for (const a of loc[skill].anchors) {
      if (typeof a.bodyRecordIndex === 'number') bodyIndexes.set(a.bodyRecordIndex, skill);
    }
  }

  const closingBudget = recs.length > 0 ? Math.max(0, Math.min(closingChars, budgetChars)) : 0;
  const perSkillPool = Math.max(0, budgetChars - closingBudget);

  // Source split — coordinator-anchored skills first, subagent-only after.
  const coordinatorSkills = [];
  const subagentOnlySkills = [];
  for (const skill of foundSkills) {
    const anchors = loc[skill].anchors;
    if (anchors.some((a) => !isSubagentRecord(recs[a.recordIndex]))) coordinatorSkills.push(skill);
    else subagentOnlySkills.push(skill);
  }
  let subagentPool = 0;
  if (subagentOnlySkills.length > 0) {
    subagentPool =
      coordinatorSkills.length === 0
        ? perSkillPool
        : Math.floor(perSkillPool * subagentPoolShare);
  }
  const coordinatorPool = perSkillPool - subagentPool;

  let truncated = false;
  /** Allot `pool` over `list`; overflow past the floor is reported, never squeezed. */
  const allot = (list, pool) => {
    const capacity = minPerSkillChars > 0 ? Math.floor(pool / minPerSkillChars) : list.length;
    const take = Math.max(0, capacity);
    for (const skill of list.slice(take)) {
      skipped.push({ skill, reason: 'budget-insufficient' });
      truncated = true;
    }
    const kept = list.slice(0, take);
    const budget = kept.length > 0 ? Math.floor(pool / kept.length) : 0;
    return kept.map((skill) => ({ skill, budget }));
  };
  const rendered = [
    ...allot(coordinatorSkills, coordinatorPool),
    ...allot(subagentOnlySkills, subagentPool),
  ];

  const sections = [];
  /** @type {EvidenceRender['perSkill']} */
  const perSkill = [];

  for (const { skill, budget: perSkillBudget } of rendered) {
    const info = loc[skill];
    const anchors = info.anchors;
    const picks = [anchors[0], anchors[anchors.length - 1]].filter(Boolean);
    const windows = picks.map((a) => ({
      start: a.recordIndex - CONTEXT_BEFORE,
      end: Math.max(a.recordIndex + CONTEXT_AFTER, a.bodyRecordIndex ?? -1),
    }));
    if (typeof info.spanEndIndex === 'number') {
      windows.push({ start: info.spanEndIndex - CONTEXT_BEFORE, end: info.spanEndIndex });
    }
    const body = renderWindows(recs, mergeWindows(windows), {
      toolTextMax,
      budget: perSkillBudget,
      bodyIndexes,
    });
    if (body.truncated) truncated = true;
    const errored = anchors.some((a) => a.errored);
    const header =
      `### ${skill} — ${info.invocations} invocation(s), kinds: ` +
      `${[...new Set(anchors.map((a) => a.kind))].join(', ')}` +
      `${errored ? ', at least one call errored' : ''}`;
    sections.push(`${header}\n${body.text}`);
    perSkill.push({
      skill,
      found: true,
      invocations: info.invocations,
      chars: body.text.length,
      anchorIndexes: anchors.map((a) => a.recordIndex),
    });
  }

  for (const entry of skipped) {
    perSkill.push({
      skill: entry.skill,
      found: loc[entry.skill]?.found === true,
      invocations: loc[entry.skill]?.invocations ?? 0,
      chars: 0,
      anchorIndexes: (loc[entry.skill]?.anchors ?? []).map((a) => a.recordIndex),
    });
  }

  // The shared closing is EVIDENCE FOR a judged skill ("did its work complete?"),
  // never evidence on its own. With no skill rendered there is nothing to attach
  // it to, and emitting it alone would hand the judge a non-empty fence that
  // contains no invocation — the #1399 defect in a new costume.
  if (closingBudget > 0 && rendered.length > 0 && mainRecordCount > 0) {
    const closing = renderWindowFromEnd(
      recs,
      { start: Math.max(0, mainRecordCount - CLOSING_RECORDS), end: mainRecordCount - 1 },
      { toolTextMax, budget: closingBudget, bodyIndexes },
    );
    if (closing.truncated) truncated = true;
    if (closing.text) sections.push(`### session closing\n${closing.text}`);
  }

  const text = sections.length > 0 ? `## Skill evidence (excerpts)\n\n${sections.join('\n\n')}` : '';
  return { text, chars: text.length, truncated, perSkill, skipped };
}

// ---------------------------------------------------------------------------
// IO layer
// ---------------------------------------------------------------------------

/**
 * Encode a repo path the way Claude Code names its projects directory: every
 * `/` and `.` becomes `-`. Same encoding as
 * `scripts/lib/wave-transcript-tail.mjs::encodeProjectDir`, duplicated here
 * rather than imported so this module stays free of that tailer's `events.mjs`
 * / file-lock / subagent-paths closure.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function encodeProjectDir(repoRoot) {
  return String(repoRoot).replace(/[/.]/g, '-');
}

/**
 * Resolve the RAW harness session id (the UUID that names the transcript file).
 *
 * Deliberately WITHOUT the newest-by-mtime tier that
 * `wave-transcript-tail.mjs::resolveSessionId` carries: in a shared working
 * copy the newest transcript directory can belong to a PEER session, and
 * judging this session's skills against a peer's transcript is worse than
 * judging nothing (`.claude/rules/identity-and-locks.md` — rank witnesses,
 * never fall back onto a peer's artefact). No id resolves → the caller reports
 * `no-transcript`.
 *
 * @param {{repoRoot?: string, env?: Record<string, string|undefined>}} [opts]
 * @returns {{sessionId: string, source: 'env'|'session.lock'} | null}
 */
export function resolveRawSessionId({ repoRoot, env = process.env } = {}) {
  const fromEnv = typeof env.CLAUDE_CODE_SESSION_ID === 'string'
    ? env.CLAUDE_CODE_SESSION_ID.trim()
    : '';
  if (fromEnv) return { sessionId: fromEnv, source: 'env' };
  if (!repoRoot) return null;
  let lock;
  try {
    lock = readLock({ repoRoot });
  } catch {
    return null;
  }
  if (!lock || !isLockLive(lock)) return null;
  const fromLock = typeof lock.session_id === 'string' ? lock.session_id.trim() : '';
  return fromLock ? { sessionId: fromLock, source: 'session.lock' } : null;
}

/**
 * Stream-read a transcript JSONL.
 *
 * `malformed_lines` is part of the RETURN VALUE, not a silent skip: a
 * half-written line turns a partial result into a clean-looking verdict, which
 * is precisely the failure the judge exists to notice
 * (`.claude/rules/measurement-discipline.md` — "Ein still ueberspringender
 * JSONL-Parser macht aus einem Teilergebnis ein sauberes Verdikt").
 *
 * Text blocks are clipped at `maxBlockChars` AT READ TIME — see
 * `DEFAULT_MAX_BLOCK_CHARS` for the ceiling and its revisit trigger.
 *
 * @param {string} path
 * @param {{maxBlockChars?: number, subagent?: boolean}} [opts]
 * @returns {Promise<{records: Array<Record<string, unknown>>, malformed_lines: number, bytes: number}>}
 */
export async function readTranscriptRecords(path, opts = {}) {
  const maxBlockChars = Number.isFinite(opts.maxBlockChars)
    ? opts.maxBlockChars
    : DEFAULT_MAX_BLOCK_CHARS;
  const records = [];
  let malformedLines = 0;
  let bytes;
  if (typeof path !== 'string' || !path || !existsSync(path)) {
    return { records, malformed_lines: 0, bytes: 0 };
  }
  try {
    bytes = statSync(path).size;
  } catch {
    bytes = 0;
  }

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      malformedLines += 1;
      continue;
    }
    const content = rec?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block.text === 'string' && block.text.length > maxBlockChars) {
          block.text = clip(block.text, maxBlockChars);
        }
      }
    }
    if (opts.subagent === true) rec._subagent = true;
    records.push(rec);
  }
  return { records, malformed_lines: malformedLines, bytes };
}

/**
 * @typedef {Object} SkillEvidence
 * @property {'ok'|'no-transcript'|'no-evidence'} status
 * @property {{path: string|null, bytes: number, records: number, malformed_lines: number}} source
 * @property {EvidenceRender['perSkill']} perSkill
 * @property {Array<{skill: string, reason: string}>} skipped
 * @property {string} text
 * @property {number} chars
 * @property {boolean} truncated
 */

/**
 * Build the judge's evidence window for `skills` from this session's transcript.
 *
 * `transcriptPath` and `projectsDir` are dependency-injection parameters —
 * pass them in tests; in production omit both and the path resolves to
 * `~/.claude/projects/<encodeProjectDir(repoRoot)>/<sessionId>.jsonl`.
 *
 * NEVER throws: every failure degrades to a status the caller can log.
 *
 * @param {object} opts
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.sessionId] — the RAW harness UUID, not the semantic id
 * @param {string[]} [opts.skills]
 * @param {number} [opts.budgetChars]
 * @param {string} [opts.transcriptPath] — DI: read exactly this file
 * @param {string} [opts.projectsDir] — DI: `<projects>/<encoded-repo>` directory
 * @param {boolean} [opts.includeSubagents=false]
 * @param {Record<string, string|undefined>} [opts.env]
 * @returns {Promise<SkillEvidence>}
 */
export async function buildSkillEvidence({
  repoRoot,
  sessionId,
  skills = [],
  budgetChars = DEFAULT_BUDGET_CHARS,
  transcriptPath,
  projectsDir,
  includeSubagents = false,
  env = process.env,
} = {}) {
  const empty = (status, path = null, extra = {}) => ({
    status,
    source: { path, bytes: 0, records: 0, malformed_lines: 0, ...extra },
    perSkill: [],
    skipped: (Array.isArray(skills) ? skills : [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((skill) => ({ skill, reason: status })),
    text: '',
    chars: 0,
    truncated: false,
  });

  const wanted = Array.isArray(skills) ? skills.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (wanted.length === 0) return empty('no-evidence');

  const rawId =
    typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : resolveRawSessionId({ repoRoot, env })?.sessionId ?? '';

  const baseDir =
    projectsDir ||
    (repoRoot ? join(homedir(), '.claude', 'projects', encodeProjectDir(repoRoot)) : '');
  const path = transcriptPath || (rawId && baseDir ? join(baseDir, `${rawId}.jsonl`) : '');
  if (!path || !existsSync(path)) return empty('no-transcript', path || null);

  let main;
  try {
    main = await readTranscriptRecords(path);
  } catch {
    return empty('no-transcript', path);
  }
  const records = main.records;
  // Captured BEFORE the subagent records are concatenated — it is the boundary
  // `renderEvidence` needs to keep the "session closing" excerpt on the MAIN
  // transcript instead of on the last subagent file.
  const mainRecordCount = records.length;
  let malformed = main.malformed_lines;
  let bytes = main.bytes;

  if (includeSubagents && rawId && baseDir) {
    const subDir = join(baseDir, rawId, 'subagents');
    let entries;
    try {
      entries = existsSync(subDir)
        ? readdirSync(subDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
        : [];
    } catch {
      entries = [];
    }
    for (const entry of entries.sort()) {
      try {
        const sub = await readTranscriptRecords(join(subDir, entry), { subagent: true });
        records.push(...sub.records);
        malformed += sub.malformed_lines;
        bytes += sub.bytes;
      } catch {
        // An unreadable subagent file removes evidence, never correctness.
      }
    }
  }

  const source = { path, bytes, records: records.length, malformed_lines: malformed };
  const located = locateSkillAnchors(records, wanted);
  const render = renderEvidence(records, located, { budgetChars, mainRecordCount });

  if (!render.text) {
    return {
      status: 'no-evidence',
      source,
      perSkill: render.perSkill,
      skipped: render.skipped,
      text: '',
      chars: 0,
      truncated: render.truncated,
    };
  }

  return {
    status: 'ok',
    source,
    perSkill: render.perSkill,
    skipped: render.skipped,
    text: render.text,
    chars: render.chars,
    truncated: render.truncated,
  };
}
