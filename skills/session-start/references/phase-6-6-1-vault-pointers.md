# Phase 6.6.1: Vault Pointers (#2169)

> Sub-file of the session-start skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 6.6.1: Vault Pointers (#2169)

> Skip silently unless `vault-integration.briefing-search` is `true` in Session Config (default `false`). With the key unset, run nothing: the start is byte-identical to a start without this phase.

Agents read a vault note mostly when its path is already in front of them, and seldom call a search tool on their own. This step runs ONE ranked search over the vault with the session topic and lays a few pointers into your briefing. No model call.

### Topic

Build the topic from what this session is about, as plain words:

1. the operator's task text from the invocation (`/session <type> <text>`), when given;
2. otherwise the titles of the top 1–3 candidate issues from Phase 6.

### Run

Write the topic words verbatim with your file-writing tool (not the shell) to a new temporary UTF-8 file, then redirect that file into the script, with the path in double quotes:

```bash
node "${PLUGIN_ROOT}/scripts/print-vault-pointers.mjs" < "<topic file>"
```

Run this Bash call with a tool timeout of 15000 ms; the script ends itself after 8 s, and the tool timeout is the outer limit should it ever not. The topic text never appears in a shell command: not in a heredoc (a line of issue text equal to the heredoc's end word ends the input early and the shell runs the rest), not in a `--topic "…"` argument (`$(…)` or backticks would run before the script starts). This is the same rule `commands/session.md` sets for the invocation text. The script sanitizes the topic (letters, digits, spaces, hyphens; at most 120 characters), resolves the command (`vault-search` on PATH, else `python3 <vault-dir>/scripts/retrieval/vault_search.py`), stops it after 5 s, and prints at most 5 pointers in at most 600 characters. When `vault-integration.vault-dir` resolves to a directory, the search is pinned to it and the block header names it, so the paths can be read from any repo. A host that switched the integration off (`SO_VAULT_INTEGRATION=off`, owner.yaml) runs no search. It always exits 0. Empty stdout means no block: omit the slot and continue. Never retry and never run a second query in this phase.

Each printed block records `orchestrator.vault.pointers_shown` with the shown paths in the local `events.jsonl` (`docs/events-schema.md`). The optional event webhook gets only the count and the source, never a path.

### Use

Put the printed block verbatim into the Session Overview under **Vault Pointers (candidates)** (`presentation-format.md`). Then:

- These are search candidates, not findings. Some will be noise, especially for plugin-internal topics.
- Read a note only when it fits the task you and the operator agree on in Phase 8. Do not read all of them up front.
- Hand a pointer to a subagent only when it fits that agent's file scope and task. Never pass the block on to subagent briefs as a whole.
