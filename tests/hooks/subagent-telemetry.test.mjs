/**
 * tests/hooks/subagent-telemetry.test.mjs
 *
 * Tests for hooks/subagent-telemetry.mjs (#342).
 *
 * Strategy: spawn the hook via node with stdin piped, CLAUDE_PROJECT_DIR
 * pointing to a tmp sandbox. Assert:
 *   1. Happy path — SubagentStop payload → appends a valid record to
 *      .orchestrator/metrics/subagents.jsonl, exits 0.
 *   2. Malformed stdin — exits 0, no file written (hook exits early on null input).
 *   3. Idempotency — two invocations leave a file with 2 valid JSONL records.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSubagents } from '@lib/subagents-schema.mjs';

const HOOK = new URL('../../hooks/subagent-telemetry.mjs', import.meta.url).pathname;
const JSONL_REL = join('.orchestrator', 'metrics', 'subagents.jsonl');

// Fixture transcript with assistant turns across 2 unique requestIds — req_AAA
// repeated 3× and req_BBB repeated 2× to prove the requestId-dedup recipe (#624).
// Deduped totals: token_input = 100 + 200 = 300, token_output = 40 + 60 = 100.
const TRANSCRIPT_FIXTURE = fileURLToPath(
  new URL('../fixtures/metrics/subagent-transcript-dedup.jsonl', import.meta.url),
);

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'subagent-telemetry-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function runHook(stdinJson) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdinJson,
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

describe('subagent-telemetry hook', () => {
  it('happy path: SubagentStop payload appends a valid record and exits 0', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'test-writer-agent-1',
      agent_type: 'test-writer',
      parent_session_id: 'main-2026-05-08-deep',
      duration_ms: 45000,
      token_input: 1200,
      token_output: 800,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const jsonlPath = join(tmp, JSONL_REL);
    const records = await readSubagents(jsonlPath);
    expect(records).toHaveLength(1);

    const rec = records[0];
    expect(rec.event).toBe('stop');
    expect(rec.agent_id).toBe('test-writer-agent-1');
    expect(rec.agent_type).toBe('test-writer');
    expect(rec.duration_ms).toBe(45000);
    expect(rec.schema_version).toBe(1);
    expect(typeof rec.timestamp).toBe('string');
  });

  it('malformed stdin: exits 0 and writes no valid records (hook exits early on null input)', async () => {
    const result = runHook('this is definitely not json');
    expect(result.status).toBe(0);

    // The documented intent is "no valid records written". `readSubagents`
    // returns [] for a missing file AND skips malformed lines in an existing
    // file, so a single hardcoded length-0 assertion covers both outcomes
    // (file absent — the actual behaviour here — or file present-but-empty).
    const jsonlPath = join(tmp, JSONL_REL);
    const records = await readSubagents(jsonlPath);
    expect(records).toHaveLength(0);

    // Concrete file-state check: the hook returns early on null input, so it
    // must not have created the JSONL file at all.
    expect(existsSync(jsonlPath)).toBe(false);
  });

  it('idempotency: two invocations produce two valid JSONL records', async () => {
    const makePayload = (event, agentId, extra = {}) =>
      JSON.stringify({ hook_event_name: event, agent_id: agentId, duration_ms: 1000, ...extra });

    runHook(makePayload('SubagentStart', 'agent-A'));
    runHook(makePayload('SubagentStop', 'agent-A'));

    const jsonlPath = join(tmp, JSONL_REL);
    const records = await readSubagents(jsonlPath);
    expect(records).toHaveLength(2);

    expect(records[0].event).toBe('start');
    expect(records[1].event).toBe('stop');

    // Both records must have the required schema_version
    for (const rec of records) {
      expect(rec.schema_version).toBe(1);
      expect(rec.agent_id).toBe('agent-A');
    }
  });

  // -------------------------------------------------------------------------
  // #624 — token capture from transcript_path (deduped by requestId)
  // -------------------------------------------------------------------------

  it('stop with transcript_path: token fields equal the DEDUPED sum and OTel aliases mirror them', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-1',
      duration_ms: 3000,
      transcript_path: TRANSCRIPT_FIXTURE,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);

    const rec = records[0];
    // Hardcoded literals — req_AAA(100/40) + req_BBB(200/60), each repeat counted ONCE.
    expect(rec.token_input).toBe(300);
    expect(rec.token_output).toBe(100);
    // OTel parity invariant: aliases mirror the legacy token fields.
    expect(rec['gen_ai.usage.input_tokens']).toBe(300);
    expect(rec['gen_ai.usage.output_tokens']).toBe(100);
    expect(rec['gen_ai.system']).toBe('anthropic');
    // Cost is best-effort — the native transcript exposes none, so it is null.
    expect(rec.total_cost_usd).toBeNull();
  });

  it('stop without transcript_path: token fields are null and exit 0', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-no-path',
      duration_ms: 3000,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    expect(records[0].token_input).toBeNull();
    expect(records[0].token_output).toBeNull();
    expect(records[0]['gen_ai.usage.input_tokens']).toBeNull();
    expect(records[0]['gen_ai.usage.output_tokens']).toBeNull();
  });

  it('stop with transcript_path pointing at a nonexistent file: token fields null, exit 0', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-missing-file',
      duration_ms: 3000,
      transcript_path: join(tmp, 'does-not-exist', 'agent-x.jsonl'),
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    expect(records[0].token_input).toBeNull();
    expect(records[0].token_output).toBeNull();
  });

  it('stop with a transcript that has 0 assistant turns: token fields null, exit 0', async () => {
    const emptyTranscript = join(tmp, 'agent-empty.jsonl');
    // Only user lines — no assistant turns with usage.
    writeFileSync(
      emptyTranscript,
      '{"type":"user","message":{"role":"user","content":"hi"}}\n' +
        '{"type":"user","message":{"role":"user","content":"again"}}\n',
      'utf8',
    );

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-no-asst',
      duration_ms: 3000,
      transcript_path: emptyTranscript,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    expect(records[0].token_input).toBeNull();
    expect(records[0].token_output).toBeNull();
  });

  // -------------------------------------------------------------------------
  // #624 — per-turn token clamping: a single poisoned value must NOT discard
  // the good turns (qa HIGH, PoC-verified). Two unique requestIds per case so
  // the good turns are counted once each.
  // -------------------------------------------------------------------------

  it('stop with one negative input_tokens turn: token_input = sum of the GOOD turns (poison skipped)', async () => {
    const t = join(tmp, 'agent-poison-neg.jsonl');
    // Three unique requestIds. req_GOOD1 = 100/40, req_BAD = -50/20 (poisoned
    // input), req_GOOD2 = 200/60. The bad input is skipped per-turn → token_input
    // = 100 + 200 = 300 (NOT null). The bad turn's VALID output (20) still counts
    // → token_output = 40 + 20 + 60 = 120.
    writeFileSync(
      t,
      '{"type":"assistant","requestId":"req_GOOD1","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40}}}\n' +
        '{"type":"assistant","requestId":"req_BAD","message":{"role":"assistant","usage":{"input_tokens":-50,"output_tokens":20}}}\n' +
        '{"type":"assistant","requestId":"req_GOOD2","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":60}}}\n',
      'utf8',
    );

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-poison-neg',
      duration_ms: 3000,
      transcript_path: t,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // Hardcoded literals — good input turns only (100 + 200); the -50 is skipped.
    expect(records[0].token_input).toBe(300);
    // Good output turns: 40 + 20 + 60 (the poisoned turn's output was valid).
    expect(records[0].token_output).toBe(120);
    expect(records[0]['gen_ai.usage.input_tokens']).toBe(300);
    expect(records[0]['gen_ai.usage.output_tokens']).toBe(120);
  });

  it('stop with a float (10.5) input_tokens turn: that turn is skipped, good turns survive', async () => {
    const t = join(tmp, 'agent-float.jsonl');
    // req_FLOAT carries a non-integer 10.5 input → skipped. The two good turns
    // sum to token_input = 100 + 200 = 300. Outputs (all integers) = 40 + 5 + 60 = 105.
    writeFileSync(
      t,
      '{"type":"assistant","requestId":"req_FGOOD1","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40}}}\n' +
        '{"type":"assistant","requestId":"req_FLOAT","message":{"role":"assistant","usage":{"input_tokens":10.5,"output_tokens":5}}}\n' +
        '{"type":"assistant","requestId":"req_FGOOD2","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":60}}}\n',
      'utf8',
    );

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-float',
      duration_ms: 3000,
      transcript_path: t,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // Hardcoded literals — the 10.5 float is skipped; 100 + 200 = 300.
    expect(records[0].token_input).toBe(300);
    expect(records[0].token_output).toBe(105);
  });

  it('stop with assistant turns that have NO requestId: ALL are counted (no dedup)', async () => {
    const t = join(tmp, 'agent-no-reqid.jsonl');
    // No requestId on any assistant turn — documents that dedup keys on requestId
    // and the harness always supplies it, so the fallback counts every turn.
    // Three turns: 100 + 50 + 200 = 350 input, 40 + 10 + 60 = 110 output.
    writeFileSync(
      t,
      '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40}}}\n' +
        '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":50,"output_tokens":10}}}\n' +
        '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":60}}}\n',
      'utf8',
    );

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-no-reqid',
      duration_ms: 3000,
      transcript_path: t,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // Hardcoded literals — no dedup, all 3 turns counted.
    expect(records[0].token_input).toBe(350);
    expect(records[0].token_output).toBe(110);
  });

  // -------------------------------------------------------------------------
  // #624 — bounded-read guard: an oversized transcript (> ~50 MB) is skipped
  // gracefully (null usage), never read whole into memory, never throws.
  // -------------------------------------------------------------------------

  it('stop with an OVERSIZED transcript (> 50 MB): token fields null, exit 0 (skipped, no throw)', async () => {
    const big = join(tmp, 'agent-oversized.jsonl');
    // One genuinely valid assistant turn (100/40) that WOULD parse if the file
    // were under the cap — then pad past the 50 MB ceiling so the guard skips it.
    writeFileSync(
      big,
      '{"type":"assistant","requestId":"req_BIG","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40}}}\n',
      'utf8',
    );
    appendFileSync(big, Buffer.alloc(51 * 1024 * 1024, 0x20)); // 51 MB of spaces
    expect(statSync(big).size).toBeGreaterThan(50 * 1024 * 1024);

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-oversized',
      duration_ms: 3000,
      transcript_path: big,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // The oversized transcript is skipped — its 100/40 turn is NOT counted.
    expect(records[0].token_input).toBeNull();
    expect(records[0].token_output).toBeNull();
    expect(records[0]['gen_ai.usage.input_tokens']).toBeNull();
    expect(records[0]['gen_ai.usage.output_tokens']).toBeNull();
  });

  it('stop with a NORMAL-size transcript just under the cap still parses (guard does not break the happy path)', async () => {
    const ok = join(tmp, 'agent-under-cap.jsonl');
    // Two unique requestIds, well under 50 MB — must still produce the deduped sum.
    writeFileSync(
      ok,
      '{"type":"assistant","requestId":"req_U1","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40}}}\n' +
        '{"type":"assistant","requestId":"req_U2","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":60}}}\n',
      'utf8',
    );
    expect(statSync(ok).size).toBeLessThan(50 * 1024 * 1024);

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-under-cap',
      duration_ms: 3000,
      transcript_path: ok,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // Hardcoded literals — under the cap, both turns parse and dedup-sum.
    expect(records[0].token_input).toBe(300);
    expect(records[0].token_output).toBe(100);
  });

  it('stop with a turn that has input_tokens but NO output_tokens: output contributes 0 (not null)', async () => {
    const t = join(tmp, 'agent-partial.jsonl');
    // req_PARTIAL has input only. req_FULL has both. Absent output → 0, present
    // sides still sum: token_input = 100 + 200 = 300, token_output = 0 + 60 = 60.
    writeFileSync(
      t,
      '{"type":"assistant","requestId":"req_PARTIAL","message":{"role":"assistant","usage":{"input_tokens":100}}}\n' +
        '{"type":"assistant","requestId":"req_FULL","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":60}}}\n',
      'utf8',
    );

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-partial',
      duration_ms: 3000,
      transcript_path: t,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // Hardcoded literals — absent output side contributes 0, not null.
    expect(records[0].token_input).toBe(300);
    expect(records[0].token_output).toBe(60);
  });
});
