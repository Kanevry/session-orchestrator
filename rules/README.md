# Rules Library (deliverable)

This directory is the **deliverable rule library** — the coding-standard and
discipline rules that *consumer* repos adopt via `/bootstrap --sync-rules`
(sync logic: [`scripts/lib/rules-sync.mjs`](../scripts/lib/rules-sync.mjs)).

It is **not** the always-on rule set of *this* repository — those live in
[`.claude/rules/`](../.claude/rules/). The two directories share the name
"rules" but play opposite roles: `rules/` ships rules **out** to other repos,
`.claude/rules/` is what this repo runs on day-to-day.

Every file here carries a
`<!-- source: session-orchestrator plugin (canonical: rules/<path>) -->` header.
On sync, plugin-sourced files are overwritten in the consumer while its
locally-authored rules are preserved (copy-on-write). The canonical manifest of
what vendors where is [`_index.md`](./_index.md).

## Structure

- **[`always-on/`](./always-on/)** — vendored to *every* consumer repo, whatever its stack (parallel-session discipline, commit discipline, the quality-gate triad).
- **[`opt-in-stack/`](./opt-in-stack/)** — vendored only when the consumer's resolved archetype matches (backend, frontend, Swift, web-security, …).
- **[`opt-in-domain/`](./opt-in-domain/)** — vendored on archetype match for a specific domain concern (e.g. prompt-caching).

The optional `[archetypes: …]` tag on an `_index.md` entry is the allowlist that
decides which repos receive an opt-in file; an untagged entry is universal.

## Authoring

New or changed rules follow the format in
[`../docs/rule-authoring.md`](../docs/rule-authoring.md) and must be registered
in [`_index.md`](./_index.md) to be vendored. Category entries must not share a
basename — all synced files flatten into the consumer's `.claude/rules/`.
