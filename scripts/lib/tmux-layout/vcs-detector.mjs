/**
 * vcs-detector.mjs — Resolve the CI-watch pane command for the tmux default layout.
 *
 * Reads the `vcs:` key from Session Config and returns a poll-loop shell command
 * suitable for Pane 3 (bottom-right). Both glab and gh are poll-based (not live-tail),
 * so all commands are wrapped in a `while true; sleep` loop per D5 findings.
 *
 * Issue #561 — ADR-0007 tmux-visualization substrate.
 *
 * ## The probed pane commands — SSOT for the lockstep test
 *
 * The two lines below are the argv this module emits, with the resolved repo
 * spec written as `<spec>` and the `2>&1` redirect dropped. They are not a
 * description of the commands: `tests/lib/tmux-layout/vcs-detector.test.mjs`
 * reconstructs the same normalisation from `detectVcsCommand()` and asserts
 * equality, so a flag added to the emitted command without a matching probe
 * here turns that test RED. See § Why a probe line, not prose.
 *
 *   PROBE 2026-08-14 glab 1.91.0: glab ci status -R <spec> --output json
 *   PROBE 2026-08-14 gh 2.86.0: gh pr checks --watch
 *
 * ## Why `glab ci status` carries no pipeline selector (#1022)
 *
 * The glab pane emitted `--pipeline-id LATEST` until 2026-08-14. That flag does
 * not exist on any `glab ci` subcommand, and `glab ci status --help` (1.91.0)
 * lists only `-b --branch`, `-c --compact`, `-l --live`, `-F --output`,
 * `-R --repo`. Probed from a non-git cwd against this repo's own remote:
 *
 *   with the flag → `ERROR Unknown flag: --pipeline-id.`, exit 1
 *   without it    → exit 0, `{"jobs":[…],"pipeline":{…}}`
 *
 * So the flag was the sole cause and it has NO replacement: the argument-less
 * form already means "the pipeline of the current branch" (glab's own help
 * example). `--branch=<name>` is the only selector glab offers and is
 * deliberately NOT used — it would freeze a render-time branch snapshot into a
 * pane that must follow the operator's checkout, the same reason the gh pane
 * takes no positional.
 *
 * The `jq` filter was dead by the same measurement and is fixed with it: the
 * payload is an OBJECT keyed `jobs`/`pipeline`, so the old `.[]` raised
 * `Cannot index array with string "name"` (jq exit 5) on every real response.
 * `.jobs[]` returns one `<status> <name>` line per job. Because the whole
 * pipeline is `… 2>&1 | jq … 2>/dev/null || echo …`, both failures were
 * swallowed into the fallback text — the pane printed "glab not available or no
 * pipeline" against a healthy pipeline, indistinguishable from a missing binary.
 *
 * ## Why only the glab pane carries `-R` (#971)
 *
 * The pane commands run in whatever cwd the operator pastes the one-liner into,
 * so an omitted `-R`/`--repo` silently targets the ambient cwd remote. Both
 * halves were probed against the installed binaries on 2026-08-14
 * (glab 1.91.0 / gh 2.86.0) and they do NOT behave the same:
 *
 *  - `glab ci status -R <spec> --output json` from a NON-git cwd → exit 0 with
 *    real pipeline JSON. The flag is applicable and makes the pane
 *    cwd-independent, so it is passed whenever `resolveRepoSpec()` resolves one.
 *  - `gh pr checks -R <spec>` with NO positional argument →
 *    `argument required when using the --repo flag` (exit non-zero, no output).
 *    gh selects "the PR of the current branch" ONLY in the argument-less form;
 *    `-R` is legal there only alongside a `<number> | <url> | <branch>`
 *    positional, which this pane deliberately does not have (the watched branch
 *    must follow the operator's checkout, and a render-time branch snapshot
 *    would go stale on the next `git switch`). Adding `-R` there would break the
 *    pane at runtime — the exact defect shape recorded in
 *    `scripts/lib/ci-status-banner.mjs` (`-R` on `gh repo view`, which rejects
 *    it). The gh pane therefore stays cwd-scoped BY MEASUREMENT, not by
 *    oversight.
 *
 * ## Why a probe line, not prose
 *
 * The #971 sweep added `-R` here and left `--pipeline-id` untouched, then wrote
 * a header documenting a probe of `glab ci status -R <spec> --output json` —
 * a command the pane never emitted. The measurement was real and cited for
 * something it had not measured, so a dead flag rode through a green test.
 * NAMED CEILING: the lockstep only proves that command and probe were changed
 * together; it cannot prove the probe was re-executed. It buys the one step
 * that was skipped — no flag change without touching the measurement record.
 * Revisit if a pane ever needs a runtime-varying flag, which this shape cannot
 * express.
 */

import { resolveRepoSpec } from '../vcs-repo-spec.mjs';

/**
 * Shell-safe spec shape. A git remote URL (`git@host:group/project.git`,
 * `https://host/group/project.git`) and an `OWNER/REPO` spec are both fully
 * inside this character class, so a matching value can be spliced into the pane
 * command line without quoting. A value OUTSIDE it is DROPPED (the flag is
 * omitted) rather than quoted — this mirrors `resolveRepoSpec`'s own contract
 * that an unresolvable spec means "omit the flag entirely", never "emit a
 * broken one", and keeps a hostile remote URL out of the pane's shell.
 */
const SHELL_SAFE_SPEC_RE = /^[A-Za-z0-9._:/@+-]+$/;

/**
 * Resolve the CI-watch pane command based on Session Config vcs: key.
 *
 * @param {{
 *   config?: object,
 *   projectRoot: string,
 *   gitRun?: (args: string[]) => { ok: boolean, stdout: string, stderr: string }
 * }} args
 *   - gitRun: optional `resolveRepoSpec` seam, so callers/tests can pin the
 *     resolved repo spec instead of spawning `git` against the real checkout.
 * @returns {{ bin: 'glab'|'gh'|null, command: string, fallback: string, blocking: boolean, platform: 'gitlab'|'github'|null }}
 *   - command: the shell command for Pane 3 (wrapped in poll-loop since glab/gh are poll-based, not live-tail)
 *   - fallback: shell command shown when bin is not available in PATH
 */
export function detectVcsCommand({ config, projectRoot, gitRun }) {
  const vcs = config?.vcs;   // 'gitlab' | 'github' | undefined

  if (vcs === 'gitlab') {
    const spec = resolveRepoSpec({
      repoRoot: projectRoot,
      vcs: 'gitlab',
      ...(typeof gitRun === 'function' ? { gitRun } : {}),
    });
    const repoFlag = spec && SHELL_SAFE_SPEC_RE.test(spec) ? ` -R ${spec}` : '';
    return {
      bin: 'glab',
      platform: 'gitlab',
      blocking: true,
      command: [
        'while true; do',
        '  clear;',
        '  date;',
        "  echo '--- glab ci status (refresh: 15s) ---';",
        // No pipeline selector: `--pipeline-id` is not a glab flag (1.91.0
        // rejects it outright) and the argument-less form already means "the
        // current branch's pipeline". `.jobs[]`, not `.[]` — the payload is an
        // object. Both measured 2026-08-14; see the module header.
        `  glab ci status${repoFlag} --output json 2>&1`,
        "    | jq -r '.jobs[] | \"\\(.status) \\(.name)\"' 2>/dev/null",
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
        // No `-R` here BY MEASUREMENT, not by oversight: `gh pr checks -R <spec>`
        // without a positional PR/branch argument is rejected outright
        // ("argument required when using the `--repo` flag", gh 2.86.0), and this
        // pane must follow the operator's current branch. See the module header.
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
