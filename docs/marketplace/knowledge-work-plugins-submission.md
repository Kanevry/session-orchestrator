# anthropics/knowledge-work-plugins Submission Draft

> Tracking issue: [GH #34](https://github.com/Kanevry/session-orchestrator/issues/34)
> Target list: https://github.com/anthropics/knowledge-work-plugins (12K★, Cowork-Marketplace)
> Status: DRAFT — awaiting external fork + PR

---

## 1. Manifest compliance

`.claude-plugin/plugin.json` already matches Anthropic's canonical schema. No manifest changes required.

| Field | Required by Anthropic | Present in our manifest | Source line |
|---|---|---|---|
| `name` | ✓ | `"session-orchestrator"` | L2 |
| `description` | ✓ | `"Session-level orchestration — wave planning, VCS integration, quality gates, persistence, and safety checks"` | L4 |
| `author.name` | ✓ | `"Bernhard Goetzendorfer"` | L6 |
| `author.email` | ✓ | `"office@gotzendorfer.at"` | L7 |
| `version` | tolerated (npm-style) | `"3.6.0"` | L3 |
| `homepage` | tolerated | `"https://gotzendorfer.at/en/session-orchestrator"` | L10 |
| `repository` | tolerated | `"https://github.com/Kanevry/session-orchestrator"` | L11 |
| `license` | tolerated | `"MIT"` | L12 |
| `keywords` | tolerated | `["session", "orchestration", "waves", "gitlab", "github", "quality-gates"]` | L13 |

## 2. Submission target path

```
engineering/session-orchestrator/
├── plugin.json                       # copy of .claude-plugin/plugin.json
├── .mcp.json                         # copy of root .mcp.json
├── commands/                         # symlink or copy of root commands/
├── skills/                           # symlink or copy of root skills/
├── agents/                           # symlink or copy of root agents/
├── hooks/                            # symlink or copy of root hooks/
└── README.md                         # trimmed plugin-submission-specific README
```

The trimmed `README.md` should focus on:
- 30-second pitch
- Quick install (`/plugin install session-orchestrator@Kanevry/session-orchestrator`)
- Core commands list (`/session`, `/plan`, `/go`, `/close`, `/discovery`, `/test`, `/portfolio`)
- Link to full README at https://github.com/Kanevry/session-orchestrator#readme

## 3. PR body draft

See `docs/submissions/knowledge-work-plugins-pr-body.md`.

## 4. Acceptance criteria status

- [x] Plugin manifest verified compliant (no changes needed)
- [x] Trimmed README plan documented
- [x] PR body drafted
- [ ] Submission-Branch erstellt (Fork von anthropics/knowledge-work-plugins) — **DEFERRED — external manual step**
- [ ] PR opened mit Link zu GH #34 — **DEFERRED — external manual step**
- [ ] GH #34 mit Submission-Status-Comment aktualisiert — **DEFERRED — external manual step**

## 5. Second-path submission

After the knowledge-work-plugins PR merges, submit to `anthropics/claude-plugins-official` via the form at https://clau.de/plugin-directory-submission. Cite this same compliance verification and the merged PR URL.

## 6. See Also

- `docs/marketplace/composio-submission.md` — parallel submission to ComposioHQ/awesome-claude-plugins (#213, also pending)
- `.claude-plugin/plugin.json` — manifest source of truth
