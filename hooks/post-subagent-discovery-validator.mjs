#!/usr/bin/env node
/**
 * post-subagent-discovery-validator.mjs — SubagentStop hook that mechanically
 * enforces PSA-006 (distributional claims need adjacent grep transcripts).
 *
 * Issue #567 (v1), Issue #908 (repo-state facts). Non-blocking (log + warn
 * only). EXIT 0 ALWAYS — exit 2 (blocking) is RESERVED for a future hard-gate
 * and MUST NOT be used here.
 *
 * Decision flow:
 *   1. shouldRunHook('post-subagent-discovery-validator') gate — exit 0 when disabled.
 *   2. Read JSON payload from stdin; require hook_event_name === 'SubagentStop'.
 *   3. Read `discovery-validator.enabled` from CLAUDE.md/AGENTS.md Session Config.
 *      Default OFF (opt-in) — exit 0 immediately unless explicitly enabled.
 *   4. Resolve the STOPPING SUBAGENT's OWN transcript (never the parent):
 *      `input.agent_transcript_path` when the harness sends it, else
 *      `<dir(transcript_path)>/<base>/subagents/agent-<agent_id>.jsonl`. Scan its
 *      TAIL (last ~8 `type:"assistant"` records), concat text blocks. When no
 *      `agent_id` is derivable (or the file is absent) the hook exits 0 and
 *      records NOTHING — see the scope note below.
 *   5. Hand the concatenated text to `hooks/_lib/subagent-transcript.mjs`
 *      `findViolations()` — the whole matcher (claim patterns, negative-context
 *      guards, evidence proximity, normalisation, dedup) lives there so it can
 *      be measured against a claim corpus without spawning this hook. It
 *      returns DEDUPLICATED `{claim, normalized, occurrences}` records.
 *   6. Attribute the claim: `agent` + `agent_source` (`payload`|`meta`|`none`)
 *      + `agent_description`, and — on `none` — the sorted stdin `payload_keys`
 *      the harness DID send, so a gap is diagnosable from the ledger.
 *   7. Write ONE record per distinct claim per session (session-scoped tmp
 *      sentinel), plus a stderr WARN. ADVISORY (#908 Baustein 2 input): claims
 *      that ARE verified but carry no measurement TIMESTAMP are counted and
 *      reported in the warn text — never recorded as violations in v1.
 *
 * Why read a transcript at all: the SubagentStop stdin payload has NO
 * output_text field — the agent's text only exists on disk.
 *
 * WHICH transcript (#1191, the root cause behind the fleet false-positive
 * flood): `input.transcript_path` is the PARENT/MAIN session transcript, not
 * the subagent's. Scanning it flagged the COORDINATOR's own prose — wave plans,
 * TL;DRs, complexity scores. Measured 2026-09-02 on a seeded random sample of
 * 60 violations: 100% coordinator text, scope-adjusted precision 0%, and
 * `agent` was `"unknown"` in 90.8% of 1,541 vault events. The hook therefore
 * reads `<transcriptDir>/<session>/subagents/agent-<agent_id>.jsonl` (the same
 * layout `hooks/subagent-telemetry.mjs` and `scripts/lib/wave-transcript-tail.mjs`
 * read) and NEVER falls back to the parent path: a scan of the wrong transcript
 * is worse than no scan.
 *
 * Output channels — THREE writes, TWO different recipients:
 *   - `discovery_validator_violation` in .orchestrator/metrics/events.jsonl,
 *     and the stderr WARN → the COORDINATOR's only copy of the finding. PSA-006
 *     makes REJECTING the unverified claim his duty, so these two are the
 *     channels that carry the rule's enforcement path.
 *   - stdout `hookSpecificOutput.additionalContext` → the STOPPING SUBAGENT
 *     (which continues and may self-correct), NOT the coordinator — a hook is
 *     structurally unable to address him. See the measured delivery note at the
 *     hookSpecificOutput write below for the shipped-binary evidence.
 *   All three are pinned together by the "all three channels fire" test in
 *   tests/hooks/post-subagent-discovery-validator.test.mjs — do not collapse
 *   the coordinator-visible pair into additionalContext.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('post-subagent-discovery-validator')) process.exit(0);

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveSubagentSidecar } from './_lib/subagent-paths.mjs';
import { findViolations, readTranscriptTail } from './_lib/subagent-transcript.mjs';
import { appendJsonl } from '../scripts/lib/common.mjs';
import { eventsFilePath } from '../scripts/lib/events.mjs';
import { getProjectDir } from '../scripts/lib/platform.mjs';
import { _parseDiscoveryValidator } from '../scripts/lib/config/discovery-validator.mjs';

// ---------------------------------------------------------------------------
// stdin reading (inline — Stop-family hooks exit 0 always, never deny)
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * Uses a 5 s timeout consistent with the Claude Code hook contract.
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

// ---------------------------------------------------------------------------
// config gate
// ---------------------------------------------------------------------------

/**
 * Read `discovery-validator.enabled` from CLAUDE.md (or AGENTS.md) at the
 * project root. Cheap inline read — avoids importing the full config orchestrator
 * from a hot hook path. Default OFF: any read failure resolves to disabled.
 *
 * @returns {Promise<boolean>}
 */
async function isEnabled() {
  const candidates = [
    path.join(getProjectDir(), 'CLAUDE.md'),
    path.join(getProjectDir(), 'AGENTS.md'),
  ];
  for (const file of candidates) {
    try {
      const content = await fs.readFile(file, 'utf8');
      return _parseDiscoveryValidator(content).enabled === true;
    } catch {
      // missing or unreadable — try next candidate
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// payload helpers
// ---------------------------------------------------------------------------

/**
 * Pick the first non-empty trimmed string value from `input` across the given
 * candidate keys, in order. Returns `fallback` when none match. Mirrors the
 * helper in hooks/subagent-telemetry.mjs so the two hooks resolve session ids
 * identically (parent_session_id first).
 *
 * @param {object} input
 * @param {string[]} keys
 * @param {*} fallback
 * @returns {string|*}
 */
function firstNonEmptyString(input, keys, fallback) {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return fallback;
}

/**
 * Resolve the STOPPING SUBAGENT's own sidecar pair (#1191, #1196).
 *
 * Thin wrapper over the consolidated derivation —
 * `hooks/_lib/subagent-paths.mjs` `resolveSubagentSidecar()` — which now ALSO
 * containment-checks the `agent_transcript_path` override this file used to
 * return unvalidated (see that module's header divergence table). Returns
 * null when the derivation is impossible — the caller must then scan
 * NOTHING. Falling back to `input.transcript_path` is the defect this
 * function exists to remove: that path is the coordinator's transcript.
 *
 * @param {object} input — SubagentStop stdin payload
 * @param {string|null} agentId
 * @returns {{base: string, transcript: string, meta: string}|null}
 */
function resolveAgentTranscriptPath(input, agentId) {
  const agentTranscriptPath = firstNonEmptyString(input, ['agent_transcript_path'], null);
  return resolveSubagentSidecar({ transcriptPath: input.transcript_path, agentId, agentTranscriptPath });
}

/**
 * Agent types carry a plugin qualifier, so the COLON is part of the real shape:
 * `session-orchestrator:code-implementer` (37 chars, measured on-disk in a real
 * sidecar meta.json 2026-09-02). Same constant as `AGENT_TYPE_META_RE` in
 * hooks/on-stop.mjs — kept local because the two hooks share no module.
 */
const AGENT_TYPE_META_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * The sidecar `description` is free operator prose ("W1-d5 Scripts-Audit"), so
 * it is clamped by LENGTH and stripped of control characters rather than
 * charset-validated. 120 chars is the widest description measured on-disk
 * (2026-09-06, 20 real `agent-*.meta.json` files under
 * `~/.claude/projects/<slug>/<session>/subagents/`: max 34 chars).
 *
 * Exposure note: unlike `orchestrator.agent.stopped` — which deliberately
 * omits `description` because that record travels the optional Clank webhook
 * unredacted (see hooks/on-stop.mjs) — this record is appended straight to
 * `.orchestrator/metrics/events.jsonl` via `appendJsonl`, never through
 * `emitEvent`, and it ALREADY carries up to 200 characters of the agent's own
 * prose in `claim_text`. Carrying the description adds no new exposure class.
 */
const AGENT_DESCRIPTION_MAX = 120;

/**
 * Resolve WHO made the claim, and say where the answer came from (#1218).
 *
 * Measured 2026-09-06 over the fleet's worst-affected repo
 * (`extern/aiat-barrierefrei-engine`, 3,360 `discovery_validator_violation`
 * records): `agent` was the literal string `"unknown"` on 3,026 of them
 * (90.1%), and NOT ONE record carried an `agent_id`. Both the sidecar-meta
 * fallback and the `agent_id` field landed in the same commit (936dae8a,
 * 2026-09-02); the newest of those 3,360 records is 2026-08-25. The 90.1% is
 * therefore a property of a PRE-FIX corpus, not of the code at HEAD — d3's
 * open question 3 ("pre- or post-#1191?") resolves to *pre*.
 *
 * What the corpus does NOT excuse is the SHAPE of the answer. Two gaps remain
 * at HEAD and this function closes them:
 *
 *   1. `"unknown"` was indistinguishable from a real agent type named
 *      "unknown", and carried no hint of WHY resolution failed. The record now
 *      always carries `agent_source` — `payload` | `meta` | `none` — and, on
 *      `none`, the sorted list of stdin keys that WERE present, so the next
 *      reader diagnoses the harness gap from the ledger instead of guessing.
 *   2. `agentType` is frequently the useless class `general-purpose`: measured
 *      on the same day over 20 real sidecars in THIS repo's own session
 *      directory, 14 read `general-purpose` and only 6 a plugin-qualified type.
 *      The sidecar's `description` ("W1-d5 Scripts-Audit") is what actually
 *      identifies the agent, so it is carried alongside as
 *      `agent_description`.
 *
 * @param {object} input — SubagentStop stdin payload
 * @param {string} metaPath — `resolveSubagentSidecar(...).meta`
 * @returns {Promise<{agent: string, source: 'payload'|'meta'|'none', description: string|null, payloadKeys: string[]}>}
 */
async function resolveAgentAttribution(input, metaPath) {
  const fromPayload = firstNonEmptyString(input, ['agent_type', 'subagent_type'], null);
  // Clamped with the same shape hooks/on-stop.mjs applies to `agentType`
  // (colon included — `session-orchestrator:code-implementer` is the real
  // shape). This value reaches BOTH the ledger event and the model-visible
  // `additionalContext` string, so a mismatch is OMITTED rather than
  // truncated: an unmeasured type stays visibly unmeasured.
  const payloadAgent =
    fromPayload !== null && AGENT_TYPE_META_RE.test(fromPayload.trim()) ? fromPayload.trim() : null;

  let metaAgent = null;
  let description = null;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    const t = meta?.agentType;
    if (typeof t === 'string' && AGENT_TYPE_META_RE.test(t.trim())) metaAgent = t.trim();
    const d = meta?.description;
    if (typeof d === 'string' && d.trim()) {
      // Control characters (a stray NUL above all: one NUL makes a text
      // file invisible to every grep-based audit) are replaced, never
      // carried. Filtered by code point rather than by a control-char
      // regex so this file itself stays greppable.
      const clean = [...d]
        .map((ch) => { const c = ch.codePointAt(0); return c < 0x20 || c === 0x7f ? ' ' : ch; })
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean) description = clean.slice(0, AGENT_DESCRIPTION_MAX);
    }
  } catch {
    // absent or corrupt sidecar meta — the payload branch still stands
  }

  const agent = payloadAgent ?? metaAgent ?? 'unknown';
  const source = payloadAgent !== null ? 'payload' : metaAgent !== null ? 'meta' : 'none';
  // Keys only, never values: the diagnostic question is "what DID the harness
  // send?", and a value could carry a path or prose that has no business in a
  // record whose whole point is attribution.
  const payloadKeys = input && typeof input === 'object' ? Object.keys(input).sort() : [];
  return { agent, source, description, payloadKeys };
}

/**
 * Sanitize a user/runtime-provided string for use in a tmp sentinel filename.
 *
 * @param {string} s
 * @returns {string}
 */
function safeSentinelComponent(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Produce a short stable hash for project-root isolation in tmp sentinels.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function projectRootHash(projectRoot) {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

/**
 * Build the dedup sentinel path for real project/session/agent/claim contexts.
 * Missing fallback IDs intentionally return null so unrelated hooks/tests do
 * not collide on a global "unknown" key.
 *
 * #1198 FIX 1: the key used to be `(projectRoot, sessionId, agent_type)` —
 * `agent_type` is a CLASS ("discovery"), not an individual agent, so two
 * DIFFERENT real subagents of the same type running in the same session
 * collided on the same sentinel: the second agent's own `additionalContext`
 * feedback was silently suppressed even though it never received a copy of
 * the first agent's warning. Keying on `agentId` (the harness's per-process
 * `agent_id`/`subagent_id`) instead removes that cross-agent collision. The
 * claim-text hash is ADDITIVE: it lets a genuinely SECOND, DISTINCT claim
 * from the same real agent still surface its own suppression check, rather
 * than being silenced merely because that agent already triggered once for a
 * different claim.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string|null} opts.sessionId
 * @param {string|null} opts.agentId
 * @param {string|null} opts.claimText
 * @returns {string|null}
 */
function dedupSentinelPath({ projectRoot, sessionId, agentId, claimText }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  if (typeof agentId !== 'string' || !agentId.trim()) return null;
  if (typeof claimText !== 'string' || !claimText.trim()) return null;

  const claimHash = createHash('sha256').update(claimText).digest('hex').slice(0, 16);
  return path.join(
    tmpdir(),
    `psa006-${projectRootHash(projectRoot)}-${safeSentinelComponent(sessionId)}-${safeSentinelComponent(agentId)}-${claimHash}.lock`
  );
}

/**
 * Build the SESSION-scoped LEDGER sentinel for one normalized claim (#1198).
 *
 * Distinct from `dedupSentinelPath` above in BOTH key and effect, and the
 * difference is the point:
 *   - `dedupSentinelPath` is keyed on the individual AGENT and suppresses only
 *     the `additionalContext` echo, so each real agent still receives its own
 *     copy of the feedback.
 *   - this one is keyed on the SESSION and the NORMALIZED claim, and suppresses
 *     the events.jsonl WRITE. The ledger is a record of distinct findings; the
 *     same sentence re-asserted by a second agent of the same session is the
 *     same finding, and writing it twice is what produced a duplication factor
 *     of 16.4 (3,360 records over 205 distinct `claim_text` values, measured
 *     2026-09-06 in `extern/aiat-barrierefrei-engine`).
 *
 * Returns null without a session id — a claim that cannot be bound to a session
 * must not collide with an unrelated one under a global "unknown" key, so it is
 * always written (the pre-#1198 behaviour, preserved for that case only).
 *
 * NAMED CEILING (BV-004): one zero-byte tmp file per distinct claim per
 * session, never cleaned up by this hook — the same shape (and the same
 * unbounded growth) `dedupSentinelPath` above has carried since #567, relying
 * on the OS's tmpdir reaping. Fine at the measured rate: 158 distinct claims
 * across a repo's worst 90 days. REVISIT TRIGGER: a repo whose distinct-claim
 * count per session reaches the hundreds — then this belongs in a single
 * per-session state file rather than one inode per claim.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string|null} opts.sessionId
 * @param {string} opts.normalizedClaim — `normalizeClaim()` output
 * @returns {string|null}
 */
function claimLedgerSentinelPath({ projectRoot, sessionId, normalizedClaim }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  if (typeof normalizedClaim !== 'string' || !normalizedClaim) return null;

  const claimHash = createHash('sha256').update(normalizedClaim).digest('hex').slice(0, 16);
  return path.join(
    tmpdir(),
    `psa006-claim-${projectRootHash(projectRoot)}-${safeSentinelComponent(sessionId)}-${claimHash}.lock`
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  if (!input) return;
  if (input.hook_event_name !== 'SubagentStop') return;

  if (!(await isEnabled())) return;

  // #1191: scan the SUBAGENT's own transcript, never the parent. No agent_id
  // (or no derivable path) → scan nothing and record nothing.
  const agentId = firstNonEmptyString(input, ['agent_id', 'subagent_id'], null);
  const sidecar = resolveAgentTranscriptPath(input, agentId);
  if (sidecar === null) return;

  const text = await readTranscriptTail(sidecar.transcript);
  const { violations, undatedVerified } = findViolations(text);
  if (violations.length === 0) return;

  const attribution = await resolveAgentAttribution(input, sidecar.meta);
  const agent = attribution.agent;
  // session_id precedence: parent_session_id first, mirroring the sibling hook
  // hooks/subagent-telemetry.mjs (firstNonEmptyString(['parent_session_id',
  // 'session_id'])). W2-review LOW finding (#567) — the prior `session_id ||
  // parent_session_id` order disagreed with telemetry and could log the wrong id.
  const sessionId = firstNonEmptyString(input, ['parent_session_id', 'session_id'], null);

  // Project/session/agent/claim deduplication: only emit additionalContext
  // once for repeated real contexts. Missing session IDs never create/read a
  // sentinel, so fallback traffic still surfaces warnings and cannot collide
  // globally. Keyed on agentId (not agent TYPE, #1198 FIX 1) plus the first
  // violation's claim text so distinct real agents and distinct claims never
  // share a sentinel.
  const projectRoot = getProjectDir();
  const sentinel = dedupSentinelPath({
    projectRoot,
    sessionId,
    agentId,
    claimText: violations[0].claim,
  });

  // Ledger write, ONE record per distinct normalized claim (#1198). Two
  // levels, because the duplication had two sources: `findViolations()` already
  // collapsed the repeats INSIDE this transcript tail into an `occurrences`
  // count, and the session sentinel below drops a claim this session has
  // already recorded from an earlier SubagentStop.
  const filePath = eventsFilePath();
  let written = 0;
  for (const violation of violations) {
    const claimSentinel = claimLedgerSentinelPath({
      projectRoot,
      sessionId,
      normalizedClaim: violation.normalized,
    });
    if (claimSentinel !== null) {
      let seen = false;
      try {
        await fs.writeFile(claimSentinel, '', { flag: 'wx' });
      } catch (err) {
        // EEXIST = this session already recorded this claim. Any OTHER
        // filesystem error must NOT suppress the record: losing a finding to a
        // full disk or a read-only tmpdir is the worse failure.
        seen = err && err.code === 'EEXIST';
      }
      if (seen) continue;
    }
    await appendJsonl(filePath, {
      event: 'discovery_validator_violation',
      timestamp: new Date().toISOString(),
      agent,
      // Always present, even (especially) on 'none': a bare "unknown" is
      // indistinguishable from a real agent type of that name, and says
      // nothing about WHY resolution failed.
      agent_source: attribution.source,
      ...(attribution.description !== null ? { agent_description: attribution.description } : {}),
      ...(attribution.source === 'none' ? { payload_keys: attribution.payloadKeys } : {}),
      ...(agentId !== null ? { agent_id: agentId } : {}),
      ...(sessionId !== null ? { session_id: sessionId } : {}),
      claim_text: violation.claim,
      occurrences: violation.occurrences,
    });
    written++;
  }

  // Advisory only (#908 item 4) — never promoted to a violation in v1.
  const undatedNote = undatedVerified > 0
    ? ` ${undatedVerified} verified claim(s) carry no measurement timestamp (advisory).`
    : '';

  // `written < violations.length` means this session had already recorded the
  // difference from an earlier SubagentStop — say so rather than let the WARN
  // count and the ledger count disagree with no explanation (#1198).
  const suppressedNote = written < violations.length
    ? ` ${violations.length - written} already recorded earlier in this session.`
    : '';

  const warnText =
    `⚠ PSA-006: ${violations.length} distinct repo-state/distributional claim(s) from agent ` +
    `"${agent}" (source: ${attribution.source}) lack an adjacent measurement transcript ` +
    `(grep/rg/find/git/wc/jq/ls/node/npm) (non-blocking).` +
    `${suppressedNote}${undatedNote} ` +
    `See .claude/rules/parallel-sessions.md § PSA-006.`;
  process.stderr.write(warnText + '\n');

  let alreadyWarned = false;
  if (sentinel !== null) {
    try {
      await fs.writeFile(sentinel, '', { flag: 'wx' });
    } catch (err) {
      // EEXIST means another hook process already won this real-context key.
      // Other filesystem errors should not suppress the inline warning.
      alreadyWarned = err && err.code === 'EEXIST';
    }
  }

  if (alreadyWarned) {
    // Events logged above; suppress the repeat additionalContext for this
    // already-warned real context. (Recipient is the stopping subagent, not the
    // coordinator — see the delivery note at the hookSpecificOutput write below.)
    return;
  }

  // v2.1.163+ additionalContext: surface the finding inline, not just in
  // stderr + events.jsonl.
  //
  // The recipient is the SUBAGENT that just stopped — NOT the coordinator.
  // Measured in the shipped binary (Claude Code 2.1.241, 2026-08-23): the
  // SubagentStop hookSpecificOutput schema reads "additionalContext is
  // non-error feedback delivered to the subagent; the subagent continues so it
  // can act on it", and the emitter picks its target with
  // `i.agentId ? "SubagentStop" : "Stop"`, yielding a `hook_additional_context`
  // message into that agent's own loop. So this text lands in the transcript of
  // the agent whose claims it is about, one moment after that agent is done.
  //
  // Worth knowing before "fixing" the path: PSA-006 asks the COORDINATOR to
  // reject unverified distributional claims, and this channel never reaches
  // him. His copy of the finding is events.jsonl + stderr, not this write.
  // Whether he SHOULD receive it is a product question (#1116) — changing the
  // route is not a comment edit.
  //
  // Non-blocking — exit 0 always. Decision:"block" must never be set here.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStop',
      additionalContext: warnText,
    },
  }));
}

// Exit 0 always — informational hook must never block Claude (#567 v1).
main().catch(() => {}).finally(() => process.exit(0));
