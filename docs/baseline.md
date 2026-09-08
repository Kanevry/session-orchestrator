# The projects-baseline Relationship

**One line:** `projects-baseline` is a **private, optional** companion repository that
holds the operator's canonical rule and schema corpus. session-orchestrator reads
from it when it is present and degrades to a documented fallback when it is not.
Nothing in this plugin requires it, and no public consumer needs to obtain it.

## What it is

A separate git repository (not vendored, not a submodule, not on npm) carrying:

- `packages/zod-schemas/src/vault-frontmatter.ts` — the canonical Zod schema for
  Obsidian vault note frontmatter.
- `templates/shared/.vault.yaml.template` — the canonical `.vault.yaml` template.
- A `.claude/rules/` corpus. Measured: **26 rule files, all using `paths:`
  frontmatter, 0 using `globs:`** (`scripts/lib/rule-loader.mjs` module doc;
  restated in `scripts/lib/validate/check-rules.mjs`). That corpus is the reason
  `paths:` exists as a same-shape alias for `globs:` at all (#795) — the fleet's
  rules are read **from the baseline**, not from this plugin, so the plugin had to
  learn the baseline's frontmatter convention rather than the other way round.

## How bootstrap finds it

Bootstrap resolves only explicit local configuration, in this order:

1. `SO_BASELINE_PATH`
2. A matching entry in the host-local `owner.yaml` `baselines` list
3. `owner.yaml` `paths.baseline-path`
4. `plan-baseline-path` in the repository's Session Config

`scripts/baseline-archetypes.mjs --repo <repo>` reuses the existing configuration
resolvers. Their diagnostics are contained in a bounded local process so paths
and private match names cannot leak through the bootstrap CLI. An absent or
missing directory keeps the public fallback. An existing directory with a
missing producer, unsupported schema, invalid metadata or unsafe source is an
explicit error; bootstrap does not silently switch to a public default.

The local producer is the baseline's `archetype-manifest.mjs export` CLI. Its reduced v1
JSON owns IDs, ordering, declarative detection signals, runtimes, package
managers, UI/API/deploy metadata, command documentation, quality gates, CI,
browser automation, and rule targets. No private package inventory or source
evidence is imported into the plugin. Marker inference uses exported priorities;
an unknown result is `insufficient-evidence`, requiring a selection from the
returned catalog for Standard/Deep. `--archetype <id>` validates an explicit ID.

The CLI is read-only, offline and dependency-free without a baseline. Commands
in its JSON are data and are never evaluated. Only the explicit scaffold action
in [`private-contract.md`](../skills/bootstrap/private-contract.md) invokes the
configured baseline's local renderer, into temporary staging. It preserves
existing destination files and excludes staged rules. Deep retains baseline CI
and its exemption/requirement instead of generating a public Node pipeline.
New instruction-file command slots come from exactly matching declared gate
IDs. Missing test/typecheck/lint gates are reported as unavailable and use
`false` placeholders, never inferred npm commands. Private verification reports
declared gates separately from unavailable slots; the generic quality runner
is unchanged and an unavailable slot must not be reported as a passed check.

S99 recomputes the complete exported rule union after rendering, including
dependency-conditional targets, and validates the baseline's local `rules`
projection against it. Sources must stay under `.claude/rules/` or
`templates/shared/.claude/rules/`, with no symlinks. All basenames owned by
`rules/_index.md` are excluded, including scoped entries: `rules-sync.mjs` remains
their sole writer. `syncBootstrapRules` passes the contract's required plugin
basenames to that writer after validating the local export, so a public scope
tag cannot silently omit a private requirement. Private S99 adds missing local rules and preserves existing
ones; the public opt-in fetch retains its existing remote behavior with the
same plugin-ownership exclusion. No baseline is downloaded or located by
guessing sibling/private host paths.

New private quality policies use the same exact `test`, `typecheck`, and `lint`
gate IDs as new Session Config blocks. Missing slots use `false` with an
unavailable explanation; existing owner policies remain unchanged. Bootstrap
accumulates actual created relative paths through inherited tiers and stages
those files individually.

## Legacy vault and maintenance resolution

Never by a hardcoded path. Resolution is host-local, most specific first:

1. `SO_BASELINE_PATH` environment variable
2. `owner.yaml` `paths.baseline-path` (`~/.config/session-orchestrator/owner.yaml`,
   host-local, never committed — see `docs/owner-config-schema.md`)
3. a sibling checkout at `<repoRoot>/../projects-baseline`
4. `~/Projects/projects-baseline` (legacy default)

Tiers 1–2 go through `resolveHostPath('baseline-path', …)` in
`scripts/lib/config/host-paths.mjs`. `scripts/lib/vault-backfill/template.mjs`
additionally honours `PROJECTS_BASELINE_DIR` above all four, for back-compat.

## The four hard-runtime touchpoints, and what each degrades to

| Touchpoint | Reads / writes | Without a baseline |
|---|---|---|
| `scripts/lib/frontmatter-guard.mjs` | the canonical vault-frontmatter Zod schema | `readVaultSchema()` → `null`; `generateFrontmatterSnippet()` falls back to an in-module enum set mirroring `skills/vault-sync/validator.mjs` and warns ONCE on stderr; `computeSchemaHash()` → `null` (never the empty-string hash) |
| `scripts/lib/vault-backfill/template.mjs` | `.vault.yaml.template` | `loadTemplate()` calls `dieFn(2, …)` with a message naming `owner.yaml paths.baseline-path`, `SO_BASELINE_PATH`, `PROJECTS_BASELINE_DIR`, and the sibling-checkout convention. Only `scripts/vault-backfill.mjs` is affected; nothing else aborts |
| `scripts/sync-vault-schema.mjs` | `--check` drift guard against the canonical schema | exits 2 (missing file). It is a maintenance script, never on a session path |
| `scripts/lib/reconcile/writer.mjs` + `scripts/lib/session-end/phase-skip.mjs` | writes rule proposals into the baseline (`reconcile.targets` containing `baseline`) | `baselineRoot` absent ⇒ the `baseline` target is a **no-op**; `repo-local` (the default target) is unaffected |

`scripts/promote-vault-strict.mjs` also uses a baseline template and already ships
an explicit `--no-baseline` opt-out.

## The public fallback

A repository bootstrapped without the baseline is a normal, supported outcome —
`skills/bootstrap/public-fallback.md` owns that path. `bootstrap.lock` records
which source produced the scaffold in its `source:` field:

- `claude-init` — `claude init` ran successfully (Claude Code fast path)
- `plugin-template` — the plugin's own template was copied (every other case)
- `projects-baseline` — the private baseline was present and used

The first two are the **public** values. A consumer repo that shows either is
fully bootstrapped; the baseline adds the operator's private corpus on top, it
does not gate the scaffold.

## See also

- `docs/owner-config-schema.md` — `owner.yaml` schema, including `paths.baseline-path`
- `docs/rule-authoring.md` — `paths:` / `globs:` frontmatter
- `skills/bootstrap/public-fallback.md` — the no-baseline bootstrap path
- `skills/frontmatter-guard/SKILL.md` — the schema-source resolution table
