/**
 * tests/lib/skill-evidence-window.test.mjs
 *
 * Unit tests for scripts/lib/skill-evidence-window.mjs (issue #1399).
 *
 * The ONE error class these tests exist for: **the invocation is absent from
 * the text the judge sees, and the judge is dispatched anyway.** Each test
 * below names the concrete bug it catches (TV-001):
 *
 *  - "keeps the invocation marker" — a tail-shaped renderer (the pre-#1399
 *    `readTranscriptTail` shape: last N assistant records, text blocks only)
 *    loses an anchor that fired at record 5 of a 50-record session, and a
 *    renderer that inlines the 40k skill body blows the character budget.
 *  - "slash-command body without the header" — body detection keyed on
 *    "Base directory for this skill:" drops 91 of 101 measured slash-command
 *    bodies; the judge then sees a command name and no body at all.
 *  - "bare skill name" — exact-string matching loses the 9-of-188 measured
 *    invocations that carry no plugin prefix.
 *  - "errored call" — a `tool_result.is_error` invocation counted as a clean
 *    application, so `applied: yes` is claimed for a call that failed.
 *  - "budget-insufficient" — silently squeezing N skills into a per-skill
 *    budget below the useful floor, so the caller cannot tell that a judged
 *    skill got no excerpt.
 *  - "malformed_lines" — a half-written JSONL line skipped without being
 *    counted turns a partial read into a clean-looking verdict.
 *
 * Record shapes are copied from live transcripts under
 * `~/.claude/projects/<encoded-repo>/` (inspected 2026-09-19): assistant
 * `tool_use` `{name:"Skill", input:{skill}}`, a `tool_result` user record, an
 * `isMeta: true` body record, and the optional `attributionSkill` string.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOSING_CHARS,
  DEFAULT_MIN_PER_SKILL_CHARS,
  buildSkillEvidence,
  locateSkillAnchors,
  readTranscriptRecords,
  renderEvidence,
} from '@lib/skill-evidence-window.mjs';

const SKILL = 'session-orchestrator:session-start';

/** Deep marker inside a skill body — must NEVER reach the rendered evidence. */
const DEEP_BODY_SENTINEL = 'DEEP-BODY-SENTINEL-8f15f77b';

const tmpDirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'so-skill-evidence-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function assistantText(text, extra = {}) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra };
}

function skillCall(skill, id = 'call_x') {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill, args: 'deep' } }] },
  };
}

function toolResult(id, { isError = false, text = `"Launching skill: ${SKILL}"` } = {}) {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }],
    },
  };
}

function bodyRecord(text) {
  return { type: 'user', isMeta: true, message: { content: [{ type: 'text', text }] } };
}

/**
 * A session shaped like a real one: the skill fires EARLY (record 5 of 50),
 * its body is 40k characters, and the records after it carry long tool output.
 */
function bigSession() {
  const records = [];
  for (let i = 0; i < 5; i += 1) records.push(assistantText(`preamble line ${i}`));
  records.push(skillCall(SKILL, 'call_start')); // index 5
  records.push(toolResult('call_start')); // index 6
  records.push(
    bodyRecord(
      `Base directory for this skill: /repo/skills/session-start\n\n` +
        `# Session Start Skill\n\n` +
        `${'lorem ipsum dolor sit amet '.repeat(1400)}${DEEP_BODY_SENTINEL}\n`,
    ),
  ); // index 7
  for (let i = 0; i < 32; i += 1) {
    records.push({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: `private reasoning ${i} `.repeat(200) },
          { type: 'tool_use', id: `call_b${i}`, name: 'Bash', input: { command: 'x '.repeat(3000) } },
        ],
      },
    });
  }
  records.push(assistantText('wave finished', { attributionSkill: SKILL }));
  for (let i = 0; i < 9; i += 1) records.push(assistantText(`closing line ${i}`));
  return records;
}

describe('locateSkillAnchors', () => {
  it('finds a slash-command body that carries NO "Base directory" header', () => {
    const records = [
      {
        type: 'user',
        message: {
          content:
            '<command-message>session-orchestrator:close</command-message>\n' +
            '<command-name>/session-orchestrator:close</command-name>',
        },
      },
      bodyRecord('# Close Session\n\nThe user wants to end the current session.'),
    ];

    const located = locateSkillAnchors(records, ['session-orchestrator:close']);
    const loc = located['session-orchestrator:close'];

    expect(loc.found).toBe(true);
    expect(loc.invocations).toBe(1);
    expect(loc.anchors[0]).toEqual({
      kind: 'slash-command',
      recordIndex: 0,
      errored: false,
      bodyRecordIndex: 1,
    });

    const { text } = renderEvidence(records, located, {});
    expect(text).toContain('[skill body: session-orchestrator:close] # Close Session');
  });

  it('matches a BARE invocation against a plugin-prefixed requested skill', () => {
    const records = [skillCall('debug', 'call_d'), toolResult('call_d')];
    const located = locateSkillAnchors(records, ['session-orchestrator:debug']);

    expect(located['session-orchestrator:debug'].found).toBe(true);
    expect(located['session-orchestrator:debug'].anchors[0].kind).toBe('skill-call');
  });

  it('marks an anchor errored when its tool_result carries is_error and says so in the render', () => {
    const records = [
      skillCall(SKILL, 'call_e'),
      toolResult('call_e', { isError: true, text: 'Skill not found' }),
    ];
    const located = locateSkillAnchors(records, [SKILL]);

    expect(located[SKILL].anchors[0].errored).toBe(true);
    expect(renderEvidence(records, located, {}).text).toContain('at least one call errored');
  });

  // Bug this catches: a SUBAGENT's skill call counted as the coordinator's.
  // Without the distinction the judge reads "the session applied this skill"
  // from a call the coordinator never made — the `_subagent` flag is stamped by
  // `readTranscriptRecords` for `<uuid>/subagents/agent-*.jsonl`, `isSidechain`
  // by the harness itself.
  it.each([
    ['_subagent (stamped by the reader)', { _subagent: true }],
    ['isSidechain (stamped by the harness)', { isSidechain: true }],
  ])('classifies a %s skill call as subagent-skill-call', (_label, marker) => {
    const records = [{ ...skillCall(SKILL, 'call_s'), ...marker }];
    const located = locateSkillAnchors(records, [SKILL]);

    expect(located[SKILL].anchors[0].kind).toBe('subagent-skill-call');
  });

  it('reports a skill with no invocation as not-found instead of inventing an anchor', () => {
    const located = locateSkillAnchors([assistantText('nothing here')], [SKILL]);
    expect(located[SKILL]).toEqual({
      found: false,
      anchors: [],
      invocations: 0,
      spanEndIndex: null,
    });
  });
});

describe('renderEvidence', () => {
  it('keeps the invocation marker in the window, drops the body bulk, and stays inside the budget', () => {
    const records = bigSession();
    const budgetChars = 12_000;
    const located = locateSkillAnchors(records, [SKILL]);
    const render = renderEvidence(records, located, { budgetChars });

    // The anchor — the whole point of the window.
    expect(render.text).toContain('[tool_use Skill]');
    expect(render.text).toContain(`"skill":"${SKILL}"`);
    // The body collapses to its first heading …
    expect(render.text).toContain(`[skill body: ${SKILL}] # Session Start Skill`);
    // … and nothing beyond it survives.
    expect(render.text).not.toContain(DEEP_BODY_SENTINEL);
    // Thinking blocks are never rendered.
    expect(render.text).not.toContain('private reasoning');
    // The closing excerpt is present and separated by an elision marker.
    expect(render.text).toContain('closing line 8');
    expect(render.text).toContain('[…]');
    // Budget holds.
    expect(render.chars).toBeLessThanOrEqual(budgetChars);
    expect(render.chars).toBe(render.text.length);
    expect(render.perSkill[0]).toMatchObject({ skill: SKILL, found: true, invocations: 1 });
  });

  it('reports budget-insufficient skills instead of silently squeezing them', () => {
    const records = [
      skillCall('session-orchestrator:a', 'c1'),
      skillCall('session-orchestrator:b', 'c2'),
      skillCall('session-orchestrator:c', 'c3'),
    ];
    const skills = ['session-orchestrator:a', 'session-orchestrator:b', 'session-orchestrator:c'];
    const located = locateSkillAnchors(records, skills);

    // Pool after the closing reservation = 2000 → room for exactly ONE skill
    // at the 1500-character floor.
    const render = renderEvidence(records, located, {
      budgetChars: DEFAULT_CLOSING_CHARS + 2 * DEFAULT_MIN_PER_SKILL_CHARS - 1000,
      closingChars: DEFAULT_CLOSING_CHARS,
      minPerSkillChars: DEFAULT_MIN_PER_SKILL_CHARS,
    });

    expect(render.truncated).toBe(true);
    expect(render.skipped).toEqual([
      { skill: 'session-orchestrator:b', reason: 'budget-insufficient' },
      { skill: 'session-orchestrator:c', reason: 'budget-insufficient' },
    ]);
    expect(render.text).toContain('session-orchestrator:a');
  });
});

describe('readTranscriptRecords', () => {
  it('COUNTS a half-written line instead of silently skipping it', async () => {
    const dir = tmp();
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(assistantText('first')),
        '{"type":"assistant","message":{"content":[{"type":"text","te', // crash mid-write
        JSON.stringify(assistantText('second')),
        '', // trailing newline — NOT malformed
      ].join('\n'),
      'utf8',
    );

    const out = await readTranscriptRecords(path);

    expect(out.malformed_lines).toBe(1);
    expect(out.records).toHaveLength(2);
    expect(out.bytes).toBeGreaterThan(0);
  });

  it('returns an empty read (never throws) for a missing file', async () => {
    const out = await readTranscriptRecords(join(tmp(), 'absent.jsonl'));
    expect(out).toEqual({ records: [], malformed_lines: 0, bytes: 0 });
  });
});

describe('buildSkillEvidence', () => {
  it('carries malformed_lines into the returned source envelope', async () => {
    const dir = tmp();
    const path = join(dir, 'session.jsonl');
    const records = bigSession();
    writeFileSync(
      path,
      [...records.map((r) => JSON.stringify(r)), '{"type":"assistant","mess'].join('\n'),
      'utf8',
    );

    const evidence = await buildSkillEvidence({
      repoRoot: '/repo',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      skills: [SKILL],
      budgetChars: 12_000,
      transcriptPath: path,
    });

    expect(evidence.status).toBe('ok');
    expect(evidence.source.malformed_lines).toBe(1);
    expect(evidence.source.records).toBe(records.length);
    expect(evidence.text).toContain(`"skill":"${SKILL}"`);
    expect(evidence.chars).toBeLessThanOrEqual(12_000);
  });

  it('returns no-transcript with empty text when the transcript file is absent', async () => {
    const evidence = await buildSkillEvidence({
      repoRoot: '/repo',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      skills: [SKILL],
      transcriptPath: join(tmp(), 'absent.jsonl'),
    });

    expect(evidence.status).toBe('no-transcript');
    expect(evidence.text).toBe('');
    expect(evidence.skipped).toEqual([{ skill: SKILL, reason: 'no-transcript' }]);
  });

  it('returns no-evidence — not a closing-only window — when no anchor is found', async () => {
    const dir = tmp();
    const path = join(dir, 'session.jsonl');
    writeFileSync(
      path,
      Array.from({ length: 20 }, (_, i) => JSON.stringify(assistantText(`line ${i}`))).join('\n'),
      'utf8',
    );

    const evidence = await buildSkillEvidence({
      repoRoot: '/repo',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      skills: [SKILL],
      transcriptPath: path,
    });

    expect(evidence.status).toBe('no-evidence');
    expect(evidence.text).toBe('');
    expect(evidence.source.records).toBe(20);
  });
});
