# Submission: hashgraph-online/awesome-codex-plugins — Icon Enhancement

> Filed for **GH #43** + **GH #34** (deep-4 2026-05-16). Adds icon metadata to existing session-orchestrator listing in the awesome-codex-plugins Codex marketplace.

## Context

- **Upstream repo:** https://github.com/hashgraph-online/awesome-codex-plugins
- **Existing listing:** confirmed in W1 D2 — session-orchestrator already appears under the "Development & Workflow" category in the awesome-codex-plugins README and marketplace.json. **This is NOT a new-listing PR.**
- **Why this PR:** Marketplace browsers display plugin icons in the Codex composer plugin picker. Without an icon, our listing falls back to a generic placeholder, hurting discoverability.
- **Related PRs from us:** none yet on this repo.

## Pre-flight (must be done in our repo first)

These MUST be merged to `session-orchestrator/main` before opening the upstream PR:

1. [ ] **Local icon asset** at `assets/icon.svg` — 512×512 SVG, `currentColor` stroke, <5KB. Authored by I2 in this session (deep-4 2026-05-16).
2. [ ] **`.codex-plugin/plugin.json` interface block** updated with `"composerIcon": "./assets/icon.svg"`. Authored by I2.
3. [ ] **Version bumped** in `.codex-plugin/plugin.json` to `3.6.0`. Authored by I2.

## Upstream changes required

The fork PR against `hashgraph-online/awesome-codex-plugins` must make exactly two changes:

1. **Add icon file** at `plugins/Kanevry/session-orchestrator/assets/icon.svg` (copy of our `assets/icon.svg`).
2. **Update marketplace.json entry** for `session-orchestrator` to include the icon path:

```json
{
  "name": "session-orchestrator",
  "owner": "Kanevry",
  "icon": "./plugins/Kanevry/session-orchestrator/assets/icon.svg"
}
```

3. **No README changes** — the README entry already exists and remains as-is.

## Validation before opening PR

- [ ] Confirm `assets/icon.svg` displays correctly when opened directly in a browser (`file://...`).
- [ ] Confirm Codex composer plugin picker preview (manual smoke test in Codex CLI — operator action).
- [ ] Confirm marketplace.json passes JSON Schema validation if the upstream repo enforces one (check upstream CI on the fork branch before opening the PR).

## Effort / Risk

- **Effort:** S (icon is small, marketplace.json entry is 1 line, no README changes).
- **Risk:** none material — additive change to existing entry, no breaking changes to the marketplace.
- **Maintainer wait:** unknown — last PR merge cadence on awesome-codex-plugins is not tracked; expect days-to-weeks.

## Acceptance criteria status

- [x] Icon asset plan documented (I2 scope, deep-4 2026-05-16)
- [x] PR body drafted — see `docs/submissions/awesome-codex-plugins-pr-body.md`
- [ ] Pre-flight: `assets/icon.svg` merged to `session-orchestrator/main` — **DEFERRED — I2 output must merge first**
- [ ] Pre-flight: `.codex-plugin/plugin.json` composerIcon field merged — **DEFERRED — I2 output must merge first**
- [ ] Fork `hashgraph-online/awesome-codex-plugins` and create branch — **DEFERRED — external manual step**
- [ ] Open PR using body from `docs/submissions/awesome-codex-plugins-pr-body.md` — **DEFERRED — external manual step**
- [ ] Update GH #43 with PR URL — **DEFERRED — external manual step**

## References

- Source issue (icon): https://github.com/Kanevry/session-orchestrator/issues/43
- Source issue (listing umbrella, already done): https://github.com/Kanevry/session-orchestrator/issues/34
- Upstream: https://github.com/hashgraph-online/awesome-codex-plugins
- PR body (copy-paste ready): `docs/submissions/awesome-codex-plugins-pr-body.md`
- Sibling submission (Anthropic Knowledge-Work-Plugins, deep-3): `docs/marketplace/knowledge-work-plugins-submission.md`
