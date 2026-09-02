#!/usr/bin/env node
/**
 * subagent-telemetry.mjs — SubagentStart + SubagentStop hook handler.
 *
 * Hook events: SubagentStart, SubagentStop (issue #342).
 * Fires when a subagent lifecycle event occurs. Discriminates on
 * `hook_event_name` to write either a 'start' or 'stop' record to
 * `.orchestrator/metrics/subagents.jsonl`.
 *
 * Decision flow:
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Read JSON payload from stdin: { hook_event_name, agent_id?, subagent_id?,
 *        agent_type?, subagent_type?, parent_session_id?, session_id?,
 *        duration_ms?, transcript_path? }.
 *   3. Discriminate on hook_event_name → event: 'start' | 'stop'.
 *   4. For stop events, parse the subagent's OWN transcript to recover
 *        token_input / token_output (#624, #949, #950, #963). The harness does NOT
 *        send token_input / token_output on stdin — they must be extracted from the
 *        transcript's per-assistant-turn `message.usage` blocks, deduped by
 *        requestId keeping the LAST block per id (streaming snapshots repeat the
 *        same requestId a median of 2× — p90 4, max 22, measured 2026-07-31 —
 *        and only the last one is complete), falling back to `message.id` with
 *        the same last-wins recipe when a block carries no requestId (#963 —
 *        42.9% of usage blocks corpus-wide; see extractTranscriptUsage() for the
 *        measurement and the per-field inflation it causes).
 *        `transcript_path` on stdin points at the PARENT session transcript, so
 *        the subagent's path is DERIVED from it — see resolveSubagentTranscriptPath().
 *   5. Build canonical record and call appendSubagent().
 *   6. Output: nothing on stdout. Diagnostic errors to stderr only.
 *
 * Phantom-stop class (#939, measured 2026-07-31 over the live ledger):
 * the harness fires SubagentStop for an ephemeral agent class that never fires
 * SubagentStart. Those payloads carry a FRESH agent_id per firing, NO
 * agent_type/subagent_type, and a transcript_path that points at the PARENT
 * session transcript (evidence: 1072 of 1395 token-bearing orphan stops share
 * an exact token_input:token_output:parent_session_id fingerprint with a
 * concurrent typed stop; 957 of those 1072 fire BEFORE it, p50 97 s; token
 * totals grow monotonically across the orphan stream). The cause is
 * harness-side, not hook-side: registration (hooks.json) sends exactly
 * SubagentStart|SubagentStop here, and the "missing hook_event_name flips
 * starts to stops" hypothesis is refuted by perfect bimodality — 0 of 1429
 * typed stops are orphaned, 0 of 1494 orphans carry a type. The hook therefore
 * records these firings faithfully but marks every stop with
 * `start_record_found` so readers can filter the phantom class mechanically.
 *
 * #949 settles what the phantom class IS: the orphans are not subagents whose
 * SubagentStart was lost — no subagent ever existed. The harness writes
 * `<transcriptDir>/<parent_session_id>/subagents/agent-<agent_id>.jsonl` for
 * every real Task subagent; measured over session 19eecab8 on 2026-07-31,
 * 25 of 25 typed stops have that file and 0 of 343 orphan stops do. The
 * existence of that file is therefore a far sharper discriminator than
 * `start_record_found` (343/343 coverage vs 32/2955 records carrying the flag),
 * and it is recorded per stop as `subagent_transcript_found`.
 *
 * TOKEN-DATA PROVENANCE — historical records are unusable (#949). Until this
 * fix, token_input/token_output were extracted from the stdin `transcript_path`,
 * which is the PARENT session transcript: every stop record — typed ones
 * included — carried the parent's running totals, not its own (measured
 * 2026-07-31: agent a60348a01ca982b4c's own transcript sums 14/22 while its
 * ledger record reads 40/27540, and up to 7 concurrent agents share bitwise
 * identical values). Those values are NOT reconstructible from the ledger,
 * which never held the subagent figure. Consumers MUST discard token_* on every
 * stop record written before this fix landed and treat only records carrying
 * `subagent_transcript_found: true` as token-bearing; summing across the
 * history double-counts the parent once per subagent.
 *
 * A SECOND, independent defect rode along until #950: the requestId dedup kept
 * the FIRST usage block per id, which on a streaming transcript is a partial
 * snapshot (typically `output_tokens: 1`). Any record written before #950 —
 * including one already reading its own subagent transcript — therefore
 * understates token_output by roughly the ratio of first-chunk to final size
 * (~145x on the measured agent; ~10x summed over this repo's transcript corpus —
 * an earlier "5.3x" here did not reproduce, see extractTranscriptUsage()'s
 * corpus block for the command and the re-measurement). token_input is
 * unaffected: it is constant across a request's snapshots.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('subagent-telemetry')) process.exit(0);

import fs from 'node:fs';
import path from 'node:path';
import { appendSubagent } from '../scripts/lib/subagents-schema.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { resolveSubagentSidecar } from './_lib/subagent-paths.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSONL_PATH = path.join(SO_PROJECT_DIR, '.orchestrator', 'metrics', 'subagents.jsonl');

/**
 * Defense-in-depth byte ceiling for transcript reads (#624). The transcript path
 * is harness-trusted, so this is not an exploitable vector — but the repo follows
 * a bounded-read discipline: a pathologically large transcript is skipped (yields
 * the empty/zero-usage result) rather than read whole into memory.
 */
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // ~50 MB

/**
 * Tail window scanned backwards to join a stop event to its own start record (#917).
 *
 * The ledger is append-only and grows without bound (1.4 MB / 4201 lines on
 * 2026-07-30), so reading it whole on EVERY SubagentStop would be a hot-path
 * regression that worsens for the life of the repo. A fixed-size tail keeps the
 * join O(1) in file size.
 *
 * Sized from the real distribution, not a guess: measured over the live ledger on
 * 2026-07-30, the byte distance from a start record to its matching stop was
 * p50 1,380 · p90 3,255 · p99 24,229 · max 36,636. 256 KiB is ~7× the observed
 * maximum, so a start that falls outside the window is far rarer than the
 * no-start-record case the null fallback already handles honestly.
 */
const START_JOIN_TAIL_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * Uses a 5 s timeout consistent with Claude Code hook contract.
 *
 * @returns {Promise<object|null>}
 */
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.closed) {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => { resolve(null); }, 5_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const raw = chunks.join('').trim();
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

/**
 * Extract deduped token totals from a subagent transcript JSONL file (#624).
 *
 * On SubagentStop the harness supplies `transcript_path`. Each
 * `{"type":"assistant"}` line carries a `message.usage` block with
 * `{ input_tokens, output_tokens, ... }`. Streaming snapshots repeat the SAME
 * `requestId` across consecutive assistant lines, so a naive Σ over every line
 * double-counts — by a factor that depends on the FIELD, which is why no single
 * scalar belongs here. The repeats are cumulative, so re-adding them inflates
 * `input_tokens` (identical in every snapshot, hence re-added once per repeat)
 * far more than `output_tokens` (the early snapshots are near-empty and add
 * almost nothing). Measured 2026-07-31 over this repo's own subagent transcripts
 * (552 files / 13,609 requestId groups): naive Σ vs this function's dedup is
 * 3.593× on token_input and 1.014× on token_output. On one named transcript,
 * agent a60348a01ca982b4c (25 usage blocks / 7 groups): 3.57× and
 * 1.02×. Snapshots per requestId are mean 2.43 · p50 2 · p90 4 · p99 6 · max 22
 * — the retired "~4-5×" figure sat near that p90 REPEAT COUNT and was never a
 * token ratio at all.
 *
 *   d="$HOME/.claude/projects/$(pwd | tr '/.' '-')" node -e '
 *     const fs=require("node:fs"),{execSync}=require("node:child_process");
 *     const F=execSync(`find ${process.env.d} -path "*subagents*" -name "agent-*.jsonl"`,
 *       {maxBuffer:1<<30}).toString().trim().split("\n").filter(Boolean);
 *     const add=(a,u)=>{const i=u.input_tokens,o=u.output_tokens;
 *       if(Number.isInteger(i)&&i>=0)a.in+=i;if(Number.isInteger(o)&&o>=0)a.out+=o;};
 *     let n={in:0,out:0},D={in:0,out:0},g=0;
 *     for(const f of F){const b=new Map();
 *       for(const l of fs.readFileSync(f,"utf8").split("\n")){
 *         const t=l.trim();if(!t)continue;let o;try{o=JSON.parse(t)}catch{continue}
 *         if(o?.type!=="assistant"||!o.message?.usage||!o.requestId)continue;
 *         add(n,o.message.usage);b.set(o.requestId,o.message.usage);}
 *       g+=b.size;for(const u of b.values())add(D,u);}
 *     console.log(JSON.stringify({files:F.length,groups:g,naive:n,dedup:D,
 *       ratio_input:+(n.in/D.in).toFixed(3),ratio_output:+(n.out/D.out).toFixed(3)}));'
 *
 *   {"files":552,"groups":13609,"naive":{"in":9112051,"out":12244723},
 *    "dedup":{"in":2536215,"out":12077245},"ratio_input":3.593,"ratio_output":1.014}
 *
 * Same live-corpus caveat as the block below: two consecutive runs reproduced
 * both ratios to three decimals while `groups` grew 13591 → 13609, so the ratios
 * are the durable part and the totals are not. The correct recipe is to group by
 * `requestId`, keep ONE usage block per id — the LAST — then sum.
 *
 * Why the LAST and not the first (#950). The repeated blocks are not copies: they
 * are CUMULATIVE snapshots of one in-flight response, and the early ones are
 * partial (typically `output_tokens: 1`). Only the final block carries the
 * response's true total, so keeping the first — the pre-#950 recipe — reported
 * the size of the first streaming chunk as the whole turn. Measured on agent
 * a60348a01ca982b4c's own transcript (2026-07-31): keep-first yields 14/22,
 * keep-last 14/3185 — token_output understated ~145x.
 *
 * Corpus measurement (re-measured 2026-07-31; the first published numbers did
 * not reproduce from the scope they named). Group every assistant `usage` block
 * by (file, requestId) over this repo's own subagent transcripts and compare the
 * first block of each group against the last:
 *
 *   d="$HOME/.claude/projects/$(pwd | tr '/.' '-')" node -e '
 *     const fs=require("node:fs"),{execSync}=require("node:child_process");
 *     const F=execSync(`find ${process.env.d} -path "*subagents*" -name "agent-*.jsonl"`,
 *       {maxBuffer:1<<30}).toString().trim().split("\n");
 *     const g=new Map();
 *     for(const f of F)for(const l of fs.readFileSync(f,"utf8").split("\n")){
 *       let o;try{o=JSON.parse(l)}catch{continue}
 *       if(o?.type!=="assistant"||!o.message?.usage||!o.requestId)continue;
 *       const k=`${f} ${o.requestId}`;(g.get(k)||g.set(k,[]).get(k)).push(o.message.usage);}
 *     let a=0,b=0,m=0,dec=0,iv=0;
 *     for(const u of g.values()){const o=u.map(x=>x.output_tokens|0);
 *       a+=o[0];b+=o.at(-1);if(o.at(-1)===Math.max(...o))m++;
 *       for(let i=1;i<o.length;i++)if(o[i]<o[i-1]){dec++;break}
 *       if(new Set(u.map(x=>x.input_tokens|0)).size>1)iv++;}
 *     console.log(JSON.stringify({files:F.length,groups:g.size,first:a,last:b,
 *       ratio:+(b/a).toFixed(2),lastIsMax:m,decreasing:dec,inputVaries:iv}));'
 *
 * Output on 2026-07-31:
 *
 *   {"files":533,"groups":13255,"first":1180170,"last":11746733,
 *    "ratio":9.95,"lastIsMax":13255,"decreasing":0,"inputVaries":0}
 *
 * So keep-first understated output ~10x corpus-wide, not the ~5.3x first
 * claimed. These are absolute counts over a LIVE, growing corpus — re-running
 * yields larger numbers (four calls over one session read 13,230 / 13,233 /
 * 13,254 / 13,255 groups). The reproducible parts are the ratio (9.95-9.96
 * across all four) and the `lastIsMax` fraction, not the totals.
 *
 * Why NOT a per-field `Math.max`, which would also survive a regressing
 * snapshot: measured and rejected. In the run above the last block IS the max in
 * 13,255 of 13,255 groups, no output sequence ever decreases, and no final block
 * ever omits a field an earlier one carried — so max buys zero accuracy here.
 *
 * That result is CORPUS-SCOPED, and deliberately stated as such: pointing the
 * same command at all of `$HOME/.claude/projects` (12,442 files / 267,735
 * groups, same day) gives `lastIsMax: 267733` — two real counterexamples — plus
 * 15 groups whose output dips mid-sequence before recovering and 2 whose
 * `input_tokens` vary. "The last block is always the max" is an observation about
 * this repo's transcripts, NOT an invariant of the format. Do not read it as a
 * licence to treat `Math.max` as equivalent.
 *
 * What settles the choice is not the tie but block atomicity: a per-field max
 * can take `input_tokens` from one snapshot and `output_tokens` from another and
 * emit a pair that appears in no record, and it hard-codes "usage only ever
 * grows" for the sibling fields (`cache_*`, `iterations`) a future reader may
 * fold in. A usage block is an atomic statement of one response's state; the
 * last one is the producer's final word, so it is kept whole. That argument
 * holds on both corpora, which is why the counterexamples above do not reopen it.
 *
 * token_input is unaffected by this change and must stay so: it is constant
 * across every snapshot of a request (`inputVaries: 0` above), which is why the
 * pre-#950 defect was output-only.
 *
 * token_input is the raw `input_tokens` sum (NOT folded with cache_* fields) to
 * match the existing OTel `gen_ai.usage.input_tokens` semantic.
 *
 * Per-turn clamping (#624): a single poisoned usage value (negative, NaN, or a
 * non-integer such as 10.5) MUST NOT discard the otherwise-good turns. Each kept
 * block's contribution is added ONLY when it is a non-negative integer; an
 * invalid value is skipped (its block still counts as a kept turn, so a
 * transcript of mixed good/bad turns yields the sum of the GOOD turns, never
 * null). Without per-turn clamping, a final `Number.isInteger(sum) && sum >= 0`
 * aggregate check would nuke the whole input sum to null on one bad value.
 *
 * Dedup fallback (#624 assumption refuted 2026-07-31, re-keyed 2026-08-03 / #963).
 * Dedup keys on `requestId`. A turn without one used to be counted individually,
 * documented as an inert forward-compat fallback rather than a double-count,
 * "because the harness never omits requestId in practice". That premise is false
 * and the fallback was a live double-count; it now keys on `message.id` with the
 * same last-wins recipe, and only a block carrying NEITHER key is counted
 * individually.
 *
 * Measured over this repo's own subagent transcripts (2026-08-03, command below):
 * 4,684 of 35,923 assistant usage blocks (13.0%), across 32 of 524 files, carry
 * usage with NO requestId — every one from a non-Anthropic model routed through
 * the same harness (`gpt-5.6-sol` 4,680, `<synthetic>` 4). They are streaming
 * snapshots, not distinct turns: those 4,684 blocks collapse to 876 distinct
 * `message.id` values, so summing them individually inflated their contribution
 * 2.55× on input and 1.84× on output.
 *
 *   d="$HOME/.claude/projects/$(pwd | tr '/.' '-')" node -e '
 *     const fs=require("node:fs"),{execSync}=require("node:child_process");
 *     const F=execSync(`find ${process.env.d} -path "*subagents*" -name "agent-*.jsonl"`,
 *       {maxBuffer:1<<30}).toString().trim().split("\n").filter(Boolean);
 *     const add=(a,u)=>{const i=u.input_tokens,o=u.output_tokens;
 *       if(Number.isInteger(i)&&i>=0)a.in+=i;if(Number.isInteger(o)&&o>=0)a.out+=o;};
 *     let blocks=0,unkeyed=0,asIs={in:0,out:0},byMid={in:0,out:0},ids=new Set(),files=new Set();
 *     const models=new Map();
 *     for(const f of F){const m=new Map();
 *       for(const l of fs.readFileSync(f,"utf8").split("\n")){
 *         const t=l.trim();if(!t)continue;let o;try{o=JSON.parse(t)}catch{continue}
 *         if(o?.type!=="assistant"||!o.message?.usage)continue;
 *         blocks++;if(o.requestId)continue;
 *         unkeyed++;files.add(f);add(asIs,o.message.usage);
 *         models.set(o.message.model,(models.get(o.message.model)||0)+1);
 *         m.set(o.message.id,o.message.usage);}
 *       for(const [k,u] of m){ids.add(f+k);add(byMid,u);}}
 *     console.log(JSON.stringify({blocks,unkeyed,files:files.size,ofFiles:F.length,
 *       messageIds:ids.size,asIs,byMessageId:byMid,
 *       inflation_input:+(asIs.in/byMid.in).toFixed(2),
 *       inflation_output:+(asIs.out/byMid.out).toFixed(2),models:[...models]}));'
 *
 *   {"blocks":35923,"unkeyed":4684,"files":32,"ofFiles":524,"messageIds":876,
 *    "asIs":{"in":15320791,"out":1241596},"byMessageId":{"in":6011144,"out":674105},
 *    "inflation_input":2.55,"inflation_output":1.84,
 *    "models":[["gpt-5.6-sol",4680],["<synthetic>",4]]}
 *
 * Same live-corpus caveat as every block above, and it already bit once: the
 * numbers first published here read `blocks: 37771 / ofFiles: 552` on 2026-07-31
 * and 35,923 / 524 on 2026-08-03 — transcripts age out of `~/.claude/projects`,
 * so the totals SHRINK as well as grow and a figure left unrestated goes stale
 * while still reading as current. The unkeyed set was byte-identical across both
 * runs (4,684 blocks / 876 message ids / 32 files), so the defect and its
 * inflation ratios are the durable part; `blocks` and `ofFiles` are not.
 *
 * THIS REPO UNDERSTATES THE DEFECT BY ~3.5×. Corpus-wide — every project dir
 * under `~/.claude/projects`, 11,251 subagent transcripts, measured 2026-08-03 —
 * 430,962 of 1,005,530 usage blocks (42.9%) are unkeyed, collapsing to 86,805
 * `message.id` groups: input inflation 8.93×, output 1.70×. Model split of the
 * unkeyed set: gpt-5.6-luna 370,404, gpt-5.6-sol 112,939, gpt-5.6-terra 13,992,
 * `<synthetic>` 648. (Two independent runs an hour apart read 11,225 and 11,251
 * files but the same 430,962 unkeyed blocks — again, ratios durable, totals not.)
 *
 * Why key on PRESENCE, never on `message.model`: `<synthetic>` appears on BOTH
 * sides of the split (648 unkeyed, 293 keyed), so no model name partitions the
 * two branches. Zero `claude-*` blocks are unkeyed, but that is an observation
 * about today's routing, not a rule to branch on.
 *
 * Why last-wins on `message.id` is LOSSLESS, measured rather than assumed
 * (2026-08-03, 86,805 groups / 430,962 blocks corpus-wide):
 *   - 18,387 groups contain ≥2 blocks with a non-null `stop_reason`, and in
 *     every single one of them all finalized usage objects are byte-identical
 *     (`JSON.stringify` set size 1 in all 18,387). Σ tokens lost to last-wins:
 *     0 input, 0 output. A `message.id` group is one turn, not two.
 *   - The 8.2% of groups whose `input_tokens` look non-monotonic are cache
 *     re-accounting INSIDE one turn, not two turns: a partial snapshot reports an
 *     undifferentiated total, then the finalized block splits
 *     `cache_read_input_tokens` out, so `input_tokens` legitimately drops.
 *     (Verified on five example lines 0.6 s apart on one `parentUuid` chain.)
 *   - 7,556 groups never finalize (interrupted turns); last-wins keeps the last
 *     partial, which is the honest available value.
 *   - Cross-check on the KEYED half: re-keying requestId-bearing blocks on
 *     `message.id` instead changes totals by +0.013% input / +0.001% output, with
 *     `midMapsToMultipleRequestIds: 0`. The two keys are interchangeable, which
 *     is why the fallback is a key swap and not a second recipe.
 *
 * The `unkeyable` branch (NEITHER key) is retained and is NOT a merge bucket.
 * Zero blocks in the entire corpus lack `message.id` (`noMidUnkeyed: 0`,
 * `noMidKeyed: 0`, `midTypes: [["string", 4684]]`), so it is untested against
 * real data — stated here as an untested forward-compat path rather than as
 * another confident claim about the harness. The guard that keeps it honest is
 * the `typeof messageId === 'string'` check in the loop below: without it every
 * keyless block collapses onto the single key `undefined`, which is a silent
 * UNDER-count of unrelated turns. The measurement one-liner above has exactly
 * that shape (`m.set(o.message.id, …)`) — harmless there because zero blocks are
 * keyless, fatal if copied into production.
 *
 * Observed effect, end-to-end through this hook over the 32 affected real
 * transcripts (each copied into a sandbox at the harness-shaped subagent path,
 * hook spawned, ledger record read back):
 *
 *   before #963:  {"affectedFiles":32,"hookTotalInput":15320791,"hookTotalOutput":1241596}
 *   after  #963:  {"affectedFiles":32,"hookTotalInput":6011144,"hookTotalOutput":674105}
 *
 * FORWARD-ONLY — already-written history stays inflated. Nothing recomputes it:
 * 2,126 records in `.orchestrator/metrics/subagents.jsonl` and 12 session totals
 * in `sessions.jsonl` were written by the pre-#963 recipe, and roughly 39 of
 * 3,015 stop records in this repo (~1.3%) came from an affected transcript. No
 * rewrite is attempted — the ledger is append-only and the transcripts that
 * produced the oldest records have since aged out, so a rewrite would be a
 * reconstruction, not a correction. Consumers comparing across the 2026-08-03
 * boundary must treat it as a series break.
 *
 * Partial-usage assumption (#624): a turn carrying `input_tokens` but no
 * `output_tokens` (or vice-versa) contributes 0 to the absent side — NOT null —
 * so the present side still sums and the aggregate stays valid.
 *
 * NEVER throws. Any failure (missing/unreadable path, 0 assistant turns, parse
 * error) yields { tokenInput: null, tokenOutput: null } so the hook still exits 0.
 *
 * @param {string|undefined|null} transcriptPath — absolute path from stdin
 * @returns {{ tokenInput: number|null, tokenOutput: number|null }}
 */
function extractTranscriptUsage(transcriptPath) {
  const nullResult = { tokenInput: null, tokenOutput: null };
  try {
    if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return nullResult;
    if (!fs.existsSync(transcriptPath)) return nullResult;

    // Bounded-read guard (#624): skip an oversized transcript gracefully rather
    // than read the whole file into memory. statSync failure (race/unreadable)
    // falls through to the readFileSync attempt below — both stay inside the
    // no-throw try/catch, so the worst case is still nullResult, never a throw.
    const { size } = fs.statSync(transcriptPath);
    if (size > MAX_TRANSCRIPT_BYTES) return nullResult;

    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');

    /** requestId -> the LAST usage block seen for it (#950). */
    const byRequestId = new Map();
    /**
     * message.id -> the LAST usage block seen for it, for blocks carrying NO
     * requestId (#963). Same last-wins recipe, a different key: on
     * non-Anthropic-model transcripts the streaming snapshots carry `message.id`
     * and no requestId, so this is the identity that collapses them. See the
     * Dedup-fallback block above for the measurement and the losslessness proof.
     */
    const byMessageId = new Map();
    /**
     * Usage blocks carrying NEITHER key. Their identity is unknown, so each is
     * counted as its own turn — absent is not zero and not "same turn as the
     * next keyless block". Zero blocks in the measured corpus land here; it is a
     * forward-compat path, and this time that is stated as an untested branch
     * rather than as an established fact about the harness.
     */
    const unkeyable = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // skip a single malformed line, keep parsing the rest
      }
      if (!obj || obj.type !== 'assistant') continue;
      const usage = obj.message?.usage;
      if (!usage || typeof usage !== 'object') continue;

      // Dedup by requestId — keep the LAST usage block per id (#950). The
      // repeats are cumulative streaming snapshots, so overwriting is what
      // promotes the partial first snapshot to the response's real total.
      const requestId = obj.requestId;
      if (typeof requestId === 'string' && requestId) {
        byRequestId.set(requestId, usage);
        continue;
      }

      // No requestId — dedup on `message.id` instead, same last-wins recipe
      // (#963). The guard mirrors the requestId branch above ON PURPOSE: a bare
      // `byMessageId.set(obj.message?.id, usage)` maps EVERY keyless block to the
      // single key `undefined`, silently merging unrelated turns into one and
      // under-reporting instead of over-reporting. Only a non-empty string is a
      // usable identity; anything else falls through to the individual count.
      const messageId = obj.message?.id;
      if (typeof messageId === 'string' && messageId) {
        byMessageId.set(messageId, usage);
      } else {
        unkeyable.push(usage);
      }
    }

    const kept = [...byRequestId.values(), ...byMessageId.values(), ...unkeyable];

    // No assistant turns with usage → leave fields null (forward-compat).
    if (kept.length === 0) return nullResult;

    let tokenInput = 0;
    let tokenOutput = 0;
    for (const usage of kept) {
      // Per-turn clamp (#624): add a turn's value ONLY when it is a non-negative
      // integer. A poisoned value (negative, NaN, float like 10.5) is skipped so
      // the good turns survive. An absent side contributes 0, not null.
      const inTok = usage.input_tokens;
      const outTok = usage.output_tokens;
      if (Number.isInteger(inTok) && inTok >= 0) tokenInput += inTok;
      if (Number.isInteger(outTok) && outTok >= 0) tokenOutput += outTok;
    }

    // The aggregate is guaranteed a non-negative integer by per-turn clamping
    // above (Σ of non-negative integers), so emit it directly.
    return {
      tokenInput,
      tokenOutput,
    };
  } catch {
    return nullResult;
  }
}

/**
 * Derive the path of the subagent's OWN transcript from the parent transcript
 * path the harness sends on stdin (#949).
 *
 * Thin wrapper over the consolidated derivation (#1196) —
 * `hooks/_lib/subagent-paths.mjs` `resolveSubagentSidecar()` — which now
 * applies a `{1,64}` bound to `agentId` (STRICTER than this file's prior
 * unbounded `+` charset check; see that module's header for the full
 * divergence table). Returns null — never the parent path — when the
 * derivation is not possible. Falling back to `transcript_path` IS the #949
 * defect: it makes every stop inherit the parent's running token totals, so
 * the caller must record null instead (an honest absence).
 *
 * @param {string|undefined|null} parentTranscriptPath — stdin `transcript_path`
 * @param {string} agentId — the stopping agent's id
 * @returns {string|null} absolute candidate path, or null when underivable
 */
function resolveSubagentTranscriptPath(parentTranscriptPath, agentId) {
  const sidecar = resolveSubagentSidecar({ transcriptPath: parentTranscriptPath, agentId });
  return sidecar === null ? null : sidecar.transcript;
}

/**
 * Scan the tail of the ledger backwards for the most recent 'start' record with
 * the given agent_id and return its timestamp in epoch-ms (#917).
 *
 * Reads only the last START_JOIN_TAIL_BYTES rather than the whole file — see that
 * constant for the measured sizing rationale. Scanning backwards means the FIRST
 * hit is the most recent start, which is the correct one when an agent_id is
 * reused across sessions (measured 2026-07-30: 22 of 1420 distinct start ids
 * appeared more than once).
 *
 * NEVER throws. Any failure (missing file, unreadable, no match, unparseable
 * timestamp) yields null so the caller falls back to an honest "unknown".
 *
 * @param {string} filePath — ledger path
 * @param {string} agentId — the stopping agent's id
 * @returns {number|null} epoch-ms of the matching start, or null
 */
function findStartTimestampMs(filePath, agentId) {
  let fd;
  try {
    if (typeof agentId !== 'string' || !agentId.trim()) return null;
    if (!fs.existsSync(filePath)) return null;

    const { size } = fs.statSync(filePath);
    if (size === 0) return null;

    const readLen = Math.min(size, START_JOIN_TAIL_BYTES);
    const from = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readLen, from);

    const lines = buf.toString('utf8').split('\n');
    // When the window does not cover the whole file, the first element is a
    // record sliced mid-line (possibly mid-UTF-8-sequence). Drop it rather than
    // feed a corrupt fragment to JSON.parse.
    if (from > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      // Cheap pre-filter — skip JSON.parse for the ~99% of lines that cannot match.
      if (!line.includes(agentId)) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // tolerate a torn/malformed line, keep scanning
      }
      if (!obj || obj.event !== 'start' || obj.agent_id !== agentId) continue;
      const ms = Date.parse(obj.timestamp);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Resolve duration_ms for a stop event (#917).
 *
 * Precedence:
 *   1. A usable harness-supplied duration_ms — authoritative when present.
 *      In practice Claude Code's SubagentStop payload does NOT carry this field,
 *      which is exactly why every pre-#917 record read 0.
 *   2. Wall-clock join: now − the precomputed timestamp of this agent's own
 *      start record (`startedAtMs`, resolved ONCE by the caller — it also feeds
 *      the #939 `start_record_found` discriminator).
 *   3. null — the honest value when the duration is genuinely unknowable.
 *
 * Why null and not 0: a stop that took zero milliseconds never happened, so a 0
 * is indistinguishable from "we never measured". The no-start branch is the
 * DOMINANT path, not a corner case, and worsening (#939, measured 2026-07-31
 * over the live ledger):
 *   - lifetime mean: 1494 of 2923 stop records (51.1%) have no start record
 *     with their agent_id anywhere in the ledger;
 *   - running traffic is far worse — the lifetime mean flatters it:
 *       since 2026-07-20:        894 stops, 157 matched (17.6%)
 *       since 2026-07-29:        408 stops,  62 matched (15.2%)
 *       since 2026-07-30T17:41:  122 stops,   8 matched ( 6.6%)
 *     i.e. ~93% of CURRENT stop traffic is orphaned (the harness phantom-stop
 *     class — see the file header). Writing 0 there would keep fabricating
 *     exactly the value #917 removed.
 *
 * @param {object} input — raw stdin payload
 * @param {number|null} startedAtMs — epoch-ms of this agent's own start record,
 *   or null when no start record is recoverable (phantom stop, 'unknown' id,
 *   or start outside the tail window)
 * @returns {number|null} duration in ms, or null when unknown
 */
function resolveDurationMs(input, startedAtMs) {
  const supplied = input.duration_ms;
  if (typeof supplied === 'number' && Number.isFinite(supplied) && supplied > 0) {
    return Math.round(supplied);
  }

  if (startedAtMs === null) return null;

  const elapsed = Date.now() - startedAtMs;
  // A non-positive elapsed means a clock jump or a start recorded in the future —
  // not a measurement. Report unknown rather than invent a plausible number.
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  return Math.round(elapsed);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  if (!input) return;

  const eventName = input.hook_event_name;
  const event = eventName === 'SubagentStart' ? 'start' : 'stop';

  // Pick the first non-empty trimmed string from the candidate keys, or the fallback.
  const firstNonEmptyString = (keys, fallback) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return fallback;
  };

  // Resolve identifiers from either naming convention the harness may use.
  const agentId = firstNonEmptyString(['agent_id', 'subagent_id'], 'unknown');
  const agentType = firstNonEmptyString(['agent_type', 'subagent_type'], null);
  const parentSessionId = firstNonEmptyString(['parent_session_id', 'session_id'], null);

  /** @type {object} */
  const record = {
    timestamp: new Date().toISOString(),
    event,
    agent_id: agentId,
    schema_version: 1,
    ...(agentType !== null ? { agent_type: agentType } : {}),
    ...(parentSessionId !== null ? { parent_session_id: parentSessionId } : {}),
  };

  // #939 forensic breadcrumb: registration (hooks.json) sends exactly
  // SubagentStart|SubagentStop to this script, so any OTHER (or missing) event
  // name is a payload anomaly. It is still written as 'stop' for
  // backwards-compat, but the raw name is preserved verbatim so the "missing
  // hook_event_name silently defaults to stop" hypothesis stays decidable from
  // the ledger instead of requiring another inference pass. Never stamped on
  // well-formed payloads — the field's PRESENCE is the anomaly signal.
  if (eventName !== 'SubagentStart' && eventName !== 'SubagentStop') {
    record.hook_event_name = typeof eventName === 'string' ? eventName : null;
  }

  if (event === 'stop') {
    // #939 orphan guard: resolve the start-join ONCE — it feeds both the
    // duration measurement and the explicit orphan discriminator below.
    // 'unknown' is the agent-id fallback for a payload with no usable id —
    // joining on it would collide across unrelated agents, so never scan for it.
    const startedAtMs = agentId === 'unknown' ? null : findStartTimestampMs(JSONL_PATH, agentId);

    // duration_ms (#917): prefer the harness value, else join backwards to this
    // agent's own start record, else null. Never 0 — see resolveDurationMs().
    record.duration_ms = resolveDurationMs(input, startedAtMs);

    // start_record_found (#939): makes the harness phantom-stop class (see file
    // header) mechanically filterable at read time. false = no start record for
    // this agent_id in the tail window — for ~93% of current stop traffic this
    // is the phantom class, whose token fields describe the PARENT transcript,
    // not a real subagent.
    record.start_record_found = startedAtMs !== null;

    // subagent_transcript_found (#949): does this stop have a real subagent
    // transcript of its own? Measured 25/25 on typed stops and 0/343 on
    // phantoms, so it is the sharpest phantom discriminator available — and it
    // is exactly the provenance flag a reader needs before trusting token_*.
    const subagentTranscriptPath = resolveSubagentTranscriptPath(input.transcript_path, agentId);
    const subagentTranscriptFound =
      subagentTranscriptPath !== null && fs.existsSync(subagentTranscriptPath);
    record.subagent_transcript_found = subagentTranscriptFound;

    // Tokens are NOT sent on stdin (#624) — recover them from the SUBAGENT's own
    // transcript, deduped by requestId. Any failure → null. There is deliberately
    // NO fallback to input.transcript_path: that path is the parent session
    // transcript, and reading it is the #949 defect (every stop inherited the
    // parent's running totals). A phantom stop gets null — the honest value.
    const { tokenInput, tokenOutput } = subagentTranscriptFound
      ? extractTranscriptUsage(subagentTranscriptPath)
      : { tokenInput: null, tokenOutput: null };
    if (tokenInput !== null) record.token_input = tokenInput;
    if (tokenOutput !== null) record.token_output = tokenOutput;

    // Cost is best-effort / forward-compat (#624): the native transcript does
    // NOT expose total_cost_usd today, so this is null in practice. No rate
    // table — use the native cost only, default null when absent.
    const totalCostUsd =
      typeof input.total_cost_usd === 'number' && Number.isFinite(input.total_cost_usd) && input.total_cost_usd >= 0
        ? input.total_cost_usd
        : null;
    record.total_cost_usd = totalCostUsd;

    // OTel alias — #411 additive, schema_version=1 backwards-compat
    record['gen_ai.usage.input_tokens'] = tokenInput;
    record['gen_ai.usage.output_tokens'] = tokenOutput;
    record['gen_ai.system'] = 'anthropic';
  }

  await appendSubagent(JSONL_PATH, record);
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
