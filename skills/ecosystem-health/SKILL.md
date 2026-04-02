---
name: ecosystem-health
description: >
  Monitor health across the Götzendorfer ecosystem: service endpoints, CI pipelines,
  critical issues. Automatically invoked during session-start when ecosystem-health
  is enabled in Session Config.
---

# Ecosystem Health Check

## Service Health

Check these endpoints (skip gracefully if unreachable — not all are available from every network):

```bash
# Event Bus (Gateway: 46.224.162.185)
curl -sf localhost:18790/health 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'Event Bus: {d.get(\"status\",\"?\")} | handlers: {d.get(\"handlerCount\",\"?\")}')
" 2>/dev/null || echo "Event Bus: unreachable"

# n8n (CI Server: 10.0.0.4)
curl -sf http://10.0.0.4:5678/healthz 2>/dev/null && echo "n8n: OK" || echo "n8n: unreachable"

# Launchpad
curl -sf http://10.0.0.4:3100/api/health 2>/dev/null | python3 -c "
import json,sys; print('Launchpad: ' + json.load(sys.stdin).get('status','?'))
" 2>/dev/null || echo "Launchpad: unreachable"

# FeedFoundry (Gateway: port 18793)
curl -sf localhost:18793/health 2>/dev/null | python3 -c "
import json,sys; print('FeedFoundry: ' + json.load(sys.stdin).get('status','?'))
" 2>/dev/null || echo "FeedFoundry: unreachable"

# Scrapling Service
curl -sf http://10.0.0.4:3200/health 2>/dev/null | python3 -c "
import json,sys; print('Scrapling: ' + json.load(sys.stdin).get('status','?'))
" 2>/dev/null || echo "Scrapling: unreachable"
```

## Critical Issues Across Projects

```bash
# Check critical issues across key projects
# BG:2, EventDrop:6, Clank:8, Launchpad:13, FeedFoundry:51
for proj in 2 6 8 13 51; do
  GITLAB_HOST=49.12.187.142 glab api "projects/$proj/issues?labels=priority:critical&state=opened&per_page=5" 2>/dev/null \
    | python3 -c "
import json,sys
issues = json.load(sys.stdin)
for i in issues:
    print(f'  PROJ-$proj #{i[\"iid\"]} {i[\"title\"][:60]}')
" 2>/dev/null
done
```

## CI Pipeline Status

```bash
# Check latest pipeline for current repo
glab pipeline list --per-page 3 2>/dev/null | head -10
```

## Report Format

Present as a compact health dashboard:

```
## Ecosystem Health
| Service | Status |
|---------|--------|
| Event Bus | [OK/unreachable] |
| n8n | [OK/unreachable] |
| Launchpad | [OK/unreachable] |
| FeedFoundry | [OK/unreachable] |
| Scrapling | [OK/unreachable] |

Critical issues: [N total across projects]
CI: [green/red/pending]
```

Flag any service that is DOWN or any critical issue count > 0 as requiring attention.
