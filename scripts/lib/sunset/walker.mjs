#!/usr/bin/env node
/**
 * walker.mjs — Sunset-review surface walker (issue #444).
 *
 * READ-ONLY analysis of the plugin's skill/agent/command surface. Combines
 * agent-dispatch telemetry (subagents.jsonl) with static reference scanning to
 * classify each surface item into a 4-tier verdict:
 *
 *   Active     — clearly in use (dispatch, command-linkage, or prose refs)
 *   Investigate — default-safe; conflicting signals OR low telemetry confidence
 *   Demote     — near-zero use (single dispatch, single cross-ref)
 *   Retire     — provably cold (zero dispatch AND zero non-boilerplate refs)
 *
 * IMPORTANT GUARDRAIL (Discovery, grep-verified):
 *   Telemetry only spans ~18 days, but the default window is 90. When
 *   coverageDays < windowDays, EVERY Retire verdict is downgraded to
 *   Investigate and meta.lowConfidence is set. Retiring on <window data is
 *   unsafe.
 *
 * Telemetry facts the walker is built to respect:
 *   - subagents.jsonl agent_type is reliable ONLY on event==="start"; all nulls
 *     are on "stop" events. The walker counts START events only.
 *   - Skill-invocation telemetry NOW EXISTS in skill-invocations.jsonl (L1
 *     telemetry, epic #645). Skills are assessed by real selection counts from
 *     that file. Static reference scanning remains a SUPPLEMENTARY signal.
 *   - NO command-invocation telemetry exists. Commands are assessed via static
 *     reference scanning only.
 *
 * This module is pure-ish and side-effect free: it reads files but writes
 * none, holds no mutable runtime state, and exposes no concurrency surface.
 * The consuming SKILL writes the last-run timestamp — NOT the walker.
 *
 * JSON-first CLI per .claude/rules/cli-design.md:
 *   node scripts/lib/sunset/walker.mjs [--json] [--window-days N] [--kind K]
 *   exit 0 = walk done (cold findings are exit 0, NOT an error)
 *   exit 1 = bad args / surface dir missing
 *   exit 2 = system error
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeSkillInvocation } from '../skill-invocations-schema.mjs';
import { normalizeSkillJudgment } from '../skill-judgments-schema.mjs';

// ---------------------------------------------------------------------------
// Named threshold constants
// ---------------------------------------------------------------------------

/** Default sunset-review window in days. */
export const DEFAULT_WINDOW_DAYS = 90;

/** Agent dispatch count strictly greater than this floor ⇒ Active. */
export const ACTIVE_DISPATCH_FLOOR = 1;

/** Agent dispatch count in (0, this ceiling] ⇒ Demote (near-zero). */
export const DEMOTE_DISPATCH_CEILING = 1;

/** Non-boilerplate prose/strict refs at or above this floor ⇒ Active. */
export const ACTIVE_REF_FLOOR = 2;

/** Default agent-type prefix stripped from telemetry. */
const AGENT_TYPE_PREFIX = 'session-orchestrator:';

/** Surface directories excluded from enumeration. */
const EXCLUDED_SKILL_DIRS = new Set(['_shared']);
const EXCLUDED_AGENT_FILES = new Set(['AGENTS.md']);

/** Directories scanned for static references. */
const SCAN_DIRS = ['skills', 'agents', 'commands', 'hooks', 'scripts'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Surface enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate the plugin's skill/agent/command surface.
 * Excludes `skills/_shared` (shared helpers, not a skill) and
 * `agents/AGENTS.md` (authoring spec, not an agent).
 *
 * @param {string} repoRoot
 * @returns {{skills: string[], agents: string[], commands: string[]}}
 */
export function enumerateSurface(repoRoot) {
  const skills = [];
  const skillsDir = path.join(repoRoot, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (EXCLUDED_SKILL_DIRS.has(entry.name)) continue;
      // A skill dir must contain a SKILL.md to count as a skill.
      if (existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
        skills.push(entry.name);
      }
    }
  }

  const agents = [];
  const agentsDir = path.join(repoRoot, 'agents');
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (EXCLUDED_AGENT_FILES.has(entry.name)) continue;
      agents.push(entry.name.replace(/\.md$/, ''));
    }
  }

  const commands = [];
  const commandsDir = path.join(repoRoot, 'commands');
  if (existsSync(commandsDir)) {
    for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      commands.push(entry.name.replace(/\.md$/, ''));
    }
  }

  return {
    skills: skills.sort(),
    agents: agents.sort(),
    commands: commands.sort(),
  };
}

// ---------------------------------------------------------------------------
// Dispatch telemetry
// ---------------------------------------------------------------------------

/**
 * Read agent-dispatch counts from subagents.jsonl.
 *
 * Only `event === "start"` records are counted — `agent_type` is null on
 * "stop" events, so a stop event must never mark an agent cold.
 *
 * @param {string} subagentsJsonlPath
 * @param {{windowDays: number, now?: number}} opts
 * @returns {{
 *   byAgent: Map<string,{count:number,lastTs:string|null}>,
 *   earliestTs: string|null,
 *   latestTs: string|null,
 *   coverageDays: number
 * }}
 */
export function readDispatchCounts(subagentsJsonlPath, { windowDays, now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const windowStartMs = nowMs - (windowDays ?? DEFAULT_WINDOW_DAYS) * MS_PER_DAY;

  /** @type {Map<string,{count:number,lastTs:string|null}>} */
  const byAgent = new Map();
  let earliestMs = null;
  let latestMs = null;

  if (!existsSync(subagentsJsonlPath)) {
    return { byAgent, earliestTs: null, latestTs: null, coverageDays: 0 };
  }

  let raw;
  try {
    raw = readFileSync(subagentsJsonlPath, 'utf8');
  } catch {
    return { byAgent, earliestTs: null, latestTs: null, coverageDays: 0 };
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      // Malformed line — skip, never throw.
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.event !== 'start') continue;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    const tsMs = ts ? Date.parse(ts) : NaN;

    // Track coverage envelope from ALL start events (regardless of window).
    if (!Number.isNaN(tsMs)) {
      if (earliestMs === null || tsMs < earliestMs) earliestMs = tsMs;
      if (latestMs === null || tsMs > latestMs) latestMs = tsMs;
    }

    const rawType = typeof rec.agent_type === 'string' ? rec.agent_type : null;
    if (!rawType) continue;
    const name = rawType.startsWith(AGENT_TYPE_PREFIX)
      ? rawType.slice(AGENT_TYPE_PREFIX.length)
      : rawType;

    // Only count dispatches inside the window for the per-agent tally.
    if (!Number.isNaN(tsMs) && tsMs < windowStartMs) continue;

    const cur = byAgent.get(name) ?? { count: 0, lastTs: null };
    cur.count += 1;
    if (ts && (cur.lastTs === null || Date.parse(ts) > Date.parse(cur.lastTs))) {
      cur.lastTs = ts;
    }
    byAgent.set(name, cur);
  }

  const coverageDays =
    earliestMs === null ? 0 : Math.max(0, (nowMs - earliestMs) / MS_PER_DAY);

  return {
    byAgent,
    earliestTs: earliestMs === null ? null : new Date(earliestMs).toISOString(),
    latestTs: latestMs === null ? null : new Date(latestMs).toISOString(),
    coverageDays,
  };
}

// ---------------------------------------------------------------------------
// Skill-invocation telemetry (L1, epic #645)
// ---------------------------------------------------------------------------

/**
 * Read skill-selection counts from skill-invocations.jsonl.
 *
 * Mirrors `readDispatchCounts` style: synchronous, window-aware, never throws.
 * Counts only `event === "selected"` records inside the window.
 *
 * Uses `normalizeSkillInvocation` from skill-invocations-schema.mjs for
 * consistent field defaulting, keeping parity with the async reader the schema
 * module also provides.
 *
 * @param {string} invocationsPath
 * @param {{windowDays: number, now?: number}} opts
 * @returns {{
 *   bySkill: Map<string,{count:number,lastTs:string|null}>,
 *   earliestTs: string|null,
 *   latestTs: string|null,
 *   coverageDays: number
 * }}
 */
export function readSkillInvocationCounts(invocationsPath, { windowDays, now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const windowStartMs = nowMs - (windowDays ?? DEFAULT_WINDOW_DAYS) * MS_PER_DAY;

  /** @type {Map<string,{count:number,lastTs:string|null}>} */
  const bySkill = new Map();
  let earliestMs = null;
  let latestMs = null;

  if (!existsSync(invocationsPath)) {
    return { bySkill, earliestTs: null, latestTs: null, coverageDays: 0 };
  }

  let raw;
  try {
    raw = readFileSync(invocationsPath, 'utf8');
  } catch {
    return { bySkill, earliestTs: null, latestTs: null, coverageDays: 0 };
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec;
    try {
      rec = normalizeSkillInvocation(JSON.parse(trimmed));
    } catch {
      // Malformed line — skip, never throw.
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.event !== 'selected') continue;

    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    const tsMs = ts ? Date.parse(ts) : NaN;

    // Track coverage envelope from ALL selected events (regardless of window).
    if (!Number.isNaN(tsMs)) {
      if (earliestMs === null || tsMs < earliestMs) earliestMs = tsMs;
      if (latestMs === null || tsMs > latestMs) latestMs = tsMs;
    }

    const skillName = typeof rec.skill === 'string' && rec.skill.trim() ? rec.skill.trim() : null;
    if (!skillName) continue;

    // Only count invocations inside the window for the per-skill tally.
    if (!Number.isNaN(tsMs) && tsMs < windowStartMs) continue;

    const cur = bySkill.get(skillName) ?? { count: 0, lastTs: null };
    cur.count += 1;
    if (ts && (cur.lastTs === null || Date.parse(ts) > Date.parse(cur.lastTs))) {
      cur.lastTs = ts;
    }
    bySkill.set(skillName, cur);
  }

  const coverageDays =
    earliestMs === null ? 0 : Math.max(0, (nowMs - earliestMs) / MS_PER_DAY);

  return {
    bySkill,
    earliestTs: earliestMs === null ? null : new Date(earliestMs).toISOString(),
    latestTs: latestMs === null ? null : new Date(latestMs).toISOString(),
    coverageDays,
  };
}

// ---------------------------------------------------------------------------
// Skill-judgment telemetry (L3, epic #645 — ADVISORY ONLY)
// ---------------------------------------------------------------------------

/**
 * Read skill-applied JUDGMENT counts from skill-judgments.jsonl (L3).
 *
 * Mirrors `readSkillInvocationCounts` style: synchronous, window-aware, never
 * throws, existsSync-guarded. Counts only `event === "judged"` records inside
 * the window and aggregates the tri-state applied/completed tallies per skill.
 *
 * Uses `normalizeSkillJudgment` from skill-judgments-schema.mjs for consistent
 * field defaulting (advisory:true, session_id:null, schema_version).
 *
 * IMPORTANT (firewall): the data returned here is ADVISORY ONLY. The walker
 * uses it to ANNOTATE a diagnosis or DOWNGRADE a verdict — never to escalate a
 * skill toward Retire (see classifyItem #645 R9 advisory-only).
 *
 * @param {string} judgmentsPath
 * @param {{windowDays: number, now?: number}} opts
 * @returns {{
 *   bySkill: Map<string,{
 *     appliedYes:number, appliedNo:number, appliedUnknown:number,
 *     completedYes:number, completedNo:number, completedUnknown:number,
 *     total:number, lastTs:string|null
 *   }>,
 *   earliestTs: string|null,
 *   latestTs: string|null,
 *   coverageDays: number
 * }}
 */
export function readSkillJudgmentCounts(judgmentsPath, { windowDays, now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const windowStartMs = nowMs - (windowDays ?? DEFAULT_WINDOW_DAYS) * MS_PER_DAY;

  /** @type {Map<string,{
   *   appliedYes:number, appliedNo:number, appliedUnknown:number,
   *   completedYes:number, completedNo:number, completedUnknown:number,
   *   total:number, lastTs:string|null
   * }>} */
  const bySkill = new Map();
  let earliestMs = null;
  let latestMs = null;

  if (!existsSync(judgmentsPath)) {
    return { bySkill, earliestTs: null, latestTs: null, coverageDays: 0 };
  }

  let raw;
  try {
    raw = readFileSync(judgmentsPath, 'utf8');
  } catch {
    return { bySkill, earliestTs: null, latestTs: null, coverageDays: 0 };
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec;
    try {
      rec = normalizeSkillJudgment(JSON.parse(trimmed));
    } catch {
      // Malformed line — skip, never throw.
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.event !== 'judged') continue;

    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    const tsMs = ts ? Date.parse(ts) : NaN;

    // Track coverage envelope from ALL judged events (regardless of window).
    if (!Number.isNaN(tsMs)) {
      if (earliestMs === null || tsMs < earliestMs) earliestMs = tsMs;
      if (latestMs === null || tsMs > latestMs) latestMs = tsMs;
    }

    const skillName = typeof rec.skill === 'string' && rec.skill.trim() ? rec.skill.trim() : null;
    if (!skillName) continue;

    // Only count judgments inside the window for the per-skill tally.
    if (!Number.isNaN(tsMs) && tsMs < windowStartMs) continue;

    const cur = bySkill.get(skillName) ?? {
      appliedYes: 0,
      appliedNo: 0,
      appliedUnknown: 0,
      completedYes: 0,
      completedNo: 0,
      completedUnknown: 0,
      total: 0,
      lastTs: null,
    };
    cur.total += 1;
    if (rec.applied === 'yes') cur.appliedYes += 1;
    else if (rec.applied === 'no') cur.appliedNo += 1;
    else cur.appliedUnknown += 1;
    if (rec.completed === 'yes') cur.completedYes += 1;
    else if (rec.completed === 'no') cur.completedNo += 1;
    else cur.completedUnknown += 1;
    if (ts && (cur.lastTs === null || Date.parse(ts) > Date.parse(cur.lastTs))) {
      cur.lastTs = ts;
    }
    bySkill.set(skillName, cur);
  }

  const coverageDays =
    earliestMs === null ? 0 : Math.max(0, (nowMs - earliestMs) / MS_PER_DAY);

  return {
    bySkill,
    earliestTs: earliestMs === null ? null : new Date(earliestMs).toISOString(),
    latestTs: latestMs === null ? null : new Date(latestMs).toISOString(),
    coverageDays,
  };
}

// ---------------------------------------------------------------------------
// Static reference scanning
// ---------------------------------------------------------------------------

/**
 * Recursively collect file paths under a directory (skipping node_modules and
 * dot-directories). Returns absolute paths.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        if (entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Determine whether a file path is a boilerplate (self-definition or
 * authoring/registry) site for a given surface item, and therefore must be
 * excluded from the "is anyone else using this?" reference count.
 *
 * @param {string} relPath - repo-root-relative POSIX path
 * @param {'skill'|'agent'|'command'} kind
 * @param {string} name
 * @returns {boolean}
 */
function isBoilerplateSite(relPath, kind, name) {
  if (kind === 'agent') {
    if (relPath === `agents/${name}.md`) return true;
    if (relPath === 'agents/AGENTS.md') return true;
    if (relPath === `agents/schemas/${name}.schema.json`) return true;
    // Routing-table / validator boilerplate.
    if (relPath === 'agents/schemas/routing-table.json') return true;
    // The dead-bridge validator (subsumed check-subagent-types per #671) carries
    // agent names in its corpus/detector fixtures — exempt it as a validator site.
    if (relPath.startsWith('scripts/lib/validate/dead-bridge')) return true;
    if (relPath.startsWith('scripts/lib/validate/check-dead-bridge')) return true;
    if (relPath.startsWith('scripts/lib/validate/check-agents')) return true;
    return false;
  }
  if (kind === 'skill') {
    // The skill's own directory is boilerplate.
    if (relPath.startsWith(`skills/${name}/`)) return true;
    // README index / top-level docs index entries are boilerplate.
    if (relPath === 'README.md') return true;
    return false;
  }
  // command
  if (relPath === `commands/${name}.md`) return true;
  if (relPath === 'README.md') return true;
  return false;
}

/**
 * Build the strict-token and prose-invocation matchers for a surface item.
 * Bare-word matching is deliberately NOT used (too noisy per Discovery: e.g.
 * "daily" yields 0 strict refs but 16 name-anywhere refs).
 *
 * @param {'skill'|'agent'|'command'} kind
 * @param {string} name
 * @returns {{strict: RegExp[], prose: RegExp[]}}
 */
function buildMatchers(kind, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (kind === 'agent') {
    return {
      strict: [
        new RegExp(`session-orchestrator:${esc}\\b`),
        new RegExp(`subagent_type[^\\n]*["']${esc}["']`),
      ],
      prose: [
        new RegExp(`\\bdispatch(?:es|ed|ing)?\\b[^\\n]*\\b${esc}\\b`, 'i'),
        new RegExp(`\\b${esc}\\b[^\\n]*\\bagent\\b`, 'i'),
      ],
    };
  }
  if (kind === 'skill') {
    return {
      strict: [
        new RegExp(`skills/${esc}/`),
        new RegExp(`session-orchestrator:${esc}\\b`),
      ],
      prose: [
        new RegExp(`\\b[Ii]nvoke[^\\n]*\\b${esc}\\b[^\\n]*\\bskill\\b`),
        new RegExp(`\\b${esc}\\b[^\\n]*\\bskill\\b`, 'i'),
      ],
    };
  }
  // command
  return {
    strict: [new RegExp(`/${esc}\\b`)],
    prose: [new RegExp(`\\b${esc}\\b[^\\n]*\\bcommand\\b`, 'i')],
  };
}

/**
 * Scan skills/agents/commands/hooks/scripts for references to a surface item,
 * excluding boilerplate (self-definition + authoring/registry) sites.
 *
 * @param {string} repoRoot
 * @param {{kind:'skill'|'agent'|'command', name:string}} opts
 * @returns {{strictRefs:number, proseRefs:number, nonBoilerplateRefs:number, refFiles:string[]}}
 */
export function staticReferenceScan(repoRoot, { kind, name }) {
  const { strict, prose } = buildMatchers(kind, name);
  let strictRefs = 0;
  let proseRefs = 0;
  /** @type {Set<string>} */
  const refFiles = new Set();

  for (const dir of SCAN_DIRS) {
    const absDir = path.join(repoRoot, dir);
    for (const file of collectFiles(absDir)) {
      const relPath = path.relative(repoRoot, file).split(path.sep).join('/');
      if (isBoilerplateSite(relPath, kind, name)) continue;
      let content;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      let hit = false;
      for (const re of strict) {
        if (re.test(content)) {
          strictRefs += 1;
          hit = true;
        }
      }
      for (const re of prose) {
        if (re.test(content)) {
          proseRefs += 1;
          hit = true;
        }
      }
      if (hit) refFiles.add(relPath);
    }
  }

  return {
    strictRefs,
    proseRefs,
    nonBoilerplateRefs: refFiles.size,
    refFiles: [...refFiles].sort(),
  };
}

// ---------------------------------------------------------------------------
// Command ↔ skill linkage
// ---------------------------------------------------------------------------

/**
 * Parse commands/*.md for the skill each command invokes. Recognises the
 * conventional `skills/<name>/SKILL.md` reference inside a command file.
 *
 * @param {string} repoRoot
 * @returns {{commandToSkill: Map<string,string|null>, skillToCommands: Map<string,string[]>}}
 */
export function commandSkillLinkage(repoRoot) {
  /** @type {Map<string,string|null>} */
  const commandToSkill = new Map();
  /** @type {Map<string,string[]>} */
  const skillToCommands = new Map();

  const commandsDir = path.join(repoRoot, 'commands');
  if (!existsSync(commandsDir)) {
    return { commandToSkill, skillToCommands };
  }

  const skillRefRe = /skills\/([a-z0-9-]+)\/SKILL\.md/i;
  for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const command = entry.name.replace(/\.md$/, '');
    let content;
    try {
      content = readFileSync(path.join(commandsDir, entry.name), 'utf8');
    } catch {
      commandToSkill.set(command, null);
      continue;
    }
    const m = skillRefRe.exec(content);
    const skill = m ? m[1] : null;
    commandToSkill.set(command, skill);
    if (skill) {
      const list = skillToCommands.get(skill) ?? [];
      list.push(command);
      skillToCommands.set(skill, list);
    }
  }

  return { commandToSkill, skillToCommands };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Strong-applied-no threshold: a skill selected but judged applied=no for at
 * least this many judgments (and no applied=yes) is a strong "selected but not
 * applied" advisory signal — enough to DOWNGRADE Active → Investigate.
 */
const STRONG_APPLIED_NO_FLOOR = 2;

/**
 * Apply the L3 judge advisory layer to an already-computed deterministic
 * verdict. ADVISORY ONLY (#645 R9):
 *   - ANNOTATE: append a diagnosis axis derived from applied/completed tallies.
 *   - DOWNGRADE: Active → Investigate on a STRONG applied=no signal.
 *   - It MUST NEVER escalate a verdict toward Retire/Demote, and MUST NEVER
 *     promote a verdict upward (no Retire→Active). Judge data only softens.
 *
 * Clean-degrade contract: when `judge` is null/absent OR carries no judgments,
 * the result is returned byte-for-byte unchanged.
 *
 * @param {{name:string,kind:string,verdict:string,score:number,reasons:string[],signals:object}} result
 *   the deterministic verdict (mutated in place: reasons/signals only)
 * @param {{appliedYes:number,appliedNo:number,appliedUnknown:number,completedYes:number,completedNo:number,completedUnknown:number,total:number,lastTs:string|null}|null} judge
 * @returns {{name:string,kind:string,verdict:string,score:number,reasons:string[],signals:object}}
 */
function applyJudgeAdvisory(result, judge) {
  // Disabled-path guarantee: null judge, or judge with zero recorded judgments,
  // leaves the deterministic result completely untouched.
  if (!judge || typeof judge !== 'object' || (judge.total ?? 0) <= 0) {
    return result;
  }

  const appliedYes = judge.appliedYes ?? 0;
  const appliedNo = judge.appliedNo ?? 0;
  const completedNo = judge.completedNo ?? 0;
  const total = judge.total ?? 0;

  // Surface the raw judge tallies on signals for downstream consumers (always
  // advisory — never read by the deterministic verdict gate above).
  result.signals.judge = {
    appliedYes,
    appliedNo,
    appliedUnknown: judge.appliedUnknown ?? 0,
    completedYes: judge.completedYes ?? 0,
    completedNo,
    completedUnknown: judge.completedUnknown ?? 0,
    total,
    lastTs: judge.lastTs ?? null,
  };

  // Annotation axis 1: selected but applied=no → trigger description may be unclear.
  const strongAppliedNo = appliedNo >= STRONG_APPLIED_NO_FLOOR && appliedYes === 0;
  if (appliedNo > 0) {
    result.reasons.push(
      `[advisory] judged applied=no in ${appliedNo}/${total} judgment(s)` +
        (appliedYes === 0
          ? ' (selected but never applied → trigger description may be unclear)'
          : ''),
    );
  }

  // Annotation axis 2: applied but completed=no → instructions may be wrong.
  if (appliedYes > 0 && completedNo > 0) {
    result.reasons.push(
      `[advisory] judged applied=yes but completed=no in ${completedNo}/${total} judgment(s) (instructions may be wrong)`,
    );
  }

  // DOWNGRADE (never escalate): a strong "selected but not applied" signal
  // softens an Active verdict to Investigate so an operator reviews the trigger.
  // Firewall: we ONLY move Active → Investigate. We never touch Demote/Retire
  // (those are deterministic-cold), and we never promote upward.
  if (strongAppliedNo && result.verdict === 'Active') {
    result.reasons.push(
      `[advisory] strong applied=no signal (${appliedNo}/${total}, 0 applied=yes) → Active downgraded to Investigate for operator review`,
    );
    result.verdict = 'Investigate';
    result.score = 2;
  }

  return result;
}

/**
 * Classify a single surface item into a 4-tier verdict.
 *
 * Verdict precedence (default-safe):
 *   - Active      — agent dispatch>floor, OR skill invoked-by-command /
 *                   command invokes-a-live-skill, OR proseRefs>=ACTIVE_REF_FLOOR
 *   - Investigate — coverage<window (low-confidence), OR conflicting signals
 *                   (DEFAULT-SAFE bucket)
 *   - Demote      — 0<dispatch<=DEMOTE_DISPATCH_CEILING, OR a skill with only a
 *                   single cross-ref and no command linkage
 *   - Retire      — dispatch===0 AND nonBoilerplateRefs===0 AND coverage>=window
 *
 * The optional `judge` (L3, epic #645) is ADVISORY ONLY. It is consumed AFTER
 * the deterministic verdict is computed, and may only ANNOTATE the diagnosis or
 * DOWNGRADE Active → Investigate on a strong applied=no signal. It can NEVER
 * escalate a skill toward Retire/Demote nor promote it upward. When `judge` is
 * null/absent the classification is byte-for-byte identical to the L1-only path
 * (disabled-path guarantee).
 *
 * @param {{
 *   kind:'skill'|'agent'|'command',
 *   name:string,
 *   dispatch?:{count:number,lastTs:string|null}|null,
 *   static:{strictRefs:number,proseRefs:number,nonBoilerplateRefs:number,refFiles:string[]},
 *   linkage?:{invokedByCommands?:string[], invokesSkill?:string|null, invokedSkillExists?:boolean},
 *   windowDays:number,
 *   coverageDays:number,
 *   judge?:{appliedYes:number,appliedNo:number,appliedUnknown:number,completedYes:number,completedNo:number,completedUnknown:number,total:number,lastTs:string|null}|null
 * }} args
 * @returns {{name:string,kind:string,verdict:string,score:number,reasons:string[],signals:object}}
 */
export function classifyItem({
  kind,
  name,
  dispatch,
  static: staticRefs,
  linkage,
  windowDays,
  coverageDays,
  judge = null,
}) {
  const reasons = [];
  const dispatchCount = dispatch?.count ?? 0;
  const proseRefs = staticRefs.proseRefs;
  const strictRefs = staticRefs.strictRefs;
  const nonBoilerplateRefs = staticRefs.nonBoilerplateRefs;
  const invokedByCommands = linkage?.invokedByCommands ?? [];
  const invokesSkill = linkage?.invokesSkill ?? null;
  // When a command invokes a skill, the caller passes whether that skill is
  // present on disk. Default-true so callers that don't thread the surface set
  // (older callers/tests) preserve the historical "Active on linkage" behavior.
  const invokedSkillExists = linkage?.invokedSkillExists ?? true;
  const lowConfidence = coverageDays < windowDays;

  const signals = {
    dispatchCount,
    lastDispatch: dispatch?.lastTs ?? null,
    strictRefs,
    proseRefs,
    nonBoilerplateRefs,
    invokedByCommands,
    invokesSkill,
    invokedSkillExists,
    lowConfidence,
  };

  // --- Agent dispatch tier takes precedence over ref-based Active -----------
  // For agents, telemetry is authoritative. An agent with exactly one dispatch
  // is near-zero (Demote-tier) even though its definition is referenced across
  // many docs — those references are largely boilerplate-adjacent and do NOT
  // prove the agent is actually being dispatched. Discovery: db-specialist /
  // ui-developer are n=1 (Demote), distinct from never-dispatched (Retire).
  if (kind === 'agent') {
    if (dispatchCount > ACTIVE_DISPATCH_FLOOR) {
      reasons.push(
        `agent dispatched ${dispatchCount}× in window (>floor ${ACTIVE_DISPATCH_FLOOR})`,
      );
      return applyJudgeAdvisory({ name, kind, verdict: 'Active', score: 0, reasons, signals }, judge);
    }
    if (dispatchCount > 0 && dispatchCount <= DEMOTE_DISPATCH_CEILING) {
      reasons.push(
        `near-zero dispatch (${dispatchCount} in (0, ${DEMOTE_DISPATCH_CEILING}] ceiling), last ${dispatch?.lastTs ?? 'n/a'}`,
      );
      if (lowConfidence) {
        reasons.push(
          `low-confidence telemetry (coverage ${coverageDays.toFixed(1)}d < window ${windowDays}d) → Investigate`,
        );
        return applyJudgeAdvisory({ name, kind, verdict: 'Investigate', score: 2, reasons, signals }, judge);
      }
      return applyJudgeAdvisory({ name, kind, verdict: 'Demote', score: 1, reasons, signals }, judge);
    }
    // dispatchCount === 0 falls through to the cold/Retire + ref checks below.
  }

  // --- Active checks (linkage + ref-floor) -----------------------------------
  // NOTE: the ref-floor Active promotion applies to skills & commands ONLY.
  // For agents, dispatch telemetry is authoritative — a zero-dispatch agent
  // must NOT be promoted to Active by mere documentation mentions (every agent
  // is referenced across docs; that proves nothing about dispatch). A
  // zero-dispatch agent with some non-boilerplate refs lands in Investigate via
  // the fallthrough below, never Active. This is the Discovery "single-grep is
  // noisy" guard realised at the verdict layer.
  // --- Command → removed-skill staleness guard -------------------------------
  // A command that invokes a skill which is no longer present on disk is the
  // exact staleness a sunset tool must surface. Such a command is NOT Active —
  // the linkage points at a deleted skill. Route it to Investigate so an
  // operator confirms whether the command (or its target skill) should go.
  if (kind === 'command' && invokesSkill && !invokedSkillExists) {
    reasons.push(`command invokes a skill not present on disk: ${invokesSkill}`);
    return applyJudgeAdvisory({ name, kind, verdict: 'Investigate', score: 2, reasons, signals }, judge);
  }

  let active = false;
  if (kind === 'skill' && invokedByCommands.length > 0) {
    active = true;
    reasons.push(`skill invoked by command(s): ${invokedByCommands.join(', ')}`);
  }
  if (kind === 'command' && invokesSkill && invokedSkillExists) {
    active = true;
    reasons.push(`command invokes live skill: ${invokesSkill}`);
  }
  if (
    kind !== 'agent' &&
    (nonBoilerplateRefs >= ACTIVE_REF_FLOOR || proseRefs >= ACTIVE_REF_FLOOR)
  ) {
    active = true;
    reasons.push(
      `${nonBoilerplateRefs} non-boilerplate ref file(s), ${proseRefs} prose ref(s) (>=floor ${ACTIVE_REF_FLOOR})`,
    );
  }
  if (active) {
    return applyJudgeAdvisory({ name, kind, verdict: 'Active', score: 0, reasons, signals }, judge);
  }

  // --- Retire (provably cold) — gated on full coverage -----------------------
  const provablyCold =
    dispatchCount === 0 && nonBoilerplateRefs === 0;
  if (provablyCold) {
    if (lowConfidence) {
      // GUARDRAIL: never Retire on < window of telemetry. Downgrade.
      reasons.push(
        `cold (0 dispatch, 0 non-boilerplate refs) BUT coverage ${coverageDays.toFixed(1)}d < window ${windowDays}d → downgraded to Investigate`,
      );
      return applyJudgeAdvisory({ name, kind, verdict: 'Investigate', score: 2, reasons, signals }, judge);
    }
    reasons.push(
      `0 dispatch AND 0 non-boilerplate refs AND coverage ${coverageDays.toFixed(1)}d >= window ${windowDays}d`,
    );
    return applyJudgeAdvisory({ name, kind, verdict: 'Retire', score: 3, reasons, signals }, judge);
  }

  // --- Demote (near-zero) — skills & commands (agents handled above) ---------
  const lonelySkill =
    kind === 'skill' && nonBoilerplateRefs <= 1 && invokedByCommands.length === 0;
  const lonelyCommand =
    kind === 'command' && !invokesSkill && nonBoilerplateRefs <= 1;
  if (lonelySkill || lonelyCommand) {
    if (lonelySkill) {
      reasons.push(`skill has only ${nonBoilerplateRefs} cross-ref and no command linkage`);
    }
    if (lonelyCommand) {
      reasons.push(`command invokes no skill and has only ${nonBoilerplateRefs} cross-ref`);
    }
    if (lowConfidence) {
      reasons.push(
        `low-confidence telemetry (coverage ${coverageDays.toFixed(1)}d < window ${windowDays}d) → Investigate`,
      );
      return applyJudgeAdvisory({ name, kind, verdict: 'Investigate', score: 2, reasons, signals }, judge);
    }
    return applyJudgeAdvisory({ name, kind, verdict: 'Demote', score: 1, reasons, signals }, judge);
  }

  // --- Investigate (default-safe fallthrough) --------------------------------
  reasons.push('conflicting or inconclusive signals → default-safe Investigate');
  return applyJudgeAdvisory({ name, kind, verdict: 'Investigate', score: 2, reasons, signals }, judge);
}

// ---------------------------------------------------------------------------
// Top-level walk
// ---------------------------------------------------------------------------

/**
 * Run the full sunset walk across the plugin surface.
 *
 * @param {string} repoRoot
 * @param {{windowDays?:number, kind?:'skill'|'agent'|'command', now?:number, subagentsPath?:string, invocationsPath?:string, judgmentsPath?:string}} [opts]
 * @returns {{
 *   meta:{generatedAt:string,windowDays:number,coverageDays:number,lowConfidence:boolean,telemetrySources:object},
 *   summary:{active:number,investigate:number,demote:number,retire:number},
 *   items:Array<object>
 * }}
 */
export function runSunsetWalk(repoRoot, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const kindFilter = opts.kind ?? null;

  const subagentsPath =
    opts.subagentsPath ??
    path.join(repoRoot, '.orchestrator', 'metrics', 'subagents.jsonl');

  const invocationsPath =
    opts.invocationsPath ??
    path.join(repoRoot, '.orchestrator', 'metrics', 'skill-invocations.jsonl');

  const judgmentsPath =
    opts.judgmentsPath ??
    path.join(repoRoot, '.orchestrator', 'metrics', 'skill-judgments.jsonl');

  const surface = enumerateSurface(repoRoot);
  const dispatch = readDispatchCounts(subagentsPath, { windowDays, now: nowMs });
  const skillInvocations = readSkillInvocationCounts(invocationsPath, { windowDays, now: nowMs });
  // L3 advisory judge telemetry (#645). Clean-degrade: when the sidecar is
  // absent (judge disabled) this returns an empty bySkill map and the skill
  // classification below behaves byte-for-byte identically to the L1-only path.
  const skillJudgments = readSkillJudgmentCounts(judgmentsPath, { windowDays, now: nowMs });
  const linkage = commandSkillLinkage(repoRoot);
  const coverageDays = dispatch.coverageDays;
  const lowConfidence = coverageDays < windowDays;

  /** @type {Array<object>} */
  const items = [];

  const wantKind = (k) => !kindFilter || kindFilter === k;

  if (wantKind('skill')) {
    for (const name of surface.skills) {
      const staticRefs = staticReferenceScan(repoRoot, { kind: 'skill', name });
      const invokedByCommands = linkage.skillToCommands.get(name) ?? [];
      // Use real L1 selection counts (#645). Fall back to zero-count (NOT null)
      // so the coverage guard treats skills with no invocations as "cold but
      // possibly low-coverage" rather than "no telemetry at all".
      const skillDispatch = skillInvocations.bySkill.get(name) ?? { count: 0, lastTs: null };
      // L3 advisory judge data (#645). null when no in-window judgment exists
      // for this skill → classifyItem ignores it entirely (disabled-path parity).
      const judge = skillJudgments.bySkill.get(name) ?? null;
      items.push(
        classifyItem({
          kind: 'skill',
          name,
          dispatch: skillDispatch,
          static: staticRefs,
          linkage: { invokedByCommands },
          windowDays,
          coverageDays,
          judge,
        }),
      );
    }
  }

  if (wantKind('agent')) {
    for (const name of surface.agents) {
      const staticRefs = staticReferenceScan(repoRoot, { kind: 'agent', name });
      items.push(
        classifyItem({
          kind: 'agent',
          name,
          dispatch: dispatch.byAgent.get(name) ?? { count: 0, lastTs: null },
          static: staticRefs,
          windowDays,
          coverageDays,
        }),
      );
    }
  }

  if (wantKind('command')) {
    const skillSet = new Set(surface.skills);
    for (const name of surface.commands) {
      const staticRefs = staticReferenceScan(repoRoot, { kind: 'command', name });
      const invokesSkill = linkage.commandToSkill.get(name) ?? null;
      // Cross-check the linkage target against the enumerated skill surface so a
      // command pointing at a deleted skill is flagged Investigate, not Active.
      const invokedSkillExists = invokesSkill ? skillSet.has(invokesSkill) : true;
      items.push(
        classifyItem({
          kind: 'command',
          name,
          dispatch: null,
          static: staticRefs,
          linkage: { invokesSkill, invokedSkillExists },
          windowDays,
          coverageDays,
        }),
      );
    }
  }

  const summary = { active: 0, investigate: 0, demote: 0, retire: 0 };
  for (const item of items) {
    const key = item.verdict.toLowerCase();
    if (key in summary) summary[key] += 1;
  }

  return {
    meta: {
      generatedAt: new Date(nowMs).toISOString(),
      windowDays,
      coverageDays: Number(coverageDays.toFixed(2)),
      lowConfidence,
      telemetrySources: {
        subagentsJsonl: subagentsPath,
        earliestTs: dispatch.earliestTs,
        latestTs: dispatch.latestTs,
        skillInvocationsJsonl: invocationsPath,
        skillInvocationsEarliestTs: skillInvocations.earliestTs,
        skillInvocationsLatestTs: skillInvocations.latestTs,
        skillJudgmentsJsonl: judgmentsPath,
        skillJudgmentsEarliestTs: skillJudgments.earliestTs,
        skillJudgmentsLatestTs: skillJudgments.latestTs,
        skillJudgmentsAssessment: 'L3 advisory only — annotates/downgrades, never escalates toward Retire',
        commandsAssessment: 'static-analysis only (no command-invocation telemetry)',
      },
    },
    summary,
    items,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse argv into options. Returns { error } on bad args.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const opts = { json: false, windowDays: DEFAULT_WINDOW_DAYS, kind: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--window-days') {
      const val = argv[i + 1];
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `--window-days requires a positive number, got: ${val}` };
      }
      opts.windowDays = n;
      i += 1;
    } else if (arg.startsWith('--window-days=')) {
      const n = Number(arg.split('=')[1]);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `--window-days requires a positive number` };
      }
      opts.windowDays = n;
    } else if (arg === '--kind') {
      const val = argv[i + 1];
      if (!['skill', 'agent', 'command'].includes(val)) {
        return { error: `--kind must be one of skill|agent|command, got: ${val}` };
      }
      opts.kind = val;
      i += 1;
    } else if (arg.startsWith('--kind=')) {
      const val = arg.split('=')[1];
      if (!['skill', 'agent', 'command'].includes(val)) {
        return { error: `--kind must be one of skill|agent|command` };
      }
      opts.kind = val;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return opts;
}

const HELP = `sunset-review walker — READ-ONLY surface usage analysis

Usage:
  node scripts/lib/sunset/walker.mjs [--json] [--window-days N] [--kind K]

Options:
  --json            Emit only JSON to stdout (machine-parseable).
  --window-days N    Sunset window in days (default ${DEFAULT_WINDOW_DAYS}).
  --kind K          Limit to one of: skill | agent | command.
  --help, -h        Show this help.

Exit codes:
  0  walk done (cold findings are exit 0, not an error)
  1  bad args / surface directory missing
  2  system error
`;

/**
 * Render a human-readable table grouped by verdict.
 * @param {ReturnType<typeof runSunsetWalk>} result
 * @returns {string}
 */
function renderHuman(result) {
  const lines = [];
  lines.push('Sunset Review — surface usage walk');
  lines.push(`  generated: ${result.meta.generatedAt}`);
  lines.push(
    `  window: ${result.meta.windowDays}d  coverage: ${result.meta.coverageDays}d  lowConfidence: ${result.meta.lowConfidence}`,
  );
  lines.push(
    `  summary: Active=${result.summary.active} Investigate=${result.summary.investigate} Demote=${result.summary.demote} Retire=${result.summary.retire}`,
  );
  if (result.meta.lowConfidence) {
    lines.push(
      '  NOTE: coverage < window — all Retire verdicts downgraded to Investigate.',
    );
  }
  for (const verdict of ['Retire', 'Demote', 'Investigate', 'Active']) {
    const group = result.items.filter((i) => i.verdict === verdict);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`== ${verdict} (${group.length}) ==`);
    for (const item of group) {
      lines.push(`  [${item.kind}] ${item.name}`);
      for (const reason of item.reasons) {
        lines.push(`      - ${reason}`);
      }
    }
  }
  return lines.join('\n');
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stderr.write(`Error: ${opts.error}\n\n${HELP}`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let repoRoot;
  try {
    repoRoot = process.cwd();
    // Prefer git root if available, but cwd is acceptable.
    const skillsDir = path.join(repoRoot, 'skills');
    if (!existsSync(skillsDir)) {
      process.stderr.write(`Error: surface directory not found: ${skillsDir}\n`);
      return 1;
    }
  } catch (err) {
    process.stderr.write(`System error resolving repo root: ${err.message}\n`);
    return 2;
  }

  let result;
  try {
    result = runSunsetWalk(repoRoot, {
      windowDays: opts.windowDays,
      kind: opts.kind,
    });
  } catch (err) {
    process.stderr.write(`System error during walk: ${err.message}\n`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(result) + '\n');
  }
  return 0;
}

// Import-safe main-guard.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const code = main(process.argv.slice(2));
  process.exit(code);
}
