# `phuryn/pm-skills` — Install-Alongside Guidance

> Companion doc for the 2026-07-05 `phuryn/pm-skills` evaluation (Epic #750,
> issue #761). Verdict: **crib the proven techniques, don't vendor the
> marketplace.** The cribbed techniques already live natively in `/grill`,
> `/brainstorm`, `/plan`, and the `/discovery` `feature` scope (see § Overlap
> table below). This doc is for the narrower case where a *product* repo
> wants the full `phuryn/pm-skills` roster installed side-by-side.

## When to install alongside

`phuryn/pm-skills` (68-skill PM marketplace, MIT license, Claude-Code-shaped)
is worth installing **in addition to** this plugin when a repo has a genuine,
recurring PM-workflow need that produces standalone artifacts this plugin
does not generate:

- **Product-heavy repos** — Ventures-produkt-repos, client MVPs with an
  active PM/product-owner role — that run discovery interviews, maintain a
  roadmap document, or keep persona/Opportunity-Solution-Tree artifacts as
  living deliverables (not one-off planning inputs).
- The team wants those artifacts as their own documents (roadmap.md,
  personas.md, OST diagrams) rather than folded into a PRD or an interrogation
  transcript.
- Cursor-IDE parity is not a requirement for that repo — `phuryn/pm-skills`
  targets Claude-Code-shaped skills with no guarantee of cross-platform
  support.

## When NOT to install alongside

- **Infrastructure / tooling repos** (this repo is the reference case). The
  evidence-based slice of PM discipline — assumption interrogation,
  divergent ideation, opportunity ranking, and evidence-anchored
  feature-intent findings — is already native here:
  - `/grill` — kill-assumption operationalization (Fails-if / Evidence-this-week
    / Kill-criterion / Cheapest-test) + pre-mortem Tiger/Paper-Tiger/Elephant
    taxonomy, part of the Six Tactics in `skills/grill/soul.md`.
  - `/brainstorm` — three-lens (PM / Designer / Engineer) divergent ideation
    pass plus Mom-Test interview discipline, in `skills/brainstorm/SKILL.md`.
  - `/plan` — Opportunity Score ranking, Impact×Risk 2×2 triage, and an
    optional job-story format, in `skills/plan/SKILL.md` / `mode-feature.md`.
  - `/discovery feature` — grounded, grep-verified intent-drift and
    stubbed/dead-feature probes (`skills/discovery/probes-feature.md`),
    routing judgment-based PM work (OST, personas, market-sizing) out to
    `/brainstorm`/`/plan` rather than treating it as a verified finding.
- A second, un-integrated 68-skill roster would not participate in this
  plugin's session-config, quality gates, or `/discovery` verification
  pipeline (PSA-006) — see § Warnings below.

## How to install

`phuryn/pm-skills` follows the same Claude Code plugin-marketplace mechanism
this plugin itself ships through (see `README.md` § Install):

```text
/plugin marketplace add phuryn/pm-skills
/plugin install <skill-name>@phuryn
```

Consult the `phuryn/pm-skills` repository (github.com/phuryn/pm-skills) for
the exact marketplace slug and the current skill roster — this doc does not
duplicate that upstream README. Install only the specific skills a repo
needs (roadmap, persona, OST artifact generation) rather than the full
roster, to limit auto-dispatch noise (see § Warnings).

## Overlap / Abgrenzung

| Capability | Overlap with this plugin | Where it lives | Verdict |
|---|---|---|---|
| Assumption interrogation / red-teaming a plan | `strategy-red-team`-class pm-skills ↔ `/grill` | `skills/grill/soul.md` (Six Tactics, kill-assumption workup, pre-mortem) | Overlap — prefer `/grill` (session/gate-integrated, codebase-grounded) |
| Divergent ideation / brainstorming | `brainstorm-ideas-*`-class pm-skills ↔ `/brainstorm` | `skills/brainstorm/SKILL.md` (three-lens PM/Designer/Engineer pass, Mom-Test) | Overlap — prefer `/brainstorm` (HARD-GATE + PRD hand-off already wired) |
| PRD generation / feature scoping / prioritization | `create-prd`-class pm-skills ↔ `/plan feature` | `skills/plan/SKILL.md`, `mode-feature.md` (Opportunity Score, 2×2 risk triage, job-story option) | Overlap — prefer `/plan` (researched Q&A engine, issue creation, appetite/scope discipline already wired) |
| Documented-vs-enforced intent auditing | No pm-skills equivalent | `/discovery feature` (`skills/discovery/probes-feature.md`) | Unique to this plugin — grep-verified, not judgment-based |
| Roadmap documents, stakeholder maps, persona trees as standalone artifacts | No equivalent here — this plugin folds personas/roadmap input into PRDs, not standalone living documents | `phuryn/pm-skills` | Unique to pm-skills — install alongside if a repo needs these as first-class artifacts |
| Opportunity Solution Tree (OST) as a maintained document | No equivalent here (OST reasoning is routed out of `/discovery`'s verified pipeline per its Non-Goals) | `phuryn/pm-skills` | Unique to pm-skills |
| Market-sizing / competitive-landscape docs | No equivalent here | `phuryn/pm-skills` | Unique to pm-skills |

Rule of thumb: where a technique overlaps, this plugin's version wins because
it is wired into session lifecycle, quality gates, and issue creation.
Where the artifact is a standalone PM document this plugin was never
designed to produce, `phuryn/pm-skills` fills a real gap — install it
alongside for those repos only.

## Warnings

- **Roster size → auto-dispatch noise.** Installing the full 68-skill roster
  alongside this plugin's own skill catalog increases the surface
  `auto-skill-dispatch` phrase-matching has to disambiguate against. Prefer
  installing only the specific skills a repo actually uses.
- **Claude Code only.** `phuryn/pm-skills` is Claude-Code-shaped with no
  Cursor IDE (or Codex CLI / Pi) parity guarantee. This plugin maintains
  cross-platform support (see `README.md` § Install) — a repo that also runs
  Cursor sessions loses parity the moment it depends on a pm-skills-only
  workflow.
- **No session-config or gate integration.** pm-skills artifacts do not
  participate in this plugin's Session Config, quality gates, or
  `/discovery` PSA-006 verification discipline. Treat its output as an
  independent artifact stream, not something `/close` or the wave-executor
  will track.
- **Sunset risk.** An installed-but-rarely-used skill from the roster is a
  `sunset-review` candidate within a session or two — install narrowly, or
  expect churn.

## See Also

- `README.md` § Install — the plugin-marketplace install mechanism this doc
  reuses.
- `skills/grill/soul.md`, `skills/brainstorm/SKILL.md`, `skills/plan/SKILL.md`
  — the native crib targets (Six Tactics, three-lens ideation, Opportunity
  Score/2×2/job-story).
- `skills/discovery/probes-feature.md` — the grep-verified intent-drift and
  stubbed-dead-feature probes that keep evidence-based PM findings inside
  the verified pipeline.
- Epic #750 / issue #761 — the evaluation and companion-doc tracking issue
  this document closes.
