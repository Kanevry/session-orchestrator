# `/plan` Skill — Design Specification

## Executive Summary

A new `/plan [new|feature|retro]` command for the session-orchestrator plugin that acts as an AI-driven project manager. It conducts structured requirement gathering through researched question waves, produces PRDs following industry best practices, scaffolds repos from projects-baseline templates, and creates prioritized GitLab issues with dependencies — bridging the gap between idea and execution.

## Problem & Motivation

The session-orchestrator covers execution (`/session`, `/go`, `/close`, `/discovery`) but the pre-execution phase is manual:
- New projects are set up via `setup-project.sh` without structured requirement gathering
- PRDs are written ad-hoc or not at all
- Issues are created manually without systematic prioritization or dependency mapping
- No connection between planning decisions and execution structure
- Feature planning lacks a standardized discovery process

**Market gap:** Research shows PRD-Taskmaster (12-step PRD generation) and CCPM (project management with GitHub Issues) exist, but no tool combines PRD creation + wave orchestration + GitLab integration + project-baseline scaffolding.

## Architecture

**One skill, three modes** sharing a common Q&A engine:

```
/plan new     → Project Kickoff → PRD → Repo Setup → Issues
/plan feature → Feature PRD → Issues
/plan retro   → Metrics Analysis → Reflection → Improvement Issues
```

**Lifecycle integration:**
```
/plan → /session → /go → /close → /plan retro
 WHAT     HOW      DO    VERIFY    REFLECT
```

### Q&A Engine (shared core)

The distinctive mechanic: **5 questions per wave with pre-researched options**.

Before each wave, dispatch 2-3 `Agent()` tool calls in a single message (parallel execution):
```
Agent({ subagent_type: "Explore", description: "Research market context", 
  prompt: "Search online for [topic]. Report findings with pros/cons." })
Agent({ subagent_type: "Explore", description: "Analyze baseline templates",
  prompt: "Read projects-baseline at $BASELINE_PATH/templates/... Report matching options." })
Agent({ subagent_type: "Explore", description: "Analyze repo context",
  prompt: "Explore current repo for [relevant patterns]. Report affected files." })
```

Results synthesize into 2 `AskUserQuestion` calls per wave (max 4 questions per call, so 4+1 or 3+2 to cover 5 questions):
```
AskUserQuestion({ questions: [
  { question: "...", header: "Topic", options: [
    { label: "Option A (Empfohlen)", description: "Pro: X. Con: Y." },
    { label: "Option B", description: "Pro: X. Con: Y." },
    { label: "Option C", description: "Pro: X. Con: Y." }
  ], multiSelect: false },
  // ... up to 4 questions per call
]})
```
- Option 1 is always the recommendation (marked with "Empfohlen")
- User can select or provide custom input via "Other"

**Adaptive depth:** 2-5 waves. Fewer waves when answers are clear and unambiguous (e.g., user knows exactly what they want). More waves when answers reveal complexity (multiple subsystems, unclear requirements, conflicting constraints). User can abort early ("enough questions, generate the PRD").

### Session Config (CLAUDE.md)

```yaml
## Session Config
plan-baseline-path: ~/Projects/projects-baseline   # Required. Error if missing.
plan-default-visibility: internal                    # Default: internal
plan-prd-location: docs/prd/                        # Default: docs/prd/
plan-retro-location: docs/retro/                    # Default: docs/retro/
```

**Integration:** These fields must be added to session-start's Phase 0 config reader (skills/session-start/SKILL.md) and the USER-GUIDE.md Section 4 config reference. The plan skill reads them using the same CLAUDE.md parsing pattern as session-start.

## Mode: `/plan new` — Project Kickoff

### Phase 1: Requirement Gathering (3 waves)

**Wave 1 — Core decisions:**
1. Project archetype (nextjs-saas, express-service, docker-service, monorepo-oss, swift-app, cli-tool) — options from projects-baseline/templates/
2. Visibility (internal: GitLab private | private: + optional GitHub mirror | public/OSS: + GitHub public + license)
3. Target audience — parallel market research informs options
4. Core problem being solved
5. GitLab group (products, agents, internal, mobile, infrastructure)

**Wave 2 — Technical details (dynamic per archetype):**
- Tech stack decisions (e.g., Supabase vs. alternative DB)
- Design style (shadcn variant for nextjs-saas: vega/nova/maia/lyra/mira)
- External integrations (APIs, services)
- Performance requirements
- Security requirements beyond baseline

**Wave 3 — Business & scope:**
- MVP scope with Shape Up appetite (1w/2w/6w)
- Success criteria (SMART format)
- Known risks and mitigations
- Post-launch plan (monitoring, rollback, feedback channels)
- Ecosystem dependencies (other repos in the 17-repo ecosystem)

### Phase 2: PRD Generation
- Fill 8-section PRD template with gathered requirements
- Dispatch PRD reviewer subagent (max 3 iterations)
- User review gate

### Phase 3: Repo Setup
- Invoke `setup-project.sh` via stdin piping. The script expects interactive input in this order:
  ```bash
  # Map archetype to choice number: 1=nextjs-saas, 2=express-service, 3=docker-service, 4=monorepo-oss, 5=swift-app, 6=cli-tool
  # For nextjs-saas, also map style: 1=vega, 2=nova, 3=maia, 4=lyra, 5=mira
  # Map group to choice: 1=products, 2=agents, 3=internal, 4=mobile, 5=infrastructure
  (
    echo "$TYPE_CHOICE"    # e.g., "1" for nextjs-saas
    echo "$STYLE_CHOICE"   # e.g., "1" for vega (only if nextjs-saas)
    echo "$PROJECT_NAME"   # e.g., "my-cool-app"
    echo "$GROUP_CHOICE"   # e.g., "1" for products
    echo "y"               # confirm
  ) | bash "$BASELINE_PATH/scripts/setup-project.sh"
  ```
- Verify success via exit code and `glab repo view $GROUP/$NAME`
- Adjust visibility if not `--internal` (via `glab repo edit --visibility private|public`)
- Set branch protection rules on main
- Populate CLAUDE.md with Session Config fields
- Commit PRD document to repo

### Phase 4: Issue Creation
- Derive Epic + sub-issues from PRD Section 4 (Solution & Scope)
- Auto-prioritize using this scoring:
  1. **Technical dependencies (highest weight):** Issues that other issues depend on get priority:critical/high. Identify via: DB schema before API, API before frontend, shared libs before consumers.
  2. **Business value (medium weight):** Issues the user marked as core MVP features in the PRD get priority:high. Nice-to-haves get priority:medium/low.
  3. **Risk (tiebreaker):** Issues with identified risks or unknowns get bumped up one level.
  - Score each issue, assign priority label, set `blocks`/`is-blocked-by` links between dependent issues.
- Present as review wave via AskUserQuestion for user confirmation
- Create via gitlab-ops skill (glab CLI)
- Labels from setup-gitlab-groups.sh taxonomy: priority (P0-P3), type, status:ready, area, appetite, mvp-phase

## Mode: `/plan feature` — Feature PRD

### Phase 1: Feature Discovery (1-2 waves)

**Wave 1 — Feature core:**
1. What to build (open-ended, Claude suggests structure)
2. Why now (business driver, user feedback, technical necessity)
3. Who uses it (existing personas or new audience)
4. Scope — MVP appetite + explicit exclusions
5. Dependencies on existing issues/features

**Wave 2 (if complexity warrants):**
- Claude analyzes existing codebase (Glob/Grep) → identifies affected areas
- Architecture decisions based on found patterns
- Integration points, API changes, DB migrations
- Parallel: online research for best practices

### Phase 2: Feature PRD
5-section compact format:
1. **Problem & Motivation** — what and why
2. **Solution & Scope** — in/out of scope
3. **Acceptance Criteria** — Given/When/Then (Gherkin style)
4. **Technical Notes** — affected files, architecture sketch
5. **Risks & Dependencies**

### Phase 3: Issue Creation
- Feature → Epic + sub-issues from acceptance criteria
- Labels: type:feature/enhancement, priority, area, appetite
- Auto-prioritize + user review wave

## Mode: `/plan retro` — Data-Driven Retrospective

### Phase 1: Data Collection (automatic)
- Read `.claude/metrics/sessions.jsonl` — relevant fields per entry:
  - `session_type`, `started_at`, `completed_at`, `duration_seconds`
  - `effectiveness.completion_rate`, `effectiveness.planned_issues`, `effectiveness.completed`, `effectiveness.carryover`
  - `agent_summary.complete`, `agent_summary.partial`, `agent_summary.failed`, `agent_summary.spiral`
  - `waves[].role`, `waves[].agent_count`, `waves[].files_changed`, `waves[].quality`
  - Uses same JSONL schema as session-end writes
- Git log analysis: files changed, commit frequency, change hotspots
- Open issues: overdue, blocked, stale
- Trend analysis: compare with previous sessions

### Phase 2: Reflection (1-2 waves)

**Wave 1 — What went well / what didn't:**
1. Highlights — top 3 successes (data-backed), user confirms
2. Blockers — top 3 problems identified, root cause discussion
3. Carryover — unfinished issues, still relevant or cancel?
4. Process — session structure (waves, agents) appropriate?
5. Surprises — unexpected outcomes (positive or negative)

**Wave 2 (optional) — Improvements:**
- Derive concrete improvement actions
- Claude proposes improvement issues with priority
- User confirms or adjusts

### Phase 3: Artifacts
- Lessons-learned document (`{plan-retro-location}/YYYY-MM-DD-retro.md`)
- Improvement issues (type:enhancement, relevant area label)
- Update learnings.jsonl with new insights (same JSONL schema as session-end writes — see session-end/SKILL.md for canonical field reference)
- Optional: suggest baseline updates if pattern problems detected

## PRD Templates

### Full PRD (8 sections, for `/plan new`)
1. Executive Summary
2. Problem & Context
3. Target Audience & Personas
4. Solution & Scope (In-Scope MVP + Explicit Out-of-Scope)
5. Success Criteria (SMART table: Metric | Target | Method | Deadline)
6. Technical Architecture (archetype, stack, integrations, schema sketch)
7. Risks & Dependencies (table: Risk | Probability | Impact | Mitigation)
8. Post-Launch Plan (monitoring, rollback, feedback)

### Feature PRD (5 sections, for `/plan feature`)
1. Problem & Motivation
2. Solution & Scope (In/Out)
3. Acceptance Criteria (Given/When/Then)
4. Technical Notes (affected files, architecture)
5. Risks & Dependencies

### Retro Document
- Metrics (auto-generated from sessions.jsonl)
- Highlights (top 3 with data)
- Improvement Areas (top 3 with root cause)
- Actions (table: # | Action | Issue Link | Priority)

## Quality Gates

### PRD Reviewer (Subagent)
Dispatched after PRD generation, checks:
- Completeness: all sections filled, no TBD/placeholder
- Consistency: no internal contradictions
- Clarity: unambiguous enough to implement
- Scope: focused, not multiple subsystems
- YAGNI: no unrequested features
- SMART metrics: specific, measurable, achievable, relevant, time-bound

Max 3 iterations, then surface to user.

### Issue Review Wave
Before creating issues, present the proposed issue structure to the user:
- Epic title and description
- Sub-issues with priority, labels, dependencies
- User confirms, adjusts priority, or removes issues

## File Structure

```
session-orchestrator/
├── skills/plan/
│   ├── SKILL.md                    (main, ~15KB)
│   ├── soul.md                     (Product Strategist identity: opinionated,
│   │                                data-driven, backs recommendations with
│   │                                research, German-capable)
│   ├── mode-new.md                 (project kickoff specifics)
│   ├── mode-feature.md             (feature PRD specifics)
│   ├── mode-retro.md               (retrospective specifics)
│   ├── prd-full-template.md        (8-section PRD template)
│   ├── prd-feature-template.md     (5-section feature PRD template)
│   ├── retro-template.md           (retro document template)
│   └── prd-reviewer-prompt.md      (subagent review prompt)
├── commands/plan.md                (/plan command)
└── .claude-plugin/plugin.json      (updated: +1 skill, +1 command)
```

**Convention note:** Flat file layout (no subdirectories) — consistent with existing skills like discovery/ which uses probes.md, issue-templates.md as flat siblings.

## Command Definition (`commands/plan.md`)

```yaml
---
description: Plan a new project, feature, or retrospective with structured requirement gathering
allowed-tools: Bash, Read, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate, WebSearch, WebFetch, Write, Edit
argument-hint: [new|feature|retro]
---
```

Body invokes the plan skill with `$ARGUMENTS` as mode selector. Pattern follows existing `commands/session.md`.

## Security Considerations

- projects-baseline path is configured per-project in CLAUDE.md, never hardcoded
- Skill reads baseline for templates/rules/scripts but output documents (PRDs, issues) never contain internal paths, IPs, or infrastructure details
- Three visibility tiers (internal/private/public) automatically configure GitLab repo settings, CI, and mirror setup
- Sensitive baseline areas (docs/INFRASTRUCTURE.md, server IPs) are read for context but filtered from outputs

## Dependencies

- **gitlab-ops skill** — issue creation, label taxonomy (existing)
- **projects-baseline** — templates, rules, setup-project.sh (external, read-only)
- **quality-gates skill** — referenced by /close for PRD verification (existing)
- **sessions.jsonl** — metrics data for /plan retro (existing)

---

*Design approved 2026-04-04 through interactive brainstorming (10 questions, 7 design sections)*
