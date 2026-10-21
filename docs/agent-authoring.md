<!-- Moved in v4.0.0 from `agents/AGENTS.md` (audit 2026-09-06 § 5A). It never was an agent: Claude Code's plugin loader registers every `agents/*.md` by directory convention and the manifest's `agents` key is additive-only, so no manifest entry could exclude it — only pseudo-frontmatter (`name: agents-authoring-spec`, `tools: Read`) kept the false registration bounded. Living under `docs/` removes the registration instead of bounding it. --> <!-- path-check: historical -->

# Sub-Agent Authoring Conventions (`agents/**`)

> Authoring spec for the sub-agent definitions in `agents/`. Read it together
> with the root `CLAUDE.md` (big picture) and, when working under `agents/`,
> whatever nested instruction file that subtree carries. Resolution rule:
> [`../skills/_shared/instruction-file-resolution.md`](../skills/_shared/instruction-file-resolution.md).
>
> **This spec lives in `docs/`, not in `agents/`, on purpose.** Claude Code's
> plugin loader registers every `agents/*.md` as a dispatchable agent by
> directory convention, and the manifest's `agents` key is documented as
> *additive* ("in addition to those in the `agents/` directory"), so it cannot
> exclude a path. As `agents/AGENTS.md` this file was therefore a registered <!-- path-check: historical -->
> agent — first an unnamed one with **full tool access**, later a contained one
> whose pseudo-frontmatter capped `tools` at `Read`. Moving it out of the
> directory removes the registration rather than bounding it. The same applies
> to any future non-agent doc: put it under `docs/`, never in `agents/`.
> (`scripts/lib/validate/check-agents.mjs` still excludes `AGENTS.md` /
> `CLAUDE.md` by name, and `measureDescriptionSurface` still excludes them from
> its walked corpus (#878) — both now vacuous for this file, and the safety net
> for anyone who reintroduces one.)
>
> Sibling spec: for `.claude/rules/*.md` frontmatter (conditional loading via
> globs/mode/host-class/expiry, plus the never-always-on invariant for
> auto-generated rules), see the canonical authoring spec
> [`docs/rule-authoring.md`](./rule-authoring.md).

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
description: Use this agent when [conditions].   # single-line routing sentence; <example> blocks go in the body § Examples
model: opus                           # inherit | sonnet | opus | haiku | fable — OR full ID like claude-opus-5-5, claude-sonnet-4-6, claude-haiku-4-5-20251001, claude-sonnet-5, claude-fable-5
effort: medium                        # low | medium | high | xhigh | max — REQUIRED whenever model is not inherit (#1614)
color: blue                           # blue | cyan | green | yellow | purple | orange | pink | red | magenta
tools: Read, Grep, Glob, Bash         # comma-separated string OR JSON array (both accepted; we prefer comma-string for consistency)
---
```

**Frontmatter spec source:** https://code.claude.com/docs/en/sub-agents § Supported frontmatter fields. Our local validator (`scripts/lib/validate/check-agents.mjs` + `scripts/lib/agent-frontmatter.mjs`) matches the canonical spec on `tools` (both forms accepted), `color` (canonical 8-color palette + magenta for backward-compat), and `model` (aliases + full IDs).

**Required vs optional:**
- Runtime canonical doc: only `name` + `description` are required.
- Our validator (defensive for plugin-distribution): all four of `name + description + model + color` required; `effort` required as soon as `model` is not `inherit`; `tools` optional.
- `omitClaudeMd: true|false` (optional, #1616) drops CLAUDE.md from the agent's start context. Set only on narrow judges that read nothing but the records they are handed (`eval-judge`, `skill-applied-judge`, `dialectic-deriver`); reviewers and implementers keep it because they check against the rules.
- `description` MUST be a single-line inline string, NOT a YAML block scalar (`>` or `|`). It carries only the routing sentence(s) — the text the dispatcher matches on. `<example>…</example>` blocks (with `<commentary>`) do NOT go inline in the description: they live in a `## Examples` section at the end of the body, one block per paragraph (#887, #1157).
- `tools` accepts BOTH comma-separated string (`Read, Edit, Write`) and JSON array (`["Read", "Edit", "Write"]`). Anthropic's own reference agents use array form; we use string form for consistency.

**Body conventions** (from Anthropic's `plugins/plugin-dev/agents/*` reference set):
- Sections: `**Your Core Responsibilities:**` → `**[X] Process:**` → `**Quality Standards:**` → `**Output Format:**` → `**Edge Cases:**`.
- Length: 500–3000 words is the recommended range. Below 500 reads as under-specified; above 3000 reads as bloated.
- Read-only reviewer agents: tools `Read, Grep, Glob, Bash` (no Edit/Write). Implementer agents: `Read, Edit, Write, Glob, Grep, Bash`. Agents on the escalation allowlist append `SendMessage` to either baseline — see § Escalation Channel (#1051) for the six that do and why the rest do not.

## Model Selection & Cost Routing (#768, #1614)

Every agent pins `model:` AND `effort:` explicitly. `inherit` was the default until 2026-10-14 and cost the catalog its users: under a Fable lead, an inheriting agent ran on the most expensive model at the session's effort, and the fleet moved to private opus/medium agents (census in #1614: plugin share of dispatches fell from 61 % in the week of 15 September to 6 % in the week of 8 October).

| Role | model | effort | Agents |
|---|---|---|---|
| Implementation and review | `opus` | `medium` | `code-implementer`, `db-specialist`, `ui-developer`, `session-reviewer`, `security-reviewer`, `architect-reviewer` |
| Tests, docs, analysis | `sonnet` | `medium` | `test-writer`, `docs-writer`, `qa-strategist`, `analyst` |
| Narrow judges | `haiku` | `medium` | `eval-judge`, `skill-applied-judge`, `dialectic-deriver` |
| Rare solo evaluator | `opus` | `medium` | `ux-evaluator` (judges screenshots and AX trees against a rubric, dispatched alone, not fanned out) |

- **`effort` is required whenever `model` is not `inherit`** (validated by `checkAgentEffort` in `scripts/lib/agent-frontmatter.mjs`). The per-model default differs: Sonnet 5.5 defaults to `high`, Opus 5.5 to `medium`, so a Sonnet agent without `effort` thinks longer than an Opus one. `medium` follows the owner's standing instruction (2026-09-30); raise it only for a named reason in the agent.
- **`haiku`** — narrow classification or a single structured verdict over a short input. Whether read-only analysis roles move to Haiku is an open owner decision (#1614); do not switch them until it is made.
- **`sonnet`** — work that needs judgment but not the strongest reasoning: test gaps, docs, PRD and coverage analysis.
- **`opus`** — code changes and reviews, where a missed defect costs more than the tokens.
- **`inherit`** — only with a reason written into the agent (e.g. the agent must follow whatever model the operator chose). It also inherits the session's effort.
- **Full model-ID pinning** (`claude-opus-5-5`, `claude-sonnet-5`, `claude-fable-5-20260101`, …) — only for a demonstrated dependency on one model version (a reproducibility snapshot, a known regression on newer models). Document the reason inline as a frontmatter comment.

Whether `effort` from a **plugin** agent's frontmatter takes effect is not stated in the upstream docs; the #1614 acceptance smoke checks it per role. If it does not, the dispatcher passes `effort` as a dispatch parameter (Claude Code v2.1.292+).

**Resolution order** (highest precedence first): `CLAUDE_CODE_SUBAGENT_MODEL` environment variable → the invocation-time model parameter (if the dispatcher passes one explicitly) → the agent's own frontmatter `model:` value. An agent's `model:` is therefore a default, not a guarantee — a session or environment override can supersede it.

See the [offline role-profile evidence contract](role-profile-contract.md).

## Git-Write Ban Requirement (PSA-007, #724)

Every agent definition with `repo-write` sandbox-tier (i.e. `Edit`/`Write` present in `tools:`) MUST carry an explicit git-write ban line in its `## Rules` section:

> Do NOT run ANY git write operation (`git add`, `git commit`, `git stash`, `git mv`, `git rm`, `git push`, `git reset`) — the git index and stash are shared session resources (PSA-007); the coordinator handles ALL VCS operations.

This is deliberately more explicit than a bare "Do NOT commit" — the git index and stash are SHARED resources across concurrently-dispatched sibling agents in the same wave, and `git stash`/`git add`/`git mv`/`git rm` are index-mutating even when scoped to the agent's own files. `docs-writer.md` had NO git-write restriction at all until #724 closed the gap (its `repo-write` siblings at least carried a bare "Do NOT commit" line) — when adding a new repo-write agent, copy the ban line verbatim rather than re-deriving a weaker phrasing so this gap does not recur. See `.claude/rules/parallel-sessions.md` § PSA-007 for the full rationale and fleet evidence.

**Sole exception — worktree mode (#1614).** Only `code-implementer` may stage its own files one by one and commit, and only when its prompt carries a line `WORKTREE-MODE: <absolute path> <branch>` that matches `git rev-parse --show-toplevel` and `git branch --show-current`; otherwise the ban applies unchanged. Coordinator duty: never grant the coordinator's own worktree, never put two agents in one worktree. The wave-executor never sets the line. A linked worktree has its own index, so the index race this ban prevents does not exist there. The commit hook briefly adds an entry to the shared stash via lint-staged; the agent itself never runs `git stash`. Push, merge, `git reset`, `git stash` and `git clean` stay banned. The exception lives in the agent's own Rules section, next to the unchanged ban line, so Check 10 still finds the ban. The detector `psa007-git-write` (`scripts/lib/wave-transcript-tail.mjs`) still reports every commit inside a wave; that is correct, because wave prompts never carry `WORKTREE-MODE`.

## Waiting, Forks and Start Cost (#1615, #1616)

- **Waiting longer than 5 minutes does not belong in a subagent.** A subagent's prompt cache lives 5 minutes, so every longer wait (pipeline, remote run, rerun) rebuilds its whole context on the next turn (#1615 measured 250 M rewritten tokens in 14 days). The agent reports its intermediate state and ends; the coordinator waits with Monitor and then continues it with `SendMessage` (or dispatches a fresh one).
- **Fork or subagent.** A short task that needs the current conversation goes to a fork: it inherits system prompt, tools and history and reads the parent session's cache, so it does not pay the 60–80k token start context again. A task with its own file scope, worktree or model goes to a subagent. The wave-executor stays on subagents, because it needs scope boundaries.

## Escalation Channel (#1051)

Six agents opt into `SendMessage` so a wave-blocking obstacle can reach the coordinator **while the wave is still running**, instead of surfacing only in the final report after the wave has ended. The allowlist is exactly:

`code-implementer` · `db-specialist` · `ui-developer` · `test-writer` · `docs-writer` · `session-reviewer`

**The Nicht-Liste is deliberate, not an oversight.** `analyst`, `qa-strategist`, `architect-reviewer`, `security-reviewer`, `ux-evaluator`, `eval-judge`, `skill-applied-judge` and `dialectic-deriver` do NOT get the tool. Their output is a judgment over a whole corpus — a finding at minute three is provisional, and the analysis is complete only at the end. An early message from one of them would carry an unfinished verdict the coordinator cannot act on without re-reading the final report anyway, so the channel would add interrupts without adding information. The six above are different: each one can hit a state where its *task* becomes unfulfillable (the file it must edit does not exist, the migration target is missing, the diff under review is absent) — an obstacle, not a verdict.

**The contract every escalation-enabled agent carries** (see `.claude/rules/cross-session-messaging.md` CSM-001/004/005):

- **One message, upward only.** Exactly ONE `SendMessage` to `main` per obstacle. Never to a sibling agent — agents send upward, they cannot discover sideways.
- **Never wait for a reply.** Silence is neither refusal nor consent (CSM-004); the agent keeps working in its scope or ends `blocked`.
- **Degrade silently.** Where `SendMessage` is unavailable (disabled telemetry, non-Anthropic provider, native Windows — CSM-005), the obstacle goes in the final report instead. No code path may assume delivery happened.
- **Payload:** agent role, declared file scope, the obstacle. The send is noted in the agent's own report so the operator can see the hand-off.

**Mandate for new agents** — same shape as the git-write ban convention above: when adding a repo-write agent that belongs on this allowlist, copy the escalation block verbatim from `code-implementer.md` (adjusting only the role name) rather than re-deriving a weaker phrasing. A paraphrase that drops "never wait for a reply" or "upward only" re-opens exactly the failure modes CSM-004 and CSM-001 exist to close.

`SendMessage` does NOT lift an agent out of `read-only`: it is in `READ_ONLY_TOOLS` (`scripts/lib/validate/tier-inference.mjs`, #1049), so `session-reviewer` keeps `sandbox-tier: read-only` and every `sandbox-tier` in this directory is unchanged by the opt-in.

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
| `read-only` | observes only; no file writes, no network | `Read, Grep, Glob, Bash` (+ `Skill`, `SendMessage`, `ListAgents`) |
| `repo-write` | may create or modify files | `Read, Edit, Write, Glob, Grep, Bash` (+ `Skill`, `SendMessage`, `ListAgents`) |
| `network-allowed` | may make outbound network calls (future) | — |
| `dangerous` | may run destructive shell commands (future) | — |

Inference rule (backward-compat): agents without `sandbox-tier:` infer their tier from tools — `Edit` or `Write` present → `repo-write`; only `Read/Grep/Glob/Bash/Skill/SendMessage/ListAgents` → `read-only`. `SendMessage` and `ListAgents` are pure agent↔coordinator communication surfaces with no filesystem write path, so they do not lift an agent out of `read-only` (`scripts/lib/validate/tier-inference.mjs` `READ_ONLY_TOOLS`, #1049) — that is what lets `session-reviewer` opt into the escalation channel while staying `read-only`. The validator emits **WARN**, not FAIL, when the field is absent, so existing agents continue to work during migration. Bash appears in all tiers — fine-grained Bash control is handled by `hooks/pre-bash-destructive-guard.mjs`, not by tier.

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
