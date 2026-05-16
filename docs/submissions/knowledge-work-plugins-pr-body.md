# PR Body — anthropics/knowledge-work-plugins / engineering/session-orchestrator

> Paste this verbatim into the PR description when opening against `anthropics/knowledge-work-plugins`.

---

## Title

Add session-orchestrator under `engineering/`

## Body

### What

Adds the **session-orchestrator** plugin under `engineering/` — a structured session-lifecycle orchestrator for Claude Code (also supports Codex CLI and Cursor IDE).

### Why it fits this marketplace

`knowledge-work-plugins` curates plugins that improve sustained, structured engineering work. session-orchestrator's core value is making multi-hour Claude sessions:

- **Plannable** — `/session [deep|feature|housekeeping]` runs a 5-wave plan (Discovery → Impl-Core → Impl-Polish → Quality → Finalization) with explicit per-wave acceptance criteria.
- **Resumable** — STATE.md persists across interrupts (process kills, terminal closes, machine sleeps). `/session` detects partial state and offers resume.
- **Quality-gated** — inter-wave checkpoints run typecheck/lint/test before proceeding; Full Gate before close. Optional security-reviewer agent at Q3.
- **VCS-native** — GitLab and GitHub integration: opens, comments, and closes issues; surfaces CI status at session-start; renders portfolio dashboards across vault-registered repos.

### Plugin manifest

Already compliant with the canonical schema in `plugin.json`:

```json
{
  "name": "session-orchestrator",
  "version": "3.6.0",
  "description": "Session-level orchestration — wave planning, VCS integration, quality gates, persistence, and safety checks",
  "author": { "name": "Bernhard Goetzendorfer", "email": "office@gotzendorfer.at" }
}
```

(npm-style additions `version`, `homepage`, `repository`, `license`, `keywords` are tolerated extensions.)

### Repository

- Source: https://github.com/Kanevry/session-orchestrator (MIT)
- Latest release: [v3.6.0](https://github.com/Kanevry/session-orchestrator/releases/tag/v3.6.0)
- Test suite: 5285 passing / 0 failing / 12 skipped (as of 2026-05-16)
- Documentation: https://github.com/Kanevry/session-orchestrator#readme

### Cross-platform

The plugin is tested on Claude Code (primary), Codex CLI (via `AGENTS.md` alias), and Cursor IDE. Skills, commands, and agents are platform-detecting where it matters (state-dir paths, agent dispatch shape).

### Issue tracking

- Parent: https://github.com/Kanevry/session-orchestrator/issues/34
- Submission tracking: https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/414

### Checklist

- [x] `plugin.json` validates against Anthropic's canonical schema
- [x] All MIT-licensed
- [x] No bundled secrets or PII
- [x] Tests + lint + typecheck pass on `main`
- [x] CI pipeline green on `main`
- [x] Trimmed README under `engineering/session-orchestrator/README.md`

Happy to iterate on placement, naming, or scope. Thanks for maintaining this marketplace.
