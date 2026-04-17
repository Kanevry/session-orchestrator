# Awesome Claude Code: Submission Draft

Destination: https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml

**How to submit:** open the link above in your browser while logged into your personal GitHub account (`@Kanevry`). Paste each field below into the matching form input. Do NOT submit via `gh` CLI; the maintainer bans CLI submissions.

---

## Required Fields

### display_name
Session Orchestrator

### category
Agent Skills

### primary_link
https://github.com/Kanevry/session-orchestrator

### author_name
Bernhard Götzendorfer

### author_link
https://github.com/Kanevry

### license
MIT

### description
A Claude Code plugin that organises agentic work into structured sessions: a research phase, a five-wave execution pattern (Discovery, Implementation, Polish, Quality, Finalization), inter-wave quality gates, and a verified close-out that commits staged files and creates carryover issues. Supports GitLab and GitHub, persists state across interruptions via STATE.md, and enforces agent scope through PreToolUse hooks. No runtime code; the entire plugin is pure Markdown.

---

## Plugin-Mandatory Fields (for Agent Skills category)

### validate_claims
To verify, install via `/plugin marketplace add Kanevry/session-orchestrator` then `/plugin install session-orchestrator@kanevry` inside Claude Code. In a fresh git-initialised directory, add a `## Session Config` block to `CLAUDE.md` (a single line such as `persistence: true` is sufficient). Run `/session feature`. Expect a research phase that reads project files, an `AskUserQuestion` turn proposing issues to scope, and a five-wave plan with agent counts. Run `/go` to execute the first wave. Run `/close` to observe the verification pass, quality gate, and commit step. Total elapsed time is under ten minutes for a trivial repo.

### specific_tasks
1. Implement a multi-issue feature bundle across backend, tests, and documentation in one session, with automatic carryover issues created for anything that does not finish.
2. Run a housekeeping session on a stale branch: merge ready work, clean up SSOT files, check CI status, and push with a staged commit.
3. Run `/discovery architecture` on an unfamiliar codebase to get a confidence-scored report of findings across code, infrastructure, and architecture categories with a triage prompt.
4. After five or more sessions, run `/evolve analyze` to surface cross-session patterns such as fragile files, effective agent sizing, and recurring scope deviations, then confirm which learnings to persist.
5. Use `/plan feature` to produce a PRD with acceptance criteria and three linked issues before starting implementation, then pipe those issues directly into `/session feature`.

### specific_prompts
`/session feature`: picks open issues from the current repo, proposes a five-wave plan, and waits for approval before executing.

`/go`: approves the proposed plan and starts wave execution; agents run in parallel per wave, gated by the session-reviewer between waves.

`/discovery architecture`: runs 23 modular probes across the codebase and returns confidence-scored findings grouped by category.

`/evolve analyze`: reads `sessions.jsonl` and extracts cross-session patterns; presents findings for confirmation before writing any learnings.

---

## Optional Fields

### subcategory
(leave blank unless a specific Agent Skills subcategory fits)

### additional_comments
v2.0.0 stable shipped April 2026 and is marked "Latest" on GitHub. MIT licensed, no telemetry, no network calls beyond the platform's own LLM provider, and no bypass-permissions usage anywhere in the plugin.

---

## Pre-Submission Checklist

- [ ] Logged into GitHub as `@Kanevry` in browser
- [ ] Plugin v2.0.0 stable release is live and marked "Latest" on GitHub
- [ ] README has no em-dashes and no "beta" strings
- [ ] Verified: plugin installs cleanly from `Kanevry/session-orchestrator` marketplace into a fresh Claude Code install
- [ ] Opened the issue template in a browser tab: https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml
- [ ] Copy each field above into the matching form input
- [ ] Submit
