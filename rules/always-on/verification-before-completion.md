<!-- source: session-orchestrator plugin (canonical: rules/always-on/verification-before-completion.md) -->
# Verification Before Completion (Always-on)

Evidence before assertions. If you have not run the verification command in this message, you cannot claim it passes. This rule exists because the most expensive failure class in a long-lived repo is the silent regression that ships behind a "should work" claim.

## The Iron Law

> **NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

"Fresh" means: in the current message thread, within the last few tool calls, against the current working tree. A test result from 5 minutes ago no longer counts if you have written code since. A type check from before the last edit no longer counts.

## VBC-001: The Gate Function

Before any claim of completion ("done", "passes", "green", "complete", "fixed"), run this gate:

1. **IDENTIFY** — name the specific command that verifies the claim (the project's test / typecheck / lint command, `gh pr checks`, `glab ci status`, `curl <url>`, …)
2. **RUN** — execute the command completely. Do not extrapolate from partial output. Do not skip flags ("the long version is slow" is not an exception).
3. **READ** — read the FULL output (not just the last 5 lines) and check the exit code. Many test runners report "PASS" lines for individual cases while exiting non-zero overall.
4. **VERIFY** — confirm the output actually demonstrates the claim. "312 passed" verifies "tests pass". "312 passed / 7 failed" does NOT verify "tests pass" even though the first number is impressive.
5. **STATE** — make the claim, quoting the evidence: "Tests pass: 312 passed / 0 failed / 12 skipped (exit 0)" — never "Tests pass" alone.

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
| "Tests pass" | The project's test command exits 0 + per-file count | "I ran one file" |
| "TypeScript clean" | `tsgo --noEmit` / `tsc --noEmit` exit 0 | "The file I edited compiled" |
| "Lint clean" | The project's lint command exits 0 | "The editor extension shows no errors" |
| "CI green" | `glab ci status` / `gh pr checks` on the current SHA | "Last pipeline was green" (last week) |
| "Migration applies" | A reset against a clean database succeeds | "It worked on my dev DB" |
| "Endpoint works" | `curl <url>` returns expected status + body | "The browser showed it" |
| "Hook fires" | Trigger the hook event + read the resulting log line | "The hook config looks right" |
| "Issue closed" | `gh issue view <N>` / `glab issue view <N>` shows state=closed | "I commented `closes #N`" |
| "Subagent edit persisted" | `git diff --stat` / `--name-only` shows the declared file(s) changed after the agent reported done | "The agent reported done" |

## VBC-004: Exceptions (Narrow)

These are the only acceptable contexts in which a verification command may be deferred:

1. **Read-only exploration**: claims about CODE STATE (not behavior) can cite a file read instead of a command run. "The function is at file:line" verifies via a read, not via test execution.
2. **Coordinator orchestration**: claims about SUBAGENT outputs (not your own work) cite the agent's reported status — but the coordinator accepts that status only paired with its OWN `git diff --name-only` evidence that the agent's declared files actually changed. An agent's word is a claim, not proof of a filesystem effect. The agent itself must have followed VBC-001 — the coordinator's claim is "agent reported done with evidence X, confirmed changed in `git diff --name-only`", not "the work is done" on the status alone.
3. **Documentation-only changes**: changes to `*.md` files that affect no code paths can skip test runs. They still require typecheck/lint if those tools touch markdown.

If you think you have a fourth exception, you do not. Run the command.

## VBC-005: Why This Is Strict

- The most expensive failures are the ones a claim covers up.
- "Should pass" claims are not falsifiable — they invite no challenge and produce no learning. Evidence-anchored claims either pass or surface a real problem; both outcomes have value.
- Verification commands are cheap. Investigating a regression days after the fact is expensive. The cost ratio is at least 10:1, often 100:1.
- Treat this rule with the same enforcement weight as the ask-via-tool and destructive-action safeguards: the default is the command, and skipping it requires an explicit named exception above.

## Anti-Patterns

- Claiming "tests pass" without running the test command in the current message
- Citing a test run from before the last edit
- Quoting only the success count when failures exist ("312 passed" suppressing "/ 7 failed")
- Saying "should work now" instead of running the verification
- Treating an agent's reported "done" as evidence (it's a claim that needs its own verification)
- Skipping verification because "the change is trivial"

## See Also

npm-quality-gates.md · ask-via-tool.md · parallel-sessions.md · receiving-review.md · test-value.md · build-value.md
