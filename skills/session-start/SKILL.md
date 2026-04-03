---
name: session-start
user-invocable: false
description: >
  Full session initialization for any project repo. Autonomously analyzes git state,
  VCS issues, SSOT files, branches, environment, and cross-repo status. Then presents
  structured findings with recommendations for user alignment before creating a wave plan.
  Triggered by /session [housekeeping|feature|deep] command.
---

# Session Start Skill

## Soul

Before anything else, read and internalize `soul.md` in this skill directory. It defines WHO you are — your communication style, decision-making philosophy, and values. Every interaction in this session should reflect this identity. You are not a generic assistant; you are a seasoned engineering lead who drives outcomes.

## Phase 0: Read Session Config

Read the project's CLAUDE.md and extract the `## Session Config` section. This tells you:
- `session-types` — which types this repo supports
- `agents-per-wave` — how many subagents per wave (default: 6)
- `waves` — how many waves (default: 5)
- `pencil` — path to .pen design file (if any)
- `cross-repos` — related repos to check (paths under ~/Projects/)
- `ssot-files` — SSOT files to check freshness (e.g., STATUS.md, STATE.md)
- `cli-tools` — CLI tools available (glab, gh, vercel, supabase, stripe, etc.)
- `mirror` — mirror target (github, none)
- `ecosystem-health` — whether to run service health checks
- `vcs` — version control system: `github` or `gitlab` (default: auto-detect from git remote)
- `gitlab-host` — custom GitLab host if not auto-detectable (default: from git remote)
- `health-endpoints` — service URLs to check health `[{name, url}]` (default: none)
- `special` — any repo-specific instructions
- `test-command` — custom test command (default: `pnpm test --run`)
- `typecheck-command` — custom typecheck command (default: `tsgo --noEmit`)
- `lint-command` — custom lint command (default: `pnpm lint`)
- `ssot-freshness-days` — days before SSOT file flagged stale (default: 5)
- `plugin-freshness-days` — days before plugin flagged outdated (default: 30)
- `recent-commits` — number of recent commits to show (default: 20)
- `issue-limit` — max issues to fetch from VCS (default: 50)
- `stale-branch-days` — days before branch flagged stale (default: 7)
- `stale-issue-days` — days before issue flagged for triage (default: 30)
- `discovery-on-close` — bool, default `false`. Run discovery probes automatically during `/close`
- `discovery-probes` — list, default `[all]`. Categories to enable: `all`, `code`, `infra`, `ui`, `arch`, `session`
- `discovery-exclude-paths` — list, default `[]`. Glob patterns to exclude from discovery scanning
- `discovery-severity-threshold` — string, default `low`. Minimum severity to report: `critical`, `high`, `medium`, `low`
- `persistence` — bool, default `true`. Enable STATE.md + session memory persistence
- `memory-cleanup-threshold` — integer, default `5`. Recommend `/memory-cleanup` after N sessions
- `enforcement` — `strict|warn|off`, default `warn`. Hook enforcement level for scope/command restrictions
- `isolation` — `worktree|none`, default `auto` (worktree for feature/deep, none for housekeeping). Agent isolation mode
- `max-turns` — integer, default `auto` (housekeeping=8, feature=15, deep=25). Maximum agent turns before PARTIAL

If no Session Config section exists, use sensible defaults: `feature` type, 6 agents, 5 waves.

For the full Session Config field reference, see `docs/USER-GUIDE.md` Section 4.

## Phase 0.5: Session Continuity

> Skip this phase if `persistence` config is `false`.

Check for `.claude/STATE.md` in the project root:

1. **STATE.md exists** — read it and inspect the `status` field:
   - `status: active` — previous session crashed or was interrupted. Use the AskUserQuestion tool to present: "Found unfinished session from [started]. [N] waves completed. Resume or start fresh?" with options to resume the previous plan or start a new session.
   - `status: paused` — session was intentionally paused. Use AskUserQuestion to offer resuming from the pause point or starting fresh.
   - `status: completed` — previous session ended cleanly. Note the summary for context (what was done, what was deferred) but continue with normal initialization.
2. **STATE.md does not exist** — first session or persistence was previously off. Continue normally.

Also read `.claude/STATUS.md` if it exists for additional project-level context.

## Phase 1: Git Analysis (parallel)

Run these checks in parallel using Bash:

1. **Branch state**: `git branch -a`, current branch, ahead/behind origin
2. **Recent commits**: `git log --oneline -N` where N is read from `recent-commits` config (default: 20) — identify last session's work by commit patterns
3. **Unpushed/uncommitted**: `git status --short` + `git log origin/main..HEAD --oneline`
4. **Open branches**: list all local branches, identify which are mergeable to develop/main
5. **Stale branches**: branches with no commits in more than `stale-branch-days` (default: 7) days

## Phase 2: VCS Deep Dive (parallel)

> **VCS Reference:** Detect the VCS platform per the "VCS Auto-Detection" section of the gitlab-ops skill.
> Use CLI commands per the "Common CLI Commands" section. For cross-project queries, see "Dynamic Project Resolution."

Using the detected VCS CLI, query (reading `issue-limit` from Session Config, default: 50):

1. **Open issues** — categorize by priority and status labels
2. **Recently closed** — what was done since last session
3. **Milestones** — active sprint status
4. **Open MRs/PRs** — anything waiting for review/merge
5. **Pipeline/CI status** — is CI green?

Group issues by:
- `priority:critical` / `priority:high` — must-address
- `status:ready` — ready to work on
- Session-type relevance (housekeeping tasks vs feature tasks vs deep-work tasks)

## Phase 3: SSOT & Environment Check

1. **SSOT freshness**: for each file in `ssot-files` config, check last modified date. Flag if older than `ssot-freshness-days` (default: 5) days.
2. **Quality baseline**: Run Baseline quality checks per the quality-gates skill. Read `test-command`, `typecheck-command`, and `lint-command` from Session Config (defaults: `pnpm test --run`, `tsgo --noEmit`, `pnpm lint`). Report results but do not block the session.
3. **Test quality** (OPTIONAL): If `scripts/test-quality.sh` exists, run it in background (`run_in_background: true`) — it can take 1-2 minutes. Report results when available but do NOT block the session flow.
4. **Pencil design status**: if `pencil` is configured, verify the `.pen` file exists at the configured path. Report: "Pencil design configured at [path] — design-code alignment reviews will run after Impl-Core and Impl-Polish waves." If file not found, warn: "Pencil path configured but file not found at [path]."
5. **Plugin freshness**: Determine the session-orchestrator plugin directory (navigate up from this skill's base directory to the plugin root). Run `git -C <plugin-dir> log -1 --format="%ci"` to get the last commit date. If older than `plugin-freshness-days` (default: 30) days, flag a warning in the Session Overview: `"⚠ Session Orchestrator plugin last updated [N] days ago — consider pulling the latest version."` Non-blocking — present in overview, don't halt.

## Phase 4: Cross-Repo Status (if configured)

For each repo in `cross-repos`:
1. `cd ~/Projects/<repo> && git log --oneline -5 && git status --short`
2. Check for open issues that reference this repo
3. Note any branches that should be merged

## Phase 5: Pattern Recognition

Look across the gathered data for:
- **Recurring patterns**: same types of issues appearing repeatedly → suggest standardization
- **Blocking chains**: issues blocked by other issues across repos
- **Quick wins**: low-effort issues that could be closed alongside main work
- **Staleness**: issues open longer than `stale-issue-days` (default: 30) days without progress → flag for triage
- **Synergies**: issues that share code paths and can be combined

## Phase 5.5: Memory Recall

> Skip this phase if `persistence` config is `false`.

Surface context from previous sessions:

1. Look for session memory files at `~/.claude/projects/<project>/memory/session-*.md`
2. Read the 2–3 most recent files (by filename date, newest first)
3. Extract relevant context: what was accomplished, what was carried over as unfinished, what patterns or warnings were noted
4. If the `memory-cleanup-threshold` has been reached (number of session-*.md files >= threshold), include a note in the Session Overview: "Consider running `/memory-cleanup` — [N] session memory files accumulated."
5. Incorporate surfaced context into the Session Overview under a **Previous Sessions** subsection (e.g., recent accomplishments, deferred items, recurring patterns)

## Phase 6: Research (session type dependent)

**For `feature` and `deep` sessions:**
- Use REF MCP (`ref_search_documentation`) to look up best practices for the tech stack areas you'll be working in
- Use `context7` for any library-specific questions
- Check SSOT files for established patterns before proposing anything new
- ALWAYS verify implementations in actual code — never assume based on memory or SSOT alone

**For `housekeeping` sessions:**
- Focus on git cleanup, documentation currency, CI health
- Skip deep research — prioritize operational tasks

## Phase 7: Structured Presentation & Q&A

Present your findings in this structure:

```
## Session Overview
- Type: [housekeeping|feature|deep]
- Repo: [name] on branch [branch]
- Git: [X uncommitted, Y unpushed, Z open branches]
- VCS: [N open issues (H high, M medium), K open MRs/PRs]
- Health: [TypeScript: 0 errors | Tests: passing/failing | CI: green/red]
- SSOT: [fresh/stale files listed]
- Cross-repos: [status summary]
- Plugin: [fresh / ⚠ N days without update]

## Recommended Focus
Based on priority, synergies, and session type, I recommend:

**Option A (recommended):** [issues + rationale]
**Option B:** [alternative focus]
**Option C:** [if applicable]

[Pros/cons for each, clear recommendation with WHY]

## Housekeeping Items (if any)
- [ ] Branches to merge: [list]
- [ ] SSOT files to refresh: [list]
- [ ] Issues to triage/close: [list]

## Questions
[Use AskUserQuestion tool — NOT plain text options]
```

**MANDATORY: Use the AskUserQuestion tool** to present options to the user. Do NOT write options as plain text in your response. The AskUserQuestion tool provides a structured UI with clickable options that is far superior to text-based A/B/C lists.

Example of what you MUST do:
```
AskUserQuestion({
  questions: [{
    question: "Which session focus do you recommend?",
    header: "Focus",
    options: [
      { label: "Issues #91 + #92 (Recommended)", description: "OpenTelemetry + OpenAPI — high synergy, concrete deliverables" },
      { label: "Infra cleanup #44 + #60", description: "Close in-progress issues, ecosystem optimization" },
      { label: "Deep work #37", description: "Core refactor — high priority, dedicated session" }
    ]
  }]
})
```

Always include your recommendation as the first option with "(Recommended)" in the label.

## Phase 8: Handoff to Session Plan

After user alignment:
1. Invoke the **session-plan** skill with the agreed scope
2. The session-plan skill will decompose tasks into waves and present the execution plan

## Critical Rules

- **NEVER make assumptions** about code state based on memory or docs — always verify in actual files
- **NEVER skip the Q&A phase** — the user MUST confirm direction before wave planning
- **ALWAYS use `run_in_background: false`** for parallel subagent work — wait for completion
- **ALWAYS check `.env` or `.env.local`** for VCS host, API keys, and service URLs
- **ALWAYS present options with pros/cons and a clear recommendation** — never just list facts
- **ALWAYS update VCS issue status** when claiming work — use the issue update command per the "Common CLI Commands" section of the gitlab-ops skill
- **For Pencil designs**: use the `filePath` parameter, work only on new designs, treat completed ones as done
- **For cross-repo work**: always check the actual state of related repos, don't assume from memory
