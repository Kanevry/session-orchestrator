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
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSubagents } from '@lib/subagents-schema.mjs';

const HOOK = new URL('../../hooks/subagent-telemetry.mjs', import.meta.url).pathname;
const JSONL_REL = join('.orchestrator', 'metrics', 'subagents.jsonl');

// Removed with #963: `tests/fixtures/metrics/subagent-transcript-dedup.jsonl`.
// Despite its name it stopped pinning any dedup behaviour when the #950
// consolidation retired its token assertions — its repeats were byte-identical,
// so it scored the same under keep-first and keep-last. Its one surviving user
// asserted the `subagent_transcript_found` flag and never looked at its contents,
// which any transcript satisfies; that case now uses STREAMING_GOLDEN. The file
// contained no `"id"` field at all, so it could not have pinned #963 either.

// The PARENT session transcript the harness actually names in `transcript_path`.
// Its usage block mirrors the live shape (cache_* siblings kept) but carries
// deliberately unmistakable totals: no subagent fixture in this file uses them,
// so any record reading 111000/222000 proves the hook read the parent (#949).
const PARENT_TRANSCRIPT =
  '{"type":"assistant","requestId":"req_PARENT","message":{"role":"assistant","usage":{"input_tokens":111000,"cache_creation_input_tokens":900000,"cache_read_input_tokens":0,"output_tokens":222000,"service_tier":"standard"}}}\n';
const PARENT_SESSION_ID = '19eecab8-5c28-4b0b-95da-20c4e433a3ae';

// Golden record (#950) — 8 assistant lines harvested from a REAL subagent
// transcript (agent-a60348a01ca982b4c, session 19eecab8, 2026-07-31), with
// `message.content` stripped and every `message.usage` block kept verbatim
// (cache_creation, iterations, server_tool_use, service_tier, inference_geo,
// speed — the real field set, not a convenient subset).
//
// Two requestIds, each a CUMULATIVE streaming group rather than repeated copies:
//   req_...UqV2K → output_tokens 1, 1, 1, 1, then 1130
//   req_...cJjjJ → output_tokens 4, 4,       then  498
// input_tokens is 2 in every single block of both groups.
//
// This is what the older hand-built dedup fixture could not do (see the removal
// note above): its repeats were byte-identical, so it scored the same under
// keep-first and keep-last and was blind to the #950 defect. This one separates
// them — keep-first yields 4/5, keep-last 4/1628.
const STREAMING_GOLDEN =
  [
    '{"type":"assistant","requestId":"req_011CdYTpiEMekUdAoWPUqV2K","message":{"role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":19257,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":19257,"ephemeral_1h_input_tokens":0},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"}}}',
    '{"type":"assistant","requestId":"req_011CdYTpiEMekUdAoWPUqV2K","message":{"role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":19257,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":19257,"ephemeral_1h_input_tokens":0},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"}}}',
    '{"type":"assistant","requestId":"req_011CdYTpiEMekUdAoWPUqV2K","message":{"role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":19257,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":19257,"ephemeral_1h_input_tokens":0},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"}}}',
    '{"type":"assistant","requestId":"req_011CdYTpiEMekUdAoWPUqV2K","message":{"role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":19257,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":19257,"ephemeral_1h_input_tokens":0},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"}}}',
    '{"type":"assistant","requestId":"req_011CdYTpiEMekUdAoWPUqV2K","message":{"role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":19257,"cache_read_input_tokens":0,"output_tokens":1130,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":19257},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":1130,"cache_read_input_tokens":0,"cache_creation_input_tokens":19257,"cache_creation":{"ephemeral_5m_input_tokens":19257,"ephemeral_1h_input_tokens":0},"type":"message"}],"speed":"standard"}}}',
    '{"type":"assistant","requestId":"req_011CdYTtUWiMehh6LvmcJjjJ","message":{"role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":3560,"cache_read_input_tokens":37544,"cache_creation":{"ephemeral_5m_input_tokens":3560,"ephemeral_1h_input_tokens":0},"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"}}}',
    '{"type":"assistant","requestId":"req_011CdYTtUWiMehh6LvmcJjjJ","message":{"role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":3560,"cache_read_input_tokens":37544,"cache_creation":{"ephemeral_5m_input_tokens":3560,"ephemeral_1h_input_tokens":0},"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"}}}',
    '{"type":"assistant","requestId":"req_011CdYTtUWiMehh6LvmcJjjJ","message":{"role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":3560,"cache_read_input_tokens":37544,"output_tokens":498,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":3560},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":498,"cache_read_input_tokens":37544,"cache_creation_input_tokens":3560,"cache_creation":{"ephemeral_5m_input_tokens":3560,"ephemeral_1h_input_tokens":0},"type":"message"}],"speed":"standard"}}}',
  ].join('\n') + '\n';

// Golden shape for #963 — assistant turns with NO requestId but WITH message.id.
// This is the real-world majority class the pre-#963 fallback double-counted:
// 430,962 of 1,005,530 usage blocks corpus-wide (42.9%, measured 2026-08-03),
// all from non-Anthropic models routed through the same harness. No test
// anywhere covered it before.
//
// Two message.id groups, each shaped like a real streaming sequence rather than
// like repeated copies — which is what makes it discriminate:
//   msg_UNK_A → in 15000/out 0 (partial), 15000/300 (partial), 12/900 (final)
//   msg_UNK_B → in  8000/out 0 (partial),                       7/250 (final)
// `stop_reason` is null on every partial and set on every final, and the final
// block's `input_tokens` is LOWER than the partials' because the partial reports
// an undifferentiated total and the final splits `cache_read_input_tokens` out
// (cache re-accounting inside ONE turn — measured corpus-wide, not invented).
//
// Scores under the four candidate recipes:
//   last-wins (production)  in    19 / out 1150   ← asserted
//   sum-every-block (#963)  in 38019 / out 1450
//   per-field max           in 23000 / out 1150
//   keep-first              in 23000 / out    0
const MESSAGE_ID_GOLDEN =
  [
    '{"type":"assistant","message":{"id":"msg_UNK_A","role":"assistant","model":"gpt-5.6-sol","stop_reason":null,"usage":{"input_tokens":15000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"service_tier":"standard"}}}',
    '{"type":"assistant","message":{"id":"msg_UNK_A","role":"assistant","model":"gpt-5.6-sol","stop_reason":null,"usage":{"input_tokens":15000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":300,"service_tier":"standard"}}}',
    '{"type":"assistant","message":{"id":"msg_UNK_A","role":"assistant","model":"gpt-5.6-sol","stop_reason":"end_turn","usage":{"input_tokens":12,"cache_creation_input_tokens":2000,"cache_read_input_tokens":14988,"output_tokens":900,"service_tier":"standard"}}}',
    '{"type":"assistant","message":{"id":"msg_UNK_B","role":"assistant","model":"gpt-5.6-sol","stop_reason":null,"usage":{"input_tokens":8000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"service_tier":"standard"}}}',
    '{"type":"assistant","message":{"id":"msg_UNK_B","role":"assistant","model":"gpt-5.6-sol","stop_reason":"end_turn","usage":{"input_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":7993,"output_tokens":250,"service_tier":"standard"}}}',
  ].join('\n') + '\n';

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

/**
 * Seed a harness-shaped transcript pair in the sandbox and return the PARENT
 * transcript path — the value the harness puts on stdin as `transcript_path`.
 *
 * Layout verified against live transcripts on 2026-07-31:
 *   <root>/<session>.jsonl                            ← parent (always seeded)
 *   <root>/<session>/subagents/agent-<agentId>.jsonl  ← subagent (opt-in)
 *
 * The token-bearing parent is seeded even when `subagent` is null. That is what
 * makes the #949 regression observable: if the hook ever falls back to
 * `transcript_path`, the record reads 111000/222000 instead of the expected
 * subagent literals (or instead of null for a phantom stop).
 *
 * @param {{ agentId: string, subagent?: string|null }} spec
 * @returns {string} the parent transcript path
 */
function seedTranscripts({ agentId, subagent = null }) {
  const root = join(tmp, 'transcripts');
  const parentPath = join(root, `${PARENT_SESSION_ID}.jsonl`);
  mkdirSync(root, { recursive: true });
  writeFileSync(parentPath, PARENT_TRANSCRIPT, 'utf8');
  if (subagent !== null) {
    const subDir = join(root, PARENT_SESSION_ID, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, `agent-${agentId}.jsonl`), subagent, 'utf8');
  }
  return parentPath;
}

/** Path of the seeded subagent transcript (for the oversized-file case). */
function subagentTranscriptPath(agentId) {
  return join(tmp, 'transcripts', PARENT_SESSION_ID, 'subagents', `agent-${agentId}.jsonl`);
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
  // #624 / #949 — token capture from the SUBAGENT's own transcript, deduped by
  // requestId. `transcript_path` on stdin is the PARENT session transcript, so
  // every case below seeds a token-bearing parent the hook must ignore.
  // -------------------------------------------------------------------------

  // Consolidated away (TV-002/TV-004): a second token-extraction case using the
  // hand-built DEDUP_TRANSCRIPT (asserting 300/100) used to sit here. Its token
  // assertions are strictly weaker than the golden-record case below, measured
  // rather than assumed — the hook was run under three dedup states and both
  // cases compared:
  //
  //   state                    golden record      dedup fixture
  //   keep-last (production)   4 / 1628  GREEN    300 / 100  GREEN
  //   keep-first (#950)        4 /    5  RED      300 / 100  GREEN  ← blind
  //   no dedup at all (#624)  16 / 1640  RED      700 / 240  RED
  //
  // The dedup fixture's repeats are byte-identical, so it scores the same under
  // keep-first and keep-last and cannot see the #950 defect at all; the golden
  // record discriminates all three states. Its two non-token assertions
  // (`gen_ai.system`, `total_cost_usd`) were the only ones nothing else covered
  // and are folded into the case below. `subagent_transcript_found: true` and
  // the #949 parent-vs-subagent contract are covered there and by the flag case.
  // The DEDUP_TRANSCRIPT fixture stays — the flag case still uses it as payload.

  it('streaming snapshots: a requestId collapses to its LAST usage block, not the partial first', async () => {
    // The #950 defect: the repeats are cumulative snapshots of ONE in-flight
    // response, so the first block of a group is a partial (output_tokens: 1)
    // and only the last carries the total. Keeping the first reported the size
    // of the opening streaming chunk as the whole turn — measured on this very
    // agent's transcript, 22 instead of 3185 output tokens (~145x understated).
    //
    // This is also the #949 case: seedTranscripts always writes a token-bearing
    // PARENT (111000/222000), so any reading other than the subagent's own file
    // fails the literals below.
    const transcriptPath = seedTranscripts({ agentId: 'stream-agent', subagent: STREAMING_GOLDEN });
    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'stream-agent',
      transcript_path: transcriptPath,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);

    // Hardcoded literals from the golden record: the FINAL block of each group,
    // 1130 + 498. Keeping the first would yield 1 + 4 = 5; summing every
    // snapshot would yield 1138 + 506 = 1644 (the double-count #624 removed).
    expect(records[0].token_output).toBe(1628);
    expect(records[0]['gen_ai.usage.output_tokens']).toBe(1628);

    // token_input is deliberately pinned in the SAME case: input_tokens is 2 in
    // all 8 blocks, so 4 is the answer under first-wins AND last-wins — this
    // asserts the #950 change did not move it. It still bites: folding the
    // cache_* siblings in would read 19259/3562-scale, and summing snapshots
    // instead of deduping would read 16.
    expect(records[0].token_input).toBe(4);
    expect(records[0]['gen_ai.usage.input_tokens']).toBe(4);

    // Folded in from the consolidated dedup case above — the only two record
    // fields it pinned that no other case does.
    expect(records[0]['gen_ai.system']).toBe('anthropic');
    // Cost is best-effort — the native transcript exposes none, so it is null.
    expect(records[0].total_cost_usd).toBeNull();
  });

  it('phantom stop (parent transcript exists, no subagent transcript): token fields null, subagent_transcript_found false', async () => {
    // The dominant live case — 343 of 343 orphan stops in session 19eecab8 have
    // no subagent transcript (measured 2026-07-31). The parent is present and
    // token-bearing, so a fallback to `transcript_path` would silently attribute
    // 111000/222000 to an agent that never existed. null is the honest value.
    const transcriptPath = seedTranscripts({ agentId: 'phantom-token-agent', subagent: null });
    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'phantom-token-agent',
      duration_ms: 3000,
      transcript_path: transcriptPath,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    expect(records[0].subagent_transcript_found).toBe(false);
    expect(records[0].token_input).toBeNull();
    expect(records[0].token_output).toBeNull();
    expect(records[0]['gen_ai.usage.input_tokens']).toBeNull();
    expect(records[0]['gen_ai.usage.output_tokens']).toBeNull();
  });

  it('subagent_transcript_found is a STOP-record contract: start records carry no flag', async () => {
    // The flag is the read-time provenance gate for token_* (#949). Stamping it
    // on start records would make "false" ambiguous between "phantom stop" and
    // "not a stop at all"; omitting it from stops would put the whole unusable
    // pre-#949 history back in play for a summing consumer.
    const transcriptPath = seedTranscripts({ agentId: 'flag-agent', subagent: STREAMING_GOLDEN });
    runHook(
      JSON.stringify({
        hook_event_name: 'SubagentStart',
        agent_id: 'flag-agent',
        transcript_path: transcriptPath,
      }),
    );
    runHook(
      JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_id: 'flag-agent',
        transcript_path: transcriptPath,
      }),
    );

    const records = await readSubagents(join(tmp, JSONL_REL));
    const start = records.find((r) => r.event === 'start');
    const stop = records.find((r) => r.event === 'stop');
    expect(start.subagent_transcript_found).toBeUndefined();
    expect(stop.subagent_transcript_found).toBe(true);
  });

  // Consolidated away (TV-002/TV-003): a 'stop without transcript_path' case
  // used to sit here. Both halves of it are dominated. Its null-token half is
  // the SAME `subagentTranscriptFound ? … : null` false branch the phantom-stop
  // case above already pins — and pins harder, since that one also proves the
  // hook does not fall back to the token-bearing parent. Its crash-safety half
  // (a payload with no transcript_path must still yield one record) was measured
  // rather than assumed: deleting the `typeof parentTranscriptPath !== 'string'`
  // guard turns 14 tests in this file red, 13 of them other than the deleted
  // case. No mutation survives its removal.

  it('stop with a subagent transcript that has 0 assistant turns: token fields null, exit 0', async () => {
    // Only user lines — no assistant turns with usage.
    const transcriptPath = seedTranscripts({
      agentId: 'token-agent-no-asst',
      subagent:
        '{"type":"user","message":{"role":"user","content":"hi"}}\n' +
        '{"type":"user","message":{"role":"user","content":"again"}}\n',
    });

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-no-asst',
      duration_ms: 3000,
      transcript_path: transcriptPath,
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

  it('stop with poisoned turns (negative AND float input_tokens): both are skipped, good turns survive', async () => {
    // One transcript covers the whole clamp contract — the two poison shapes are
    // the same code path (`Number.isInteger(v) && v >= 0`), so separate cases
    // were duplicate coverage. Four unique requestIds:
    //   req_GOOD1 = 100/40, req_NEG = -50/20, req_FLOAT = 10.5/5, req_GOOD2 = 200/60.
    // Poisoned INPUTS are skipped → 100 + 200 = 300 (NOT null). Both poisoned
    // turns carry VALID outputs → 40 + 20 + 5 + 60 = 125.
    const transcriptPath = seedTranscripts({
      agentId: 'token-agent-poison',
      subagent:
        '{"type":"assistant","requestId":"req_GOOD1","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40}}}\n' +
        '{"type":"assistant","requestId":"req_NEG","message":{"role":"assistant","usage":{"input_tokens":-50,"output_tokens":20}}}\n' +
        '{"type":"assistant","requestId":"req_FLOAT","message":{"role":"assistant","usage":{"input_tokens":10.5,"output_tokens":5}}}\n' +
        '{"type":"assistant","requestId":"req_GOOD2","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":60}}}\n',
    });

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-poison',
      duration_ms: 3000,
      transcript_path: transcriptPath,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // Hardcoded literals — good input turns only; -50 and 10.5 are skipped.
    expect(records[0].token_input).toBe(300);
    expect(records[0].token_output).toBe(125);
    expect(records[0]['gen_ai.usage.input_tokens']).toBe(300);
    expect(records[0]['gen_ai.usage.output_tokens']).toBe(125);
  });

  it('no requestId but WITH message.id: snapshots collapse to the LAST block per message.id', async () => {
    // #963 — the real-world majority class, and until now covered by no test at
    // all: 42.9% of usage blocks corpus-wide carry `message.id` and no
    // requestId, and the old fallback summed every one of them (8.93x input
    // inflation corpus-wide; 2.55x over this repo's own 32 affected transcripts).
    //
    // The literals below discriminate the fix from all three plausible wrong
    // recipes — see MESSAGE_ID_GOLDEN for the per-recipe score table. In
    // particular `input_tokens` DROPS on the finalized block (cache_read splits
    // out), so a per-field `Math.max` reads 23000 and only last-wins reads 19.
    const transcriptPath = seedTranscripts({
      agentId: 'mid-agent',
      subagent: MESSAGE_ID_GOLDEN,
    });

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'mid-agent',
      transcript_path: transcriptPath,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // Hardcoded literals — the FINAL block of each message.id group: 12 + 7 and
    // 900 + 250. Summing every snapshot (the pre-#963 behaviour) reads
    // 38019/1450; keeping the first reads 23000/0.
    expect(records[0].token_input).toBe(19);
    expect(records[0].token_output).toBe(1150);
    expect(records[0]['gen_ai.usage.input_tokens']).toBe(19);
    expect(records[0]['gen_ai.usage.output_tokens']).toBe(1150);
  });

  it('stop with assistant turns that have NEITHER requestId NOR message.id: ALL are counted', async () => {
    // Neither key — the identity is unknown, so each block stays its own turn.
    // This is ALSO the landmine pin for #963: a naive `map.set(obj.message?.id,
    // usage)` maps all three of these blocks onto the single key `undefined`,
    // collapsing unrelated turns into one and reading 200/60 instead of 350/110.
    // Absent is not zero, and it is not "the same turn as the next keyless
    // block" either. (Zero blocks in the measured corpus lack `message.id`, so
    // this branch is forward-compat — deliberately NOT restated as a fact about
    // what the harness always sends; that assumption is exactly what #963
    // refuted.)
    // Three turns: 100 + 50 + 200 = 350 input, 40 + 10 + 60 = 110 output.
    const transcriptPath = seedTranscripts({
      agentId: 'token-agent-no-reqid',
      subagent:
        '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40}}}\n' +
        '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":50,"output_tokens":10}}}\n' +
        '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":60}}}\n',
    });

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-no-reqid',
      duration_ms: 3000,
      transcript_path: transcriptPath,
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

  it('stop with an OVERSIZED subagent transcript (> 50 MB): token fields null, exit 0 (skipped, no throw)', async () => {
    // One genuinely valid assistant turn (100/40) that WOULD parse if the file
    // were under the cap — then pad past the 50 MB ceiling so the guard skips it.
    const transcriptPath = seedTranscripts({
      agentId: 'token-agent-oversized',
      subagent:
        '{"type":"assistant","requestId":"req_BIG","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40}}}\n',
    });
    const big = subagentTranscriptPath('token-agent-oversized');
    appendFileSync(big, Buffer.alloc(51 * 1024 * 1024, 0x20)); // 51 MB of spaces
    expect(statSync(big).size).toBeGreaterThan(50 * 1024 * 1024);

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-oversized',
      duration_ms: 3000,
      transcript_path: transcriptPath,
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
    // The flag reports EXISTENCE of the subagent transcript, not extraction
    // success — the file is there, the read was declined. Null here must not be
    // confused with the phantom class, whose flag reads false.
    expect(records[0].subagent_transcript_found).toBe(true);
  });

  it('stop with a turn that has input_tokens but NO output_tokens: output contributes 0 (not null)', async () => {
    // req_PARTIAL has input only. req_FULL has both. Absent output → 0, present
    // sides still sum: token_input = 100 + 200 = 300, token_output = 0 + 60 = 60.
    const transcriptPath = seedTranscripts({
      agentId: 'token-agent-partial',
      subagent:
        '{"type":"assistant","requestId":"req_PARTIAL","message":{"role":"assistant","usage":{"input_tokens":100}}}\n' +
        '{"type":"assistant","requestId":"req_FULL","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":60}}}\n',
    });

    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'token-agent-partial',
      duration_ms: 3000,
      transcript_path: transcriptPath,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const records = await readSubagents(join(tmp, JSONL_REL));
    expect(records).toHaveLength(1);
    // Hardcoded literals — absent output side contributes 0, not null.
    expect(records[0].token_input).toBe(300);
    expect(records[0].token_output).toBe(60);
  });

  // -------------------------------------------------------------------------
  // #917 — duration_ms is measured by joining to the agent's own start record,
  // never defaulted to a fabricated 0.
  // -------------------------------------------------------------------------

  describe('#917 duration_ms', () => {
    const stopPayload = (extra = {}) =>
      JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'dur-agent', ...extra });

    it('stop after a start recovers a positive duration when the harness omits duration_ms', async () => {
      // The real SubagentStop payload carries no duration_ms — that omission is
      // precisely what made every pre-#917 record read 0.
      runHook(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'dur-agent' }));
      await new Promise((r) => setTimeout(r, 60));
      const result = runHook(stopPayload());
      expect(result.status).toBe(0);

      const records = await readSubagents(join(tmp, JSONL_REL));
      const stop = records.find((r) => r.event === 'stop');
      // Bounded rather than exact: the value is a real wall-clock measurement, so
      // pinning a literal would be pinning the machine's scheduling noise. The
      // floor is what the regression is about — it must never be 0 again.
      expect(stop.duration_ms).toBeGreaterThan(0);
      expect(stop.duration_ms).toBeLessThan(60_000);
      expect(Number.isInteger(stop.duration_ms)).toBe(true);
    });

    it('stop with NO matching start record yields null, not 0', async () => {
      const result = runHook(stopPayload({ agent_id: 'orphan-agent' }));
      expect(result.status).toBe(0);

      const records = await readSubagents(join(tmp, JSONL_REL));
      expect(records).toHaveLength(1);
      // null is the honest "unknown". This is the DOMINANT path, not a corner
      // case: lifetime 51.1% of stop records have no start record, and ~93% of
      // CURRENT stop traffic is orphaned (#939 phantom-stop class, measured
      // 2026-07-31 — see the hook header docblock).
      expect(records[0].duration_ms).toBeNull();
      // Folded in from the consolidated #939 orphan case (TV-004): that case ran
      // the identical scenario — one SubagentStop, no start record anywhere —
      // and differed only in asserting this flag instead of the duration. Both
      // read the SAME `startedAtMs === null` resolution, so they were one test.
      expect(records[0].start_record_found).toBe(false);
    });

    it('a harness-supplied positive duration_ms stays authoritative over the join', async () => {
      runHook(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'dur-agent' }));
      runHook(stopPayload({ duration_ms: 45000 }));

      const records = await readSubagents(join(tmp, JSONL_REL));
      const stop = records.find((r) => r.event === 'stop');
      expect(stop.duration_ms).toBe(45000);
    });

    it('a harness-supplied duration_ms of 0 is NOT written through as 0', async () => {
      // The exact regression pin: 0 from the harness is not a measurement. It must
      // fall through to the join (and here, with no start record, to null).
      const result = runHook(stopPayload({ agent_id: 'zero-agent', duration_ms: 0 }));
      expect(result.status).toBe(0);

      const records = await readSubagents(join(tmp, JSONL_REL));
      expect(records).toHaveLength(1);
      expect(records[0].duration_ms).toBeNull();
    });

    it('joins to the MOST RECENT start when an agent_id is reused', async () => {
      // agent_id reuse is real (measured 2026-07-30: 22 of 1420 distinct start
      // ids appear more than once). The backwards scan must pick the latest start,
      // otherwise a reused id reports the age of a long-finished agent.
      const stale = new Date(Date.now() - 3_600_000).toISOString();
      mkdirSync(join(tmp, '.orchestrator', 'metrics'), { recursive: true });
      // Seed the stale start FIRST so the fresh one below sits later in the file —
      // the backwards scan must reach the fresh one first.
      writeFileSync(
        join(tmp, JSONL_REL),
        JSON.stringify({ timestamp: stale, event: 'start', agent_id: 'dur-agent', schema_version: 1 }) + '\n',
        'utf8',
      );
      runHook(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'dur-agent' }));
      runHook(stopPayload());

      const records = await readSubagents(join(tmp, JSONL_REL));
      const stop = records.find((r) => r.event === 'stop');
      // Must reflect the fresh start (~0s), never the hour-old one.
      expect(stop.duration_ms).toBeLessThan(60_000);
    });

    it('ignores a start record belonging to a DIFFERENT agent_id', async () => {
      runHook(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'someone-else' }));
      runHook(stopPayload({ agent_id: 'lonely-agent' }));

      const records = await readSubagents(join(tmp, JSONL_REL));
      const stop = records.find((r) => r.event === 'stop');
      expect(stop.duration_ms).toBeNull();
    });

    it('survives a torn/malformed line in the ledger while scanning backwards', async () => {
      runHook(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'dur-agent' }));
      // A partially-flushed line must not throw the hook or abort the scan.
      appendFileSync(join(tmp, JSONL_REL), '{"timestamp":"2026-07-30T00:00:00.0\n', 'utf8');
      await new Promise((r) => setTimeout(r, 60));
      const result = runHook(stopPayload());
      expect(result.status).toBe(0);

      const records = await readSubagents(join(tmp, JSONL_REL));
      const stop = records.find((r) => r.event === 'stop');
      expect(stop.duration_ms).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // #939 — orphan guard + event-name breadcrumb. The harness fires SubagentStop
  // for a phantom class that never fires SubagentStart (~93% of current stop
  // traffic); `start_record_found` makes that class mechanically filterable at
  // read time, and the breadcrumb keeps payload anomalies decidable from the
  // ledger. Bugs these catch: flag inverted/missing (readers cannot separate
  // phantom from real stops), breadcrumb stamped on every record (schema noise)
  // or never stamped (anomaly invisible again).
  // -------------------------------------------------------------------------

  describe('#939 orphan guard + breadcrumb', () => {
    it('a stop joined to its own start carries start_record_found: true; the start record carries NO flag', async () => {
      runHook(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'joined-agent' }));
      await new Promise((r) => setTimeout(r, 60));
      const result = runHook(JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'joined-agent' }));
      expect(result.status).toBe(0);

      const records = await readSubagents(join(tmp, JSONL_REL));
      const start = records.find((r) => r.event === 'start');
      const stop = records.find((r) => r.event === 'stop');
      expect(stop.start_record_found).toBe(true);
      // The flag is a STOP-record contract only — a start record has no join.
      expect(start.start_record_found).toBeUndefined();
    });

    // Consolidated away (TV-004): 'an orphan stop (no start record anywhere)
    // carries start_record_found: false' sat here. It ran the same single
    // SubagentStop-with-no-start scenario as the #917 'yields null, not 0' case
    // above and asserted the sibling field of the same `startedAtMs === null`
    // resolution; its assertion moved there rather than being dropped.

    it('a payload with NO hook_event_name is written as stop WITH a hook_event_name: null breadcrumb', async () => {
      // Hypothesis (b) of #939: a payload missing hook_event_name silently
      // defaults to 'stop'. The breadcrumb makes that case decidable from the
      // ledger instead of requiring another inference pass over fingerprints.
      const result = runHook(JSON.stringify({ agent_id: 'nameless-event-agent' }));
      expect(result.status).toBe(0);

      const records = await readSubagents(join(tmp, JSONL_REL));
      expect(records).toHaveLength(1);
      expect(records[0].event).toBe('stop');
      expect(records[0].hook_event_name).toBeNull();
    });

    it('a well-formed SubagentStop payload carries NO hook_event_name breadcrumb', async () => {
      const result = runHook(
        JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'normal-stop-agent' }),
      );
      expect(result.status).toBe(0);

      const records = await readSubagents(join(tmp, JSONL_REL));
      expect(records).toHaveLength(1);
      // PRESENCE of the field is the anomaly signal — it must be absent here.
      expect(records[0].hook_event_name).toBeUndefined();
    });
  });
});
