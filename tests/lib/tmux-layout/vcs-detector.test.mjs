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

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { detectVcsCommand } from '../../../scripts/lib/tmux-layout/vcs-detector.mjs';

/** Module URL — no hardcoded home path (owner-leakage gate). */
const MODULE_URL = new URL('../../../scripts/lib/tmux-layout/vcs-detector.mjs', import.meta.url);

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

  // --- #971: repo-spec pinning of the pane commands -------------------------
  //
  // These assert on the FULL argument list of the CLI invocation, never on a
  // bare `toContain('-R')`. A substring probe is what let the sibling defect in
  // `scripts/lib/ci-status-banner.mjs` survive: its test mocks execFile and
  // asserts `toContain('-R')`, so it stays green while the flag it pins is one
  // gh REJECTS. Only the exact token list discriminates "right flag", "wrong
  // flag", and "flag on a subcommand that refuses it".

  /** Stub `git remote get-url` for `resolveRepoSpec` — no real checkout touched. */
  const gitRunReturning = (url) => (args) =>
    args.includes('remote') && args.includes('get-url')
      ? { ok: true, stdout: `${url}\n`, stderr: '' }
      : { ok: false, stdout: '', stderr: 'no such remote' };

  /**
   * Extract the CLI invocation from the poll-loop wrapper as an exact token
   * list. Splits the `;`-separated loop body and takes the segment that STARTS
   * with the CLI name — an `echo '--- glab ci status …'` banner segment starts
   * with `echo`, so it can never be mistaken for the invocation — then cuts at
   * the first pipe (the `| jq` / `|| echo` tail is not part of the argv).
   */
  const argvOf = (command, cli) => {
    const segment = command
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cli} `));
    return segment ? segment.split('|')[0].trim().split(/\s+/) : null;
  };

  it('pins the repo spec on the glab pane so the pipeline is not read from the ambient cwd remote', () => {
    const result = detectVcsCommand({
      config: { vcs: 'gitlab' },
      projectRoot: '/tmp/test',
      gitRun: gitRunReturning('git@example.test:group/project.git'),
    });
    // Full argv — a bare toContain('-R') would also pass for `-R` in the wrong
    // position, on the wrong subcommand, or with a mangled spec.
    expect(argvOf(result.command, 'glab')).toEqual([
      'glab', 'ci', 'status',
      '-R', 'git@example.test:group/project.git',
      '--output', 'json',
      '2>&1',
    ]);
  });

  it('omits the flag entirely when no remote resolves (never emits a bare -R)', () => {
    const result = detectVcsCommand({
      config: { vcs: 'gitlab' },
      projectRoot: '/tmp/test',
      gitRun: () => ({ ok: false, stdout: '', stderr: 'not a git repository' }),
    });
    expect(argvOf(result.command, 'glab')).toEqual([
      'glab', 'ci', 'status', '--output', 'json', '2>&1',
    ]);
  });

  it('drops a spec carrying shell metacharacters instead of splicing it into the pane shell', () => {
    const result = detectVcsCommand({
      config: { vcs: 'gitlab' },
      projectRoot: '/tmp/test',
      gitRun: gitRunReturning('https://example.test/g/p.git;touch$(id)'),
    });
    expect(result.command).not.toContain('touch');
    expect(argvOf(result.command, 'glab')).toEqual([
      'glab', 'ci', 'status', '--output', 'json', '2>&1',
    ]);
  });

  it('does NOT put -R on the gh pane — gh pr checks rejects it without a positional argument', () => {
    // Probed 2026-08-14 (gh 2.86.0): `gh pr checks -R cli/cli` with no
    // positional prints "argument required when using the `--repo` flag" and
    // produces no output. Adding the flag here would break the pane at runtime,
    // so its ABSENCE is the contract — pinned as a full argv list so a future
    // "sweep every call site" pass cannot quietly add it.
    const result = detectVcsCommand({
      config: { vcs: 'github' },
      projectRoot: '/tmp/test',
      gitRun: gitRunReturning('git@github.test:owner/repo.git'),
    });
    expect(argvOf(result.command, 'gh')).toEqual(['gh', 'pr', 'checks', '--watch', '2>&1']);
  });

  // --- #1022: command ↔ probe lockstep ---------------------------------------
  //
  // The bug this catches, by name: the #971 sweep added `-R` to the glab pane
  // and left `--pipeline-id LATEST` in place — a flag glab 1.91.0 rejects with
  // `Unknown flag` — while writing a module header that documented a probe of
  // `glab ci status -R <spec> --output json`, a command the pane never emitted.
  // The probe was real; it just measured something else than what shipped, so
  // the dead flag rode through a green suite. Run against that tree, this test
  // fails: emitted `--pipeline-id LATEST`, probed without it.
  //
  // What it CANNOT do, stated so nobody reads more into a green run: it never
  // asks glab whether the flag exists. A test that shells out to the real CLI
  // is not runnable in CI (no glab, no network, no token), so the mechanical
  // reach stops at "the emitted command and the recorded measurement changed
  // together". Re-executing the probe stays a human step.

  /** Probe lines from the module header: `PROBE <date> <cli> <version>: <command>`. */
  const probeLines = () => {
    const source = readFileSync(MODULE_URL, 'utf8');
    return [...source.matchAll(/^\s*\*\s+PROBE\s+\d{4}-\d{2}-\d{2}\s+(gh|glab)\s+\S+:\s*(.+?)\s*$/gm)].map(
      (match) => ({ cli: match[1], command: match[2] }),
    );
  };

  /**
   * Emitted argv, rendered the way a probe line writes it: the resolved spec
   * collapses to `<spec>` (its value is per-checkout, the flag's presence is
   * not) and the `2>&1` redirect drops (shell plumbing, not argv).
   */
  const probeFormOf = (command, cli) => {
    const argv = argvOf(command, cli);
    const rendered = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '2>&1') continue;
      rendered.push(argv[index]);
      if (argv[index] === '-R') {
        rendered.push('<spec>');
        index += 1;
      }
    }
    return rendered.join(' ');
  };

  it('every pane command is recorded verbatim as a probe line in the module header', () => {
    const probes = probeLines();
    // Both panes, so a probe block that silently loses a line fails here too.
    expect(probes.map((entry) => entry.cli).sort()).toEqual(['gh', 'glab']);

    const glab = detectVcsCommand({
      config: { vcs: 'gitlab' },
      projectRoot: '/tmp/test',
      gitRun: gitRunReturning('git@example.test:group/project.git'),
    });
    const github = detectVcsCommand({ config: { vcs: 'github' }, projectRoot: '/tmp/test' });

    expect(probes.find((entry) => entry.cli === 'glab')?.command).toBe(probeFormOf(glab.command, 'glab'));
    expect(probes.find((entry) => entry.cli === 'gh')?.command).toBe(probeFormOf(github.command, 'gh'));
  });

  it('reads the pipeline payload as an object — `.[]` on it is a jq type error, not a filter', () => {
    // glab 1.91.0 `ci status --output json` returns {"jobs":[…],"pipeline":{…}}.
    // Probed 2026-08-14 against this repo's own pipeline: `.[] | "\(.status)
    // \(.name)"` → `Cannot index array with string "name"`, jq exit 5, and the
    // pane's `2>/dev/null || echo` tail turns that into the same "no pipeline"
    // text a missing binary produces. Pinning the accessor keeps the two apart.
    const result = detectVcsCommand({ config: { vcs: 'gitlab' }, projectRoot: '/tmp/test' });
    expect(result.command).toContain('.jobs[]');
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
