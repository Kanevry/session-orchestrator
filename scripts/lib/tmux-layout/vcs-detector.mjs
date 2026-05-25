/**
 * vcs-detector.mjs — Resolve the CI-watch pane command for the tmux default layout.
 *
 * Reads the `vcs:` key from Session Config and returns a poll-loop shell command
 * suitable for Pane 3 (bottom-right). Both glab and gh are poll-based (not live-tail),
 * so all commands are wrapped in a `while true; sleep` loop per D5 findings.
 *
 * Issue #561 — ADR-0007 tmux-visualization substrate.
 */

/**
 * Resolve the CI-watch pane command based on Session Config vcs: key.
 *
 * @param {{ config?: object, projectRoot: string }} args
 * @returns {{ bin: 'glab'|'gh'|null, command: string, fallback: string, blocking: boolean, platform: 'gitlab'|'github'|null }}
 *   - command: the shell command for Pane 3 (wrapped in poll-loop since glab/gh are poll-based, not live-tail)
 *   - fallback: shell command shown when bin is not available in PATH
 */
export function detectVcsCommand({ config, projectRoot: _projectRoot }) {
  const vcs = config?.vcs;   // 'gitlab' | 'github' | undefined

  if (vcs === 'gitlab') {
    return {
      bin: 'glab',
      platform: 'gitlab',
      blocking: true,
      command: [
        'while true; do',
        '  clear;',
        '  date;',
        "  echo '--- glab ci status (refresh: 15s) ---';",
        '  glab ci status --pipeline-id LATEST --output json 2>&1',
        "    | jq -r '.[] | \"\\(.status) \\(.name)\"' 2>/dev/null",
        "    || echo 'glab not available or no pipeline';",
        '  sleep 15;',
        'done',
      ].join(' '),
      fallback: [
        'while true; do',
        '  clear;',
        "  echo 'glab not installed — install: brew install glab (macOS) / apt install glab (Linux)';",
        '  sleep 60;',
        'done',
      ].join(' '),
    };
  }

  if (vcs === 'github') {
    return {
      bin: 'gh',
      platform: 'github',
      blocking: true,
      command: [
        'while true; do',
        '  clear;',
        '  date;',
        "  echo '--- gh pr checks --watch (will exit on PR completion) ---';",
        '  gh pr checks --watch 2>&1',
        "    || echo 'no PR in current branch';",
        '  sleep 15;',
        'done',
      ].join(' '),
      fallback: [
        'while true; do',
        '  clear;',
        "  echo 'gh CLI not installed — install: brew install gh (macOS) / apt install gh (Linux)';",
        '  sleep 60;',
        'done',
      ].join(' '),
    };
  }

  // vcs unset or other value — show a static informational message
  return {
    bin: null,
    platform: null,
    blocking: false,
    command: [
      'while true; do',
      '  clear;',
      "  echo 'vcs: not configured in Session Config (CLAUDE.md / AGENTS.md on Codex CLI).';",
      "  echo 'Set vcs: gitlab or vcs: github to enable CI-watch in this pane.';",
      '  sleep 60;',
      'done',
    ].join(' '),
    fallback: '',
  };
}
