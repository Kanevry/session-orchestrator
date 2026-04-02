---
name: ecosystem-health
description: >
  Monitor health across configured service endpoints, CI pipelines, and critical
  issues. Automatically invoked during session-start when ecosystem-health is
  enabled in Session Config.
---

# Ecosystem Health Check

## Session Config Fields Used

This skill reads from the project's Session Config (`.session-config.yml` or equivalent):

- **`health-endpoints`** — list of `{name, url}` objects for service health checks
- **`cross-repos`** — list of related repositories for critical issue scanning

Both fields are optional. The skill degrades gracefully when either is missing.

## Service Health

Read the `health-endpoints` field from Session Config. If not configured or empty, print:

> No health endpoints configured in Session Config. Add `health-endpoints` to enable service monitoring.

and skip this section.

Otherwise, for each configured endpoint, run a health check:

```bash
# Example health-endpoints config:
#   health-endpoints:
#     - name: API
#       url: https://api.example.com/health
#     - name: Worker
#       url: http://worker:8080/healthz
#     - name: Dashboard
#       url: http://localhost:3000/api/health

# For EACH endpoint in health-endpoints, run:
curl -sf <url> 2>/dev/null && echo "<name>: OK" || echo "<name>: unreachable"

# If the endpoint returns JSON with a "status" field, extract it:
curl -sf <url> 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'<name>: {d.get(\"status\",\"OK\")}')
" 2>/dev/null || echo "<name>: unreachable"
```

Generate the check commands dynamically from the config — do not hardcode any service names or URLs.

## Critical Issues Across Projects

Read the `cross-repos` field from Session Config. If not configured or empty, print:

> No cross-repos configured in Session Config. Add `cross-repos` to enable cross-project issue scanning.

and skip this section.

### Auto-detect VCS type

Determine whether to use `glab` (GitLab) or `gh` (GitHub) based on the git remote URL:

```bash
remote_url=$(git remote get-url origin 2>/dev/null)
if echo "$remote_url" | grep -qi github; then
  VCS="github"
elif echo "$remote_url" | grep -qi gitlab; then
  VCS="gitlab"
else
  echo "Could not detect VCS type from remote: $remote_url"
fi
```

### For each cross-repo, query critical issues

**GitLab** (`glab`):

```bash
# Resolve project ID from repo path, then query
# For a cross-repo like "mygroup/myproject":
project_id=$(glab api "projects/$(echo '<group>/<project>' | sed 's|/|%2F|g')" 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

if [ -n "$project_id" ]; then
  glab api "projects/$project_id/issues?labels=priority::critical,priority::high&state=opened&per_page=5" 2>/dev/null \
    | python3 -c "
import json,sys
issues = json.load(sys.stdin)
for i in issues:
    print(f'  {i[\"references\"][\"full\"]} {i[\"title\"][:60]}')
" 2>/dev/null
fi
```

**GitHub** (`gh`):

```bash
# For a cross-repo like "owner/repo":
gh issue list --repo <owner>/<repo> --label "priority:critical,priority:high" --state open --limit 5 2>/dev/null
```

## CI Pipeline Status

```bash
# Check latest pipeline for current repo
# GitLab:
glab pipeline list --per-page 3 2>/dev/null | head -10

# GitHub:
gh run list --limit 3 2>/dev/null
```

## Report Format

Present as a compact health dashboard. Build the table dynamically from whichever endpoints are configured:

```
## Ecosystem Health
| Service       | Status            |
|---------------|-------------------|
| <name>        | [OK/unreachable]  |
| ...           | ...               |

Critical issues: [N total across cross-repos]
CI: [green/red/pending]
```

If no health endpoints are configured, omit the service table entirely.
If no cross-repos are configured, omit the critical issues line.

Flag any service that is DOWN or any critical issue count > 0 as requiring attention.
