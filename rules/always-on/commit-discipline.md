<!-- source: session-orchestrator plugin (canonical: rules/always-on/commit-discipline.md) -->
# Commit Discipline (Always-on)

Every commit in a shared repository is a permanent, public record. Sloppy staging or ambiguous commit messages erode git history quality and make bisect, revert, and code review harder for everyone — including future-you. These rules apply to all contributors regardless of role or urgency.

## Rules

- **Stage by filename, never by glob.** Use `git add <specific-file>` rather than `git add .` or `git add -A`. Blanket staging silently includes unrelated in-progress work from parallel sessions, leftover debug files, and accidental editor artifacts.
- **Review `git diff --cached` before every commit.** Verify each staged line is intentional. If you see changes you did not author, unstage them and ask the user before proceeding.
- **Use Conventional Commits format.** Prefix every commit message with a type: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, or `ci`. Example: `feat(auth): add JWT refresh endpoint`. This feeds automated changelogs and makes intent unambiguous.
- **Describe WHY, not WHAT.** The diff already shows what changed. The commit message should explain the motivation: what problem this solves, what constraint it respects, or what decision it encodes.
- **Never amend a commit you did not create.** `git commit --amend` rewrites history. Amending someone else's commit — even to fix a typo — destroys their authorship record and can corrupt parallel-session work in shared branches.
- **One logical change per commit.** If your work touches unrelated concerns, split it into separate commits. Atomic commits are easier to review, cherry-pick, and revert without side-effects.
- **Never use `--no-verify`.** Pre-commit hooks exist for a reason. If a hook fails, fix the underlying issue rather than bypassing the gate.

## Anti-Patterns

- Running `git add .` in a worktree where another agent is active — you will commit their partial work.
- Writing commit messages like `fix stuff` or `wip` — these carry no information and pollute the log.
- Amending pushed commits — this forces all collaborators to reset, breaking parallel sessions.
- Squashing without reading — blindly squash-merging can discard important intermediate state or commit attribution.
- Committing with `--no-verify` to "just get it in" — the hook is protecting an invariant; skipping it ships a broken state.

## See Also

- `parallel-sessions.md` PSA-004 — the sister rule covering parallel-session staging discipline.
