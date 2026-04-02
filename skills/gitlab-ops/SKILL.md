---
name: gitlab-ops
description: >
  VCS operations reference for GitLab and GitHub: CLI commands (glab/gh),
  label taxonomy, issue templates, dynamic project resolution.
  Used as a reference by other skills and during issue management.
---

# VCS Operations Reference

## VCS Auto-Detection

Detect which VCS platform the current repo uses and select the right CLI:

```bash
# Check git remote
REMOTE_URL=$(git remote get-url origin 2>/dev/null)
if echo "$REMOTE_URL" | grep -q "github.com"; then
  VCS=github    # use `gh`
else
  VCS=gitlab    # use `glab`
fi
```

**Session Config overrides:**
- `vcs: github|gitlab` — force a specific platform
- `gitlab-host: <host>` — override auto-detected GitLab host (glab reads host from git remote by default)

## Dynamic Project Resolution

Never hardcode project IDs. Resolve them at runtime.

### Current project

```bash
# GitLab — get numeric project ID
glab repo view --output json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"

# GitHub — get owner/name identifier
gh repo view --json nameWithOwner -q '.nameWithOwner'
```

### Cross-project queries

When a skill needs to reference other projects (e.g., from `cross-repos` in Session Config):

```bash
# GitLab — resolve project ID by name
glab api "projects?search=<project-name>" | python3 -c "import json,sys; [print(p['id'], p['path_with_namespace']) for p in json.load(sys.stdin)]"

# GitHub — resolve repo details
gh api "repos/<owner>/<name>" --jq '.full_name'
```

**Note:** Some API calls require numeric project IDs (GitLab) or `owner/repo` slugs (GitHub). Always resolve dynamically from the project name.

## Label Taxonomy

### Priority Labels
- `priority:critical` — blocking production or users
- `priority:high` — important, schedule this sprint
- `priority:medium` — plan for next sprint
- `priority:low` — backlog, nice-to-have

### Status Labels
- `status:ready` — defined, ready to pick up
- `status:in-progress` — actively being worked on
- `status:review` — MR/PR created, awaiting review
- `status:blocked` — waiting on external dependency

### Area Labels
- `area:frontend` | `area:backend` | `area:database`
- `area:ai` | `area:security` | `area:testing`
- `area:ci` | `area:infrastructure` | `area:compliance`

### Type Labels
- `bug` | `feature` | `enhancement` | `refactor`
- `chore` | `documentation` | `epic`

## Common CLI Commands

### GitLab (glab)

```bash
# Issues
glab issue list --per-page 50                              # All open issues
glab issue list --label "status:ready" --per-page 10       # Ready to work on
glab issue list --label "priority:high" --per-page 10      # High priority
glab issue list --state closed --per-page 10               # Recently closed
glab issue view <IID>                                       # View issue details
glab issue view <IID> --comments                            # With comments
glab issue create --title "title" --label "priority:high,status:ready"
glab issue update <IID> --label "status:in-progress"
glab issue close <IID>
glab issue note <IID> -m "Comment text"                    # Add comment

# MRs
glab mr list --state opened                                # Open MRs
glab mr create --fill --draft                               # Create draft MR
glab mr merge <MR_IID>                                     # Merge MR

# Pipelines
glab pipeline list --per-page 5                            # Recent pipelines
glab pipeline status <ID>                                  # Pipeline details

# API (reads host from git remote automatically)
glab api "projects/$(glab repo view --output json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")/issues?state=opened&per_page=50"
glab api "projects/$(glab repo view --output json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")/milestones?state=active"
```

### GitHub (gh)

```bash
# Issues
gh issue list --limit 50                                   # All open issues
gh issue list --label "status:ready" --limit 10            # Ready to work on
gh issue list --label "priority:high" --limit 10           # High priority
gh issue list --state closed --limit 10                    # Recently closed
gh issue view <NUMBER>                                      # View issue details
gh issue view <NUMBER> --comments                           # With comments
gh issue create --title "title" --label "priority:high,status:ready"
gh issue edit <NUMBER> --add-label "status:in-progress"
gh issue close <NUMBER>
gh issue comment <NUMBER> --body "Comment text"            # Add comment

# PRs
gh pr list --state open                                    # Open PRs
gh pr create --fill --draft                                 # Create draft PR
gh pr merge <NUMBER>                                       # Merge PR

# Workflows (CI equivalent)
gh run list --limit 5                                      # Recent workflow runs
gh run view <RUN_ID>                                       # Run details

# API
gh api "repos/{owner}/{repo}/issues?state=open&per_page=50"
gh api "repos/{owner}/{repo}/milestones?state=open"
```

## Issue Templates

### Bug Template
```
## Description
What happens vs. what should happen.

## Steps to Reproduce
1.
2.

## Root Cause (if known)

## Acceptance Criteria
- [ ]
```

### Feature Template
```
## Goal
What should be achieved and why.

## Tasks
- [ ]

## Acceptance Criteria
- [ ]

## Session Type
[housekeeping|feature|deep]
```

### Carryover Template (from /close)
```
## [Carryover] Original Task Description

### What was completed
- [completed items]

### What remains
- [ ] [remaining task 1]
- [ ] [remaining task 2]

### Context for next session
[relevant context, file paths, decisions made]

### Original Issue
Relates to #ORIGINAL_IID
```
