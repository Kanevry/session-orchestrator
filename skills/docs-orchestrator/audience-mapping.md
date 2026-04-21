# Audience Mapping

Rules for mapping session scope to target audiences, content sources, and documentation ownership.

## Audiences & File Patterns

| Audience | Target files (globs) | Typical update triggers |
|----------|----------------------|-------------------------|
| User | `README.md`, `docs/user/**/*.md`, `docs/getting-started.md`, `examples/**/*.md` | new CLI command, breaking API change, install flow change, new user-facing feature, changed example output |
| Dev | `CLAUDE.md`, `docs/dev/**/*.md`, `docs/adr/**/*.md` | architecture decision, major refactor, new module/subsystem, test coverage change, dependency upgrade, ADR-worthy choice |
| Vault/Ops | `<vault>/01-projects/<slug>/context.md`, `<vault>/01-projects/<slug>/decisions.md`, `<vault>/01-projects/<slug>/people.md` | project status change, ownership transition, stack/infra decision, cross-project dependency, migration, archival event |

## Source Rules

Four sources are permitted. Every docs-writer task prompt must enumerate which sources
apply. Content without a traceable source gets `<!-- REVIEW: source needed -->` — the
agent NEVER invents content.

1. **diff** — Direct code changes from `git diff $SESSION_START_REF..HEAD`. Authoritative
   for Dev narratives (what changed and why) and Vault decisions (what was decided, when).
   Preferred primary source for Dev audience tasks.
2. **git-log** — Commit messages and associated PR/MR bodies from
   `git log $SESSION_START_REF..HEAD`. Secondary context for all audiences. Use to
   reconstruct the "why" when code diffs alone are ambiguous.
3. **session-memory** — Session transcript, wave outputs, agent summaries, and test
   results stored in `.orchestrator/` during the current session. Primary source for
   Vault narratives (status updates, decisions made in conversation). Also the source
   for User audience tasks where the feature was designed interactively.
4. **affected-files** — Full content of files modified in this session, passed to
   docs-writer as context. Primary for User and Dev content where understanding the
   updated interface, configuration schema, or module structure is required.

**Ban on hallucination:** any section without a traceable source gets
`<!-- REVIEW: source needed -->`. This marker signals to the human reviewer that the
content needs verification before the next release. The docs-writer MUST NOT invent
architecture decisions, CLI flags, or status narratives from general knowledge.

## Non-Overlap with Sibling Skills

| Skill | Owned pattern | Relationship |
|-------|---------------|--------------|
| vault-sync | Frontmatter validation + wiki-link integrity (read-only quality gate) | Complementary. vault-sync validates what docs-writer produces; it never edits files, so no target conflict. |
| vault-mirror | `<vault>/01-projects/<slug>/_overview.md` | Read-only input. docs-writer MUST NOT edit. vault-mirror regenerates this file from JSONL on every session-end. |
| claude-md-drift-check | CLAUDE.md drift diagnostics | Complementary. drift-check flags divergence; docs-writer remediates via the Dev audience path. Must not run on CLAUDE.md in parallel within the same session wave. |
| daily | `<vault>/03-daily/YYYY-MM-DD.md` | Forbidden target. docs-writer NEVER writes here. daily owns this path exclusively and is idempotent-by-design; a second writer would corrupt the day's scratch notes. |

## Example Prompt Skeleton for docs-writer

The following is a representative prompt that docs-orchestrator generates for a Dev
audience task. Adjust file-pattern target, trigger, and sources per task.

```
You are docs-writer. Your task is to update developer documentation based on
session output.

## Task
Audience: Dev
File-pattern target: docs/dev/**/*.md, CLAUDE.md
Trigger: New `coordinator-snapshot.mjs` module added; CWD-drift guard introduced
  in wave-executor (issues #196, #219).

## Allowed Sources
- diff: `git diff $SESSION_START_REF..HEAD` (provided below)
- git-log: `git log $SESSION_START_REF..HEAD --format="%H %s%n%b"` (provided below)
- session-memory: wave summaries and agent outputs (provided below)
- affected-files: content of modified .mjs and SKILL.md files (provided below)

No other sources are permitted. Do not use general knowledge about Node.js APIs,
architectural patterns, or project history that is not present in the sources above.

## Hallucination Ban
Any section you write that cannot be traced to one of the four sources above MUST
include the marker:
  <!-- REVIEW: source needed -->
Do not omit this marker to make the output look cleaner. Human reviewers depend on
it to catch invented content before it ships.

## Forbidden Targets
- <vault>/01-projects/*/_overview.md — owned by vault-mirror. Do not edit.
- <vault>/03-daily/* — owned by daily. Do not edit.

## Sources
[diff output inserted here]
[git-log output inserted here]
[session-memory summary inserted here]
[affected-files content inserted here]
```
