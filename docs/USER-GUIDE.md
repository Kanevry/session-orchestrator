# Session Orchestrator — User Guide

Session Orchestrator is a Claude Code plugin that brings structured, wave-based development sessions to any project. It handles session planning, parallel agent execution, VCS integration, quality gates, and session close-out — so you can focus on deciding *what* to build while it orchestrates *how*.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Commands Reference](#2-commands-reference)
3. [Session Types](#3-session-types)
4. [Session Config Reference](#4-session-config-reference)
5. [The Wave Pattern](#5-the-wave-pattern)
6. [Workflow Walkthrough](#6-workflow-walkthrough)
7. [VCS Integration](#7-vcs-integration)
8. [Quality Gates](#8-quality-gates)
9. [Design-Code Alignment (Pencil Integration)](#9-design-code-alignment-pencil-integration)
10. [Ecosystem Health](#10-ecosystem-health)
11. [Cheat Sheet](#11-cheat-sheet)
12. [FAQ](#12-faq)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Quick Start

### Install the plugin

From a local path:

```bash
claude plugin install /path/to/session-orchestrator
```

Or from the Claude Code plugin marketplace:

```bash
claude plugin install session-orchestrator
```

After installation, starting Claude Code will display:

```
🎯 Session Orchestrator v1.0 — /session [housekeeping|feature|deep] to start
```

### Add Session Config to your project

Open your project's `CLAUDE.md` and add a `## Session Config` section. A minimal configuration looks like this:

```markdown
## Session Config

- **session-types:** [feature]
- **agents-per-wave:** 6
- **waves:** 5
- **vcs:** github
```

If you skip this step, the plugin uses sensible defaults: `feature` type, 6 agents per wave, 5 waves, and auto-detected VCS.

### Run your first session

```
/session feature
```

The orchestrator researches your project state autonomously, presents findings with recommendations, and asks you to pick a direction. Once you agree on a plan, run `/go` to execute it across multiple parallel agents in structured waves. When done, run `/close` to verify, commit, and clean up.

---

## 2. Commands Reference

Session Orchestrator provides three commands:

| Command | Purpose | When to use |
|---------|---------|-------------|
| `/session [type]` | Start a new session | Beginning of a work session |
| `/go` | Approve the plan and begin wave execution | After reviewing the proposed wave plan |
| `/close` | End the session with verification and commits | When all waves are complete |

### `/session [type]`

Starts a new development session. Accepts one argument: `housekeeping`, `feature`, or `deep`. If omitted, the type is read from your Session Config or defaults to `feature`.

```
/session feature
/session housekeeping
/session deep
```

This triggers autonomous research: git state, open issues, SSOT freshness, CI status, cross-repo health, and more. You then review findings and pick a direction before any code changes happen.

### `/go`

Approves the wave plan and begins execution. You can optionally pass additional instructions:

```
/go
/go focus on the API endpoints first
```

This dispatches parallel subagents wave by wave. You do not need to intervene during execution — the orchestrator handles inter-wave reviews and plan adaptation automatically.

### `/close`

Ends the session. This runs a full verification against the agreed plan, creates issues for any gaps, runs quality gates, commits cleanly, pushes, mirrors (if configured), and presents a session summary.

```
/close
```

---

## 3. Session Types

### Housekeeping

Best for: git cleanup, SSOT refresh, CI fixes, branch merges, documentation updates.

- **Execution model:** Serial (no wave structure)
- **Agents:** 1-2 per task
- **Typical duration:** Short
- **Use when:** Your repo needs maintenance, not new features

```
/session housekeeping
```

### Feature

Best for: frontend/backend feature work, implementing issues, standard development.

- **Execution model:** 5 waves with parallel agents
- **Agents:** 4-6 per wave (configurable)
- **Typical duration:** Medium
- **Use when:** You have feature issues to implement

```
/session feature
```

### Deep

Best for: complex backend work, security audits, database refactoring, architecture changes.

- **Execution model:** 5 waves with parallel agents
- **Agents:** Up to 10-18 per wave (configurable)
- **Typical duration:** Longer
- **Use when:** The work requires extensive discovery, testing, or touches critical systems

```
/session deep
```

---

## 4. Session Config Reference

Add a `## Session Config` section to your project's `CLAUDE.md` to configure how Session Orchestrator behaves in that repository.

### Example

```markdown
## Session Config

- **session-types:** [housekeeping, feature, deep]
- **agents-per-wave:** 6
- **waves:** 5
- **pencil:** designs/app.pen
- **cross-repos:** [api-service, shared-lib]
- **ssot-files:** [.claude/STATUS.md]
- **cli-tools:** [glab, vercel, supabase]
- **mirror:** github
- **ecosystem-health:** true
- **vcs:** gitlab
- **gitlab-host:** gitlab.company.com
- **health-endpoints:** [{name: "API", url: "https://api.example.com/health"}, {name: "Worker", url: "http://worker:8080/healthz"}]
- **special:** "Always run database migrations before testing"
```

### Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `session-types` | list | `[feature]` | Which session types this repo supports. Controls what `/session <type>` accepts. |
| `agents-per-wave` | integer | `6` | Maximum number of parallel subagents per wave. Higher values increase parallelism but use more resources. |
| `waves` | integer | `5` | Number of execution waves for feature and deep sessions. |
| `pencil` | string | none | Path to a `.pen` design file (relative to project root). Enables design-code alignment reviews after Waves 2 and 3. |
| `cross-repos` | list | none | Related repositories under `~/Projects/`. The orchestrator checks their git state and critical issues during session start. |
| `ssot-files` | list | none | Single Source of Truth files to track for freshness (e.g., `STATUS.md`, `STATE.md`). Flagged if older than 5 days. |
| `cli-tools` | list | none | CLI tools available in this project (e.g., `glab`, `vercel`, `supabase`, `stripe`). Informs the orchestrator what commands it can use. |
| `mirror` | string | `none` | Mirror target after push. Set to `github` to automatically push to a GitHub remote after every session commit. |
| `ecosystem-health` | boolean | `false` | Enable service health checks at session start. Requires `health-endpoints` to be configured. |
| `vcs` | string | auto-detect | Version control platform: `github` or `gitlab`. Auto-detected from git remote URL if not set. |
| `gitlab-host` | string | from remote | Custom GitLab hostname. Only needed if the host cannot be inferred from the git remote URL. |
| `health-endpoints` | list | none | Service URLs to check health. Each entry is an object with `name` and `url` fields. |
| `special` | string | none | Repo-specific instructions. Freeform text that the orchestrator reads and follows during sessions. |

### Minimal Config

If you add no Session Config at all, the orchestrator uses these defaults:

- Session type: `feature`
- Agents per wave: `6`
- Waves: `5`
- VCS: auto-detected from git remote
- Everything else: disabled/none

See [examples](examples/) for project-specific configurations (Next.js, Express API, Swift iOS).

---

## 5. The Wave Pattern

Feature and deep sessions execute work in 5 structured waves. Each wave has a specific purpose, and agents within a wave run in parallel.

### Wave Structure

| Wave | Name | Purpose | Agents modify code? |
|------|------|---------|---------------------|
| **1** | Validation & Discovery | Understand the current state before changing anything | No (read-only) |
| **2** | Implementation A | Core feature work — the primary implementation | Yes |
| **3** | Implementation B | Polish, fix Wave 2 issues, integration, edge cases | Yes |
| **4** | Quality & Testing | Tests, TypeScript checks, lint, security review | Yes (tests only) |
| **5** | Finalization | Documentation, issue cleanup, commit preparation | Minimal |

### Wave Details

**Wave 1 — Validation & Discovery**
Agents audit affected code paths, verify assumptions from the plan, check existing test coverage, and identify edge cases. This wave is read-only: no files are modified. If discoveries warrant it, the plan is adjusted before Wave 2 begins.

**Wave 2 — Implementation A (Core)**
The primary implementation wave. Agents write core feature code, database changes, API endpoints, and primary UI components. Each agent has a clearly scoped set of files and acceptance criteria. Output: a working (possibly rough) implementation.

**Wave 3 — Implementation B (Polish)**
Agents fix issues discovered during Wave 2, implement secondary features, handle integration between Wave 2 outputs, and address edge cases. If Pencil design review is configured, a design-code alignment check runs after this wave.

**Wave 4 — Quality & Testing**
Agents write and update tests, run the full test suite, run TypeScript checks (`tsgo --noEmit`), run lint, and perform a security review. Goal: all tests passing, zero TypeScript errors, no lint violations.

**Wave 5 — Finalization**
One or two agents update SSOT files, close or update issues, write session handover documentation, and prepare clean commits. No new feature work happens here.

### Agent Counts by Session Type

| Session Type | Wave 1 | Wave 2 | Wave 3 | Wave 4 | Wave 5 |
|-------------|--------|--------|--------|--------|--------|
| housekeeping | 2 | 2 | 1 | 1 | 1 |
| feature | 4-6 | 6 | 4-6 | 4 | 2 |
| deep | 6-8 | 6-10 | 6-8 | 6 | 2-4 |

The `agents-per-wave` config value caps the maximum. These counts are guidelines — the orchestrator adjusts based on task complexity.

### Inter-Wave Checkpoints

Between each wave, the orchestrator:

1. Reviews all agent outputs
2. Checks for file conflicts between agents
3. Runs incremental verification (tests, TypeScript after Wave 4)
4. Runs design review if configured (after Waves 2 and 3)
5. Adapts the plan for the next wave if needed (adds fix tasks, re-scopes)
6. Reports progress to you

---

## 6. Workflow Walkthrough

Here is what happens step by step when you run a full feature session.

### Step 1: Start the session

```
/session feature
```

The orchestrator autonomously researches your project:

- **Git analysis:** Branch state, recent commits, unpushed changes, stale branches
- **VCS deep dive:** Open issues (categorized by priority), recently closed issues, open MRs/PRs, CI pipeline status, active milestones
- **SSOT check:** Freshness of tracked files, TypeScript error count, test baseline
- **Cross-repo status:** Git state and critical issues in related repositories
- **Ecosystem health:** Service endpoint checks (if configured)
- **Pattern recognition:** Recurring issue patterns, blocking chains, quick wins, synergies

### Step 2: Review findings and pick a direction

The orchestrator presents a structured overview:

```
## Session Overview
- Type: feature
- Repo: my-app on branch main
- Git: 0 uncommitted, 0 unpushed, 3 open branches
- VCS: 12 open issues (2 high, 4 medium), 1 open PR
- Health: TypeScript: 0 errors | Tests: passing | CI: green
- SSOT: STATUS.md fresh (2 days)

## Recommended Focus
Option A (recommended): Issues #42 + #45 — high synergy, shared code paths
Option B: Issue #38 — standalone deep work, can be done independently
Option C: Issues #50 + #51 + #52 — quick wins, clean up the backlog
```

You pick an option (or propose your own). The orchestrator does not proceed until you confirm.

### Step 3: Review the wave plan

After you choose a direction, the orchestrator decomposes the work into a 5-wave plan:

```
## Wave Plan (Session: feature)

### Wave 1: Validation & Discovery (4 agents)
- Agent 1: Audit API endpoint structure → src/api/ → map current routes
- Agent 2: Verify database schema → prisma/schema.prisma → check relations
...

### Wave 2: Implementation A (6 agents)
- Agent 1: Implement new API route → src/api/users.ts → endpoint returns 200
...

### Inter-Wave Checkpoints
- After W2: Design review (Pencil configured)
- After W4: Full quality gate

Ready to execute? Use /go to begin.
```

You can request changes to the plan. When satisfied:

### Step 4: Execute

```
/go
```

Waves execute automatically. Agents within each wave run in parallel. Between waves, the orchestrator reviews results, runs checks, and adapts the plan if needed. You see progress updates after each wave:

```
## Wave 2 Complete ✓
- Agent 1: done — API route implemented, returns correct schema
- Agent 2: done — Database migration created
- Agent 3: done — Frontend form component built
- Tests: 3 new passing | TypeScript: 0 errors
- Design: ALIGNED
- Adaptations for Wave 3: none
```

### Step 5: Close the session

After Wave 5 completes:

```
/close
```

The orchestrator:

1. **Verifies** every planned item against the agreed plan (with evidence)
2. **Creates issues** for any work that was not completed (carryover issues)
3. **Runs quality gates:** TypeScript (0 errors), tests (passing), lint (clean), no debug artifacts
4. **Updates SSOT** files with current metrics
5. **Commits** using Conventional Commits format, staging files individually
6. **Pushes** to origin
7. **Mirrors** to GitHub (if configured)
8. **Closes/updates issues** on your VCS platform
9. **Presents a session summary** with completed items, carryovers, new issues, metrics, and recommendations for the next session

---

## 7. VCS Integration

Session Orchestrator works with both GitHub and GitLab. It manages issues, merge requests / pull requests, labels, milestones, and CI status throughout the session.

### Auto-Detection

The VCS platform is detected from your git remote URL:

- Remote contains `github.com` --> uses `gh` CLI
- All other remotes --> uses `glab` CLI

To override auto-detection, set `vcs` in your Session Config:

```markdown
- **vcs:** github
```

or

```markdown
- **vcs:** gitlab
- **gitlab-host:** gitlab.company.com
```

### What the orchestrator does with your VCS

**At session start:**
- Lists open issues, categorized by priority and status labels
- Lists recently closed issues (context from last session)
- Checks active milestones
- Lists open MRs/PRs
- Checks CI pipeline status

**During execution:**
- Marks selected issues as `status:in-progress`
- Adds comments to issues noting which wave is working on them

**At session end:**
- Closes resolved issues with a summary comment
- Updates issue labels to reflect actual state
- Creates carryover issues for partially-completed work
- Creates new issues for discovered problems
- Updates milestone progress

### Label Taxonomy

The orchestrator uses a structured label system. Create these labels in your VCS if they do not already exist:

**Priority labels:**

| Label | Meaning |
|-------|---------|
| `priority:critical` | Blocking production or users |
| `priority:high` | Important, schedule this sprint |
| `priority:medium` | Plan for next sprint |
| `priority:low` | Backlog, nice-to-have |

**Status labels:**

| Label | Meaning |
|-------|---------|
| `status:ready` | Defined, ready to pick up |
| `status:in-progress` | Actively being worked on |
| `status:review` | MR/PR created, awaiting review |
| `status:blocked` | Waiting on external dependency |

**Area labels:** `area:frontend`, `area:backend`, `area:database`, `area:ai`, `area:security`, `area:testing`, `area:ci`, `area:infrastructure`, `area:compliance`

**Type labels:** `bug`, `feature`, `enhancement`, `refactor`, `chore`, `documentation`, `epic`

### GitHub Mirroring

If your primary VCS is GitLab but you also maintain a GitHub mirror, configure:

```markdown
- **mirror:** github
```

The orchestrator pushes to the `github` remote after every session commit. The remote must already be configured in your git config.

---

## 8. Quality Gates

Session Orchestrator enforces quality at two levels: inter-wave checks during execution, and a full quality gate at session end.

### Session Reviewer Agent

The `session-reviewer` is a dedicated agent that verifies work quality. It runs between waves (especially before Wave 3 and after Wave 4) and at session end. It checks:

1. **Implementation correctness** — Changed files match task descriptions. No incomplete implementations, placeholder values, or hardcoded data. Error handling follows project patterns.

2. **Test coverage** — Every changed source file has a corresponding test file. Tests cover the new behavior (not just boilerplate). Tests pass when run.

3. **TypeScript health** — `tsgo --noEmit` reports zero errors. This is non-negotiable.

4. **Security basics (OWASP quick check):**
   - No hardcoded secrets or API keys
   - User input validated at boundaries (e.g., with Zod)
   - No unjustified `any` types
   - No `console.log` in production code (except `warn`/`error`)
   - SQL uses parameterized queries
   - Auth checks present in server actions

5. **Issue tracking accuracy** — Claimed issues have the correct status labels. Acceptance criteria from issues are actually met.

### Review Output

The reviewer produces a structured verdict:

```
## Quality Review — Wave 2

### Implementation: PASS
### Tests: WARN — missing test for src/api/users.ts
### TypeScript: PASS — 0 errors
### Security: PASS
### Issues: PASS

### Verdict: PROCEED (address test gap in Wave 4)
```

Possible verdicts:
- **PROCEED** — quality is acceptable, continue to next wave
- **FIX REQUIRED** — specific items must be addressed before continuing

### Session-End Quality Gate

Before any code is committed, `/close` runs all checks:

| Check | Requirement |
|-------|------------|
| TypeScript | 0 errors |
| Tests | All passing |
| Lint | No errors (warnings acceptable) |
| Debug artifacts | No `console.log`, `debugger`, or `TODO: remove` in changed files |
| Git status | All changes accounted for |

If any check fails and cannot be quickly fixed, the orchestrator creates a `priority:high` issue for immediate follow-up rather than committing broken code.

---

## 9. Design-Code Alignment (Pencil Integration)

If your project uses Pencil (`.pen`) design files, the orchestrator can automatically compare your implementation against the design after each implementation wave.

### Setup

Add the path to your `.pen` file in Session Config:

```markdown
- **pencil:** designs/app.pen
```

The path is relative to your project root. The orchestrator verifies the file exists during session start.

### How it works

After **Wave 2** and **Wave 3**, the orchestrator:

1. Opens the `.pen` file via Pencil MCP
2. Finds design frames relevant to the current wave's UI work
3. Screenshots those frames
4. Reads the actual UI files changed in the wave
5. Compares: layout structure, component hierarchy, visual elements (headings, buttons, inputs, cards), responsive behavior

### Alignment Reports

Each design review produces one of three verdicts:

| Verdict | Meaning | Action |
|---------|---------|--------|
| **ALIGNED** | Implementation matches design | Proceed as planned |
| **MINOR DRIFT** | Small differences (spacing, colors, minor layout) | Fix tasks added to next wave automatically |
| **MAJOR MISMATCH** | Significant deviation from design | User informed, revised plan proposed |

### Example output

```
## Wave 2 Complete ✓
...
- Design: MINOR DRIFT — card grid uses 3 columns instead of designed 2-column layout
- Adaptations for Wave 3: Agent 2 assigned to fix card grid layout
```

### Without Pencil

Pencil integration is entirely optional. If no `pencil` path is configured, design reviews are skipped with no impact on the rest of the session workflow.

---

## 10. Ecosystem Health

For projects with deployed services or multiple related repositories, the orchestrator can check ecosystem health at session start.

### Setup

Enable ecosystem health and configure your endpoints in Session Config:

```markdown
- **ecosystem-health:** true
- **health-endpoints:** [{name: "API", url: "https://api.example.com/health"}, {name: "Dashboard", url: "http://localhost:3000/api/health"}]
- **cross-repos:** [api-service, shared-lib]
```

### What gets checked

**Service health endpoints:**
Each configured endpoint is queried with a simple HTTP check. If the endpoint returns JSON with a `status` field, that value is reported. Otherwise, the check reports OK or unreachable.

**Cross-repo critical issues:**
For each related repository, the orchestrator queries open issues with `priority:critical` or `priority:high` labels. This surfaces blocking problems in other parts of your ecosystem before you start working.

**CI pipeline status:**
The latest CI pipeline runs are checked for the current repository.

### Health Report

The report appears in the session overview:

```
## Ecosystem Health
| Service   | Status      |
|-----------|-------------|
| API       | OK          |
| Dashboard | unreachable |

Critical issues: 2 across cross-repos
CI: green
```

Any service that is down or any critical issue count above zero is flagged as requiring attention.

### Graceful Degradation

If `health-endpoints` is not configured, the service table is omitted. If `cross-repos` is not configured, the cross-project issue scan is omitted. The orchestrator does not fail — it simply skips the unconfigured checks.

---

## 11. Cheat Sheet

### Commands

```
/session feature       Start a feature session
/session housekeeping  Start a cleanup/maintenance session
/session deep          Start a deep work session (complex, many agents)
/go                    Approve plan, begin wave execution
/go <instructions>     Approve plan with additional guidance
/close                 Verify all work, commit, push, clean up issues
```

### Session Config (add to CLAUDE.md)

```markdown
## Session Config

- **session-types:** [housekeeping, feature, deep]
- **agents-per-wave:** 6
- **waves:** 5
- **vcs:** github
- **gitlab-host:** gitlab.company.com
- **mirror:** github
- **pencil:** designs/app.pen
- **cross-repos:** [other-repo]
- **ssot-files:** [.claude/STATUS.md]
- **cli-tools:** [gh, vercel]
- **ecosystem-health:** true
- **health-endpoints:** [{name: "API", url: "https://api.example.com/health"}]
- **special:** "Run migrations before testing"
```

### Typical Session Flow

```
/session feature          # Research + recommendations
  (pick a direction)      # User chooses focus
  (review wave plan)      # Orchestrator proposes 5-wave plan
/go                       # Execute waves with parallel agents
  (waves 1-5 execute)     # Automatic, with inter-wave reviews
/close                    # Verify, commit, push, summarize
```

### Wave Quick Reference

```
Wave 1  Validation & Discovery  (read-only)
Wave 2  Implementation A        (core work)
Wave 3  Implementation B        (polish + integration)
Wave 4  Quality & Testing       (tests, TS, lint, security)
Wave 5  Finalization            (docs, issues, commits)
```

---

## 12. FAQ

### Can I use this with GitHub?

Yes. The orchestrator auto-detects your VCS platform from the git remote URL. If your remote points to `github.com`, it uses the `gh` CLI. You can also force it with `vcs: github` in Session Config. Both GitHub and GitLab are fully supported for issues, PRs/MRs, CI status, and milestones.

### What if an agent fails during a wave?

The wave executor does not ignore failures. If an agent produces broken code or reports errors, the orchestrator adds fix tasks to the next wave. If an agent times out, it is re-dispatched with a smaller scope. If there is a major blocker, the orchestrator informs you and proposes a revised plan for the remaining waves.

### Can I change the plan mid-session?

Yes. Between each wave, the orchestrator reviews results and can adapt the plan. If you need to change direction, you can communicate that and the remaining waves will be re-scoped. The orchestrator documents every deviation from the original plan so the session summary remains accurate.

### How many agents run in parallel?

This is controlled by the `agents-per-wave` setting in your Session Config. The default is 6. For deep sessions, you can increase this to 10-18. All agents within a single wave run in parallel; the orchestrator waits for all of them to complete before starting the next wave.

### Do I need Pencil?

No. Pencil design integration is entirely optional. If you do not configure a `pencil` path in Session Config, design-code alignment reviews are simply skipped. Everything else works the same.

### What is the Soul system?

The Soul is a personality layer that shapes how the orchestrator communicates and makes decisions. It defines the orchestrator as a seasoned engineering lead who drives outcomes — direct, opinionated, systems-thinking, pragmatic. It affects communication style (recommendations first, not analysis), decision-making priorities (user safety > productivity > code quality > ecosystem health > speed), and values (pragmatism over perfection, evidence over assumptions). You do not need to configure it; it is built into the plugin.

### Does the orchestrator commit automatically?

No. The orchestrator never commits code until you run `/close`. During wave execution, agents do not commit independently — the coordinator handles all commits at session end after running quality gates. This ensures only verified, clean code is committed.

### What happens to unfinished work?

During `/close`, any work that was planned but not completed is documented. The orchestrator creates carryover issues on your VCS platform with the title prefix `[Carryover]`, including context on what was done and what remains. Nothing is silently dropped.

### Can I use this across multiple repos?

Yes. Configure `cross-repos` in your Session Config with the names of related repositories (located under `~/Projects/`). The orchestrator checks their git state and critical issues at session start, giving you ecosystem-wide awareness.

---

## 13. Troubleshooting

### "glab: command not found" or "gh: command not found"

The orchestrator needs the appropriate VCS CLI tool installed:

- **GitLab:** Install `glab` — [https://gitlab.com/gitlab-org/cli](https://gitlab.com/gitlab-org/cli)
- **GitHub:** Install `gh` — [https://cli.github.com](https://cli.github.com)

After installing, authenticate:

```bash
glab auth login
# or
gh auth login
```

### "No issues found" when issues exist

This usually means the CLI tool is not authenticated or is pointing at the wrong host.

- Run `glab auth status` or `gh auth status` to verify authentication
- For GitLab with a custom host, ensure `gitlab-host` is set in Session Config or that your `.env` / `.env.local` contains the correct `GITLAB_HOST`
- Check that `git remote get-url origin` returns the expected URL

### Plugin not loading

Verify the plugin structure is intact:

```bash
ls /path/to/session-orchestrator/.claude-plugin/plugin.json
```

The `plugin.json` must exist and contain valid JSON with `name`, `version`, and `description` fields. If you installed from a local path, try reinstalling:

```bash
claude plugin install /path/to/session-orchestrator
```

### "tsgo: command not found"

The orchestrator uses `tsgo` for TypeScript checking. If it is not available, it falls back to `npx tsgo --noEmit`. If neither works, TypeScript checks are skipped with a warning. Install globally if needed:

```bash
npm install -g @anthropic-ai/tsgo
```

### Agents timing out

If agents consistently time out during wave execution:

- Reduce `agents-per-wave` in Session Config (fewer parallel agents = less resource contention)
- Switch from `deep` to `feature` session type if you do not need the extra agent count
- Check that your machine has sufficient resources for parallel agent execution

### Design review skipped unexpectedly

If you configured `pencil` but design reviews are not running:

- Verify the `.pen` file exists at the configured path (relative to project root)
- Ensure the Pencil MCP server is running and accessible
- Check the wave progress output for messages like "Pencil review skipped — .pen file unavailable"

### Session Config not being read

The orchestrator looks for a `## Session Config` section in your project's `CLAUDE.md`. Ensure:

- The file is named exactly `CLAUDE.md` (case-sensitive) and is in the project root
- The section heading is exactly `## Session Config`
- Fields use the exact format: `- **field-name:** value`

### Mirror push fails

If `mirror: github` is configured but mirroring fails:

- Verify a `github` remote exists: `git remote get-url github`
- If not, add it: `git remote add github git@github.com:user/repo.git`
- Ensure you have push access to the GitHub repository

---

## License

Session Orchestrator is released under the MIT License. See the project repository for details: [https://github.com/Kanevry/session-orchestrator](https://github.com/Kanevry/session-orchestrator)
