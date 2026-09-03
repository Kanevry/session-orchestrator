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

  it('ENABLED + repeated real context → suppresses only repeated additionalContext', () => {
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
    expect(events).toHaveLength(2);
    expect(events[0].session_id).toBe('dedup-session-001');
    expect(events[1].session_id).toBe('dedup-session-001');
  });

  it('ENABLED + concurrent repeated real context → only one process emits additionalContext', async () => {
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
    expect(events).toHaveLength(8);
    expect(events.every((e) => e.session_id === 'parallel-dedup-session-001')).toBe(true);
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
