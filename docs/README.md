# docs/ — Router

This directory holds three distinct classes of document. Knowing which class a
file belongs to tells you whether to trust it as current, read it as history,
or look for it in the (private) Meta-Vault instead. See `docs/prd/2026-07-08-docs-public-split.md`
(Epic #774) for the sanitation project that established this split.

## The three classes

### 1. Living reference

Root-level `docs/*.md` files plus `docs/examples/*.md` and `docs/recipes/*.md`.
These describe the **current** behaviour of the plugin — setup guides,
schemas, architecture, config reference. They are corrected when found stale
and mechanically monitored by two guards so drift does not silently
re-accumulate:

- **`claude-md-drift-check` Check 10 (`docs-parity`)** — session-end opt-in
  gate; compares `docs/components.md` count-claims against on-disk counts and
  diffs Session Config keys between `docs/session-config-template.md` and
  `docs/session-config-reference.md`. See
  [`docs/session-config-reference.md § CLAUDE.md Drift Check`](./session-config-reference.md#claudemd-drift-check).
- **`/discovery` docs-staleness probe** — opt-in filesystem-mtime probe over
  the same living-doc surface. See
  [`docs/session-config-reference.md § Docs Staleness (#781)`](./session-config-reference.md#docs-staleness-781).

`docs/templates/` (copy-paste config snippets, e.g. the `AGENTS.md` Session
Config block) is treated as living reference too — it is read directly by
setup instructions in the root docs above.

`docs/pm-skills-marketplace.md` is a root-level living-reference doc: when to
install the `phuryn/pm-skills` marketplace alongside this plugin (product-heavy
repos with standalone PM artifacts), when not to (the techniques are already
cribbed into `/grill`, `/brainstorm`, `/plan`, and `/discovery`'s `feature`
scope), and the overlap table between the two.

### 2. Public decision history

`docs/adr/` — Architecture Decision Records. These stay public permanently:
ADRs are an industry-standard artifact, and the plugin's own ADRs are cited
externally. Unlike living reference docs, ADRs are not "corrected" for
staleness — a decision recorded on the date it was made is not wrong later,
even if a subsequent ADR supersedes it. Where an ADR cites a since-archived
research record or spike (see class 3 below), the citation names the record's
**title + issue number** rather than a `docs/research/…` path that no longer
resolves in this repository — e.g. `"Instruction-Budget Mechanism —
Coordinator-Injection Verdict" (#687; archived in the private Meta-Vault)`.

### 3. Active work documents

`docs/prd/` (PRDs of currently **open** epics) and `docs/plans/`
(`/write-executable-plan` artifacts for in-progress work — the directory may
be absent when nothing is currently mid-plan). Both are live working
directories, not permanent archives. When an epic closes, the
`archive-closed-prds` custom phase (`scripts/archive-closed-prds.mjs`, wired
as a session-end/housekeeping custom phase) moves that epic's PRD out of
`docs/prd/` into the private Meta-Vault automatically — no manual sweep
required.

## What is NOT here: archived in the Meta-Vault

Everything that used to live under `docs/{research,spikes,spike-probes,
test-runs,submissions,marketplace,baseline-diffs,experiments,migrations,
audit}/`, plus PRDs of closed epics and the retired `docs/validation-checklist.md`,
has moved to `<vault>/01-projects/session-orchestrator/<type>/` in the private
Meta-Vault (type-folder convention, minimal generated frontmatter). These are
process records — research notes, spike write-ups, test-run proofs, PR/issue
submission drafts, baseline diffs, experiment reports, closed-epic PRDs — not
reference material a consumer of the plugin needs.

Two things worth knowing about this split:

- **Removal is not un-publishing.** The records remain findable in this
  repository's public git history even after removal from `HEAD` — deleting a
  file from the working tree does not rewrite history. A sensitivity scan
  (`check-owner-leakage`-based, plus manual sampling) ran over every moved
  file before the move and confirmed zero critical findings; if that had
  turned up real findings, a history rewrite would have been a separate,
  explicit decision — not an automatic consequence of this move.
- **The move is a `git rm`, not a copy.** Once a record is archived, it no
  longer exists in this repository's working tree at all. Cross-references
  from a still-public file (an ADR, this router, a living-reference doc) use
  the title + issue-number convention above so the citation stays meaningful
  even without a resolvable path.

## Directory table

| Directory | Class | Description |
|---|---|---|
| `docs/*.md` (root) | Living reference | Setup guides, config reference/template, architecture, schemas — corrected on drift, monitored by Check 10 + the docs-staleness probe. |
| `docs/examples/` | Living reference | Example Session Config blocks per project shape (Express API, integration test, Next.js, Swift/iOS). |
| `docs/recipes/` | Living reference | Narrow how-to write-ups for a specific recurring pattern (e.g. the quality-gate container test-runner pattern). |
| `docs/templates/` | Living reference | Copy-paste config snippets referenced directly by the setup guides (e.g. the `AGENTS.md` Session Config template). |
| `docs/telemetry.md` (root) | Living reference | Public transparency page for the opt-in usage-telemetry client — exact field list, kill switches, consent precedence, retention. |
| `docs/telemetry/` | Living reference | `telemetry-claims.md` — provenance/methodology notes for cross-repo telemetry numbers cited elsewhere in the docs (a separate, local-corpus data flow from the opt-in client telemetry above). |
| `docs/adr/` | Public decision history | Architecture Decision Records — permanent, never archived, cited externally. |
| `docs/prd/` | Active work document | PRDs of currently open epics only. Auto-archived to the Meta-Vault on epic close. |
| `docs/plans/` | Active work document | `/write-executable-plan` artifacts for in-progress work. May not exist when nothing is mid-plan. |
| `docs/_private/`, `docs/specs/` | Local-only (gitignored) | Operator scratch space; never tracked, out of scope for this classification. |

## See Also

- `docs/prd/2026-07-08-docs-public-split.md` — the epic that established this split (S1–S8, issues #775–#782).
- `docs/session-config-reference.md` — full Session Config field reference, including the two guards named above.
- `docs/pm-skills-marketplace.md` — when to install `phuryn/pm-skills` alongside this plugin, and the overlap table against `/grill`, `/brainstorm`, `/plan`, `/discovery`.
- `README.md` — top-level project overview; links into this router for anything docs-specific.
