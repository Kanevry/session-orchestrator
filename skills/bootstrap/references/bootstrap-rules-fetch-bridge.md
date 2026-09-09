# Bootstrap — Phase 3.6: (Optional) Rules-Fetch Bridge

> Reference of the `bootstrap` skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`, `private-contract.md` → `../private-contract.md`, `standard-template.md` → `../standard-template.md`, `deep-template.md` → `../deep-template.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.

## Phase 3.6: (Optional) Rules-Fetch Bridge

> Closes session-orchestrator issue #110.

After scaffolding, the Standard and Deep templates execute S99. On the private
path, it applies the selected contract's local rule union, rechecks conditional
dependencies and preserves existing files. It excludes every plugin-owned
basename and aborts on an invalid configured contract; see `private-contract.md`.

On the public path, S99 retains the optional remote rules-fetch step. It pulls
canonical `.claude/rules/*.md` directly from the configured baseline GitLab
project, excluding all plugin-owned basenames. The remote step only fires when:

- `baseline-ref` is present in Session Config
- `GITLAB_TOKEN` env var is set
- `scripts/lib/fetch-baseline.mjs` is present in the plugin
- A GitLab host is resolvable from the `gitlab-host` Session Config key (or the `GITLAB_HOST` env var) — never a hardcoded default

When triggered, the step:

1. Loops over a default rule manifest, invoking `node scripts/lib/fetch-baseline.mjs <project_id> <file_path> <baseline-ref>` once per rule. The CLI prints one file body to stdout (exit 0 success; 1 auth, 2 not-found, 3 network) — bootstrap redirects stdout to the target path and skips failures so a single 404 cannot abort the batch.
2. Fetches each rule listed in the default manifest from the configured `baseline-project-id` (default `52`) at the configured `baseline-ref`
3. Writes `.claude/.baseline-fetch.lock` (via an inline `node --input-type=module -e`) recording what was fetched
4. Populates `.claude/.baseline-cache/` for offline fallback on subsequent invocations

When the fetch fails (network error, auth, missing file), bootstrap **does not abort**. Rules will arrive in the repo via Clank's weekly baseline sync MRs (the legacy path). A warning is printed.

**Why opt-in:** Repos without `baseline-ref` continue to receive rules via the existing Clank sync flow. The fetch bridge is a faster on-demand alternative for newly-bootstrapped repos that want current rules immediately.

**Local edits:** Re-running bootstrap with `baseline-ref` set will overwrite `.claude/rules/*.md` (rules are canonical). Repo-specific extensions belong in `.claude/rules/local/*.md` (not fetched, not overwritten).

See `standard-template.md` (Step S99) and `deep-template.md` (Step D99) for the implementation, and `docs/session-config-reference.md` for the `baseline-ref` and `baseline-project-id` field definitions.

### `.claude/.baseline-fetch.lock` Schema

The lock file is committed to git and records what was fetched.

```yaml
# .claude/.baseline-fetch.lock
version: 1
project_id: 52
baseline_ref: main
fetched_at: 2026-04-17T13:42:00Z   # ISO 8601 UTC
files:
  - .claude/rules/development.md
  - .claude/rules/security.md
  - .claude/rules/...
```

| Field | Description |
|---|---|
| `version` | Lock file schema version. Currently `1`. |
| `project_id` | GitLab project ID the files were fetched from. |
| `baseline_ref` | The git ref (branch/tag/SHA) at fetch time. |
| `fetched_at` | ISO 8601 UTC timestamp. |
| `files` | List of fetched file paths (relative to repo root). |

---

