---
name: gitlab-ops
description: >
  GitLab operations reference: glab CLI commands, label taxonomy, issue templates,
  project ID mapping. Used as a reference by other skills and during issue management.
---

# GitLab Operations Reference

## Project ID Mapping

| Project | ID | Group | Path |
|---------|-----|-------|------|
| BuchhaltGenie | 2 | products | products/BuchhaltGenieV5 |
| EventDrop | 6 | products | products/EventDrop |
| Clank | 8 | agents | agents/clank |
| bg-pdf-service | 12 | infrastructure | infrastructure/bg-pdf-service |
| Launchpad | 13 | internal | internal/launchpad |
| WalkAITalkie | 41 | mobile | mobile/WalkAITalkie |
| FeedFoundry | 51 | agents | agents/feedfoundry |
| projects-baseline | 52 | infrastructure | infrastructure/projects-baseline |
| ci-components | 55 | infrastructure | infrastructure/ci-components |
| scrapling-service | 59 | infrastructure | infrastructure/scrapling-service |
| ai-gateway | 68 | infrastructure | infrastructure/ai-gateway |
| claude-code-skills | 71 | infrastructure | infrastructure/claude-code-skills |
| session-orchestrator | 74 | infrastructure | infrastructure/session-orchestrator |

## Label Taxonomy

### Priority Labels
- `priority:critical` — blocking production or users
- `priority:high` — important, schedule this sprint
- `priority:medium` — plan for next sprint
- `priority:low` — backlog, nice-to-have

### Status Labels
- `status:ready` — defined, ready to pick up
- `status:in-progress` — actively being worked on
- `status:review` — MR created, awaiting review
- `status:blocked` — waiting on external dependency

### Area Labels
- `area:frontend` | `area:backend` | `area:database`
- `area:ai` | `area:security` | `area:testing`
- `area:ci` | `area:infrastructure` | `area:compliance`

### Type Labels
- `bug` | `feature` | `enhancement` | `refactor`
- `chore` | `documentation` | `epic`

## Common glab Commands

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

# API (for advanced queries)
GITLAB_HOST=49.12.187.142 glab api "projects/<ID>/issues?state=opened&per_page=50"
GITLAB_HOST=49.12.187.142 glab api "projects/<ID>/milestones?state=active"
```

## Issue Templates

### Bug Template
```
## Beschreibung
Was passiert vs. was sollte passieren.

## Schritte zum Reproduzieren
1.
2.

## Root Cause (wenn bekannt)

## Acceptance Criteria
- [ ]
```

### Feature Template
```
## Goal
Was soll erreicht werden und warum.

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

### Was erledigt wurde
- [completed items]

### Was noch offen ist
- [ ] [remaining task 1]
- [ ] [remaining task 2]

### Kontext für nächste Session
[relevant context, file paths, decisions made]

### Ursprüngliches Issue
Relates to #ORIGINAL_IID
```
