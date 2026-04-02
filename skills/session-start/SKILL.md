---
name: session-start
description: >
  Full session initialization for any Götzendorfer repo. Autonomously analyzes git state,
  GitLab issues, SSOT files, branches, environment, and cross-repo status. Then presents
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
- `cli-tools` — CLI tools available (glab, vercel, supabase, stripe, etc.)
- `mirror` — mirror target (github, none)
- `ecosystem-health` — whether to run service health checks
- `special` — any repo-specific instructions

If no Session Config section exists, use sensible defaults: `feature` type, 6 agents, 5 waves.

Also read `.claude/STATE.md` or `.claude/STATUS.md` if they exist for session continuity.

## Phase 1: Git Analysis (parallel)

Run these checks in parallel using Bash:

1. **Branch state**: `git branch -a`, current branch, ahead/behind origin
2. **Recent commits**: `git log --oneline -20` — identify last session's work by commit patterns
3. **Unpushed/uncommitted**: `git status --short` + `git log origin/main..HEAD --oneline`
4. **Open branches**: list all local branches, identify which are mergeable to develop/main
5. **Stale branches**: branches with no commits in >7 days

## Phase 2: GitLab Deep Dive (parallel)

Using `glab` CLI (set GITLAB_HOST if needed from .env or .env.local):

1. **Open issues**: `glab issue list --per-page 50` — categorize by priority and status labels
2. **Recently closed**: `glab issue list --state closed --per-page 10` — what was done since last session
3. **Milestones**: `glab api "projects/:id/milestones?state=active"` — active sprint status
4. **Open MRs**: `glab mr list --state opened` — anything waiting for review/merge
5. **Pipeline status**: `glab pipeline list --per-page 3` — is CI green?

Group issues by:
- `priority:critical` / `priority:high` — must-address
- `status:ready` — ready to work on
- Session-type relevance (housekeeping tasks vs feature tasks vs deep-work tasks)

## Phase 3: SSOT & Environment Check

1. **SSOT freshness**: for each file in `ssot-files` config, check last modified date. Flag if >5 days old.
2. **TypeScript health** (if TS project): `tsgo --noEmit 2>&1 | tail -5` — current error count
3. **Test baseline**: `pnpm test --run 2>&1 | tail -5` (or equivalent) — are tests passing?
4. **Dependency health**: check for outdated critical deps if `pnpm outdated` is fast
5. **Pencil design status**: if `pencil` is configured, note it for the user (don't open it yet)

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
- **Staleness**: issues open >30 days without progress → flag for triage
- **Synergies**: issues that share code paths and can be combined

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
- GitLab: [N open issues (H high, M medium), K open MRs]
- Health: [TypeScript: 0 errors | Tests: passing/failing | CI: green/red]
- SSOT: [fresh/stale files listed]
- Cross-repos: [status summary]

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
[Specific questions about priorities, scope, or approach — use AskUserQuestion tool]
```

Use the **AskUserQuestion** tool to present options. Always include your recommendation as the first option with "(Empfohlen)" label.

## Phase 8: Handoff to Session Plan

After user alignment:
1. Invoke the **session-plan** skill with the agreed scope
2. The session-plan skill will decompose tasks into waves and present the execution plan

## Critical Rules

- **NEVER make assumptions** about code state based on memory or docs — always verify in actual files
- **NEVER skip the Q&A phase** — the user MUST confirm direction before wave planning
- **ALWAYS use `run_in_background: false`** for parallel subagent work — wait for completion
- **ALWAYS check `.env` or `.env.local`** for GitLab host, API keys, and service URLs
- **ALWAYS present options with pros/cons and a clear recommendation** — never just list facts
- **ALWAYS update GitLab issue status** when claiming work: `glab issue update <IID> --label "status:in-progress"`
- **For Pencil designs**: use the `filePath` parameter, work only on new designs, treat completed ones as done
- **For cross-repo work**: always check the actual state of related repos, don't assume from memory
