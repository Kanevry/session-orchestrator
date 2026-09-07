# Feature: Codex command entrypoints

**Date:** 2026-09-07
**Author:** Maintainer + Codex
**Status:** Reviewed; implementation in progress
**Epic:** #1263 — implementation #1264, validation #1265, installed acceptance #1266
**Appetite:** 1w ceiling; one focused implementation
**Parent Project:** Session Orchestrator

## 1. Problem & Motivation

### What

Expose the existing Session Orchestrator commands as discoverable, explicitly selectable Codex skills. In the reported desktop session, typing `/go` suggests the unrelated built-in Goal command and `/close` returns "No commands". The plugin is installed and enabled, but its manifest registers `skills/`, while the command entrypoints live in `commands/`.

The current repository contains 25 commands and 43 canonical skills. Their names overlap in 17 cases; eight command names are absent from the skill surface: `close`, `go`, `harness-audit`, `portfolio`, `release`, `session`, `templates-ack`, and `test`. Matching names do not establish behavioral parity: command files also contain argument handling and prechecks before dispatching internal skills.

### Why

The Codex setup guide already promises these workflows. Fixing only the menu names would still bypass the Express Path in `go`, the state/ledger checks in `close`, and other command-specific behavior. A generated adapter must preserve the command as the entrypoint and keep the shared workflow files authoritative.

### Who

People using the installed Session Orchestrator plugin in Codex desktop or CLI, and maintainers adding or changing commands. This is a compatibility repair for the existing workflow, with no new lifecycle actions.

## 2. Solution & Scope

### In-Scope

- [ ] Generate one Codex-only skill tree at `.codex-plugin/skills/` from the union of canonical command and skill names. A command takes precedence over a same-named skill, producing one public entry per name inside the plugin.
- [ ] Make each generated entry point to its canonical document, resolving references from the package location rather than the user's working directory.
- [ ] Read the full command before invoking a canonical internal skill. Resolve internal skill calls to `skills/<name>/SKILL.md`, avoiding recursive dispatch to the public command adapter.
- [ ] Map command `disable-model-invocation` to the supported Codex `policy.allow_implicit_invocation` boolean in `agents/openai.yaml`.
- [ ] Define `$ARGUMENTS` as trailing user input; retain it as data. Do not perform shell expansion or global substitution in command documents.
- [ ] Validate generated freshness, manifest wiring, unique names, canonical targets, and invocation policy. Test actual Codex discovery as well as the generator.
- [ ] Move the incompatible standard root manifest to Cursor's native `.cursor-plugin/plugin.json`, preserving its declared skills/MCP scope and suppressing additional native discovery. Update package and release paths.
- [ ] Document desktop selection, explicit CLI syntax, refresh behavior, and the distinction from native `/goal`. Refresh the local installation after verified integration.

### Out-of-Scope

- Changing what the existing session, wave, close, release, or other workflows do.
- Adding Claude-style `commands` to the Codex manifest, or replacing native Codex commands.
- Changing hook trust, wiring additional lifecycle hooks, or publishing an npm release.
- Redesigning portable `.agents/skills/` discovery or eliminating pre-existing duplicate entries between repository and installed-plugin scopes.
- Introducing a runtime service, an additional dependency, or a second set of maintained workflow bodies.

## User Stories

### US-1 — Run the intended workflow

**Als** Codex-Nutzer **möchte ich** die bekannten Orchestrator-Befehle eindeutig auswählen können, **damit** der vollständige vorgesehene Ablauf einschließlich seiner Vorprüfungen ausgeführt wird.
- ↳ AC: AC-1, AC-2.

### US-2 — Keep distribution correct

**Als** Plugin-Maintainer **möchte ich** die Codex-Einstiegspunkte aus den kanonischen Dateien generieren und prüfen, **damit** neue oder geänderte Befehle nicht erneut still fehlen.
- ↳ AC: AC-3.

### US-3 — Use the installed update

**Als** Codex-Nutzer **möchte ich** die aktualisierten Befehle nach dem Plugin-Refresh in der Anwendung finden, **damit** die Korrektur in meinem täglichen Arbeitsablauf verfügbar ist.
- ↳ AC: AC-4.

## 3. Acceptance Criteria

### AC-1 — Complete, unambiguous plugin discovery

```gherkin
Given the canonical command and skill directories and the Codex manifest
When the generated plugin is read by Codex
Then every command name has one command-backed skill in the plugin
And every remaining canonical skill name has one skill-backed entry
And go, close, session, test, portfolio, release, harness-audit and templates-ack are discoverable
And a same-named command and skill produce one public plugin entry
```

The measured starting set yields 51 unique entries: 25 command-backed and 26 skill-backed. Tests derive the expected set from their inputs, rather than freezing a repository-wide count.

### AC-2 — Preserve command intent and dispatch

```gherkin
Given a command declaring disable-model-invocation: true
When its Codex skill is generated
Then agents/openai.yaml contains the boolean allow_implicit_invocation: false
And explicit selection remains supported
Given an explicitly selected command with trailing flags, quoted text or Unicode
When its adapter is read
Then the full canonical command is read before any internal skill
And trailing input is treated as arguments, not evaluated as shell code
And internal skill references resolve to the canonical skills directory
```

At the starting revision, `bootstrap`, `brainstorm`, `close`, `go`, `plan`, and `release` require explicit invocation. Preserve the source setting for other commands as well. No real lifecycle command is executed merely to test discovery.

### AC-3 — Detect stale or invalid distribution

```gherkin
Given an existing generated surface
When a source is added, renamed, removed or changes invocation policy
Then check mode detects stale output without writing files
And regeneration restores the expected surface
And removing a command whose name also belongs to a skill exposes that canonical skill
Given invalid source YAML or a non-boolean invocation flag
When generation runs
Then it reports the offending source and fails before publishing output
Given a manifest pointing back to skills/ or a missing generated policy/target
When plugin validation runs
Then validation fails with an actionable diagnostic
```

Generation owns only its generated artifacts; unrelated files are retained or reported, never silently deleted. The published package must include generated entries, policies, and referenced canonical documents.

### AC-4 — Usable installed result

```gherkin
Given the updated local plugin installed through public Codex commands
When Codex reloads skills and a fresh desktop composer searches for go or close
Then the corresponding Session Orchestrator skill can be selected
And the selected entry references the correct generated adapter
And the CLI supports an explicit namespaced skill invocation
```

Before completion, collect actual `plugin/read` or `skills/list` results for all expected entries, plus desktop picker evidence for Go and Close where the current app exposes the updated surface. Report an app reload requirement separately from repository and discovery checks; a unit test alone cannot establish desktop acceptance.

## 4. Technical Notes

### Architecture

Add `scripts/generate-codex-skills.mjs`, following the existing generated-artifact convention. Reuse portable frontmatter projection from `scripts/generate-agents-skills.mjs`; do not change the existing portable mirror contract. Expose `generateCodexSurface({ pluginRoot, check = false })` and a CLI accepting `--plugin-root`, `--check`, and `--json`. Return structured success, generated paths, writes, drift, and source errors. Parse and validate sources before writing output. Use the existing YAML dependency.

The manifest points exclusively to `./.codex-plugin/skills/`. Each `SKILL.md` carries discovery metadata and a package-relative link to either `../../../commands/<name>.md` or `../../../skills/<name>/SKILL.md`. Command adapters carry the argument and dispatch rules above. Their `agents/openai.yaml` files provide recognizable display names and the effective invocation policy. The canonical documents remain packaged at their current paths, preserving their own relative references.

**Runtime discovery correction (2026-09-07):** real probes found that a root `plugin.json` declaring the Agent Plugins schema intercepts native Codex discovery. Its loader fixes the skill path to `./skills` and uses the root version; the native overlay cannot override either. Move the root metadata to Cursor's supported `.cursor-plugin/plugin.json`, remove the standard `$schema`, retain its skills/MCP paths, and explicitly disable additional native rules/agents/commands/hooks discovery. The existing Cursor installer remains responsible for its command/hook adapters. Portable `AGENTS.md` and `.agents/skills/` generation stays unchanged. This avoids a duplicate distribution tree and restores the committed Codex cache identity. The independent validator rejects reintroduction of the intercepting root manifest.

A separate artifact validator reads emitted files independently of the generator's expected text. It verifies source-name coverage, manifest registration, metadata types, policy booleans, and canonical links. Its CLI also runs the generator in read-only check mode and requires a valid structured result. Integrate this check into `scripts/validate-plugin.mjs`; retain the existing Codex hook/manifest contract check.

### Affected Files

- `scripts/generate-codex-skills.mjs` — generation and read-only freshness check.
- `scripts/lib/validate/check-codex-skills.mjs` — independent artifact/wiring validation and CLI integration.
- `scripts/validate-plugin.mjs` — run the Codex skill check.
- `.codex-plugin/plugin.json` — registered skill root and committed cache invalidation suffix.
- `.codex-plugin/skills/` — generated artifacts only.
- `plugin.json` → `.cursor-plugin/plugin.json`, `package.json`, `scripts/release.mjs`, `tests/scripts/release.test.mjs` — native Cursor registration, packaging and version parity after removing the Codex interception.
- `tests/scripts/generate-codex-skills.test.mjs` — source-to-artifact regression tests.
- `tests/lib/validate/check-codex-skills.test.mjs` — malformed artifacts, disconnected manifest and CLI failure behavior.
- `README.md`, `docs/codex-setup.md`, `docs/components.md`, `docs/migration-v4.md`, `docs/instruction-delivery.md` — invocation, generation, refresh and native-manifest compatibility.

### Implementation sequence and verification

1. **Generation:** reproduce absent command discovery with a small command/skill fixture; implement the union, precedence, policy and pointer generation. Cover overlap, deletion fallback, invalid sources, non-mutating check mode and owned-artifact cleanup in focused Vitest tests.
2. **Integration:** independently validate the emitted contract; wire the manifest and validation runner; generate the real surface and bump the Codex cache suffix. Verify command coverage and package contents with `npm pack --dry-run --json`.
3. **Acceptance:** run focused tests, repository lint/typecheck and plugin validation, then the relevant broader suite. Review the diff independently, integrate the reviewed commits, refresh the local plugin using public commands, and verify actual Codex discovery plus desktop selection without executing the selected workflow.

All four acceptance groups must be verified or explicitly reported as unresolved before this feature is described as complete. Implementation uses an isolated branch; only reviewed task changes are integrated.

### Data Model and API Changes

No persisted user data or session schema changes. The additive user-facing API is the set of namespaced Codex skill entrypoints. No new network endpoint, tool, or plugin permission is introduced.

## 5. Risks & Dependencies

| Risk | Impact | Mitigation | Triage |
|------|--------|------------|--------|
| Two entries for one command name | Ambiguous selection or wrong workflow | Register one generated union; commands win overlaps | Implement |
| Internal skill call selects its public adapter again | Recursive execution | Explicit package-relative canonical skill dispatch | Implement |
| Invocation policy becomes ineffective metadata | Automatic execution of explicit-only commands | Native boolean policy plus independent artifact check | Implement |
| Generated pointers work only in the source checkout | Installed commands cannot load their workflows | Package-relative links, package census and real Codex discovery | Implement |
| Installed cache retains the old surface | Menu still lacks the commands after code changes | Committed cache suffix, public refresh and fresh discovery | Implement |
| Standard root manifest overrides the Codex skill path/version | All adapter tests pass while real discovery remains unchanged | Native Cursor manifest, root-interception regression, probes with both CLI and desktop binaries | Implement |
| Existing repository and plugin skill duplicates remain | Same-name entries may appear from different scopes | Preserve scope labels; test the plugin-qualified entry specifically | Defer |

### Dependencies and evidence

- Existing generator conventions, canonical commands/skills, `js-yaml`, Vitest and the public Codex plugin lifecycle are already present.
- The configured baseline supplies general project conventions; no new scaffold or baseline template is required for this existing plugin.
- Read-only issue research found related multi-harness portability and install work, but no required blocker for this command adapter.
- Starting revision `19b66e6e` has a successful GitLab pipeline. This is baseline evidence, not evidence for the new implementation.
- [OpenAI conversion guidance](https://developers.openai.com/plugins/guides/submit-claude-plugin) recommends converting Markdown commands into skills.
- [OpenAI skill metadata and invocation policy](https://learn.chatgpt.com/docs/build-skills) defines `agents/openai.yaml` and `allow_implicit_invocation`.
- A temporary `plugin/read` probe on Codex CLI 0.153.3 verified namespaced discovery and interface metadata before implementation; it did not execute command workflows or change the user's installation.
- Actual worktree probes after the native-manifest correction discover 51 unique entries and the committed cache version on CLI 0.153.3 and the desktop-bundled CLI 0.153.4. [Codex loader source](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/agent_plugin_manifest.rs) confirms the standard-root override limitation.
- [Cursor native manifest reference](https://cursor.com/docs/reference/plugins) and its [official schema](https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json) support the replacement path and explicit component declarations. The manifest passes schema validation; native Cursor runtime execution is outside this Codex acceptance test.
- Desktop UI automation is unavailable: the Computer Use tool rejects access to the Codex app for safety reasons. Actual desktop-binary discovery is verifiable; visible picker selection must be reported separately as unverified.
