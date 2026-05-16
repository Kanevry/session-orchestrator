# PR Body — hashgraph-online/awesome-codex-plugins / Add icon to session-orchestrator entry

> Paste this verbatim into the PR description when opening against `hashgraph-online/awesome-codex-plugins`.
> Pre-flight checklist and context: `docs/marketplace/awesome-codex-plugins-submission.md`

---

## Title

Add icon to session-orchestrator entry

## Body

### What

This PR adds an icon to the existing `session-orchestrator` listing under **Development & Workflow** so the plugin renders with a glyph in the Codex composer marketplace picker.

### What's changed

- **New file:** `plugins/Kanevry/session-orchestrator/assets/icon.svg`
  - 512×512 viewBox SVG
  - `currentColor` stroke (re-tintable by the host)
  - <5KB, readable at 32×32px
- **marketplace.json:** added `"icon": "./plugins/Kanevry/session-orchestrator/assets/icon.svg"` to the existing session-orchestrator entry.

### Why

The plugin already lists under Development & Workflow but falls back to a placeholder in the picker. The new icon (a stacked-wave glyph representing the 5-wave orchestration loop) provides a recognisable visual at all picker sizes.

### Plugin metadata cross-check

- Source repo: https://github.com/Kanevry/session-orchestrator
- Source-side commit adding `interface.composerIcon` field to `.codex-plugin/plugin.json`: latest `main` (deep-4 2026-05-16).
- Version: 3.6.0

### Plugin manifest sample (our side, for cross-reference)

```json
{
  "name": "session-orchestrator",
  "version": "3.6.0",
  "interface": {
    "displayName": "Session Orchestrator",
    "category": "Coding",
    "capabilities": ["Interactive", "Write"],
    "composerIcon": "./assets/icon.svg",
    "websiteURL": "https://gotzendorfer.at/en/session-orchestrator"
  }
}
```

### Testing

- Validated SVG well-formedness via JSON-import test and visual inspection; rendering at 32×32px confirmed by maintainers welcome.
- JSON-validated marketplace.json after the edit.
- No README changes — existing entry untouched.

### Related

- Source-side tracking issue (icon): https://github.com/Kanevry/session-orchestrator/issues/43
- Source-side tracking issue (listing umbrella): https://github.com/Kanevry/session-orchestrator/issues/34

Happy to iterate on the icon design if the maintainers have specific preferences.
