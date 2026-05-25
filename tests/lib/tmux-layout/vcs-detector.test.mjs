/**
 * tests/lib/tmux-layout/vcs-detector.test.mjs
 *
 * Tests for scripts/lib/tmux-layout/vcs-detector.mjs — verifies the CI-watch
 * command returned by detectVcsCommand() matches the expected shape for each
 * vcs platform AND that the poll-loop wrapper correctly contains --unbuffered
 * (jq 1.7+) per W4 coordinator research (jq --line-buffered flag was removed
 * in jq 1.6+; the modern flag is --unbuffered).
 *
 * Source: W1 D5 finding — glab ci status is POLL-based, NOT live-tail.
 * Source: WebSearch synthesis 2026-05-25 — jq buffering best practices.
 */

import { describe, it, expect } from 'vitest';
import { detectVcsCommand } from '../../../scripts/lib/tmux-layout/vcs-detector.mjs';

describe('detectVcsCommand', () => {
  it('returns glab command + --unbuffered when vcs=gitlab', () => {
    const result = detectVcsCommand({
      config: { vcs: 'gitlab' },
      projectRoot: '/tmp/test',
    });
    expect(result.bin).toBe('glab');
    expect(result.platform).toBe('gitlab');
    expect(result.command).toContain('glab ci status');
    // Per W4 coordinator research: jq 1.7+ uses --unbuffered, not --line-buffered.
    expect(result.command).toMatch(/jq.*--unbuffered|jq -r/);
    // Poll-loop wrapper per W1 D5 (glab is NOT live-tail — must wrap in while/sleep)
    expect(result.command).toContain('while true');
    expect(result.command).toContain('sleep');
  });

  it('returns gh command when vcs=github', () => {
    const result = detectVcsCommand({
      config: { vcs: 'github' },
      projectRoot: '/tmp/test',
    });
    expect(result.bin).toBe('gh');
    expect(result.platform).toBe('github');
    expect(result.command).toContain('gh pr checks');
    expect(result.command).toContain('while true');
  });

  it('returns informational fallback when vcs unset', () => {
    const result = detectVcsCommand({
      config: {},
      projectRoot: '/tmp/test',
    });
    expect(result.bin).toBeNull();
    expect(result.platform).toBeNull();
    // Fallback should reference BOTH CLAUDE.md AND AGENTS.md per the
    // instruction-file-alias-coverage convention (issue #33).
    expect(result.command).toContain('CLAUDE.md');
    expect(result.command).toContain('AGENTS.md');
  });

  it('returns informational fallback when config is missing', () => {
    const result = detectVcsCommand({ projectRoot: '/tmp/test' });
    expect(result.bin).toBeNull();
    expect(result.platform).toBeNull();
  });

  it('command output is a single line (no embedded newlines that would break tmux send-keys)', () => {
    const gitlab = detectVcsCommand({ config: { vcs: 'gitlab' }, projectRoot: '/tmp' });
    const github = detectVcsCommand({ config: { vcs: 'github' }, projectRoot: '/tmp' });
    const fallback = detectVcsCommand({ config: {}, projectRoot: '/tmp' });
    expect(gitlab.command).not.toMatch(/\n/);
    expect(github.command).not.toMatch(/\n/);
    expect(fallback.command).not.toMatch(/\n/);
  });
});
