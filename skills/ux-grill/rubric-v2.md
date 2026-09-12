# UX Rubric v2 (`/ux-grill`)

v2 generalises `skills/test-runner/rubric-v1.md`'s four checks into Stufe 1 of `/ux-grill`. Stufe 1 is **LLM-free by construction**: every severity in this rubric comes from a MEASUREMENT (`scripts/lib/ux-grill/schema.mjs`, `measures.mjs`, `collect.mjs`), never from a model judgment — the research the PRD cites (LLM heuristic evaluation ~21% overlap with experts, severity consistency only 56%) is why `ux-evaluator` is deliberately NOT reused here.

Carryover by id from v1: `axe-violations`, `console-errors`. Generalised: `onboarding-step-count` → `journey-step-count` (a journey here is a scripted `journey.steps[]` replay, not just a step count). New in v2: `journey-failed` (success never reached, distinct from success reached late), `target-size-floor`, `target-size-target`, `horizontal-overflow`, `title-mismatch`. Dropped: `liquid-glass-conformance` (native macOS is out of scope for v2, see § Out of scope).

§ Stufe 2 below is a **separate, advisory catalogue** for the Grill-Loop coordinator — it carries no score and no severity, only a citation to a source item plus a screenshot path.

**`rubric_hash` convention.** The `.orchestrator/metrics/ux-grill.jsonl` run-record (`schema.mjs` `makeRunRecord()`) carries `rubric_hash` = sha256 of THIS file's full text, hex-encoded. Any edit here — a threshold, a wording change, a reordering — changes the hash on the next run, and `compareRuns` in `compare.mjs` MUST treat two runs whose `rubric_hash` differ as non-comparable (report every fingerprint as `new` rather than diff against a mismatched baseline): diffing findings scored under two rubric revisions would silently blend two different measurement bases into one `new | persisting | fixed` verdict. `collect.mjs` does not compute the hash itself — `rubricHash` is a required caller-supplied argument to `collect()`; hashing this file is the `/ux-grill` command layer's job, once per invocation, before Stufe 1 starts.

## Findings record

Every finding `collect.mjs` writes to `findings.jsonl` has exactly these fields, per `makeFinding()` in `scripts/lib/ux-grill/schema.mjs`:

- `scope` — always `"ux-grill"` (`SCOPE`) — a fingerprint input, never changed casually.
- `checkId` — one of `CHECK_IDS`, or `axe-<ruleId>` for an axe finding (never the literal `axe-violations`).
- `locator` — pipe-delimited, truncated to `LOCATOR_MAX_LENGTH` (256) in the record; see § Fingerprint contract for what an over-long locator fingerprints as.
- `severity` — one of `high | medium | low` (`SEVERITIES`); Stufe 1 never emits `critical` — no measured ux-grill violation is defined as release-blocking by itself.
- `provisional` — boolean; `true` only for `target-size-*` findings on a `build: dev` manifest, see § provisional.
- `fingerprint` — 16 hex chars, `fingerprintFinding({scope, checkId, locator})` over the fingerprint locator (§ Long-locator rule).
- `message` — one-line human summary; defaults to `""`.
- `evidence` — free-form object (screenshot path, axe node, measured px); defaults to `{}`.

## Fingerprint contract

`fingerprintFinding({ scope: 'ux-grill', checkId, locator })` from `scripts/lib/test-runner/fingerprint.mjs`. Do not re-derive the formula — see `skills/test-runner/rubric-v1.md` § Fingerprint formula: `sha256(scope + '\n' + checkId + '\n' + locator).slice(0, 16)`. The `\n` separator is collision-free by construction because it is forbidden inside a locator (`makeFinding()` rejects `\n`/`\r`/`\0`), the same `ARG_BOUNDARY_DANGEROUS` boundary that guards shell arguments elsewhere.

`checkId` is one of the 8 `CHECK_IDS` values, **except** `'axe-violations'` itself, which is the catalogue entry only — `makeFinding()` throws when handed that literal. An emitted axe finding always carries `checkId = 'axe-<ruleId>'` (e.g. `axe-color-contrast`), which is exactly why two axe rules violated on the same selector remain two distinct findings: the rule id, not just `axe`, is part of the fingerprint input.

Two locator shapes: `route|viewport|selector` for every route-scoped check (`axe-*`, `target-size-*`, `horizontal-overflow`, `title-mismatch`, `console-errors` — `selector` is `document`, `title`, `console`, or a generated CSS path depending on the check), and `journey|viewport|<name>` for both journey checks (`<name>` is the manifest journey name, never a per-element selector). Locators are truncated to 256 chars in the record (`makeFinding()`; the fingerprint input for an over-long locator follows the Long-locator rule below), and every segment is sanitised of `\n`/`\r`/`\0` by `collect.mjs` `safeLocatorPart()` before assembly, so a hostile selector text cannot crash a run mid-way.

**Long-locator rule (deliberate deviation from rubric-v1, #1334).** A locator of ≤ 256 chars is fingerprinted as-is, exactly as rubric-v1 prescribes. A locator LONGER than 256 chars is fingerprinted as `truncated + ':' + sha256(fullLocator).slice(0, 8)` — the record still carries only the readable 256-char truncation. Why ux-grill deviates: the audited page controls its own selectors, so under bare truncation a decoy element under a > 256-char class chain sharing the real element's prefix would take the real violation's fingerprint, and `compare.mjs` (first fingerprint wins) would let the decoy shadow it. The suffixed input is 265 chars long, so it can never equal an untruncated locator and every ≤ 256-char fingerprint stays byte-for-byte stable. rubric-v1 and `scripts/lib/test-runner/fingerprint.mjs` stay unchanged on purpose: changing them would invalidate every existing `/test` fingerprint.

## Check catalogue

Examples below omit `scope` (always `"ux-grill"`) and `fingerprint` (derived, see § Fingerprint contract) for brevity; a real record carries all 8 fields.

### `axe-violations` (`axe-<ruleId>`)
**Measured:** `agent-browser a11y --tags wcag2a,wcag2aa --json` on the loaded route; `collect.mjs` `findingsFromAxe()` emits one finding per violation × node target — never one per violation — so two nodes violating the same rule are two findings, and two rules violating the same node are two findings. **Locator:** `route|viewport|selector` (selector = the axe node's flattened `target`, shadow-DOM boundaries joined `>>>`). **Severity:** `severityForAxeImpact(impact)` — critical/serious → high, moderate → medium, minor/unknown → low.
```json
{
  "checkId": "axe-button-name",
  "locator": "/dashboard|desktop|#submit-btn",
  "severity": "high",
  "provisional": false,
  "message": "button has no accessible name",
  "evidence": { "impact": "serious" }
}
```
**Does not catch:** a violation that only appears after a user interaction (e.g. a focus trap after a click sequence) — the scan runs once per loaded route.

### `console-errors`
**Measured:** `agent-browser errors --json`, read AFTER the route's other measurements so anything they trigger is still attributed to this route; `errors --clear` runs before `open` so the buffer holds only this route. **Locator:** `route|viewport|console`. **Severity:** fixed `medium` — ANY count ≥ 1 becomes exactly ONE finding.
```json
{
  "checkId": "console-errors",
  "locator": "/invoices|mobile|console",
  "severity": "medium",
  "provisional": false,
  "message": "3 page error(s) recorded on this route",
  "evidence": { "errorCount": 3 }
}
```
**Does not catch:** which error is new versus recurring — the count collapses into one finding, so a route regressing from 1 to 4 errors keeps the same fingerprint and reads as `persisting`, not `new`.

### `journey-step-count`
**Measured:** `collect.mjs` `runJourney()` replays `journey.steps[]` up to `max-steps + JOURNEY_STEP_OVERRUN` (4) and tests `journey.success` after each step; emitted when `success` IS reached but `stepsRun > max-steps`. **Locator:** `journey|viewport|<name>`. **Severity:** fixed `medium`.
```json
{
  "checkId": "journey-step-count",
  "locator": "journey|desktop|create-first-invoice",
  "severity": "medium",
  "provisional": false,
  "message": "journey reached success in 8 step(s), budget is 6",
  "evidence": { "stepsRun": 8, "maxSteps": 6 }
}
```
**Does not catch:** WHY the journey overran (a confusing screen versus a slow network) — that judgment belongs to Stufe 2, not this check.

### `journey-failed`
**Measured:** same replay; emitted instead of `journey-step-count` when `success` is never reached within the hard cap (`max-steps + 4`). **Locator:** `journey|viewport|<name>`. **Severity:** fixed `high`.
```json
{
  "checkId": "journey-failed",
  "locator": "journey|mobile|onboarding-avv",
  "severity": "high",
  "provisional": false,
  "message": "journey did not reach its success condition after 10 step(s)",
  "evidence": { "stepsRun": 10, "maxSteps": 6 }
}
```
**Does not catch:** whether the journey SCRIPT is stale (a selector that no longer matches) versus a genuine product regression — both look identical here.

### `target-size-floor`
**Measured:** `measures.mjs` `TARGET_SIZE_EVAL` runs in-page over the interactive-target population (`INTERACTIVE_TARGET_SELECTOR` — cite the module, do not restate the selector list; excludes hidden/zero-area, `opacity:0`, `aria-hidden`/`inert` ancestors, and — for `select`/`input` only — covered-or-offscreen-or-≤1×1). `classifyTargetSize()` returns `'floor'` when EITHER axis is below `TARGET_SIZE_FLOOR_PX` (24 px, WCAG 2.5.8). **Locator:** `route|viewport|selector` (generated CSS path, depth ≤ 5, ≤ 160 chars). **Severity:** fixed `high`.
```json
{
  "checkId": "target-size-floor",
  "locator": "/dashboard|mobile|button:nth-of-type(3)",
  "severity": "high",
  "provisional": true,
  "message": "interactive target measures 147x20 CSS px",
  "evidence": { "width": 147, "height": 20 }
}
```
**Does not catch:** a target reachable only via a JS click handler with no matching selector — the population is syntactic on purpose, so it stays reproducible run to run (PRD § 2 S2 reproducibility AC).

### `target-size-target`
Same measurement and population as `target-size-floor`; `classifyTargetSize()` returns `'target'` when both axes are ≥ 24 px but EITHER axis is below `TARGET_SIZE_TARGET_PX` (44 px, WCAG 2.5.5). **Locator:** `route|viewport|selector`. **Severity:** fixed `medium`.
```json
{
  "checkId": "target-size-target",
  "locator": "/dashboard|desktop|a:nth-of-type(2)",
  "severity": "medium",
  "provisional": true,
  "message": "interactive target measures 32x32 CSS px",
  "evidence": { "width": 32, "height": 32 }
}
```
**Does not catch:** SPACING between two adjacent compliant targets — WCAG 2.5.x concerns size only, never gap between targets.

### `horizontal-overflow`
**Measured:** `measures.mjs` `OVERFLOW_EVAL` (`document.documentElement.scrollWidth` vs. `window.innerWidth`); the verdict is `hasHorizontalOverflow()`, which applies a 1 px subpixel tolerance (`OVERFLOW_TOLERANCE_PX`) — so `scrollWidth > innerWidth + 1`, NOT the plain `scrollWidth > innerWidth` of PRD § 2 S3. The tolerance is deliberate; its ceiling and revisit trigger are stated AT the constant in `measures.mjs` (BV-004) — this line is a pointer, not the justification. `collect.mjs` `findingFromOverflow()` calls that one helper rather than re-deriving the comparison. **Locator:** `route|viewport|document` — overflow is a page property, not an element's. **Severity:** fixed `medium`.
```json
{
  "checkId": "horizontal-overflow",
  "locator": "/reports|mobile|document",
  "severity": "medium",
  "provisional": false,
  "message": "page scrolls horizontally: scrollWidth 428 > innerWidth 393",
  "evidence": { "scrollWidth": 428, "innerWidth": 393 }
}
```
**Does not catch:** WHICH element causes the overflow — `bodyScrollWidth` is carried alongside as diagnostic context only, never part of the verdict.

### `title-mismatch`
**Measured:** `agent-browser get title --json`; `titleMatches()` compiles the route's `title-pattern` (a regex source string, no delimiters/flags) and tests the measured title against it. **Locator:** `route|viewport|title`. **Severity:** fixed `low`.
```json
{
  "checkId": "title-mismatch",
  "locator": "/invoices|desktop|title",
  "severity": "low",
  "provisional": false,
  "message": "page title does not match title-pattern ^Invoices",
  "evidence": { "title": "Dashboard" }
}
```
**Does not catch:** a route with NO `title-pattern` declared — an absent expectation is not a defect (`titleMatches()` returns `matched: true`). An UNCOMPILABLE `title-pattern` is not a finding either: it is a manifest defect, and `collect()` validates every route pattern up front, throwing `CollectError('invalid-title-pattern')` BEFORE the browser session opens, so no run starts on a broken manifest.

## Severity table

| check (`checkId`) | measurement | severity |
|---|---|---|
| `axe-violations` (`axe-<ruleId>`) | impact `critical` / `serious` | high |
| `axe-violations` (`axe-<ruleId>`) | impact `moderate` | medium |
| `axe-violations` (`axe-<ruleId>`) | impact `minor` / unknown | low |
| `target-size-floor` | either axis < 24 px | high |
| `target-size-target` | both axes ≥ 24 px, either axis < 44 px | medium |
| `horizontal-overflow` | `scrollWidth > innerWidth + 1 px` (`OVERFLOW_TOLERANCE_PX`) | medium |
| `journey-failed` | `success` not reached within `max-steps + 4` | high |
| `journey-step-count` | `success` reached, `stepsRun > max-steps` | medium |
| `console-errors` | ≥ 1 page error recorded on the route | medium |
| `title-mismatch` | title does not match `title-pattern` | low |

SSOT is `SEVERITY_BY_CHECK` / `severityForAxeImpact` in `schema.mjs`; this table is a rendering of it, not a second source of truth — if the two ever disagree, `schema.mjs` wins and this table is stale.

## provisional

`makeFinding()` sets `provisional: true` exactly when `build === 'dev' && checkId.startsWith('target-size-')` — only `target-size-floor` and `target-size-target` findings, and only when the manifest's `build` frontmatter is `dev`. Every other check is never provisional, regardless of build.

Why: a dev build (unminified CSS, dev-mode component libraries, no production media-query tree-shaking) is not a reliable geometry measurement basis — the same Vault-learning the PRD cites in its Risks table ("Dev-Build ≠ Prod-Build für Geometrie"). A target-size violation measured against a dev build is still reported (it may well be real), but flagged rather than dropped or silently trusted: Stufe 2 and reconcile must weigh a `provisional: true` finding differently — e.g. never auto-file it as an issue without first reproducing it against a `prod` build.

## Skipped

Four `SKIP_REASONS` (`schema.mjs`), each recorded as `{what, reason}` in the run-record's `skipped[]`:

- **`device-mismatch`** — `set device`/`set viewport` did not produce the requested `window.innerWidth` (verified, not assumed — PRD § 5 "`set device` kennt Gerätenamen nicht"). The viewport is skipped; the run continues at the next viewport rather than filing screenshots or findings under a wrong label. The expectation comes from an explicit `expected-width` on the viewport entry or from `collect.mjs` `DEVICE_WIDTHS` (widths measured against agent-browser 0.37.1, 2026-09-12); a viewport with NEITHER is skipped under this same reason rather than accepted at whatever width it happened to measure.
- **`pencil-unavailable`** — Pen.app or its MCP surface is unreachable; the optional S6 coverage step is skipped and the run still ends without error.
- **`measure-failed`** — ONE measurement on an otherwise reachable page produced no usable payload: a non-zero exit, unparseable stdout, or an `agent-browser` envelope carrying `success: false` (which arrives at EXIT CODE 0 — measured 2026-09-12, v0.37.1). The `what` is `route|viewport|<call>` with `<call>` ∈ `get:title` · `a11y` · `eval:target-size` · `eval:overflow` · `errors` (plus `viewport:<name>|eval:viewport-width`). The failing check produces NO findings for that page, so "nothing found" and "never measured" stay distinguishable in the next compare run.
- **`route-unreachable`** — a NON-FIRST route failed to load. This is a SKIP, not a dropped route: emitting zero findings for an unreached route would read as "clean" in the next `compare.mjs` run and silently turn an outage into a `fixed` classification. A JOURNEY whose `start` page never opened is recorded the same way (`journey:<name>`) — never as a `journey-failed` finding, which would blame the product for an unreachable page. When the FIRST route of the FIRST viewport fails to open, `collect.mjs` does not skip — it throws `CollectError('base-url-unreachable')`, because the app is not running at all and every subsequent measurement would be meaningless.

## Stufe 2 — advisory catalogue (no score)

Every Stufe-2 finding names its source item from this catalogue AND a screenshot path. No numbers, no severity, no fingerprint — Stufe 2 is a Grill-Loop coordinator judgment (`skills/ux-grill/SKILL.md`), not a Stufe-1 measurement.

**Nielsen's 10 usability heuristics** — visibility of system status; match between system and the real world; user control and freedom; consistency and standards; error prevention; recognition rather than recall; flexibility and efficiency of use; aesthetic and minimalist design; help users recognize, diagnose and recover from errors; help and documentation.

**Cognitive Walkthrough** — four questions per journey step: can the user **understand** what is possible here; can they **decide** on the right action; can they **act** on it without a wrong click; can they **recover** when they take a wrong turn.

**Mobile ergonomics** — thumb zone (are primary actions reachable one-handed in the bottom two thirds of the viewport); the fold (is anything load-bearing hidden below it with no visual cue); tap spacing (adjacent targets close enough to mis-tap even when each individually clears § target-size).

**Empty states** — is a zero-data screen designed (a next action, a reason) or a blank/undesigned gap; does it contradict a claim made elsewhere in the same journey (PRD's "Widersprüche zwischen Screens" — a Phase-3 primary output of the Grill-Loop).

**Voice contract** — narrative Stufe-2 findings follow this repo's register, defined once in `skills/session-start/soul.md` § "Register — how a sentence reads" and pointed to (not copied) by `skills/grill/soul.md` § "Register — how a sentence reads": write for someone who knows the product but did not watch this run; plain words, real things — no analogy that collapses when its nouns are deleted.

## Out of scope (v2)

- **Pixel- oder Property-Diff gegen `.pen`** — needs `design/manifest.json` from the Design-First epic (projects-baseline #458, SO#1301); today it would only compare against 4 mobile frames.
- **`design-reviewer` agent (SO#1300 B4)** — stays there. `/ux-grill` checks journeys; B4 checks per-wave design drift. No replacement, a clear boundary.
- **Dark mode** — a future `viewports` extension (`set media dark`), not in this 2-week appetite.
- **Native macOS (peekaboo)** — web only; this is also why `liquid-glass-conformance` from rubric-v1 has no v2 equivalent.
