# Verification Before Completion (Always-on)

Evidence before assertions. If you have not run the verification command in this message, you cannot claim it passes. This rule exists because the most expensive failure class in our history is the silent regression that ships behind a "should work" claim — see CLAUDE.md narrative entries 2026-05-09 deep-3 → deep-1 (8-pipeline silent regression), 2026-04-30 → 2026-05-01 (inter-wave lint regressions caught retroactively).

## The Iron Law

> **NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

"Fresh" means: in the current message thread, within the last few tool calls, against the current working tree. A test result from 5 minutes ago no longer counts if you have written code since. A type check from before the last edit no longer counts.

## VBC-001: The Gate Function

Before any claim of completion ("done", "passes", "green", "complete", "fixed"), run this gate:

1. **IDENTIFY** — name the specific command that verifies the claim (`npm test`, `npm run typecheck`, `npm run lint`, `gh pr checks`, `glab ci status`, `curl <url>`, …)
2. **RUN** — execute the command completely. Do not extrapolate from partial output. Do not skip flags ("the long version is slow" is not an exception).
3. **READ** — read the FULL output (not just the last 5 lines) and check the exit code. Many test runners report "PASS" lines for individual cases while exiting non-zero overall.
4. **VERIFY** — confirm the output actually demonstrates the claim. "5129 passed" verifies "tests pass". "5129 passed / 7 failed" does NOT verify "tests pass" even though the first number is impressive.
5. **STATE** — make the claim, quoting the evidence: "Tests pass: 5129 passed / 0 failed / 12 skipped (npm test exit 0)" — never "Tests pass" alone.

## VBC-002: Banned Phrases

The following phrases are forbidden when used to characterize completion without fresh evidence. They are signals that the Gate Function was skipped.

- "should work now" / "should pass" / "should be fine"
- "I'm confident" / "I believe" / "I'm pretty sure"
- "looks correct" / "looks right" / "looks good"
- "Great!" / "Perfect!" / "Done!" / "Excellent!"
- "Just this once" / "I'll verify later"
- "Agent said success" — the agent's word is not evidence; the verification command is

If you catch yourself typing one of these without the verification evidence in the SAME message, stop. Run the command first, then state the claim with the evidence inline.

## VBC-003: Common Failures Table

| Claim type | Required verification | Common shortcut to avoid |
|---|---|---|
| "Tests pass" | `npm test` / `pnpm test --run` exit 0 + per-file count | "I ran one file" |
| "TypeScript clean" | `tsgo --noEmit` / `tsc --noEmit` exit 0 | "The file I edited compiled" |
| "Lint clean" | `npm run lint` / `pnpm lint` exit 0 | "ESLint extension shows no errors" |
| "CI green" | `glab ci status` / `gh pr checks` on the current SHA | "Last pipeline was green" (last week) |
| "Migration applies" | `supabase db reset` succeeds on a clean DB | "It worked on my dev DB" |
| "Endpoint works" | `curl <url>` returns expected status + body | "The browser showed it" |
| "Hook fires" | Trigger the hook event + read the resulting log line | "The hook config looks right" |
| "Issue closed" | `gh issue view <N>` / `glab issue view <N>` shows state=closed | "I commented `closes #N`" |

## VBC-004: Exceptions (Narrow)

These are the only acceptable contexts in which a verification command may be deferred:

1. **Read-only exploration**: claims about CODE STATE (not behavior) can cite a file read instead of a command run. "The function is at file:line" verifies via Read, not via test execution.
2. **Coordinator orchestration**: claims about SUBAGENT outputs (not your own work) cite the agent's reported STATUS. The agent itself must have followed VBC-001 — the coordinator's claim is "agent reported done with evidence X", not "the work is done".
3. **Documentation-only changes**: changes to `*.md` files that affect no code paths can skip test runs. They still require typecheck/lint if those tools touch markdown.

If you think you have a fourth exception, you do not. Run the command.

## VBC-005: Why This Is Strict

- The session-orchestrator harness exists to detect silent failures. The most expensive ones are the ones a claim covers up.
- "Should pass" claims are not falsifiable — they invite no challenge and produce no learning. Evidence-anchored claims either pass or surface a real problem; both outcomes have value.
- Verification commands are cheap. Investigating a regression days after the fact is expensive. The cost ratio is at least 10:1, often 100:1.
- Treat this rule with the same enforcement weight as AUQ-001 (ask via tool) and PSA-003 (destructive-action safeguards): the default is the command, and skipping it requires an explicit named exception above.

## Anti-Patterns

- Claiming "tests pass" without running the test command in the current message
- Citing a test run from before the last edit
- Quoting only the success count when failures exist ("5129 passed" suppressing "/ 7 failed")
- Saying "should work now" instead of running the verification
- Treating an agent's STATUS: done as evidence (it's a claim that needs its own verification)
- Skipping verification because "the change is trivial"

## See Also

development.md · testing.md · cli-design.md · ask-via-tool.md · parallel-sessions.md · loop-and-monitor.md · receiving-review.md
