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

## How the plugin finds it

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
