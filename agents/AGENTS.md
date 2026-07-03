# `agents/` — Sub-Agent Authoring Conventions

> Nested instruction file for the `agents/` subtree. Claude Code / Cursor IDE
> and Codex CLI both load this additively when working on files in this
> directory (root `CLAUDE.md` for the big picture, this file for local
> conventions). Resolution rule:
> [`../skills/_shared/instruction-file-resolution.md`](../skills/_shared/instruction-file-resolution.md).
>
> This is **not** an agent definition — it is the authoring spec the agent
> `*.md` definitions in this directory must follow. The plugin validator
> (`scripts/lib/validate/check-agents.mjs`) excludes `AGENTS.md` / `CLAUDE.md`
> from agent-frontmatter validation by name.
>
> Sibling spec: for `.claude/rules/*.md` frontmatter (conditional loading via
> globs/mode/host-class/expiry, plus the never-always-on invariant for
> auto-generated rules), see the canonical authoring spec
> [`docs/rule-authoring.md`](../docs/rule-authoring.md).

## Local Validation Commands

Run from the plugin root. These are the scoped checks for any change under `agents/`:

```bash
node scripts/lib/validate/check-agents.mjs .   # Checks 6/7/8: frontmatter, output-schema, sandbox-tier
npm run lint                                   # eslint — agent .md bodies are prose, but schemas/*.json are linted
npm test -- tests/scripts/validate/check-agents.test.mjs tests/unit/sandbox-tier.test.mjs
```

- **test-command:** `npm test -- tests/scripts/validate/check-agents.test.mjs`
- **lint-command:** `npm run lint`

`scripts/validate-plugin.mjs` runs `check-agents.mjs` as Check 7 at plugin-distribution time, so a broken agent file fails CI fast.

## Frontmatter Contract

Agent files live in `agents/` as Markdown with YAML frontmatter. Required fields:

```yaml
---
name: kebab-case-name                # 3-50 chars, lowercase + hyphens only
description: Use this agent when [conditions]. <example>Context: ... user: "..." assistant: "..." <commentary>Why this agent is appropriate</commentary></example>
model: inherit                        # inherit | sonnet | opus | haiku — OR full ID like claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
color: blue                           # blue | cyan | green | yellow | purple | orange | pink | red | magenta
tools: Read, Grep, Glob, Bash         # comma-separated string OR JSON array (both accepted; we prefer comma-string for consistency)
---
```

**Frontmatter spec source:** https://code.claude.com/docs/en/sub-agents § Supported frontmatter fields. Our local validator (`scripts/lib/validate/check-agents.mjs` + `scripts/lib/agent-frontmatter.mjs`) matches the canonical spec on `tools` (both forms accepted), `color` (canonical 8-color palette + magenta for backward-compat), and `model` (aliases + full IDs).

**Required vs optional:**
- Runtime canonical doc: only `name` + `description` are required.
- Our validator (defensive for plugin-distribution): all four of `name + description + model + color` required; `tools` optional.
- `description` MUST be a single-line inline string, NOT a YAML block scalar (`>` or `|`). Put `<example>` blocks inline.
- `tools` accepts BOTH comma-separated string (`Read, Edit, Write`) and JSON array (`["Read", "Edit", "Write"]`). Anthropic's own reference agents use array form; we use string form for consistency.

**Body conventions** (from Anthropic's `plugins/plugin-dev/agents/*` reference set):
- Sections: `**Your Core Responsibilities:**` → `**[X] Process:**` → `**Quality Standards:**` → `**Output Format:**` → `**Edge Cases:**`.
- Length: 500–3000 words is the recommended range. Below 500 reads as under-specified; above 3000 reads as bloated.
- Read-only reviewer agents: tools `Read, Grep, Glob, Bash` (no Edit/Write). Implementer agents: `Read, Edit, Write, Glob, Grep, Bash`.

## Git-Write Ban Requirement (PSA-007, #724)

Every agent definition with `repo-write` sandbox-tier (i.e. `Edit`/`Write` present in `tools:`) MUST carry an explicit git-write ban line in its `## Rules` section:

> Do NOT run ANY git write operation (`git add`, `git commit`, `git stash`, `git mv`, `git rm`, `git push`, `git reset`) — the git index and stash are shared session resources (PSA-007); the coordinator handles ALL VCS operations.

This is deliberately more explicit than a bare "Do NOT commit" — the git index and stash are SHARED resources across concurrently-dispatched sibling agents in the same wave, and `git stash`/`git add`/`git mv`/`git rm` are index-mutating even when scoped to the agent's own files. `docs-writer.md` had NO git-write restriction at all until #724 closed the gap (its `repo-write` siblings at least carried a bare "Do NOT commit" line) — when adding a new repo-write agent, copy the ban line verbatim rather than re-deriving a weaker phrasing so this gap does not recur. See `.claude/rules/parallel-sessions.md` § PSA-007 for the full rationale and fleet evidence.

## Color Allocation Strategy (#443)

`color` is an **operator side-channel**, not a cosmetic field. In a `/tmux-layout` or multi-pane session, the per-agent color lets the operator tell co-running agents apart at a glance. With only a 9-color palette (`blue | cyan | green | yellow | purple | orange | pink | red | magenta`) and more than 9 agents in this directory, some colors are **deliberately shared** — but never carelessly.

**Hard rule:** No two agents that CAN be dispatched in the SAME wave may share a color. Same-wave color collisions defeat the side-channel — the operator can no longer disambiguate two concurrent agents by color. The validator (`scripts/lib/validate/check-agents.mjs`) emits a **WARN** (not FAIL) when two dispatchable agents share a color, so an unintended collision surfaces in CI without blocking distribution.

**Co-dispatch sets** (agents that co-run in one wave — no intra-set color may repeat):

| Set | When co-run | Members (color) |
|---|---|---|
| **Quality wave** | end-of-impl QA pass | test-writer (orange), security-reviewer (red), session-reviewer (pink), qa-strategist (purple) |
| **wave-reviewers (5a)** | inter-wave architecture/QA panel | architect-reviewer (blue), qa-strategist (purple), analyst (yellow) |
| **Impl wave** | feature build | code-implementer (green), ui-developer (magenta), db-specialist (purple), test-writer (orange), docs-writer (cyan) |

qa-strategist takes **purple**: it co-runs with the Quality wave (orange/red/pink) and the wave-reviewers panel (blue/yellow), but never with the Impl wave — so it safely borrows db-specialist's impl-only purple.

**Deliberate-share exceptions** (a same color is acceptable ONLY when the agents can never collide on screen):

- **(a) Dispatchable + non-dispatchable reference doc.** `memory-proposal-collector` carries `color: cyan` but is a coordinator-direct reference doc (its `description` begins "Reference documentation (NOT a dispatchable agent)"). It never dispatches as a subagent, so its color can never collide. The validator skips such files when aggregating collisions.
- **(b) Mutually-exclusive-phase agents.** Two dispatchable agents that run in different, non-overlapping phases never appear in the same wave. Examples: `ux-evaluator` (blue) is dispatched **solo** by test-runner/driver skills and never co-runs with anything — it shares blue with `architect-reviewer` (inter-wave reviewer panel) harmlessly. `dialectic-deriver` (cyan, `/evolve` phase) and `docs-writer` (cyan, impl/finalization phase) run in different phases.

**Instruction for new agents:** when adding an agent past the 9-color budget, do NOT pick a free-looking color blindly. Pick the color of an agent you can **never co-run with** (a different-phase or solo-dispatch agent), and record the pairing rationale in your agent's body or in this table. If you cannot find a safe share, the collision is real — fix the dispatch design, not the color.

## Optional `sandbox-tier:` field (#418)

Agents MAY declare their sandbox permission tier. Valid values:

| Value | Meaning | Typical tools |
|---|---|---|
| `read-only` | observes only; no file writes, no network | `Read, Grep, Glob, Bash` |
| `repo-write` | may create or modify files | `Read, Edit, Write, Glob, Grep, Bash` |
| `network-allowed` | may make outbound network calls (future) | — |
| `dangerous` | may run destructive shell commands (future) | — |

Inference rule (backward-compat): agents without `sandbox-tier:` infer their tier from tools — `Edit` or `Write` present → `repo-write`; only `Read/Grep/Glob/Bash/Skill` → `read-only`. The validator emits **WARN**, not FAIL, when the field is absent, so existing agents continue to work during migration. Bash appears in all tiers — fine-grained Bash control is handled by `hooks/pre-bash-destructive-guard.mjs`, not by tier.

Example:

```yaml
tools: Read, Edit, Write, Glob, Grep, Bash
sandbox-tier: repo-write
output-schema: schemas/code-implementer.schema.json
```

## Optional `output-schema:` field (#417)

Agents MAY declare a JSON-Schema-2020-12 file under `agents/schemas/` that describes the shape of their machine-readable output (the trailing fenced ```json block in the agent's return). Example:

```yaml
tools: Read, Edit, Write, Glob, Grep, Bash
output-schema: schemas/code-implementer.schema.json
```

When present, `scripts/lib/agent-output-schema.mjs#validateAgentOutput()` parses the agent's last fenced ```json block and validates it against the schema (AJV 2020). Agents without `output-schema:` fall through with `mode: 'unvalidated'` (backward-compatible). `scripts/validate-plugin.mjs` Check 7 compiles every declared schema at plugin-distribution time so broken schemas fail fast. Currently declared: `code-implementer`, `db-specialist`, `test-writer`, `ui-developer` (W2 of issue #417); the remaining 7 agents are scoped for a follow-up issue.

Reference: https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/agent-development/SKILL.md
