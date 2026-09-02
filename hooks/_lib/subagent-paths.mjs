/**
 * subagent-paths.mjs — consolidated subagent sidecar-path derivation (#1196).
 *
 * Four call sites independently derived the SAME shape — the stopping
 * subagent's own `agent-<id>.jsonl` transcript + `agent-<id>.meta.json`
 * sidecar, from the PARENT transcript path the harness sends on stdin — and
 * diverged on strictness. Measured 2026-09-02 @ a019d5a4 (this consolidation):
 *
 * | copy (file:line)                                          | honours `agent_transcript_path` | id bound        | rejects `'unknown'` | containment check |
 * |------------------------------------------------------------|:---:|:---:|:---:|:---:|
 * | hooks/subagent-telemetry.mjs:513 `resolveSubagentTranscriptPath` | no  | unbounded (`+`) | yes (:517) | n/a (no override) |
 * | hooks/on-stop.mjs:666 `resolveSidecarBase`                       | no  | `{1,64}` (:566) | **no** | n/a (no override) |
 * | hooks/post-subagent-discovery-validator.mjs:538 `resolveAgentTranscriptPath` | yes (:539) | `{1,64}` (:547) | yes (:549) | **no** — `explicit` returned unchecked (:539) |
 * | scripts/lib/wave-transcript-tail.mjs:610 `readAgentType`         | no  | **none** | no | n/a (no override) |
 *
 * `resolveSubagentSidecar()` below applies the STRICTEST rule found in ANY
 * copy to every caller: the `{1,64}` bound, the `'unknown'` rejection (closes
 * the on-stop.mjs / wave-transcript-tail.mjs gap), AND a path-containment
 * check on the `agentTranscriptPath` override that NONE of the four copies
 * performed — post-subagent-discovery-validator.mjs returned the harness
 * override completely unvalidated. That containment check is a NEW rule this
 * consolidation introduces, not a preserved behaviour.
 *
 * @module hooks/_lib/subagent-paths
 */

import path from 'node:path';

/**
 * Real agent ids are hex-ish tokens (e.g. `a60348a01ca982b4c`); anything else
 * is rejected, not sanitised, so no payload value can traverse out of the
 * `subagents/` directory. `{1,64}` is the strictest bound found across the
 * four prior copies (hooks/subagent-telemetry.mjs used an unbounded `+`;
 * scripts/lib/wave-transcript-tail.mjs applied no charset check at all).
 */
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a candidate agent id against the strictest rule of the four prior
 * copies: the `{1,64}` charset+length bound, AND explicit rejection of the
 * literal `'unknown'` — the no-usable-id fallback value that several callers
 * (`firstNonEmptyString(..., 'unknown')`) substitute when the harness sends no
 * id at all. `'unknown'` matches `AGENT_ID_RE` (it's plain lowercase letters),
 * so a charset check alone does not catch it — hooks/on-stop.mjs's
 * `resolveSidecarBase()` had exactly this gap (AGENT_ID_RE-only, no explicit
 * `'unknown'` rejection) before this consolidation.
 *
 * @param {unknown} agentId
 * @returns {agentId is string}
 */
export function isValidAgentId(agentId) {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId) && agentId !== 'unknown';
}

/**
 * Resolve the sidecar pair (`.jsonl` transcript + `.meta.json`) for a stopping
 * subagent (#949, #1190, #1191, #1196).
 *
 * Two paths to the same result:
 *  - **Override.** `agentTranscriptPath` (the harness's `agent_transcript_path`,
 *    honoured today only by hooks/post-subagent-discovery-validator.mjs:539)
 *    wins when present — but ONLY when, after `path.resolve`, it sits inside
 *    `dirname(transcriptPath)`. An override outside that tree is REJECTED
 *    (returns null), never silently accepted and never falls through to
 *    derivation — a bad override must not resolve to an unrelated agent's
 *    sidecar.
 *  - **Derivation.** `<dir>/<base>/subagents/agent-<agentId>` from the PARENT
 *    transcript path — the shape all four prior copies agree on
 *    (subagent-telemetry.mjs:513, on-stop.mjs:666,
 *    post-subagent-discovery-validator.mjs:552-553, and the subagentsDir
 *    scripts/lib/wave-transcript-tail.mjs's tailLoop() already builds by hand).
 *
 * Returns null — never a guessed or partial path — on ANY invalid input: an
 * empty/non-string `transcriptPath`, an `agentId` failing `isValidAgentId()`
 * (only checked in the derivation branch — the override branch does not need
 * a valid agentId, matching all four prior copies' precedence), or an override
 * that fails containment.
 *
 * NAMED CEILING (BV-004): the meta path is always derived as
 * `transcript.replace(/\.jsonl$/i, '.meta.json')` (or `${transcript}.meta.json`
 * when the transcript has no `.jsonl` suffix to replace — an override the
 * harness contract says never happens; see the header comments of
 * hooks/post-subagent-discovery-validator.mjs). REVISIT TRIGGER: if a real
 * override without a `.jsonl` suffix is ever observed, this needs its own
 * validation branch instead of the current always-well-formed assumption.
 *
 * @param {object} args
 * @param {string|undefined|null} args.transcriptPath — parent transcript path
 *   (stdin `transcript_path`, or an equivalent parent-transcript path)
 * @param {string|undefined|null} args.agentId
 * @param {string|undefined|null} [args.agentTranscriptPath] — harness override
 *   (`agent_transcript_path`); takes precedence over derivation when present
 *   and contained under `dirname(transcriptPath)`
 * @returns {{base: string, transcript: string, meta: string}|null}
 */
export function resolveSubagentSidecar({ transcriptPath, agentId, agentTranscriptPath = null }) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return null;

  const dir = path.dirname(transcriptPath);
  const base = path.basename(transcriptPath).replace(/\.jsonl$/i, '');
  if (!base || base === '.' || base === '..') return null;

  let transcript;
  if (typeof agentTranscriptPath === 'string' && agentTranscriptPath.trim()) {
    const resolvedOverride = path.resolve(agentTranscriptPath);
    const resolvedDir = path.resolve(dir);
    const rel = path.relative(resolvedDir, resolvedOverride);
    const contained = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!contained) return null;
    transcript = resolvedOverride;
  } else {
    if (!isValidAgentId(agentId)) return null;
    transcript = path.join(dir, base, 'subagents', `agent-${agentId}.jsonl`);
  }

  const meta = /\.jsonl$/i.test(transcript)
    ? transcript.replace(/\.jsonl$/i, '.meta.json')
    : `${transcript}.meta.json`;

  return {
    base: transcript.replace(/\.jsonl$/i, ''),
    transcript,
    meta,
  };
}
