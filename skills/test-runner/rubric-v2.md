# UX Rubric v2 (`/test`)

> Specification the `ux-evaluator` agent applies to test-runner artifacts since #1961.
> v2 = six **human checks** first, the four v1 **mechanical checks** as a footnote.
> Not to be confused with `skills/ux-grill/rubric-v2.md` (a different skill, a different catalogue).

**Why v2 exists.** A run reported a UI as "mechanics clean, 0 slop, axe 0" while a person
looking at the live pages saw an overloaded screen with no guidance, decoration without
information, unused whitespace, dead buttons and red lock messages. All four v1 checks are
counters; none asks whether someone without prior knowledge understands what the page is
and what to do. A counter that finds nothing proves only that its counter found nothing.

## Which rubric applies when

| Situation | Rubric |
|---|---|
| Every new evaluation run | **v2** (this file) |
| Re-reading or re-rendering a run whose `findings.jsonl` `_meta.rubric_version` is `"v1"` | `rubric-v1.md` — never re-score an old run under v2 |
| A profile pinning `rubric: skills/test-runner/rubric-v1.md` (the mac profiles do: peekaboo writes no 1440/390 snapshots) | v1 runs, and the stdout summary says `Rubric: rubric-v1 (legacy — no human checks)`; `/test` passes the profile's `rubric` to the evaluator (`skills/test-runner/SKILL.md` § Rubric and Target Label) |

v1 stays in the repo unchanged so old runs stay readable.

---

## Hard rules

1. **Human checks run first.** For every page and for both viewports, **1440** and **390**
   px wide, all six human checks are judged before any mechanical check is read.
2. **Mechanics are a footnote.** The v1 checks may never produce the overall verdict. A report
   must not open with, or summarise itself as, "clean", "sauber", "no issues", "0 findings"
   or any equivalent on the strength of mechanical checks. Mechanical results live only in the
   `Mechanical checks (footnote)` section at the end of the report.
3. **No human checks, no report.** A report that lacks a verdict for any human check on any
   page/viewport is INCOMPLETE. Its first line is exactly:

   ```
   REPORT INCOMPLETE — human checks missing: <check>@<page>@<viewport>[, …]
   ```

   It carries no overall verdict, its `_meta.report_complete` is `false`, and its JSON
   contract verdict is `BLOCKED`. `checkReportComplete({ pages, coverage, judged })` in
   `scripts/lib/test-runner/human-checks.mjs` computes the missing list deterministically
   over every page × viewport (1440, 390) × all six checks: a floor check counts as decided
   only when that viewport's AX snapshot was parsed, a judgment check only with a recorded
   verdict. A missing viewport, a rejected snapshot or a run with no pages is incomplete.
4. **Judge the live state.** The target is the live URL or a production build. A run against a
   dev server (or a single branch's preview) is allowed only when labelled. The report header
   carries the field `Target:` with one of `live`, `production-build`, `dev-server`, followed
   by the URL. For `dev-server` the second line is exactly:

   ```
   DEV-SERVER RUN — not the live state; no verdict about what users see.
   ```

   An unlabelled target is treated as `dev-server`.

## Evidence per human check

Each judgment uses the screenshot at that viewport (`screenshots/`) **and** the AX snapshot
(`ax-snapshots/*.yaml`). Every finding names its location (page, viewport, AX path or visible
region) and a concrete suggestion — "improve the hierarchy" is not a suggestion; "make
'Termin anlegen' the only filled button and turn the other two into text links" is.

AX snapshot file name convention: `ax-snapshots/<page-slug>-w<viewport>.yaml`
(e.g. `start-w1440.yaml`, `start-w390.yaml`). Two shapes are accepted: the aria snapshot
(`locator.ariaSnapshot()`, carries link targets as `/url`) and the accessibility tree
(`page.accessibility.snapshot()`, no link targets). Prefer the aria snapshot — without link
targets the dead-link floor cannot run.

---

## The six human checks

| check | question | mode | severity |
|---|---|---|---|
| `five-second` | Without scrolling: what is this, and what can I do here? Both must be answerable from the first screen. | judgment | high |
| `primary-action` | Is there exactly **one** recognisable primary action? None, or several of equal weight, fails. | floor + judgment | medium |
| `dead-or-locked` | Do controls do something? Are locked features shown with red/refusal messages in the demo path? | floor + judgment | high |
| `empty-state` | Are there empty or placeholder areas ("noch leer", "kommt bald", "coming soon", "lorem", "TODO", empty lists/cards)? | floor + judgment | medium |
| `density` | Overload: how many equal-rank elements above the fold? Waste: what share of the first screen is unused space? | judgment | medium |
| `decoration` | Side bars, pills, badges, glows that carry no information? | judgment | low |

**Mode.** `floor` = `human-checks.mjs` finds the mechanically detectable part; the agent adds
what only the screenshot shows (e.g. a button that looks clickable but has no effect, a red
colour). `judgment` = no machine floor; `evaluateHumanChecks()` returns a coverage entry with
`status: "requires-judgment"` so the report cannot skip it.

### Mechanical floor (`scripts/lib/test-runner/human-checks.mjs`)

| check | `checkId` | detected when | ceiling |
|---|---|---|---|
| `empty-state` | `empty-state-placeholder` | any AX name/text matches a placeholder phrase (`noch leer`, `kommt bald`, `coming soon`, `lorem ipsum`, case-sensitive `TODO`, `Platzhalter`/`placeholder`, `under construction`, `in Arbeit`/`in Vorbereitung`) | wording list only; an empty card without text needs the screenshot |
| `empty-state` | `empty-state-empty-container` | a `list`/`listbox`/`table`/`grid`/`feed`/`tree` with no children | other empty containers need the screenshot |
| `dead-or-locked` | `dead-link` | a link whose `/url` is empty, `#` or `javascript:` | aria snapshot only; a `<button>` without a handler is invisible to the AX tree |
| `dead-or-locked` | `locked-control` / `lock-message` | a disabled control, or any text, with lock/refusal wording (`gesperrt`, `locked`, `nicht verfügbar`, `not available`, `keine Berechtigung`, `access denied`, `freischalten`, padlock) | colour is not in the artifact — red is judged from the screenshot |
| `primary-action` | `primary-action-competing` | ≥ 3 enabled buttons (or call-to-action links) as siblings in one container outside nav/banner/footer/toolbar/menu/tablist | no visual weight or geometry in the artifact; "none at all" and "which one looks primary" are judgment |

The floor is a minimum, never the verdict: zero floor findings says nothing about
`five-second`, `density` or `decoration`.

---

## Findings record

Same shape as rubric-v1 § Findings JSON schema, with `rubric_version: "v2"`. All v1 invariants
hold (no `null`, lowercase severity, existing `evidence_path`, unique fingerprint per run).

- Human checks: `scope: "human"`, `check` ∈ the six check names, `checkId` = the floor id
  above or, for a judged finding, `<check>-<short-kebab-slug>` (e.g. `density-equal-rank-cards`,
  `decoration-badge-without-info`).
- Mechanical checks: exactly as in rubric-v1 (scopes `onboarding`, `a11y`, `console`,
  `liquid-glass`; same `checkId` values).

### Fingerprint — compatible with v1

`fingerprintFinding({scope, checkId, locator})` from `scripts/lib/test-runner/fingerprint.mjs`,
formula and 256-char truncation exactly as rubric-v1 § Fingerprint formula. Consequences:

- A mechanical finding has the **same fingerprint** under v1 and v2 — existing issues are not
  duplicated when a target moves to v2.
- Human findings use the new scope `human`, so they never collide with a v1 fingerprint.
- Human-check locator: `<page>@<viewport> :: <AX path>`, e.g.
  `/start@1440 :: main > link "Termin buchen"`. For a judged finding without an AX node, use
  the visible region instead of the AX path (`/start@390 :: first-screen`). The viewport is part
  of the locator, so the same defect at 1440 and 390 is two findings.

### Metadata record (first line of `findings.jsonl`)

```json
{
  "_meta": true,
  "rubric_version": "v2",
  "run_id": "<run-id>",
  "evaluated_at": "<ISO-8601-UTC>",
  "target_kind": "live | production-build | dev-server",
  "target_url": "<url or build path>",
  "pages": ["/start"],
  "viewports": [1440, 390],
  "human_checks_judged": <integer — page × viewport × check verdicts recorded>,
  "report_complete": <boolean — checkReportComplete().complete>,
  "checks_applied": 10,
  "findings_count": <integer>,
  "collisions": <integer>
}
```

---

## Report layout

```
UX Evaluation — run <run-id>
Target: <live|production-build|dev-server> <url>
[DEV-SERVER RUN — not the live state; no verdict about what users see.]
Rubric: rubric-v2

Human checks (per page × viewport)
Page     Viewport  five-second  primary-action  dead-or-locked  empty-state  density  decoration
/start   1440      FAIL         FAIL            FAIL            FAIL         PASS     PASS
/start   390       ...

Findings: N  (CRITICAL n · HIGH n · MEDIUM n · LOW n)
<one line per finding: severity, check, location, suggestion>

Mechanical checks (footnote — never a verdict)
onboarding-step-count n · axe-violations n · console-errors n · liquid-glass-conformance n|skipped
```

---

## Mechanical checks (footnote section)

The four v1 checks run unchanged after the human checks, with the definitions, severities,
evidence rules and fingerprint inputs of `rubric-v1.md` Checks 1–4:

| check | v1 section |
|---|---|
| `onboarding-step-count` | rubric-v1 § Check 1 |
| `axe-violations` | rubric-v1 § Check 2 |
| `console-errors` | rubric-v1 § Check 3 |
| `liquid-glass-conformance` | rubric-v1 § Check 4 |

Their findings are real findings (they enter `findings.jsonl` and issue reconciliation), but
their zero counts are never reported as a quality statement about the UI.

## Out of scope (v2)

Same as rubric-v1 § Out-of-scope. In addition: the floor reads no computed styles or bounding
boxes, so colour, visual weight and above-the-fold position are judged from the screenshot.
Revisit when the Playwright fixtures write computed styles next to the AX snapshot.
