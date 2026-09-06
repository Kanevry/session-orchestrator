/**
 * tests/hooks/post-subagent-discovery-validator.test.mjs
 *
 * Tests for hooks/post-subagent-discovery-validator.mjs (#567).
 *
 * The hook is a NON-BLOCKING SubagentStop validator (PSA-006): it resolves the
 * STOPPING SUBAGENT's own transcript from `input.transcript_path` + `agent_id`
 * (#1191 — the parent transcript is never scanned), scans the tail of assistant records for
 * distributional-claim regexes, and — when a claim lacks an adjacent fenced
 * grep/rg/find block — appends a `discovery_validator_violation` record to
 * .orchestrator/metrics/events.jsonl + writes a stderr WARN. Exit 0 ALWAYS.
 * Gated OFF by default (opt-in) via the `discovery-validator.enabled`
 * Session-Config key — absent block included (#1191).
 *
 * Strategy (mirrors tests/hooks/subagent-telemetry.test.mjs): spawn the hook
 * via node with stdin piped, CLAUDE_PROJECT_DIR pointing to a tmp sandbox, and
 * a transcript JSONL written into that sandbox. Assert exit code + the contents
 * of events.jsonl (behaviour, not implementation).
 *
 * Coverage:
 *   - DISABLED (default): SubagentStop payload → exit 0, NO event written.
 *   - ENABLED + claim WITH adjacent grep block → exit 0, NO violation.
 *   - ENABLED + bare distributional claim → exit 0, violation appended.
 *   - ENABLED + each of the 6 patterns: positive (real claim flags) +
 *     negative false-positive cases ("Turn 3 of 25 complete" / "every developer
 *     should test" must NOT flag — locks in FIX 1 regex tightening).
 *   - ±5-line adjacency boundary (5 lines away → OK; 6 lines away → violation).
 *   - Missing / malformed transcript_path → exit 0, no crash, no event.
 *   - Non-SubagentStop event → exit 0, no scan.
 *   - session_id precedence: event uses parent_session_id when both present
 *     (locks in FIX 2).
 *   - additionalContext dedup only applies to repeated real
 *     (project, session, agent) contexts; missing session ids never create a
 *     global sentinel, and different project roots do not collide.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dedupeViolations,
  findViolations,
  normalizeClaim,
} from '../../hooks/_lib/subagent-transcript.mjs';

const HOOK = new URL('../../hooks/post-subagent-discovery-validator.mjs', import.meta.url).pathname;
const EVENTS_REL = join('.orchestrator', 'metrics', 'events.jsonl');
const TRANSCRIPT_REL = 'transcript.jsonl';
// The harness keeps each subagent's own transcript beside the parent one:
// <dir>/<base>/subagents/agent-<agent_id>.jsonl. Since #1191 the hook reads
// THAT file, so every fixture writes there and every payload carries agent_id.
const AGENT_ID = 'a1';
const SUBAGENTS_REL = join('transcript', 'subagents');

const CLAUDE_MD_ENABLED = [
  '# Sandbox',
  '',
  'discovery-validator:',
  '  enabled: true',
  '',
].join('\n');

const CLAUDE_MD_DISABLED = [
  '# Sandbox',
  '',
  'discovery-validator:',
  '  enabled: false',
  '',
].join('\n');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'discovery-validator-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

/**
 * Write a transcript JSONL into the sandbox composed of one assistant record
 * per supplied text block. Returns the absolute path.
 */
function writeTranscript(textBlocks, agentId = AGENT_ID) {
  writeAgentTranscript(textBlocks, agentId);
  // The payload's transcript_path stays the PARENT path — the hook derives the
  // subagent file from it. The parent file itself is never read.
  return join(tmp, TRANSCRIPT_REL);
}

/** Write a subagent transcript at the harness's derived location. */
function writeAgentTranscript(textBlocks, agentId = AGENT_ID) {
  const records = textBlocks.map((text) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }));
  const dir = join(tmp, SUBAGENTS_REL);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

/** Write the PARENT/main transcript (which the hook must never scan). */
function writeMainTranscript(textBlocks) {
  const records = textBlocks.map((text) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }));
  const path = join(tmp, TRANSCRIPT_REL);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

/** Write CLAUDE.md into the sandbox so isEnabled() can read it. */
function writeClaudeMd(content) {
  writeFileSync(join(tmp, 'CLAUDE.md'), content, 'utf8');
}

/** Spawn the hook with the given stdin payload object. */
function runHook(payloadObj) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payloadObj),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmp,
      SO_HOOK_PROFILE: 'full',
      SO_DISABLED_HOOKS: '',
    },
    timeout: 10_000,
  });
}

function runHookAsync(payloadObj) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmp,
        SO_HOOK_PROFILE: 'full',
        SO_DISABLED_HOOKS: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payloadObj));
  });
}

/** Read + parse the events.jsonl violation records (skips blank lines). */
function readEvents() {
  const path = join(tmp, EVENTS_REL);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Standard SubagentStop payload pointing at a transcript. */
function stopPayload(transcriptPath, extra = {}) {
  return {
    hook_event_name: 'SubagentStop',
    agent_type: 'discovery',
    agent_id: AGENT_ID,
    transcript_path: transcriptPath,
    ...extra,
  };
}

describe('post-subagent-discovery-validator hook', () => {
  it('DISABLED (default): SubagentStop with a bare claim → exit 0, NO event and NO stdout', () => {
    // Merged from two tests that spawned the hook on the same DISABLED path and
    // asserted one output channel each. Both channels must stay silent: an
    // event write leaks a violation the operator never opted into, and a stdout
    // write feeds additionalContext back to a subagent under a disabled gate.
    writeClaudeMd(CLAUDE_MD_DISABLED);
    const transcript = writeTranscript(['We confirmed 4 of 4 callers opt-in to the new API.']);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
    expect(result.stdout.trim()).toBe('');
  });

  it('ABSENT block (opt-in default): SubagentStop with a bare claim → exit 0, NO event and NO stdout', () => {
    // #1191: the DISABLED case above pins an EXPLICIT `enabled: false`. The
    // absent-block default — the state every repo but this one is in — was
    // never tested, which is how the #690 flip to ON shipped and produced
    // 6,946 violation events across 18 repos that never opted in.
    writeClaudeMd(['# Sandbox', '', 'persistence: true', ''].join('\n'));
    const transcript = writeTranscript(['We confirmed 4 of 4 callers opt-in to the new API.']);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
    expect(result.stdout.trim()).toBe('');
  });

  // -------------------------------------------------------------------------
  // #1191 — WHICH transcript is scanned. The hook used to read
  // input.transcript_path (the COORDINATOR's transcript); a seeded random
  // sample of 60 fleet violations was 100% coordinator prose. These two cases
  // pin both directions of the fix.
  // -------------------------------------------------------------------------

  it('ENABLED + claim only in the MAIN transcript → exit 0, NO violation (coordinator prose is never scanned)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeMainTranscript(['The repo has 14 commits since the session-start ref.']);
    writeAgentTranscript(['Read three files and applied the edit. Nothing to report.']);

    const result = runHook(stopPayload(join(tmp, TRANSCRIPT_REL)));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('ENABLED + claim in the SUBAGENT transcript → violation carrying agent_id', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeMainTranscript(['Dispatching wave 2. Nothing measurable here.']);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.']);

    const result = runHook(stopPayload(join(tmp, TRANSCRIPT_REL)));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].agent_id).toBe(AGENT_ID);
    expect(events[0].claim_text).toBe('The repo has 14 commits since the session-start ref.');
  });

  it('ENABLED + no agent_id → exit 0, no scan, no event (never falls back to the parent transcript)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeMainTranscript(['The repo has 14 commits since the session-start ref.']);

    const result = runHook({
      hook_event_name: 'SubagentStop',
      agent_type: 'discovery',
      transcript_path: join(tmp, TRANSCRIPT_REL),
    });

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('ENABLED + a 65-char agent_id → exit 0, no scan, no event (Q2-F8 length bound)', () => {
    // hooks/on-stop.mjs bounds the IDENTICAL value at {1,64} and says why: the
    // id lands verbatim in the event below and travels the optional webhook.
    // The charset guard here had no length bound at all.
    const longId = 'a'.repeat(65);
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.'], longId);

    const result = runHook(stopPayload(join(tmp, TRANSCRIPT_REL), { agent_id: longId }));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('ENABLED + a structured agentType in the meta sidecar → falls back to "unknown" (Q1-LOW-F3)', () => {
    // The meta-derived agent type reaches BOTH the event and the model-visible
    // additionalContext string, so it is clamped with the same regex on-stop.mjs
    // uses — omit on mismatch, never truncate; the caller then records the
    // honest 'unknown'.
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.']);
    writeFileSync(
      join(tmp, SUBAGENTS_REL, `agent-${AGENT_ID}.meta.json`),
      JSON.stringify({ agentType: 'discovery\n{"injected":true}' }),
      'utf8',
    );

    const result = runHook({
      hook_event_name: 'SubagentStop',
      agent_id: AGENT_ID,
      transcript_path: join(tmp, TRANSCRIPT_REL),
    });

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe('unknown');
    expect(result.stdout).not.toContain('injected');
  });

  it('ENABLED + a plugin-qualified agentType in the meta sidecar → kept verbatim (colon is the real shape)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.']);
    writeFileSync(
      join(tmp, SUBAGENTS_REL, `agent-${AGENT_ID}.meta.json`),
      JSON.stringify({ agentType: 'session-orchestrator:code-implementer' }),
      'utf8',
    );

    const result = runHook({
      hook_event_name: 'SubagentStop',
      agent_id: AGENT_ID,
      transcript_path: join(tmp, TRANSCRIPT_REL),
    });

    expect(result.status).toBe(0);
    expect(readEvents()[0].agent).toBe('session-orchestrator:code-implementer');
  });

  // -------------------------------------------------------------------------
  // #1218 — ATTRIBUTION PROVENANCE. `agent: "unknown"` on 3,026 of 3,360 fleet
  // records (90.1%, measured 2026-09-06 in
  // extern/aiat-barrierefrei-engine/.orchestrator/metrics/events.jsonl) said
  // nothing about WHY: it is indistinguishable from a real agent type named
  // "unknown", and from a resolution that was never attempted. Every record now
  // carries `agent_source`, and the no-answer case carries the stdin keys the
  // harness DID send.
  // -------------------------------------------------------------------------

  it('#1218 agent_type in the payload → agent_source "payload"', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.']);

    const result = runHook(stopPayload(join(tmp, TRANSCRIPT_REL), { agent_type: 'discovery' }));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events[0].agent).toBe('discovery');
    expect(events[0].agent_source).toBe('payload');
  });

  it('#1218 no agent_type but a sidecar meta → agent_source "meta" + the description that identifies the agent', () => {
    // Measured 2026-09-06 over 20 real agent-*.meta.json sidecars in this
    // repo's own session directory: 14 carry the useless class
    // `general-purpose`, only 6 a plugin-qualified type. `description` is what
    // actually names the agent, so it is carried alongside the type.
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.']);
    writeFileSync(
      join(tmp, SUBAGENTS_REL, `agent-${AGENT_ID}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'W1-d5 Scripts-Audit',
        toolUseId: 'toolu_01X2kckU679yMpcMGsqNk4km',
      }),
      'utf8',
    );

    const result = runHook({
      hook_event_name: 'SubagentStop',
      agent_id: AGENT_ID,
      transcript_path: join(tmp, TRANSCRIPT_REL),
    });

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events[0].agent).toBe('general-purpose');
    expect(events[0].agent_source).toBe('meta');
    expect(events[0].agent_description).toBe('W1-d5 Scripts-Audit');
  });

  it('#1218 neither payload nor sidecar → agent_source "none" + the sorted payload keys that WERE sent', () => {
    // The honest gap. Without the key list the ledger cannot distinguish
    // "harness sent no agent_type" from "the sidecar was unreadable", which is
    // exactly the question the 90.1% could not answer.
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.']);

    const result = runHook({
      hook_event_name: 'SubagentStop',
      agent_id: AGENT_ID,
      transcript_path: join(tmp, TRANSCRIPT_REL),
    });

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events[0].agent).toBe('unknown');
    expect(events[0].agent_source).toBe('none');
    expect(events[0].payload_keys).toEqual(['agent_id', 'hook_event_name', 'transcript_path']);
  });

  it('#1218 payload_keys carries KEYS ONLY — never a value', () => {
    // The record exists to attribute a claim; a value could smuggle a path or
    // prose into it that has no business being there.
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.']);

    const result = runHook({
      hook_event_name: 'SubagentStop',
      agent_id: AGENT_ID,
      transcript_path: join(tmp, TRANSCRIPT_REL),
      cwd: '/Users/secret/private-project',
    });

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events[0].payload_keys).toContain('cwd');
    expect(JSON.stringify(events[0])).not.toContain('private-project');
  });

  it('#1218 a control character in the sidecar description is replaced, never carried', () => {
    // A NUL in a tracked artefact makes it invisible to every grep-based audit
    // (see .claude/rules/anti-pattern-a-nul-byte-…). events.jsonl is such an
    // artefact and the description is harness-written prose we do not control.
    writeClaudeMd(CLAUDE_MD_ENABLED);
    writeAgentTranscript(['The repo has 14 commits since the session-start ref.']);
    writeFileSync(
      join(tmp, SUBAGENTS_REL, `agent-${AGENT_ID}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', description: 'W1 d5\nAudit' }),
      'utf8',
    );

    const result = runHook({
      hook_event_name: 'SubagentStop',
      agent_id: AGENT_ID,
      transcript_path: join(tmp, TRANSCRIPT_REL),
    });

    expect(result.status).toBe(0);
    expect(readEvents()[0].agent_description).toBe('W1 d5 Audit');
  });

  it('ENABLED + claim WITH an adjacent grep block → exit 0, NO violation', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      [
        'Verified the scope:',
        '```bash',
        'grep -rn "canonicalizeRoot" hooks/ scripts/',
        '```',
        'Result: 4 of 4 callers opt-in to canonicalizeRoot.',
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('ENABLED + bare distributional claim (no grep block) → exit 0, violation appended', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      'Result: 4 of 4 callers opt-in to canonicalizeRoot. No grep was run.',
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('discovery_validator_violation');
    expect(events[0].agent).toBe('discovery');
    expect(events[0].claim_text).toBe(
      'Result: 4 of 4 callers opt-in to canonicalizeRoot. No grep was run.'
    );
    expect(typeof events[0].timestamp).toBe('string');
  });

  it('ENABLED + a grep block exactly 5 lines from the claim → OK (within ±5 boundary)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    // grep block's closing fence is on a line, claim is exactly 5 lines below it.
    const transcript = writeTranscript([
      [
        '```bash', // line 0
        'grep -rn "foo" src/', // line 1
        '```', // line 2  ← closing fence (a grep-block line)
        'filler a', // line 3
        'filler b', // line 4
        'filler c', // line 5
        'filler d', // line 6
        'all 4 callers verified.', // line 7  → 7 - 2 = 5 lines from grep block → within ±5
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('ENABLED + a grep block 6 lines from the claim → violation (outside ±5 boundary)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      [
        '```bash', // line 0
        'grep -rn "foo" src/', // line 1
        '```', // line 2  ← closing fence (a grep-block line)
        'filler a', // line 3
        'filler b', // line 4
        'filler c', // line 5
        'filler d', // line 6
        'filler e', // line 7
        'all 4 callers verified.', // line 8  → 8 - 2 = 6 lines from grep block → outside ±5
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].claim_text).toBe('all 4 callers verified.');
  });

  it('missing transcript_path → exit 0, no crash, no event', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);

    const result = runHook({ hook_event_name: 'SubagentStop', agent_type: 'discovery' });

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('malformed transcript_path (nonexistent file) → exit 0, no crash, no event', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);

    const result = runHook(stopPayload(join(tmp, 'does-not-exist.jsonl')));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('non-SubagentStop event → exit 0, no scan, no event', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['Result: 4 of 4 callers opt-in. No grep here.']);

    const result = runHook(stopPayload(transcript, { hook_event_name: 'SubagentStart' }));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // FIX 2 — session_id precedence. Two former tests differing only in which ids
  // the payload carries: the event must be filed under the COORDINATOR's
  // session, so a violation lands in the ledger the operator reads rather than
  // under a per-subagent id nothing queries.
  it.each([
    {
      why: 'parent_session_id wins when both ids are present',
      ids: { parent_session_id: 'main-2026-05-27-deep-3', session_id: 'sub-agent-999' },
      expected: 'main-2026-05-27-deep-3',
    },
    {
      why: 'session_id is used when parent_session_id is absent',
      ids: { session_id: 'sub-agent-only-777' },
      expected: 'sub-agent-only-777',
    },
  ])('session_id precedence: $why (FIX 2)', ({ ids, expected }) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['Result: 4 of 4 callers opt-in. No grep was run.']);

    const result = runHook(stopPayload(transcript, ids));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // The 6 distributional-claim patterns — positive (real code claim flags).
  // Each claim has NO adjacent grep block, so each MUST produce a violation.
  // -------------------------------------------------------------------------

  it.each([
    ['N of M + ctx', '4 of 4 callers opt-in to the helper.'],
    ['100% of + ctx', '100% of call sites use the new pattern.'],
    ['all N + ctx', 'all 12 imports were updated.'],
    ['no remaining + ctx', 'no remaining references to the old API.'],
    ['every + ctx', 'every caller imports the shared module.'],
    ['none of + ctx', 'none of the consumers import it directly.'],
  ])('POSITIVE pattern "%s": flags a violation', (_label, claim) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([claim]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].claim_text).toBe(claim);
  });

  // -------------------------------------------------------------------------
  // FIX 1 — false-positive lock-in. These benign strings MUST NOT flag.
  // -------------------------------------------------------------------------

  it.each([
    ['turn counter', 'Turn 3 of 25 complete'],
    ['generic advice', 'every developer should test their code'],
    ['non-code "every"', 'every engineer on the team agrees'],
    ['non-code "N of M"', 'I rate this 3 of 5 stars'],
    ['non-code "100% of"', '100% of users love the redesign'],
    ['non-code "none of"', 'none of your business'],
    ['non-code "no remaining"', 'there is no remaining time today'],
    ['non-code "all N"', 'all 4 reasons are listed below'],
  ])('NEGATIVE false-positive "%s": does NOT flag', (_label, benign) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([benign]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // (a) Multi-violation count: 2 distinct distributional-claim patterns in
  // the same transcript (NEITHER with adjacent grep) → both flagged via the
  // multi-violation loop at hook:305-313.
  // -------------------------------------------------------------------------

  it('ENABLED + two distinct bare claims → two violation events appended', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const claim1 = '4 of 4 callers opt-in to the helper.';
    const claim2 = 'no remaining references to the old API.';
    const transcript = writeTranscript([
      [
        claim1,
        '',
        'Some narrative prose without any grep verification.',
        '',
        claim2,
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(2);
    expect(events[0].claim_text).toBe(claim1);
    expect(events[1].claim_text).toBe(claim2);
  });

  // -------------------------------------------------------------------------
  // (c) additionalContext feed-back (#666 — v2.1.163+) and the channel split
  //
  // On a violation the hook writes THREE times, to TWO different recipients:
  //   1. events.jsonl `discovery_validator_violation`  → the coordinator
  //   2. the stderr WARN                               → the coordinator
  //   3. stdout hookSpecificOutput.additionalContext   → the STOPPING SUBAGENT
  //
  // (3) does NOT reach the coordinator. Verified in the shipped binary (Claude
  // Code 2.1.241, 2026-08-23): the SubagentStop schema reads "additionalContext
  // is non-error feedback delivered to the subagent; the subagent continues so
  // it can act on it", and the emitter selects with `i.agentId ? … : …`. The
  // delivery note at the hook's hookSpecificOutput write carries the full
  // quote. PSA-006 makes REJECTING an unverified claim the coordinator's duty,
  // so (1) + (2) are the rule's only enforcement path.
  //
  // TV-001, the bug the three-channel test below catches: a refactor that
  // "consolidates" the warning into additionalContext alone — a plausible
  // cleanup, since all three carry the identical warnText — would silently
  // delete both coordinator-visible signals while leaving every stdout
  // assertion in this file green. Pinning stderr alongside stdout + the event
  // makes that refactor RED. Before this test, `expect(...stderr...)` appeared
  // ZERO times in this file (measured 2026-08-25, `grep -n "expect(.*stderr"`
  // → no matches), so channel (2) was entirely unasserted.
  //
  // On a clean path (no violation) stdout must be empty.
  // -------------------------------------------------------------------------

  it('ENABLED + violation → all three channels fire: events.jsonl + stderr WARN (coordinator) and stdout additionalContext (subagent)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['4 of 4 callers opt-in to the helper. No grep was run.']);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);

    // (1) coordinator channel — events.jsonl write still happens (additive,
    //     never replaced by additionalContext)
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('discovery_validator_violation');
    expect(events[0].claim_text).toBe(
      '4 of 4 callers opt-in to the helper. No grep was run.'
    );

    // (2) coordinator channel — the stderr WARN naming the rule and the agent
    expect(result.stderr).toContain('PSA-006');
    expect(result.stderr).toContain('discovery');

    // (3) subagent channel — stdout carries the hookSpecificOutput JSON
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SubagentStop');
    expect(typeof out.hookSpecificOutput.additionalContext).toBe('string');
    expect(out.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
    // must not set decision:"block" (non-blocking always)
    expect(out.decision).toBeUndefined();

    // Same finding on both routes: the subagent's copy is the coordinator's
    // WARN verbatim. Collapsing (2) into (3) therefore cannot stay green.
    expect(result.stderr).toContain(out.hookSpecificOutput.additionalContext);
  });

  it('ENABLED + violation → additionalContext mentions PSA-006 and the agent name', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['no remaining references to the old API.']);

    const result = runHook(stopPayload(transcript, { agent_type: 'my-discovery-agent' }));

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('PSA-006');
    expect(out.hookSpecificOutput.additionalContext).toContain('my-discovery-agent');
  });

  it('ENABLED + missing session id → does not deduplicate additionalContext or event appends', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['4 of 4 callers opt-in to the helper. No grep was run.']);
    const payload = stopPayload(transcript);

    const first = runHook(payload);
    const second = runHook(payload);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain('PSA-006');
    expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toContain('PSA-006');

    const events = readEvents();
    expect(events).toHaveLength(2);
    expect(events[0].session_id).toBeUndefined();
    expect(events[1].session_id).toBeUndefined();
  });

  it('ENABLED + repeated real context → ONE ledger record, and only the first additionalContext (#1198)', () => {
    // The pre-#1198 assertion here was `toHaveLength(2)`: the same claim, from
    // the same session, wrote a second identical record every time a subagent
    // stopped. That is the mechanism behind the measured duplication factor of
    // 16.4 (3,360 records over 205 distinct claim_text values, 2026-09-06,
    // extern/aiat-barrierefrei-engine). The ledger is a record of DISTINCT
    // findings; the second write added no information and cost a record.
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['4 of 4 callers opt-in to the helper. No grep was run.']);
    const payload = stopPayload(transcript, {
      agent_type: 'dedup-discovery-agent',
      session_id: 'dedup-session-001',
    });

    const first = runHook(payload);
    const second = runHook(payload);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain(
      'dedup-discovery-agent'
    );
    expect(second.stdout.trim()).toBe('');

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('dedup-session-001');
    // The stderr WARN still fires on the repeat — it is the coordinator's
    // channel, and it names the suppression rather than hiding it.
    expect(second.stderr).toContain('already recorded earlier in this session');
  });

  it('ENABLED + concurrent repeated real context → ONE ledger record across 8 racing processes (#1198)', async () => {
    // Cross-process: the ledger sentinel is an atomic `wx` create, so exactly
    // one of eight concurrent hook processes may write the claim. Pre-#1198
    // this asserted 8 records for one finding.
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['4 of 4 callers opt-in to the helper. No grep was run.']);
    const payload = stopPayload(transcript, {
      agent_type: 'parallel-dedup-agent',
      session_id: 'parallel-dedup-session-001',
    });

    const results = await Promise.all(Array.from({ length: 8 }, () => runHookAsync(payload)));

    expect(results.every((r) => r.status === 0)).toBe(true);
    const stdoutCount = results.filter((r) => r.stdout.trim().length > 0).length;
    expect(stdoutCount).toBe(1);

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events.every((e) => e.session_id === 'parallel-dedup-session-001')).toBe(true);
  });

  it('ENABLED + the SAME claim repeated inside one transcript tail → ONE record carrying occurrences (#1198)', () => {
    // The second duplication source: one agent restating its own finding in a
    // progress note and again in its final report. `findViolations()` collapses
    // them on the normalized key and counts them, so the ledger keeps the
    // frequency without keeping the copies. Note the differing bullet markers —
    // normalisation strips them, which is what makes the two shapes one key.
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      [
        '- 4 of 4 callers opt-in to the helper.',
        'Some intervening prose that measures nothing.',
        '* 4 of 4 callers opt-in to the helper.',
        'More prose.',
        '4 of 4 callers   opt-in to the helper.',
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript, { session_id: 'occurrences-session-001' }));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].occurrences).toBe(3);
  });

  it('ENABLED + same session and agent in different project roots → both emit additionalContext', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['4 of 4 callers opt-in to the helper. No grep was run.']);

    const first = runHook(stopPayload(transcript, {
      agent_type: 'project-isolated-agent',
      session_id: 'project-isolated-session',
    }));

    const originalTmp = tmp;
    const otherTmp = mkdtempSync(join(tmpdir(), 'discovery-validator-test-'));
    try {
      tmp = otherTmp;
      writeClaudeMd(CLAUDE_MD_ENABLED);
      const otherTranscript = writeTranscript([
        '4 of 4 callers opt-in to the helper. No grep was run.',
      ]);

      const second = runHook(stopPayload(otherTranscript, {
        agent_type: 'project-isolated-agent',
        session_id: 'project-isolated-session',
      }));

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain(
        'project-isolated-agent'
      );
      expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toContain(
        'project-isolated-agent'
      );
      expect(readEvents()).toHaveLength(1);
    } finally {
      tmp = originalTmp;
      rmSync(otherTmp, { recursive: true, force: true });
    }

    expect(readEvents()).toHaveLength(1);
  });

  it('ENABLED + NO violation (adjacent grep block present) → stdout is empty (no additionalContext)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      [
        '```bash',
        'grep -rn "canonicalizeRoot" hooks/ scripts/',
        '```',
        '4 of 4 callers use canonicalizeRoot.',
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
    expect(result.stdout.trim()).toBe('');
  });

  // -------------------------------------------------------------------------
  // (b) TAIL_RECORDS=8 boundary: 10 assistant records — a bare claim in
  // record #1 (outside the last-8 window → NOT scanned) and a bare claim in
  // the last record (in-window → flagged). Only the in-window claim appears
  // in events.jsonl.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // #908 — bare-cardinal repo-state facts.
  //
  // Bug caught: a Discovery brief stating "14 commits" / "92 learnings" /
  // "5 dirty files" / "412 lines" carried NO quantifier trigger, so the six
  // #567 patterns were structurally blind to it. That is the exact drift the
  // #908 session recorded (briefed 9 commits vs. actual 14, briefed 40
  // learnings vs. actual 92) — the coordinator propagated stale numbers into
  // every Impl prompt for hours.
  // -------------------------------------------------------------------------

  it.each([
    ['commit count', 'The repo has 14 commits since the session-start ref.'],
    ['learnings count', 'The metrics store holds 92 learnings.'],
    ['dirty-file count', 'The working tree shows 5 dirty files.'],
    ['line count', 'The largest module is 412 lines.'],
  ])('#908 bare cardinal "%s" without a measurement block → violation', (_label, claim) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([claim]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].claim_text).toBe(claim);
  });

  // -------------------------------------------------------------------------
  // #908 — the extended MEASUREMENT command set.
  //
  // Bug caught: repo-state counts are measured with `git log | wc -l`, `jq`
  // over a JSONL metrics file or `git status --porcelain`, none of which the
  // grep/rg/find-only fence check recognised. An agent that DID quote its
  // measurement was still reported as a violator — punishing the honest path
  // is how a warn-only validator earns its way onto the ignore list.
  // -------------------------------------------------------------------------

  it('#908 four repo-state facts WITH a git/wc/jq measurement block → no violation', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      [
        'Measured 2026-07-29 at HEAD:',
        '```bash',
        'git log --oneline session-start..HEAD | wc -l',
        'jq -s length .orchestrator/metrics/learnings.jsonl',
        'git status --porcelain | wc -l',
        '```',
        'The repo has 14 commits, 92 learnings and 5 dirty files.',
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
    expect(result.stdout.trim()).toBe('');
  });

  it('#908 inline-code measurement quote counts as evidence (no fence required)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      'Counted with `git log --oneline | wc -l` → 14 commits.',
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // #908 — false-positive lock-in for the greedy cardinal pattern.
  //
  // Bug caught: an unguarded `\d+ <noun>` fires on every issue reference,
  // version literal, ISO date, line-number suffix, percentage and slash-
  // separated gate summary in a normal report. A validator that flags every
  // report gets switched off — strictly worse than no validator at all.
  // Measured over 32 real agent-stop windows from this repo's transcripts,
  // the unguarded variant fired 93 times (2.9 per stop).
  // -------------------------------------------------------------------------

  it.each([
    ['issue reference', 'Fixes #906 and #908 in this wave.'],
    ['version literal', 'Shipped in v3.17.0 with 2 follow-ups tracked.'],
    ['line-number suffix', 'See hooks/post-subagent-discovery-validator.mjs:162 for the gate.'],
    ['ISO date', 'The gate ran green on 2026-07-29 across the fleet.'],
    ['percentage', 'Coverage sits at 70% across the board.'],
    ['slash-separated summary', 'Full Gate reported 12615/0/11 on the last SHA.'],
    ['rule identifier', 'PSA-006 and PSA-007 both apply to this wave.'],
    ['inline-code span', 'Use `14 commits` as the example string in the docs.'],
    ['stopword between number and noun', 'The summary lists 2 sections below the commits table.'],
  ])('#908 false-positive class "%s": does NOT flag', (_label, benign) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([benign]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('#908 numbers inside a fenced tool-output block are evidence, not claims', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      ['Captured output:', '```text', '5129 files changed', '12 commits pending', '```'].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('#908 "every <repo-state noun>" stays out of scope (no numeric anchor)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      'every commit must be signed and every rule is always-on',
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // #908 — measurement-TIMESTAMP advisory (Baustein 2 input).
  //
  // Bug caught: an undated measurement is indistinguishable from a fresh one,
  // which is what let a 9-hour-old Discovery count be briefed as current. v1
  // records the signal as an ADVISORY inside the existing warn — promoting it
  // to a violation before the authoring habit exists would buy friction, not
  // accuracy. This test pins "advisory, never a violation".
  // -------------------------------------------------------------------------

  it('#908 verified-but-undated claim is reported as advisory, never as a violation', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      [
        '```bash',
        'git log --oneline | wc -l',
        '```',
        'The repo has 14 commits.',
        'filler 1', 'filler 2', 'filler 3', 'filler 4', 'filler 5', 'filler 6', 'filler 7',
        'The metrics store holds 92 learnings.',
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    // Only the UNVERIFIED claim is a violation; the undated-but-verified one is not.
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].claim_text).toBe('The metrics store holds 92 learnings.');
    // …and the advisory count is surfaced in additionalContext (which reaches
    // the stopping subagent, not the coordinator).
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('1 verified claim(s) carry no measurement timestamp (advisory).');
  });

  // -------------------------------------------------------------------------
  // #918 — the PSA-006 canonical numerator/denominator slash form.
  //
  // Bug caught: PSA-006 literally demands "Quote the numerator AND
  // denominator", and `N/M <noun>` is the notation that demand produces — yet
  // the #908 cardinal trigger's lookahead (?![\d.%:/-]) excluded the slash, so
  // the rule's own canon form ("Coverage across 12/14 files is complete.") was
  // structurally invisible to the detector. Same for `callers` — PSA-006's own
  // canonical noun (the rule's worked examples all count callers) — which was
  // missing from CARDINAL_NOUN entirely. Both were previously pinned as
  // KNOWN-BOUNDARY silences below; #918 flips them to caught claims.
  //
  // FP re-measured on the CORRECT text sort per the #918 Auflage (the prior
  // 1.07/stop figure was measured on coordinator narration): 490 real
  // SubagentStop subagent transcripts, 2026-07-31 — 0.7041 → 0.7102 per stop
  // (+3 firings; 1 true positive "0/49 Learnings mit Allow-List-Typ").
  // -------------------------------------------------------------------------

  it.each([
    ['numerator/denominator slash form', 'Coverage across 12/14 files is complete.'],
    ['slash form + canonical noun callers', 'Verified 4/4 callers migrated to the wrapper.'],
    ['bare cardinal + canonical noun callers', 'The legacy helper still has 14 callers.'],
  ])('#918 canon form "%s" without a measurement block → violation', (_label, claim) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([claim]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].claim_text).toBe(claim);
  });

  // -------------------------------------------------------------------------
  // #918 — FP guard for the re-opened slash class.
  //
  // Bug caught: admitting the slash into a claim trigger is exactly what the
  // #908 lookahead existed to prevent — a naive `\d+/\d+` fires on gate
  // summaries ("12615/0/11"), US dates, path segments and scores. The
  // noun-immediately-after-denominator discriminator is what keeps those
  // quiet; this table (plus the existing "slash-separated summary" row above)
  // goes red if a later edit relaxes it. Fake-regression verified 2026-07-31:
  // discriminator removed → date + score rows red; lookahead additionally
  // removed → the 12615/0/11 row red; both restored → green.
  // -------------------------------------------------------------------------

  it.each([
    ['US-style date slash', 'The incident review happened on 12/14 during the rollout.'],
    ['path-glued slash pair', 'Artifacts live under runs/12/14 in the archive.'],
    ['score slash pair', 'The panel rated the migration 3/5 overall.'],
  ])('#918 slash false-positive class "%s": does NOT flag', (_label, benign) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([benign]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
    expect(result.stdout.trim()).toBe('');
  });

  it('#908 remains non-blocking: a violating cardinal claim still exits 0 without decision:block', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['The repo has 14 commits since the session-start ref.']);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('ENABLED + 10-record transcript: only claims inside last-8 records are flagged', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const outOfWindowClaim = '100% of call sites use the legacy pattern.';
    const inWindowClaim = 'every caller imports the shared module.';
    // 10 assistant records: index 0 has the out-of-window claim, indices 1..8
    // are filler (no claims), index 9 has the in-window claim. The hook scans
    // .slice(-8) → indices 2..9. Record 0 (and 1) must be excluded.
    const blocks = [
      outOfWindowClaim,                 // index 0 — outside last-8
      'Filler narrative record one.',   // index 1 — outside last-8
      'Filler narrative record two.',   // index 2
      'Filler narrative record three.', // index 3
      'Filler narrative record four.',  // index 4
      'Filler narrative record five.',  // index 5
      'Filler narrative record six.',   // index 6
      'Filler narrative record seven.', // index 7
      'Filler narrative record eight.', // index 8
      inWindowClaim,                    // index 9 — in last-8 window
    ];
    const transcript = writeTranscript(blocks);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].claim_text).toBe(inWindowClaim);
  });

  // -------------------------------------------------------------------------
  // #908 — pattern-7 KNOWN BOUNDARY (deliberate silence, recorded not assumed).
  //
  // Bug caught: a later widening of the cardinal detector — one more noun in
  // CARDINAL_NOUN, one relaxed character in the trigger lookahead — lands as a
  // one-token diff that no test opposes, and ships WITHOUT the false-positive
  // re-measurement that is the whole reason the pattern is this narrow.
  // Unguarded, the cardinal variant fired 93 times over 32 real agent-stop
  // windows (2.9 per stop — the zone where a warn-only validator gets switched
  // off, which is strictly worse than no validator). The forms below are
  // silent TODAY BY CHOICE; pinning them makes the next widening a DECISION:
  // whoever widens must re-measure the FP rate and move the case out of this
  // table, instead of learning about the regression later as validator fatigue.
  //
  // That procedure has now run once: #918 re-measured on 490 real SubagentStop
  // transcripts (2026-07-31) and moved two former rows out of this table into
  // the #918 canon-form block above — the `N/M <noun>` slash notation (with a
  // noun-after-denominator discriminator instead of a relaxed lookahead) and
  // the `callers` noun. The remaining silences below still carry their named
  // costs and stay pinned.
  // -------------------------------------------------------------------------

  it.each([
    // `tests` and `hooks` are outside the closed CARDINAL_NOUN set
    // (commits|learnings|issues|branches|lines|files|callers). They were
    // measured as pure FP cost and left to the six quantifier-triggered
    // patterns, which carry a lexical anchor. (`callers` moved INTO the set
    // with #918 — re-measured at +0 firings from the bare form.)
    ['noun outside the closed CARDINAL_NOUN set', 'I reviewed 27 tests and 9 hooks in this pass.'],

    // Order-sensitive by construction: the pattern is <number> … <noun>, so a
    // count reported noun-first with the digit trailing has no noun AFTER the
    // trigger to match. Relaxing the order would make every `foo: 12` config
    // line and every table cell a candidate.
    ['count reported noun-first (colon form)', 'Commits since session-start: 14, learnings: 92'],

    // No digit at all — CARDINAL_TRIGGER is \d{1,9}. Spelled-out numerals would
    // need a separate word-numeral alternation, which is a different pattern
    // with its own FP budget, not a tweak to this one.
    ['spelled-out numeral', 'There are fourteen commits in the window.'],
  ])('#908 pattern-7 KNOWN BOUNDARY "%s": deliberately does NOT flag', (_label, text) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([text]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
    // No additionalContext either — the stopping subagent sees nothing at all.
    expect(result.stdout.trim()).toBe('');
  });

  // -------------------------------------------------------------------------
  // #1198 — three defects Discovery D8 measured on 400 sampled
  // discovery_validator_violation events (2026-09-02): 186/400 (46.5%) were
  // the harness's OWN gate-summary/STATUS lines, a masking-order bug let a
  // backtick-quoted MENTION of a claim still trip the six original patterns,
  // and the dedup sentinel keyed on agent_type (a CLASS) instead of agent_id
  // (an individual real agent), silently suppressing a genuinely different
  // agent's own additionalContext feedback.
  //
  // RED-before-fix verified via ad-hoc probe against the unmodified hook
  // (`node /tmp/dv-probe/probe2.mjs`, `node /tmp/dv-probe/probe.mjs`,
  // 2026-09-02, run in this session before the fix landed):
  //   - gate-summary case (1) below: flagged=true pre-fix → flagged=false post-fix.
  //   - dedupe case below: agent-y's stdout was `''` (suppressed) pre-fix →
  //     non-empty, containing "PSA-006", post-fix.
  // -------------------------------------------------------------------------

  it.each([
    [
      'gate-summary heading with passed/failed ratio',
      '## Wave 3 (Impl-Polish) Complete ✓ — Gate: typecheck 413 OK · lint 0 · **14904 passed / 0 failed** (608 files)',
    ],
    [
      'STATUS: done report line',
      'STATUS: done — 76/76 scoped tests green, typecheck 423 files OK',
    ],
    [
      'German "Full Gate … grün" summary',
      'W4 Full Gate **grün**: typecheck 413 OK · lint 0 · 14914 passed / 0 failed (608 files)',
    ],
    [
      'bold Full Gate summary with skipped count',
      '**Full Gate W4: 622 Files / 15419 passed / 0 failed / 11 skipped, exit 0**',
    ],
  ])('#1198 FIX 2 gate-summary line "%s": does NOT flag', (_label, benign) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([benign]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // A sixth candidate line from the P2 brief — "**Vorgeschlagene Struktur —
  // 5 feste Issues, 1 bedingtes, 5 Kommentare:**" — is DELIBERATELY OMITTED
  // here: measured against this fix (probe2.mjs, 2026-09-02), it still flags
  // (flagged=true) because it carries none of GATE_SUMMARY_LINE_RE's four
  // triggers (no passed/failed ratio, no `STATUS:` prefix, no "Full Gate", no
  // `Gate: typecheck|grün|rot`). Widening the regex to also catch a bare
  // "N feste Issues" planning bullet would risk silencing a true "N files"-
  // shaped claim outside a gate-summary context, which is out of scope for
  // this fix — see brief instruction "include (6) only if your regex change
  // actually excludes it; otherwise leave it out and say so".

  it('#1198 FIX 3 (masking-order): a claim entirely inside backticks does NOT flag', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      'the rule says `all 4 callers opt in` as an example',
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // Positives — the gate-summary/masking fixes above must not silence a REAL
  // bare-cardinal claim. Measured against the unmodified hook (probe2.mjs,
  // 2026-09-02): the P2 brief listed a THIRD positive, "C4 bekommt 8
  // Einträge, davon 4 aus dem eigenen Dateiscope." — that claim does NOT flag
  // even on the UNMODIFIED hook (German "Einträge" is outside both
  // CARDINAL_NOUN and every CLAIM_PATTERNS trigger word, all of which are
  // English-lexical), so it is refuted as a "still flags" case and omitted
  // rather than asserted as true.
  it.each([
    ['German commit-count cardinal', 'Der Katalog installiert seit vier Monaten einen 730 Commits alten Build.'],
    ['German issue-count cardinal', 'Issue-Triage ist da: 102 offene Issues.'],
  ])('#1198 positive "%s": still flags after the gate-summary/masking fixes', (_label, claim) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([claim]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].claim_text).toBe(claim);
  });

  it('#1198 FIX 1: two DIFFERENT agent_ids of the SAME type in the SAME session each get their own additionalContext', () => {
    // Pre-fix: dedupSentinelPath keyed on (projectRoot, session_id,
    // agent_type) — NOT agent_id — so agent-y's additionalContext was
    // silently suppressed by agent-x's sentinel purely because both share
    // agent_type "discovery", despite being two distinct real subagents.
    // (events.jsonl was never affected by this bug — that append loop has no
    // sentinel gate at all; only additionalContext, the channel meant for the
    // STOPPING SUBAGENT, was wrongly shared across different agents.)
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const claim = '4 of 4 callers opt-in to the helper. No grep was run.';
    writeAgentTranscript([claim], 'agent-x');
    writeAgentTranscript([claim], 'agent-y');

    const first = runHook(stopPayload(join(tmp, TRANSCRIPT_REL), {
      agent_id: 'agent-x',
      agent_type: 'discovery',
      session_id: 'shared-session-001',
    }));
    const second = runHook(stopPayload(join(tmp, TRANSCRIPT_REL), {
      agent_id: 'agent-y',
      agent_type: 'discovery',
      session_id: 'shared-session-001',
    }));

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstCtx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    const secondCtx = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    expect(firstCtx).toContain('PSA-006');
    expect(secondCtx).toContain('PSA-006');
  });

  // -------------------------------------------------------------------------
  // #1211 — German distributional claims. D3 (Discovery, 2026-09-03) measured
  // the proposal against 41 real German claim lines sampled from this repo's
  // own events.jsonl: the quantifier-anchored German patterns (CLAIM_PATTERNS
  // additions) flagged 7/41 (disciplined, same order of magnitude as the
  // English six); a WIDE German bare-cardinal noun set flagged 39/41 (~57% FP
  // in the labelled sample) and was rejected. Shipped: the quantifier
  // patterns + a NARROW bare-cardinal German noun addition (Zeilen/Dateien/
  // Datei/Aufrufer/Einträge only) + four German gate-summary shapes.
  //
  // The "davon" case is the #1198 sentence itself ("C4 bekommt 8 Einträge,
  // davon 4 aus dem eigenen Dateiscope") — on the unmodified (pre-#1211)
  // hook this claim carries no matching pattern at all and does NOT flag,
  // which is the concrete bug #1211 fixes. See the fake-regression pinned
  // below the positive block.
  // -------------------------------------------------------------------------

  it.each([
    ['davon-Anker (ASCII "Eintraege")', 'C4 bekommt 8 Eintraege, davon 4 aus dem eigenen Dateiscope.'],
    ['davon-Anker (Umlaut "Einträge")', 'C4 bekommt 8 Einträge, davon 4 aus dem eigenen Dateiscope.'],
    ['N von M <noun>', '13 von 100 Learnings werden doppelt zugestellt.'],
    ['alle N <noun>', 'Alle 8 Issues markiert und kommentiert.'],
    [
      'ratio + English "Commits" noun still flags alongside a German heading',
      '**4/4 Kern-Issues geliefert und geschlossen**, 2 Commits auf origin/main:',
    ],
    // Singular "Eintrag" (#1211 follow-up): the original `eintr(?:ä|ae)ge?`
    // alternation made only the trailing `e` optional, so it could match
    // `einträg`/`eintraeg` but never the actual singular noun `Eintrag`.
    ['bare-cardinal singular "Eintrag"', '1 Eintrag ohne Beleg wurde übernommen.'],
  ])('#1211 German positive "%s": flags a violation', (_label, claim) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([claim]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].claim_text).toBe(claim);
  });

  it.each([
    [
      'N Wellen, M Agents summary',
      '**5 Wellen, 20 Agents, 3 Commits, CI-Pipeline #6995 grün auf `1e2ba8b`** (origin + github).',
    ],
    ['Arbeitsbaum leer', '**7 Commits, Arbeitsbaum leer, nichts gepusht.**'],
    [
      'Gate N.N/M ratio',
      '**Welle 2** (7 Agenten + 3 Koordinator-Edits): 4 Commits auf beiden Remotes, Gate 14.118/0.',
    ],
    ['mit Nachweis geschlossen', '### Abgeschlossen (7 Issues, alle mit Nachweis geschlossen)'],
  ])('#1211 German gate-summary "%s": does NOT flag', (_label, benign) => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([benign]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('#1211 German claim WITH an adjacent rg measurement block → exit 0, NO violation', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript([
      [
        'Alle 8 Issues wurden geprüft:',
        '```bash',
        'rg -c "Issue" report.md',
        '```',
      ].join('\n'),
    ]);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #1218 — matcher PRECISION, measured on a labelled sample.
//
// The matcher used to be reachable only by spawning this hook with a sandbox
// repo, a CLAUDE.md and a transcript on disk (~130 ms per case), which is why
// its precision was asserted case-by-case and never MEASURED as a rate. Since
// the engine moved to hooks/_lib/subagent-transcript.mjs it is a pure
// function, so the whole sample runs as one table.
//
// SAMPLE PROVENANCE. The false-positive rows are verbatim `claim_text` values
// from the fleet's worst-affected ledger, or minimal shapes of the classes
// measured there (2026-09-06):
//
//   jq -r 'select(.event=="discovery_validator_violation")|.claim_text' \
//     ~/Projects/extern/aiat-barrierefrei-engine/.orchestrator/metrics/events.jsonl \
//     | sort -u | wc -l          # → 205 distinct over 3,360 records (×16.4)
//
// Of those 205, 201 still re-fire on the pre-#1218 matcher; 35 are markdown
// table rows, 9 are ATX headings, and an independently drawn n=60 sample
// (2026-09-02, docs/audits/2026-09-02-fleet-instruments.md) contained ZERO
// true positives.
//
// MEASURED ON THIS TABLE (24 rows, 6 of them genuine violations):
//   before #1218:  TP 6 · FP 13 · FN 0  → precision 0.3158, recall 1.0
//   after  #1218:  TP 6 · FP  0 · FN 0  → precision 1.0,    recall 1.0
// Recall is unchanged: not one true positive was traded for the precision.
// On the full 205-claim corpus the same guards remove 43 firings (201 → 158,
// −21.4%) and add none.
//
// A row is here to name ONE class. Adding a row without naming the class it
// falsifies is how a table like this rots into volume (TV-001).
// ---------------------------------------------------------------------------

describe('#1218 claim-matcher precision (labelled sample)', () => {
  /**
   * `expect: true` = this text IS a PSA-006 violation and must be flagged.
   * `expect: false` = it must NOT be flagged, for the reason in `why`.
   */
  const SAMPLE = [
    // --- true distributional claims WITH evidence ---
    { id: 'A1', expect: false, why: 'fenced grep block within ±5 lines', text:
      'All 4 callers of resolveSubagentSidecar() pass an agentId.\n```bash\ngrep -rn "resolveSubagentSidecar(" hooks/ scripts/   # 4 matches @ HEAD e4674109\n```' },
    { id: 'A2', expect: false, why: 'inline-code grep evidence', text:
      'No remaining references to pathMatchesPattern: `grep -rn "pathMatchesPattern" hooks/` returned 0 matches on 2026-09-06.' },
    { id: 'A3', expect: false, why: '#1218 German prose evidence, date-anchored', text:
      'Gemessen 2026-09-06 @ e4674109: 4 von 4 Aufrufer nutzen den neuen Helper.' },
    { id: 'A4', expect: false, why: '#1218 "Verifizierte Zahlen … HEAD <sha>"', text:
      'Verifizierte Zahlen gegen HEAD e4674109: 205 Eintraege im Ledger, davon 3 ohne Beleg.' },
    { id: 'A5', expect: false, why: 'fenced git|wc measurement for a #908 cardinal', text:
      'The repo has 14 commits since the session-start ref.\n```\ngit log --oneline abc1234..HEAD | wc -l   # 14\n```' },

    // --- true claims WITHOUT evidence (must still be caught) ---
    { id: 'B1', expect: true, why: '"all N <ctx>" unmeasured', text:
      'All 4 callers of resolveSubagentSidecar() pass an agentId.' },
    { id: 'B2', expect: true, why: '"no remaining <ctx>" unmeasured', text:
      'There are no remaining references to the old API in scripts/.' },
    { id: 'B3', expect: true, why: '"100% of <ctx>" unmeasured', text:
      '100% of callers opt-in to the new contract.' },
    { id: 'B4', expect: true, why: 'German "N <noun> … davon N" unmeasured', text:
      '8 Eintraege, davon 4 aus dem eigenen Dateiscope.' },
    { id: 'B5', expect: true, why: '#908 bare cardinal unmeasured', text:
      'The hook directory carries 412 lines of dead code.' },

    // --- bullet / heading / table false positives ---
    { id: 'C1', expect: false, why: 'ATX heading is a label, not an assertion', text:
      '## Welle 1 abgeschlossen - 10/10 Lanes, 15 Commits' },
    { id: 'C2', expect: false, why: 'ATX heading', text:
      '### 15 Issues mit Beweiskette geschlossen' },
    { id: 'C3', expect: false, why: 'markdown table row = structured status matrix', text:
      '| **Welle 1** | 10/10 Lanes integriert, 26 Commits - vier statische Gates gruen | laeuft |' },
    { id: 'C4', expect: false, why: 'markdown table row', text:
      '| 127 Commits nicht auf main | offen - PR #1075 mergefaehig, sobald die Lanes durch sind |' },
    { id: 'C5', expect: false, why: 'ATX heading', text:
      '# Session-Bilanz - drei Wellen, 58 Commits' },

    // --- score / config / version literal false positives ---
    { id: 'D1', expect: false, why: 'YAML key: scalar — the number is a SETTING', text:
      '  max-lines: 412 lines' },
    { id: 'D2', expect: false, why: 'YAML list-item key', text:
      '- name: 3 files' },
    { id: 'D3', expect: false, why: 'JSON key line', text:
      '  "open_issues": 130 issues, "closed": 19' },
    { id: 'D4', expect: false, why: 'version literals — cardinal lookahead rejects digit+dot', text:
      'Der Tag v0.15.0 markiert Release 3.24.0 im Changelog.' },
    { id: 'D5', expect: false, why: 'score ratios — no artefact noun after the denominator', text:
      'Die UX-Bewertung liegt bei 3/5 Punkten, PAC bei 23/29.' },

    // --- plan / intent items, and the negative control for German evidence ---
    { id: 'E1', expect: false, why: 'intent line ("Empfehlung:") states a plan, not a finding', text:
      'Empfehlung: 3 Issues zuerst schliessen, dann die 12 Dateien migrieren.' },
    { id: 'E2', expect: false, why: 'task-list checkbox', text:
      '- [ ] 5 files auf den neuen Helper umstellen' },
    { id: 'E3', expect: false, why: 'TODO line', text:
      'TODO: 14 commits nachtraeglich signieren' },
    { id: 'E4', expect: true, why: 'NEGATIVE CONTROL: a German marker with NO date/HEAD/sha anchor grants no evidence', text:
      'Gemessen wurde nichts: 4 von 4 Aufrufer nutzen den neuen Helper.' },
  ];

  it.each(SAMPLE)('$id ($why)', ({ expect: shouldFlag, text }) => {
    const fired = findViolations(text).violations.length > 0;
    expect(fired).toBe(shouldFlag);
  });

  it('the sample as a RATE: precision 1.0 and recall 1.0 (the numbers in the header)', () => {
    let tp = 0, fp = 0, fn = 0;
    for (const row of SAMPLE) {
      const fired = findViolations(row.text).violations.length > 0;
      if (row.expect && fired) tp++;
      else if (!row.expect && fired) fp++;
      else if (row.expect && !fired) fn++;
    }
    expect({ tp, fp, fn }).toEqual({ tp: 6, fp: 0, fn: 0 });
  });
});

describe('#1198 claim normalisation and dedup', () => {
  it('normalizeClaim strips leading markers, collapses whitespace and lowercases', () => {
    // The three shapes an agent writes the SAME finding in — a bullet in a
    // progress note, a numbered item in a summary, a bare sentence in the
    // final report — must all reduce to ONE key, or the ledger keeps three
    // copies of one finding.
    const shapes = [
      '- 4 of 4 Callers opt-in.',
      '2. 4 of 4   callers   opt-in.',
      '> 4 of 4 callers opt-in.',
      '#### 4 of 4 callers opt-in.',
      '  4 of 4 callers opt-in.  ',
    ];
    const keys = new Set(shapes.map(normalizeClaim));
    expect([...keys]).toEqual(['4 of 4 callers opt-in.']);
  });

  it('dedupeViolations collapses on the normalized key and counts occurrences', () => {
    const out = dedupeViolations([
      '- 14 commits since the ref',
      '14 commits since the ref',
      '* 92 learnings in the store',
    ]);
    expect(out.map((v) => [v.claim, v.occurrences])).toEqual([
      ['- 14 commits since the ref', 2],
      ['* 92 learnings in the store', 1],
    ]);
  });

  it('dedupeViolations preserves DISTINCT claims — normalisation must not over-merge', () => {
    // The fake-regression guard for the opposite failure: a normaliser that
    // stripped too much (digits, punctuation) would fold two different findings
    // into one and silently lose a violation.
    const out = dedupeViolations(['14 commits since the ref', '15 commits since the ref']);
    expect(out).toHaveLength(2);
  });
});
