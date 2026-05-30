/**
 * tests/lib/sunset-walker.test.mjs
 *
 * Smoke tests for scripts/lib/sunset/walker.mjs (issue #444).
 *
 * Covers the load-bearing contracts:
 *   - readDispatchCounts counts ONLY event==="start" (a "stop" record with
 *     agent_type:null must NOT mark an agent cold).
 *   - readDispatchCounts strips the "session-orchestrator:" prefix and tolerates
 *     malformed lines without throwing.
 *   - classifyItem 4-tier verdicts: Active / Investigate / Demote / Retire.
 *   - The low-confidence guardrail: coverage < window downgrades Retire →
 *     Investigate.
 *
 * Deep classification coverage is a later wave — this is a happy-path smoke
 * test plus the two highest-risk regressions (start-only counting + guardrail).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  readDispatchCounts,
  staticReferenceScan,
  commandSkillLinkage,
  classifyItem,
  runSunsetWalk,
  DEFAULT_WINDOW_DAYS,
} from '../../scripts/lib/sunset/walker.mjs';

const NOW = Date.parse('2026-05-30T12:00:00.000Z');

const WALKER_CLI = fileURLToPath(
  new URL('../../scripts/lib/sunset/walker.mjs', import.meta.url),
);

/** Build a SKILL.md under skills/<name>/ inside the given root. */
function makeSkill(root, name, body) {
  mkdirSync(path.join(root, 'skills', name), { recursive: true });
  writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), body, 'utf8');
}

describe('readDispatchCounts', () => {
  let dir;
  let jsonlPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sunset-walker-'));
    jsonlPath = path.join(dir, 'subagents.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts only start events and ignores stop events with null agent_type', () => {
    const lines = [
      // stop with null agent_type — MUST NOT count
      JSON.stringify({
        event: 'stop',
        agent_type: null,
        timestamp: '2026-05-29T10:00:00.000Z',
      }),
      // two start events for the same agent — count = 2
      JSON.stringify({
        event: 'start',
        agent_type: 'session-orchestrator:code-implementer',
        timestamp: '2026-05-29T11:00:00.000Z',
      }),
      JSON.stringify({
        event: 'start',
        agent_type: 'session-orchestrator:code-implementer',
        timestamp: '2026-05-30T09:00:00.000Z',
      }),
    ].join('\n');
    writeFileSync(jsonlPath, lines + '\n', 'utf8');

    const { byAgent } = readDispatchCounts(jsonlPath, {
      windowDays: DEFAULT_WINDOW_DAYS,
      now: NOW,
    });

    expect(byAgent.get('code-implementer')).toEqual({
      count: 2,
      lastTs: '2026-05-30T09:00:00.000Z',
    });
    // No agent record should ever be derived from the stop line.
    expect(byAgent.size).toBe(1);
  });

  it('tolerates malformed and empty lines without throwing', () => {
    const lines = [
      '',
      'not json at all',
      '{ "event": "start" ', // truncated JSON
      JSON.stringify({
        event: 'start',
        agent_type: 'analyst',
        timestamp: '2026-05-29T11:00:00.000Z',
      }),
    ].join('\n');
    writeFileSync(jsonlPath, lines + '\n', 'utf8');

    const result = readDispatchCounts(jsonlPath, {
      windowDays: DEFAULT_WINDOW_DAYS,
      now: NOW,
    });
    // Bare type (no prefix) is preserved verbatim.
    expect(result.byAgent.get('analyst').count).toBe(1);
  });

  it('returns empty counts for a missing telemetry file', () => {
    const result = readDispatchCounts(path.join(dir, 'nope.jsonl'), {
      windowDays: DEFAULT_WINDOW_DAYS,
      now: NOW,
    });
    expect(result.byAgent.size).toBe(0);
    expect(result.earliestTs).toBeNull();
    expect(result.coverageDays).toBe(0);
  });
});

describe('classifyItem', () => {
  const noRefs = { strictRefs: 0, proseRefs: 0, nonBoilerplateRefs: 0, refFiles: [] };

  it('classifies a heavily-dispatched agent as Active (full coverage)', () => {
    const result = classifyItem({
      kind: 'agent',
      name: 'code-implementer',
      dispatch: { count: 236, lastTs: '2026-05-30T07:40:40.446Z' },
      static: noRefs,
      windowDays: DEFAULT_WINDOW_DAYS,
      coverageDays: 120,
    });
    expect(result.verdict).toBe('Active');
  });

  it('classifies a never-dispatched, unreferenced agent as Retire when coverage >= window', () => {
    const result = classifyItem({
      kind: 'agent',
      name: 'memory-proposal-collector',
      dispatch: { count: 0, lastTs: null },
      static: noRefs,
      windowDays: 10,
      coverageDays: 16,
    });
    expect(result.verdict).toBe('Retire');
  });

  it('downgrades a cold agent from Retire to Investigate when coverage < window (guardrail)', () => {
    const result = classifyItem({
      kind: 'agent',
      name: 'memory-proposal-collector',
      dispatch: { count: 0, lastTs: null },
      static: noRefs,
      windowDays: DEFAULT_WINDOW_DAYS,
      coverageDays: 16,
    });
    expect(result.verdict).toBe('Investigate');
    expect(result.signals.lowConfidence).toBe(true);
  });

  it('classifies a single-dispatch agent as Demote when coverage >= window', () => {
    const result = classifyItem({
      kind: 'agent',
      name: 'db-specialist',
      dispatch: { count: 1, lastTs: '2026-05-19T05:44:47.919Z' },
      static: noRefs,
      windowDays: 10,
      coverageDays: 16,
    });
    expect(result.verdict).toBe('Demote');
  });

  it('classifies a command that invokes a live skill as Active', () => {
    const result = classifyItem({
      kind: 'command',
      name: 'repo-audit',
      static: noRefs,
      linkage: { invokesSkill: 'repo-audit' },
      windowDays: DEFAULT_WINDOW_DAYS,
      coverageDays: 120,
    });
    expect(result.verdict).toBe('Active');
  });
});

// ---------------------------------------------------------------------------
// 1. Fault-injection depth — readDispatchCounts on degraded telemetry.
//    Must skip bad lines, never throw, and return sane envelope fields.
// ---------------------------------------------------------------------------

describe('readDispatchCounts — fault-injection depth', () => {
  let dir;
  let jsonlPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sunset-fault-'));
    jsonlPath = path.join(dir, 'subagents.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a zero envelope for an empty file', () => {
    writeFileSync(jsonlPath, '', 'utf8');
    const result = readDispatchCounts(jsonlPath, {
      windowDays: DEFAULT_WINDOW_DAYS,
      now: NOW,
    });
    expect(result.byAgent.size).toBe(0);
    expect(result.earliestTs).toBeNull();
    expect(result.latestTs).toBeNull();
    expect(result.coverageDays).toBe(0);
  });

  it('counts start records missing a timestamp but excludes them from the coverage envelope', () => {
    const lines = [
      // start with NO timestamp — still counted, but contributes no coverage.
      JSON.stringify({ event: 'start', agent_type: 'session-orchestrator:analyst' }),
      // dated start, 10 days before NOW — sets the coverage envelope.
      JSON.stringify({
        event: 'start',
        agent_type: 'session-orchestrator:analyst',
        timestamp: '2026-05-20T12:00:00.000Z',
      }),
    ].join('\n');
    writeFileSync(jsonlPath, lines + '\n', 'utf8');

    const result = readDispatchCounts(jsonlPath, {
      windowDays: DEFAULT_WINDOW_DAYS,
      now: NOW,
    });

    expect(result.byAgent.get('analyst')).toEqual({
      count: 2,
      lastTs: '2026-05-20T12:00:00.000Z',
    });
    // Envelope is driven only by the dated record (NOW − 2026-05-20 = 10 days).
    expect(result.earliestTs).toBe('2026-05-20T12:00:00.000Z');
    expect(result.latestTs).toBe('2026-05-20T12:00:00.000Z');
    expect(result.coverageDays).toBe(10);
  });

  it('skips truncated lines interleaved with valid records without throwing', () => {
    const lines = [
      JSON.stringify({
        event: 'start',
        agent_type: 'session-orchestrator:analyst',
        timestamp: '2026-05-25T12:00:00.000Z',
      }),
      '{ "event": "start", "agent_type": "ses', // truncated mid-record
      'plain garbage not json',
      JSON.stringify({
        event: 'start',
        agent_type: 'session-orchestrator:analyst',
        timestamp: '2026-05-28T12:00:00.000Z',
      }),
    ].join('\n');
    writeFileSync(jsonlPath, lines + '\n', 'utf8');

    const result = readDispatchCounts(jsonlPath, {
      windowDays: DEFAULT_WINDOW_DAYS,
      now: NOW,
    });

    // Only the two well-formed start records count; the two bad lines are skipped.
    expect(result.byAgent.get('analyst')).toEqual({
      count: 2,
      lastTs: '2026-05-28T12:00:00.000Z',
    });
    expect(result.earliestTs).toBe('2026-05-25T12:00:00.000Z');
    expect(result.latestTs).toBe('2026-05-28T12:00:00.000Z');
    // NOW − 2026-05-25 = 5 days.
    expect(result.coverageDays).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. Static-scan boilerplate exclusion — references that exist ONLY in
//    authoring/registry/validator sites must not mask coldness.
// ---------------------------------------------------------------------------

describe('staticReferenceScan — boilerplate exclusion (agents)', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sunset-boiler-'));
    mkdirSync(path.join(root, 'agents', 'schemas'), { recursive: true });
    mkdirSync(path.join(root, 'scripts', 'lib', 'validate'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports zero non-boilerplate refs when an agent appears only in self/authoring/registry/validator sites', () => {
    const name = 'ghost-agent';
    // self-definition
    writeFileSync(
      path.join(root, 'agents', `${name}.md`),
      `session-orchestrator:${name} self definition`,
      'utf8',
    );
    // authoring spec
    writeFileSync(
      path.join(root, 'agents', 'AGENTS.md'),
      `Routing for session-orchestrator:${name} lives here.`,
      'utf8',
    );
    // schema
    writeFileSync(
      path.join(root, 'agents', 'schemas', `${name}.schema.json`),
      `{ "subagent_type": "${name}" }`,
      'utf8',
    );
    // routing table
    writeFileSync(
      path.join(root, 'agents', 'schemas', 'routing-table.json'),
      `{ "session-orchestrator:${name}": 1 }`,
      'utf8',
    );
    // routing validator
    writeFileSync(
      path.join(root, 'scripts', 'lib', 'validate', 'check-subagent-types.mjs'),
      `const x = 'session-orchestrator:${name}';`,
      'utf8',
    );

    const result = staticReferenceScan(root, { kind: 'agent', name });

    // All five sites are boilerplate → coldness is NOT masked.
    expect(result.nonBoilerplateRefs).toBe(0);
    expect(result.refFiles).toEqual([]);
  });

  it('counts a genuine third-party dispatch reference as non-boilerplate', () => {
    const name = 'ghost-agent';
    // self-definition (boilerplate)
    writeFileSync(
      path.join(root, 'agents', `${name}.md`),
      `session-orchestrator:${name} self definition`,
      'utf8',
    );
    // a real consumer: a skill that dispatches the agent — NOT boilerplate.
    makeSkill(
      root,
      'consumer',
      `We dispatch the session-orchestrator:${name} agent here.`,
    );

    const result = staticReferenceScan(root, { kind: 'agent', name });

    expect(result.nonBoilerplateRefs).toBe(1);
    expect(result.refFiles).toEqual(['skills/consumer/SKILL.md']);
  });
});

// ---------------------------------------------------------------------------
// 3. Prose-invocation matcher + English-word collision.
// ---------------------------------------------------------------------------

describe('staticReferenceScan — prose matcher and bare-word collisions', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sunset-prose-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('detects a skill invoked only via the prose phrase "Invoke the <name> skill" (no token)', () => {
    // self-definition is boilerplate and excluded.
    makeSkill(root, 'discovery', 'Self-definition of the discovery skill.');
    // a consumer that references it ONLY in prose, with no session-orchestrator: token.
    makeSkill(root, 'consumer', 'Invoke the discovery skill to find issues.');

    const result = staticReferenceScan(root, { kind: 'skill', name: 'discovery' });

    // No strict token present → strictRefs stays 0; prose matchers fire.
    expect(result.strictRefs).toBe(0);
    expect(result.proseRefs).toBeGreaterThanOrEqual(1);
    expect(result.nonBoilerplateRefs).toBe(1);
    expect(result.refFiles).toEqual(['skills/consumer/SKILL.md']);
  });

  it('does NOT inflate a skill named "daily" from the bare English word "daily" in unrelated prose', () => {
    makeSkill(root, 'daily', 'Self-definition of the daily skill.');
    // unrelated prose containing the word "daily" but NOT as a skill invocation.
    makeSkill(
      root,
      'unrelated',
      'Write your daily notes every morning. This is routine housekeeping.',
    );

    const result = staticReferenceScan(root, { kind: 'skill', name: 'daily' });

    // The bare word "daily" must not be matched — coldness preserved.
    expect(result.proseRefs).toBe(0);
    expect(result.strictRefs).toBe(0);
    expect(result.nonBoilerplateRefs).toBe(0);
    expect(result.refFiles).toEqual([]);
  });

  it('still matches "daily" when it is genuinely qualified as a skill in prose', () => {
    makeSkill(root, 'daily', 'Self-definition of the daily skill.');
    makeSkill(root, 'caller', 'The daily skill writes the rollover note.');

    const result = staticReferenceScan(root, { kind: 'skill', name: 'daily' });

    expect(result.proseRefs).toBe(1);
    expect(result.nonBoilerplateRefs).toBe(1);
    expect(result.refFiles).toEqual(['skills/caller/SKILL.md']);
  });
});

// ---------------------------------------------------------------------------
// 4. Command → skill linkage.
// ---------------------------------------------------------------------------

describe('commandSkillLinkage', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sunset-link-'));
    mkdirSync(path.join(root, 'commands'), { recursive: true });
    makeSkill(root, 'live-skill', 'A live skill.');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('links a command to the live skill it invokes, and that skill classifies Active', () => {
    writeFileSync(
      path.join(root, 'commands', 'cmd-live.md'),
      'Runs skills/live-skill/SKILL.md to do the work.',
      'utf8',
    );

    const { commandToSkill, skillToCommands } = commandSkillLinkage(root);
    expect(commandToSkill.get('cmd-live')).toBe('live-skill');
    expect(skillToCommands.get('live-skill')).toEqual(['cmd-live']);

    // The invoked skill is promoted to Active via command linkage.
    const verdict = classifyItem({
      kind: 'skill',
      name: 'live-skill',
      dispatch: null,
      static: { strictRefs: 0, proseRefs: 0, nonBoilerplateRefs: 0, refFiles: [] },
      linkage: { invokedByCommands: skillToCommands.get('live-skill') },
      windowDays: DEFAULT_WINDOW_DAYS,
      coverageDays: 120,
    });
    expect(verdict.verdict).toBe('Active');
    expect(verdict.signals.invokedByCommands).toEqual(['cmd-live']);
  });

  it('parses the linkage target even when the referenced skill does not exist on disk', () => {
    // A command pointing at a removed skill: linkage extracts the name verbatim.
    writeFileSync(
      path.join(root, 'commands', 'cmd-dead.md'),
      'Runs skills/ghost-skill/SKILL.md which no longer exists.',
      'utf8',
    );

    const { commandToSkill, skillToCommands } = commandSkillLinkage(root);
    // commandSkillLinkage records the raw token verbatim — it does NOT (and
    // should not) cross-check skill existence; that cross-check is the
    // classifier's job (see the classification test below).
    expect(commandToSkill.get('cmd-dead')).toBe('ghost-skill');
    expect(skillToCommands.has('ghost-skill')).toBe(true);
    expect(skillToCommands.get('ghost-skill')).toEqual(['cmd-dead']);
  });

  it('classifies a command that invokes a REMOVED skill as Investigate, not Active', () => {
    // The linkage target was deleted: invokedSkillExists is false. The command
    // must surface for operator review rather than be marked Active by a stale
    // pointer — this is the exact staleness a sunset tool exists to catch.
    const result = classifyItem({
      kind: 'command',
      name: 'cmd-dead',
      dispatch: null,
      static: { strictRefs: 0, proseRefs: 0, nonBoilerplateRefs: 0, refFiles: [] },
      linkage: { invokesSkill: 'ghost-skill', invokedSkillExists: false },
      windowDays: DEFAULT_WINDOW_DAYS,
      coverageDays: 120,
    });
    expect(result.verdict).toBe('Investigate');
    // The reason must NOT claim the skill is live.
    expect(result.reasons.join(' ')).not.toContain('live');
    expect(result.reasons.join(' ')).toContain('not present on disk');
  });
});

// ---------------------------------------------------------------------------
// 5. CLI contract — JSON-first, exit codes, stdout/stderr separation.
// ---------------------------------------------------------------------------

describe('walker CLI', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

  it('--json emits ONLY valid JSON to stdout and exits 0 even when non-Active items exist', () => {
    const res = spawnSync('node', [WALKER_CLI, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    // stdout must be parseable JSON in its entirety (no human text mixed in).
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveProperty('meta');
    expect(parsed).toHaveProperty('summary');
    expect(Array.isArray(parsed.items)).toBe(true);
    // Cold/low-confidence findings are DATA, not an error — exit stays 0.
    const total =
      parsed.summary.active +
      parsed.summary.investigate +
      parsed.summary.demote +
      parsed.summary.retire;
    expect(total).toBe(parsed.items.length);
  });

  it('exits 1 on an invalid --kind and writes the error to stderr, not stdout', () => {
    const res = spawnSync('node', [WALKER_CLI, '--json', '--kind', 'bogus'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--kind must be one of');
    // Diagnostics never leak into stdout.
    expect(res.stdout).toBe('');
  });

  it('exits 1 on a non-positive --window-days', () => {
    const res = spawnSync('node', [WALKER_CLI, '--window-days', '-5'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--window-days requires a positive number');
    expect(res.stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. classifyItem tier boundaries — hardcoded input → hardcoded verdict.
// ---------------------------------------------------------------------------

describe('classifyItem — agent dispatch tier boundaries', () => {
  const noRefs = { strictRefs: 0, proseRefs: 0, nonBoilerplateRefs: 0, refFiles: [] };

  it('dispatch 0 + coverage >= window → Retire', () => {
    const result = classifyItem({
      kind: 'agent',
      name: 'x',
      dispatch: { count: 0, lastTs: null },
      static: noRefs,
      windowDays: 10,
      coverageDays: 10,
    });
    expect(result.verdict).toBe('Retire');
    expect(result.signals.lowConfidence).toBe(false);
  });

  it('dispatch 0 + coverage < window → Investigate (guardrail)', () => {
    const result = classifyItem({
      kind: 'agent',
      name: 'x',
      dispatch: { count: 0, lastTs: null },
      static: noRefs,
      windowDays: 90,
      coverageDays: 16,
    });
    expect(result.verdict).toBe('Investigate');
    expect(result.signals.lowConfidence).toBe(true);
  });

  it('dispatch 1 (ceiling) + coverage >= window → Demote', () => {
    const result = classifyItem({
      kind: 'agent',
      name: 'x',
      dispatch: { count: 1, lastTs: '2026-05-19T05:44:47.919Z' },
      static: noRefs,
      windowDays: 10,
      coverageDays: 16,
    });
    expect(result.verdict).toBe('Demote');
  });

  it('dispatch many (> floor) → Active', () => {
    const result = classifyItem({
      kind: 'agent',
      name: 'x',
      dispatch: { count: 42, lastTs: '2026-05-30T07:40:40.446Z' },
      static: noRefs,
      windowDays: 10,
      coverageDays: 16,
    });
    expect(result.verdict).toBe('Active');
    expect(result.signals.dispatchCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 7. commandSkillLinkage graceful degradation on an unreadable command file.
//    A command that exists in the listing but throws on read must yield
//    null linkage and must NOT throw (graceful-degradation contract).
// ---------------------------------------------------------------------------

describe('commandSkillLinkage — unreadable command file', () => {
  let root;
  let deadPath;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sunset-unreadable-'));
    mkdirSync(path.join(root, 'commands'), { recursive: true });
    // A readable command linking to a live skill — proves the loop continues.
    writeFileSync(
      path.join(root, 'commands', 'good.md'),
      'Runs skills/live-skill/SKILL.md.',
      'utf8',
    );
    makeSkill(root, 'live-skill', 'A live skill.');
    // A command file that exists in the directory listing but is unreadable.
    deadPath = path.join(root, 'commands', 'locked.md');
    writeFileSync(deadPath, 'Runs skills/secret/SKILL.md.', 'utf8');
    chmodSync(deadPath, 0o000);
  });

  afterEach(() => {
    // Restore perms so rmSync can clean up.
    try {
      chmodSync(deadPath, 0o644);
    } catch {
      /* best-effort */
    }
    rmSync(root, { recursive: true, force: true });
  });

  // Skip under root, where the 000 mode is bypassed and the read succeeds.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)(
    'records null linkage for an unreadable command file and does not throw',
    () => {
      let result;
      expect(() => {
        result = commandSkillLinkage(root);
      }).not.toThrow();
      // The unreadable file degrades to null linkage (catch branch).
      expect(result.commandToSkill.get('locked')).toBe(null);
      // The readable command is still linked — the loop did not abort.
      expect(result.commandToSkill.get('good')).toBe('live-skill');
    },
  );
});

// ---------------------------------------------------------------------------
// 8. runSunsetWalk — --kind filter and summary tally on a controlled fixture.
//    Hardcoded expected summary, computed by hand for this exact fixture.
// ---------------------------------------------------------------------------

describe('runSunsetWalk — kind filter and summary tally', () => {
  let root;
  let subagentsPath;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sunset-walk-'));
    mkdirSync(path.join(root, 'agents'), { recursive: true });
    mkdirSync(path.join(root, 'commands'), { recursive: true });

    // 1 linked skill (invoked by a command → Active).
    makeSkill(root, 'linked', 'Self-definition of the linked skill.');
    // 1 cold skill (no refs, no linkage → Retire at full coverage).
    makeSkill(root, 'lonely', 'Self-definition of the lonely skill.');
    // 1 active agent (5 dispatches → Active).
    writeFileSync(
      path.join(root, 'agents', 'worker.md'),
      'session-orchestrator:worker self definition',
      'utf8',
    );
    // 1 command invoking the live skill → Active.
    writeFileSync(
      path.join(root, 'commands', 'cmd.md'),
      'Runs skills/linked/SKILL.md to do the work.',
      'utf8',
    );

    // Telemetry: 5 start events for worker, earliest 10 days before NOW.
    subagentsPath = path.join(root, 'subagents.jsonl');
    const starts = [
      '2026-05-20T12:00:00.000Z',
      '2026-05-22T12:00:00.000Z',
      '2026-05-24T12:00:00.000Z',
      '2026-05-26T12:00:00.000Z',
      '2026-05-28T12:00:00.000Z',
    ].map((ts) =>
      JSON.stringify({ event: 'start', agent_type: 'session-orchestrator:worker', timestamp: ts }),
    );
    writeFileSync(subagentsPath, starts.join('\n') + '\n', 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('with kind=skill returns ONLY skill items', () => {
    const result = runSunsetWalk(root, {
      kind: 'skill',
      windowDays: 5,
      now: NOW,
      subagentsPath,
    });
    expect(result.items.every((i) => i.kind === 'skill')).toBe(true);
    expect(result.items.length).toBe(2);
  });

  it('without a kind filter tallies the summary to the hand-computed expected object', () => {
    const result = runSunsetWalk(root, {
      windowDays: 5,
      now: NOW,
      subagentsPath,
    });
    // Hand-computed for this fixture (coverage 10d >= window 5d → full confidence):
    //   linked skill  → Active   (invoked by cmd)
    //   lonely skill  → Retire   (0 dispatch, 0 non-boilerplate refs)
    //   worker agent  → Active   (5 dispatches > floor 1)
    //   cmd command   → Active   (invokes live skill 'linked')
    expect(result.summary).toEqual({ active: 3, investigate: 0, demote: 0, retire: 1 });
    expect(result.meta.lowConfidence).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. staticReferenceScan — skill-kind boilerplate exclusion + node_modules skip.
// ---------------------------------------------------------------------------

describe('staticReferenceScan — skill boilerplate + node_modules exclusion', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sunset-skill-boiler-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports zero non-boilerplate refs when a skill appears only in README + its own dir', () => {
    makeSkill(root, 'solo', 'Self-definition of the solo skill.');
    // README.md is boilerplate for a skill — must not mask coldness.
    writeFileSync(
      path.join(root, 'README.md'),
      'The solo skill is listed at skills/solo/ in the index.',
      'utf8',
    );

    const result = staticReferenceScan(root, { kind: 'skill', name: 'solo' });

    expect(result.nonBoilerplateRefs).toBe(0);
    expect(result.refFiles).toEqual([]);
  });

  it('does NOT count a reference buried under a scanned dir node_modules', () => {
    makeSkill(root, 'solo', 'Self-definition of the solo skill.');
    // A reference under scripts/node_modules — collectFiles skips node_modules.
    mkdirSync(path.join(root, 'scripts', 'node_modules', 'x'), { recursive: true });
    writeFileSync(
      path.join(root, 'scripts', 'node_modules', 'x', 'y.md'),
      'Invoke the solo skill from this vendored file.',
      'utf8',
    );

    const result = staticReferenceScan(root, { kind: 'skill', name: 'solo' });

    // The node_modules reference is invisible to the scanner → still cold.
    expect(result.nonBoilerplateRefs).toBe(0);
    expect(result.refFiles).toEqual([]);
  });
});
