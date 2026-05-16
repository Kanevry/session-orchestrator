# ComposioHQ/awesome-claude-plugins Submission Draft

> Tracking issue: [#213](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/213)  
> Target list: https://github.com/ComposioHQ/awesome-claude-plugins  
> Status: DRAFT — awaiting manual fork + PR  
> PR body: [docs/submissions/composio-awesome-claude-plugins-pr-body.md](../submissions/composio-awesome-claude-plugins-pr-body.md)

---

## 1. Target category

**Primary proposal:** Create new category **"Session & Workflow Orchestration"**.

**Fallback:** If maintainer prefers existing categories → place under **Developer Productivity** (alphabetical position: after `backlog`, before any `s`-prefixed entries).

**Rationale for new category:**  
The 9 existing categories cover tool integrations, language-specific surfaces (frontend, backend, git, docs), and quality tooling. None covers plugins whose core value is *managing the Claude session itself* — structuring multi-wave execution, persisting state across interruptions, coordinating parallel sub-agents, and enforcing close-out policies. Two existing entries already live in this space (`maestro-orchestrate` in Backend & Architecture, `backlog` in Developer Productivity) but are filed under categories that describe their secondary surface rather than their primary function. A dedicated "Session & Workflow Orchestration" category would reduce friction for users specifically looking for orchestration tooling and signal that this is an emerging plugin class worth curating.

---

## 2. Entry text (verbatim, ready to paste)

Under the proposed new section heading `### Session & Workflow Orchestration`:

```
- **session-orchestrator** — Structured 5-wave session orchestration (Discovery / Impl-Core / Polish / Quality / Finalization) with role-based parallel agents, GitLab+GitHub integration, inter-wave quality gates, cross-session learning via `.orchestrator/metrics/learnings.jsonl`, and persistence via STATE.md. Includes 37 skills, 16 commands, 11 agents, `/test` agentic end-to-end orchestrator, and autopilot `--multi-story` for parallel worktree pipelines. Cross-platform (Claude Code + Codex CLI + Cursor IDE). [Repo](https://github.com/Kanevry/session-orchestrator) · [Latest v3.6.0](https://github.com/Kanevry/session-orchestrator/releases/tag/v3.6.0)
```

If the maintainer rejects the new category, use this identical line under `### Developer Productivity`.

---

## 3. Distinguishing features vs. existing entries

| Feature | session-orchestrator | maestro-orchestrate | backlog |
|---|---|---|---|
| **Primary function** | End-to-end session lifecycle management | Task delegation to sub-agents | Issue backlog management |
| **Category filed under** | (proposed) Session & Workflow Orchestration | Backend & Architecture | Developer Productivity |
| **Execution model** | 5 typed waves with inter-wave quality gates | 4-phase sequential with parallel subagents | Single-agent backlog triage |
| **Autopilot / headless mode** | Yes — `--headless` + `--multi-story` parallel worktrees | No | No |
| **State persistence** | STATE.md + sessions.jsonl (survives interrupts) | None documented | None documented |
| **Cross-session learning** | Confidence-scored `.orchestrator/metrics/learnings.jsonl`, opt-in `/evolve` review | Session archival to `docs/maestro/` | None documented |
| **Multi-platform** | Claude Code + Codex CLI + Cursor IDE (3) | Gemini CLI + Claude Code + Codex + Qwen Code (4) | Claude Code only |
| **VCS integration** | GitLab-first dual support (GitHub mirror), issues, MRs, hooks | Runtime-agnostic | GitHub issues |
| **Specialist components** | 37 skills, 16 commands, 11 agents, 11 hook handlers | Specialist agent types | Single agent |
| **Destructive-op guard** | PreToolUse hook with policy file | None | None |
| **Version shipped** | v3.6.0 (stable, tagged) | Not versioned | Not versioned |

Key differentiators vs maestro-orchestrate:
- **Wave-based progressive execution** with typed inter-wave quality gates (vs maestro 4-phase sequential)
- **GitLab-first dual VCS** with GitHub mirror support (vs maestro runtime-agnostic)
- **Cross-session learning** via confidence-scored `learnings.jsonl`, opt-in `/evolve` review (vs maestro session archival without learning extraction)

---

## 4. PR mechanics

1. Fork `ComposioHQ/awesome-claude-plugins` into `@Kanevry` GitHub account (browser, one click).
2. Create branch `add-session-orchestrator` from `main`.
3. Open `README.md` in the fork.
4. **If proposing new category:** Find the last existing `##` section. Insert a new `## Session & Workflow Orchestration` section after `## Developer Productivity`. Add the entry line from §2 inside the new section.
5. **If falling back:** Find `## Developer Productivity`. Insert the entry line in alphabetical order (after `backlog`).
6. Commit with message: `Add session-orchestrator (v3.6.0) — Session & Workflow Orchestration`.
7. Open PR from `Kanevry:add-session-orchestrator` → `ComposioHQ:main`.
8. Paste the PR title + body from §5.
9. Once PR URL is available, paste it into GitLab issue #213 as a comment.

---

## 5. PR title + body (verbatim)

### Title
```
Add session-orchestrator (v3.6.0) — Session & Workflow Orchestration
```

### Body

See [`docs/submissions/composio-awesome-claude-plugins-pr-body.md`](../submissions/composio-awesome-claude-plugins-pr-body.md) for the copy-paste-ready PR body.

---

## 6. Risk / fallback path

| Scenario | Action |
|---|---|
| Maintainer rejects new category | Update PR: move entry to `## Developer Productivity` (alphabetical after `backlog`). Comment on #213. |
| PR stalls > 4 weeks | Mirror entry to `hesreallyhim/awesome-claude-code` under "Agent Skills" (submission draft already exists at `docs/submissions/awesome-claude-code.md`). |
| Repository archived or unmaintained | Close #213 as won't-fix; note in GitLab #152 v3 release tracking. |
| Entry text needs update for v3.7+ | Amend the PR description or open a follow-up PR referencing the new release tag. |

---

## 7. Post-submission tracking

1. Once PR is open, add the PR URL as a comment on GitLab issue #213.
2. Update `CLAUDE.md` backlog count when #213 closes.
3. If the new "Session & Workflow Orchestration" category is accepted, note it in `docs/submissions/awesome-claude-code.md` as a cross-reference — the two lists are maintained independently.
4. Track maintainer responsiveness in GitLab #213; escalate to fallback (§6) after 4 weeks of silence.
