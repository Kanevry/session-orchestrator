/**
 * tests/hooks/post-subagent-discovery-validator.test.mjs
 *
 * Tests for hooks/post-subagent-discovery-validator.mjs (#567).
 *
 * The hook is a NON-BLOCKING SubagentStop validator (PSA-006): it reads
 * `input.transcript_path`, scans the tail of assistant records for
 * distributional-claim regexes, and — when a claim lacks an adjacent fenced
 * grep/rg/find block — appends a `discovery_validator_violation` record to
 * .orchestrator/metrics/events.jsonl + writes a stderr WARN. Exit 0 ALWAYS.
 * Gated OFF by default via the `discovery-validator.enabled` Session-Config key.
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
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../../hooks/post-subagent-discovery-validator.mjs', import.meta.url).pathname;
const EVENTS_REL = join('.orchestrator', 'metrics', 'events.jsonl');
const TRANSCRIPT_REL = 'transcript.jsonl';

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
function writeTranscript(textBlocks) {
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
    transcript_path: transcriptPath,
    ...extra,
  };
}

describe('post-subagent-discovery-validator hook', () => {
  it('DISABLED (default): SubagentStop with a bare claim → exit 0, NO event written', () => {
    writeClaudeMd(CLAUDE_MD_DISABLED);
    const transcript = writeTranscript(['We confirmed 4 of 4 callers opt-in to the new API.']);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
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

  it('session_id precedence: event uses parent_session_id when both ids present (FIX 2)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['Result: 4 of 4 callers opt-in. No grep was run.']);

    const result = runHook(
      stopPayload(transcript, {
        parent_session_id: 'main-2026-05-27-deep-3',
        session_id: 'sub-agent-999',
      })
    );

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('main-2026-05-27-deep-3');
  });

  it('session_id falls back to session_id when parent_session_id is absent', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['Result: 4 of 4 callers opt-in. No grep was run.']);

    const result = runHook(stopPayload(transcript, { session_id: 'sub-agent-only-777' }));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('sub-agent-only-777');
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
  // (c) additionalContext feed-back (#666 — v2.1.163+)
  //
  // On a violation the hook MUST emit hookSpecificOutput.additionalContext to
  // stdout so the warning is fed back to the coordinator turn inline.
  // On a clean path (no violation) stdout must be empty.
  // -------------------------------------------------------------------------

  it('ENABLED + violation → stdout has hookSpecificOutput.hookEventName="SubagentStop" and non-empty additionalContext', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['4 of 4 callers opt-in to the helper. No grep was run.']);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    // events.jsonl write still happens (additive — not replaced by additionalContext)
    expect(readEvents()).toHaveLength(1);
    // stdout carries the hookSpecificOutput JSON
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SubagentStop');
    expect(typeof out.hookSpecificOutput.additionalContext).toBe('string');
    expect(out.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
    // must not set decision:"block" (non-blocking always)
    expect(out.decision).toBeUndefined();
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

  it('DISABLED → stdout is empty (no additionalContext)', () => {
    writeClaudeMd(CLAUDE_MD_DISABLED);
    const transcript = writeTranscript(['4 of 4 callers opt-in to the helper.']);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('ENABLED + violation → additionalContext kept under 10k chars (well within limit)', () => {
    writeClaudeMd(CLAUDE_MD_ENABLED);
    const transcript = writeTranscript(['4 of 4 callers opt-in to the helper. No grep.']);

    const result = runHook(stopPayload(transcript));

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.additionalContext.length).toBeLessThan(10_000);
  });

  // -------------------------------------------------------------------------
  // (b) TAIL_RECORDS=8 boundary: 10 assistant records — a bare claim in
  // record #1 (outside the last-8 window → NOT scanned) and a bare claim in
  // the last record (in-window → flagged). Only the in-window claim appears
  // in events.jsonl.
  // -------------------------------------------------------------------------

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
});
