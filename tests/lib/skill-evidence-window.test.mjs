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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // Bug this catches (#1421): with subagent records concatenated after the main
  // ones, the LAST `attributionSkill` hit of a coordinator-dispatched skill lands
  // inside a subagent file, so the skill's span end — and with it the third
  // rendered window — jumps out of the main transcript. Measured on session
  // 58f82af0: `wave-executor` moved from record 357 to record 7449, and that
  // single jump was 100 % of the character difference between the flag off and
  // on. `spanEndIndexMain` is the main-transcript-only twin the renderer uses
  // for coordinator-anchored skills.
  it('tracks a MAIN-transcript span end separately from the subagent one', () => {
    const records = [
      skillCall(SKILL, 'call_main'),
      toolResult('call_main'),
      assistantText('coordinator wrap-up', { attributionSkill: SKILL }), // index 2
      { ...assistantText('subagent wrap-up', { attributionSkill: SKILL }), _subagent: true }, // 3
    ];

    const loc = locateSkillAnchors(records, [SKILL])[SKILL];

    expect(loc.spanEndIndex).toBe(3);
    expect(loc.spanEndIndexMain).toBe(2);
  });

  // The other half of the same guarantee: with NO subagent records present —
  // the library default `includeSubagents: false` — the two fields are equal, so
  // #1421 changes nothing for every caller that never opted in.
  it('keeps both span-end fields identical when no subagent record is present', () => {
    const records = [
      skillCall(SKILL, 'call_main'),
      toolResult('call_main'),
      assistantText('coordinator wrap-up', { attributionSkill: SKILL }),
    ];

    const loc = locateSkillAnchors(records, [SKILL])[SKILL];

    expect(loc.spanEndIndex).toBe(2);
    expect(loc.spanEndIndexMain).toBe(loc.spanEndIndex);
  });

  it('reports a skill with no invocation as not-found instead of inventing an anchor', () => {
    const located = locateSkillAnchors([assistantText('nothing here')], [SKILL]);
    expect(located[SKILL]).toEqual({
      found: false,
      anchors: [],
      invocations: 0,
      spanEndIndex: null,
      spanEndIndexMain: null,
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

  /**
   * A session dir shaped like the real one: `<projects>/<sessionId>.jsonl` plus
   * `<projects>/<sessionId>/subagents/agent-<n>.jsonl`. Synthetic on purpose —
   * the operator's own transcripts are neither reproducible nor ours to read.
   */
  function sessionDir({ mainRecords, subagentFiles = {} }) {
    const dir = tmp();
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(join(dir, `${sid}.jsonl`), jsonl(mainRecords), 'utf8');
    const subDir = join(dir, sid, 'subagents');
    mkdirSync(subDir, { recursive: true });
    for (const [name, recs] of Object.entries(subagentFiles)) {
      writeFileSync(join(subDir, name), jsonl(recs), 'utf8');
    }
    return { projectsDir: dir, sessionId: sid };
  }

  // Bug this catches (#1412): a skill invoked ONLY inside a subagent leaves no
  // anchor in the main transcript, so the evidence window comes back empty and
  // `runSkillJudge` never dispatches — the skill is structurally unjudgeable
  // and the gap is invisible, because `no-evidence` reads exactly like "this
  // session did not use the skill".
  it('reaches a subagent-only skill ONLY with includeSubagents — no-evidence without it', async () => {
    const { projectsDir, sessionId } = sessionDir({
      mainRecords: [
        ...Array.from({ length: 8 }, (_, i) => assistantText(`coordinator line ${i}`)),
      ],
      subagentFiles: {
        'agent-w3-3.jsonl': [
          assistantText('subagent preamble'),
          skillCall(SKILL, 'call_sub'),
          toolResult('call_sub'),
          bodyRecord('# Session Start Skill\n\nbody inside the subagent'),
        ],
      },
    });

    const off = await buildSkillEvidence({
      repoRoot: '/repo',
      sessionId,
      projectsDir,
      skills: [SKILL],
    });
    expect(off.status).toBe('no-evidence');
    expect(off.text).toBe('');
    expect(off.source.records).toBe(8);

    const on = await buildSkillEvidence({
      repoRoot: '/repo',
      sessionId,
      projectsDir,
      skills: [SKILL],
      includeSubagents: true,
    });
    expect(on.status).toBe('ok');
    expect(on.source.records).toBe(12);
    expect(on.text).toContain(`"skill":"${SKILL}"`);
    expect(on.perSkill).toEqual([
      expect.objectContaining({ skill: SKILL, found: true, invocations: 1 }),
    ]);
  });

  // Bug this catches (#1412 budget guard): the newly admitted subagent-only
  // skill takes an equal share of ONE shared pool, pushing a coordinator skill
  // that was rendered before the flag flip past the `minPerSkillChars` floor —
  // decided purely by its position in the requested-skills array.
  it('never lets a subagent-only skill displace a coordinator skill, and says so', async () => {
    const { projectsDir, sessionId } = sessionDir({
      mainRecords: [skillCall('session-orchestrator:coord', 'c1'), toolResult('c1')],
      subagentFiles: {
        'agent-1.jsonl': [skillCall('session-orchestrator:subonly', 's1'), toolResult('s1')],
      },
    });
    const skills = ['session-orchestrator:subonly', 'session-orchestrator:coord'];

    // Pool after the closing reservation = 2000 → room for exactly ONE skill at
    // the 1500-character floor. `subonly` is FIRST in the requested array.
    const evidence = await buildSkillEvidence({
      repoRoot: '/repo',
      sessionId,
      projectsDir,
      skills,
      includeSubagents: true,
      budgetChars: DEFAULT_CLOSING_CHARS + 2 * DEFAULT_MIN_PER_SKILL_CHARS - 1000,
    });

    expect(evidence.status).toBe('ok');
    expect(evidence.text).toContain('### session-orchestrator:coord');
    expect(evidence.text).not.toContain('### session-orchestrator:subonly');
    // The shortfall stays VISIBLE — a silently shortened window is the failure.
    expect(evidence.truncated).toBe(true);
    expect(evidence.skipped).toEqual([
      { skill: 'session-orchestrator:subonly', reason: 'budget-insufficient' },
    ]);
  });

  // Bug this catches (#1412): subagent records are CONCATENATED after the main
  // ones, so a closing excerpt taken from the end of the joined array renders
  // the tail of the last subagent file under the heading "session closing" —
  // mislabelled evidence, which is worse for a judge than none.
  it('takes the session-closing excerpt from the MAIN transcript, not the last subagent file', async () => {
    const { projectsDir, sessionId } = sessionDir({
      mainRecords: [
        skillCall(SKILL, 'call_main'),
        toolResult('call_main'),
        ...Array.from({ length: 14 }, (_, i) => assistantText(`main closing line ${i}`)),
      ],
      subagentFiles: {
        'agent-1.jsonl': Array.from({ length: 14 }, (_, i) =>
          assistantText(`subagent tail line ${i}`),
        ),
      },
    });

    const evidence = await buildSkillEvidence({
      repoRoot: '/repo',
      sessionId,
      projectsDir,
      skills: [SKILL],
      includeSubagents: true,
    });

    const closing = evidence.text.slice(evidence.text.indexOf('### session closing'));
    expect(closing).toContain('main closing line 13');
    expect(closing).not.toContain('subagent tail line');
  });

  // Bug this catches (#1421): a COORDINATOR-dispatched skill whose work also
  // carries `attributionSkill` inside a subagent file ends its evidence window
  // in that subagent file, because the subagent records are concatenated after
  // the main ones and the last hit wins. The renderer then hands the judge a
  // third window from a transcript the coordinator never wrote. Measured on
  // session 58f82af0: `wave-executor`'s span end moved 357 → 7449 and accounted
  // for 100 % of the character difference between the flag off and on.
  it('ends a coordinator-anchored skill window in the MAIN transcript, not in a subagent file', async () => {
    const SUBAGENT_SPAN_SENTINEL = 'SUBAGENT-SPAN-END-SENTINEL-1421';
    const { projectsDir, sessionId } = sessionDir({
      mainRecords: [
        skillCall(SKILL, 'call_main'),
        toolResult('call_main'),
        ...Array.from({ length: 6 }, (_, i) => assistantText(`main line ${i}`)),
        assistantText('coordinator span end', { attributionSkill: SKILL }),
      ],
      subagentFiles: {
        'agent-1.jsonl': [
          assistantText('subagent line 0'),
          assistantText('subagent line 1'),
          assistantText(SUBAGENT_SPAN_SENTINEL, { attributionSkill: SKILL }),
          assistantText('subagent line 3'),
        ],
      },
    });

    const evidence = await buildSkillEvidence({
      repoRoot: '/repo',
      sessionId,
      projectsDir,
      skills: [SKILL],
      includeSubagents: true,
    });

    expect(evidence.status).toBe('ok');
    // The skill is coordinator-anchored — its own section must stay on the
    // coordinator's transcript.
    expect(evidence.text).toContain('coordinator span end');
    expect(evidence.text).not.toContain(SUBAGENT_SPAN_SENTINEL);
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

/**
 * The library default `includeSubagents: false` is deliberate (fail-closed for
 * every caller), and the ONE production caller opts in explicitly. Both halves
 * are load-bearing and neither lives in a `.mjs` file: the caller is prose in
 * `skills/session-end/phase-3-6-tail.md`, so no import graph, no typechecker and
 * no test in this suite would notice it losing the flag.
 *
 * The default half is pinned behaviourally above by "reaches a subagent-only
 * skill ONLY with includeSubagents". This block pins the other half — the CALL,
 * not the prose around it (TV-002c: asserting a sentence is present pins prose;
 * this extracts the argument object of the `buildSkillEvidence({ … })`
 * invocation and asserts what it passes). Same shape as
 * `scripts/lib/validate/check-validator-registration.mjs`, which pins validator
 * basenames at their run surfaces rather than in documentation about them.
 */
describe('production wiring pin — skills/session-end/phase-3-6-tail.md', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const TAIL_DOC = join(REPO_ROOT, 'skills', 'session-end', 'phase-3-6-tail.md');

  /** Every `buildSkillEvidence({ … })` argument object in `text`, brace-balanced. */
  function extractCalls(text) {
    const marker = 'buildSkillEvidence({';
    const calls = [];
    for (let from = 0; ; ) {
      const at = text.indexOf(marker, from);
      if (at === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = at + marker.length - 1; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break;
      calls.push(text.slice(at, end + 1));
      from = end + 1;
    }
    return calls;
  }

  // Bug this catches (#1412): the single production call silently falls back to
  // the library default `false`. Nothing breaks, nothing errors — the phase just
  // reports `no-evidence` for every subagent-dispatched skill, which reads
  // exactly like "this session did not use the skill" (#1399 blindness). Measured
  // over the 94 base pairs of the s9 manifest: 71/83 positives found with the
  // default, 83/83 with the flag — the 12 misses are exactly the
  // `status: subagent-only` pairs.
  it('passes includeSubagents: true at the ONE production call site', () => {
    const calls = extractCalls(readFileSync(TAIL_DOC, 'utf8'));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/includeSubagents:\s*true/);
  });
});
