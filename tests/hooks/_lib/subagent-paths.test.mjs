/**
 * tests/hooks/_lib/subagent-paths.test.mjs
 *
 * Tests for hooks/_lib/subagent-paths.mjs — consolidated subagent sidecar-path
 * derivation (#1196). Only the named-bug cases per TV-001; the four migrated
 * consumers' own unchanged behaviour is covered by their existing test files.
 *
 * Covered cases:
 *   1. The literal 'unknown' agentId is rejected — proving the gap the charset
 *      regex alone leaves open (it matches plain lowercase letters).
 *   2. An agentId of 65 chars is rejected (the `{1,64}` bound).
 *   3. An `agentTranscriptPath` override outside the transcript's own
 *      directory tree is rejected (the containment check NONE of the four
 *      prior copies performed).
 *   4. A valid override inside the tree is honoured, taking precedence over
 *      derivation.
 *   5. Normal derivation shape: `<dir>/<base>/subagents/agent-<id>.jsonl` (+
 *      `.meta.json`).
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { AGENT_ID_RE, isValidAgentId, resolveSubagentSidecar } from '../../../hooks/_lib/subagent-paths.mjs';

describe('resolveSubagentSidecar', () => {
  it('rejects the literal "unknown" agentId even though it matches the charset regex', () => {
    // Proves the bug: a charset-only check (as hooks/on-stop.mjs's prior
    // AGENT_ID_RE-only guard did) would ACCEPT this value.
    expect(AGENT_ID_RE.test('unknown')).toBe(true);
    expect(isValidAgentId('unknown')).toBe(false);
    expect(
      resolveSubagentSidecar({
        transcriptPath: '/home/user/.claude/projects/repo/session-1.jsonl',
        agentId: 'unknown',
      }),
    ).toBeNull();
  });

  it('rejects an agentId of 65 characters (over the {1,64} bound)', () => {
    const tooLong = 'a'.repeat(65);
    expect(
      resolveSubagentSidecar({
        transcriptPath: '/home/user/.claude/projects/repo/session-1.jsonl',
        agentId: tooLong,
      }),
    ).toBeNull();
  });

  it('rejects an agentTranscriptPath override outside the transcript directory', () => {
    const result = resolveSubagentSidecar({
      transcriptPath: '/home/user/.claude/projects/repo/session-1.jsonl',
      agentId: 'abc123',
      agentTranscriptPath: '/etc/passwd',
    });
    expect(result).toBeNull();
  });

  it('honours a valid agentTranscriptPath override, taking precedence over derivation', () => {
    const override = '/home/user/.claude/projects/repo/session-1/subagents/agent-real-id.jsonl';
    const result = resolveSubagentSidecar({
      transcriptPath: '/home/user/.claude/projects/repo/session-1.jsonl',
      // A malformed agentId would fail derivation, but the override wins
      // BEFORE agentId validation runs — proving precedence.
      agentId: 'unknown',
      agentTranscriptPath: override,
    });
    expect(result).toEqual({
      base: path.resolve(override).replace(/\.jsonl$/i, ''),
      transcript: path.resolve(override),
      meta: path.resolve(override).replace(/\.jsonl$/i, '.meta.json'),
    });
  });

  it('derives the standard sidecar shape from the parent transcript path', () => {
    const result = resolveSubagentSidecar({
      transcriptPath: '/home/user/.claude/projects/repo/session-1.jsonl',
      agentId: 'abc123',
    });
    expect(result).toEqual({
      base: '/home/user/.claude/projects/repo/session-1/subagents/agent-abc123',
      transcript: '/home/user/.claude/projects/repo/session-1/subagents/agent-abc123.jsonl',
      meta: '/home/user/.claude/projects/repo/session-1/subagents/agent-abc123.meta.json',
    });
  });
});
