# Skeleton Report — /test --target mac-target --profile mac-target-onboarding

> **Status: SKELETON — operator-triggered live run pending.**
> No peekaboo execution has occurred. This document describes the expected pipeline,
> rubric checks, and exact bash invocation for the operator. Fill in the "Run Results"
> section after the first live run.

---

## Why

**Issue:** #386 — Peekaboo skeleton proof for `/test --target mac-target --profile onboarding`

The mac-target V3.3 release (git ref `b29ea71`) shipped a 10-step onboarding flow
with zero E2E coverage. According to `skills/test-runner/rubric-v1.md` Check 1:

> The mac-target V3.3 release shipped a 10-step onboarding flow with no E2E
> coverage; user-completion rate dropped 34% vs V3.2 (cited in PRD §1.1 as the
> canonical motivating example for this rubric).

A 10-step flow is `severity: CRITICAL` under rubric-v1 Check 1 (threshold ≥ 10 steps).
The `/test` command exists precisely to catch this class of regression — a long onboarding
funnel that ships without peekaboo coverage. This skeleton proves the profile, scenario
sequence, and artifact shape before committing any live run time.

**Motivation summary:**
- V3.3 onboarding = 10 steps → CRITICAL by rubric-v1 Check 1 (§ onboarding-step-count)
- HEAD (v3.21) may have improved or regressed further — the profile enables tracking
- The `axe-violations` and `console-errors` checks are N/A for native SwiftUI; only
  `onboarding-step-count` (Check 1) and `liquid-glass-conformance` (Check 4) are in scope
- `liquid-glass-conformance` is currently a no-op because the app targets macOS .v14 < 26;
  it is declared in the profile so it activates automatically when the deployment target bumps

---

## Profile

Profile key: `mac-target-onboarding`
Declared in: `.orchestrator/policy/test-profiles.json`

| Field | Value |
|---|---|
| `driver` | `peekaboo` |
| `target_name` | `mac-target` (the .app product name from `apps/menubar/MacTarget.xcodeproj`) |
| `checks` | `["onboarding-step-count", "liquid-glass-conformance"]` |
| `timeout_ms` | `180000` (3 minutes) |
| `liquid_glass_skipped` | `true` — deployment target macOS .v14 < 26 |
| `app_source` | `<app-source-path>` |
| `swift_ref_note` | V3.3 = `b29ea71`; HEAD is v3.21 — operator must checkout V3.3 ref before running |

### 4 Expected Onboarding Scenarios

The following scenarios represent the distinct stages a new user passes through during
mac-target onboarding. Each stage corresponds to a peekaboo capture point (one
AX-snapshot + one screenshot per stage).

| Stage # | Scenario key | Description |
|---|---|---|
| 1 | `LLM-Provider` | User selects and configures the LLM backend (Anthropic key, OpenAI key, or local model). First screen after app launch. |
| 2 | `Test-Run` | The app runs a connectivity test against the chosen LLM provider. User sees a progress indicator and pass/fail state. |
| 3 | `Keychain` | User authorises keychain access for storing the API key securely. macOS permission dialog + confirmation screen. |
| 4 | `Mail-Surface` | User grants Mail access permissions and sees the initial mail-surface panel. Final onboarding screen before the main UI. |

> **Why 4 scenarios, not 10?** The V3.3 regression added 6 additional screens on top of
> this 4-stage critical path (duplicate confirmations, optional profile steps that were
> not skippable). The 4 scenarios above represent the minimum viable onboarding path.
> The rubric check counts all reachable distinct screens — the CRITICAL finding reflects
> the full count, not just the 4 named stages.

---

## Expected Outcome

After a successful live run against V3.3 (`b29ea71`), the artifact directory at
`.orchestrator/metrics/test-runs/<run-id>/` should contain:

### Artifacts per scenario

| Artifact | Stage | Expected path |
|---|---|---|
| AX-snapshot | LLM-Provider | `ax-snapshots/LLM-Provider-ax.yaml` |
| Screenshot | LLM-Provider | `screenshots/LLM-Provider.png` |
| AX-snapshot | Test-Run | `ax-snapshots/Test-Run-ax.yaml` |
| Screenshot | Test-Run | `screenshots/Test-Run.png` |
| AX-snapshot | Keychain | `ax-snapshots/Keychain-ax.yaml` |
| Screenshot | Keychain | `screenshots/Keychain.png` |
| AX-snapshot | Mail-Surface | `ax-snapshots/Mail-Surface-ax.yaml` |
| Screenshot | Mail-Surface | `screenshots/Mail-Surface.png` |

### Results JSON (`.orchestrator/metrics/test-runs/<run-id>/results.json`)

```json
{
  "exit_code": 1,
  "scenarios_attempted": 4,
  "scenarios_passed": 4,
  "scenarios_failed": 0
}
```

> `exit_code: 1` is expected because the rubric will emit a CRITICAL finding
> (step-count ≥ 10) — the run succeeds in capturing evidence but the rubric check fails.
> `scenarios_passed: 4` confirms all 4 capture points completed successfully.

### Expected findings.jsonl

A CRITICAL finding from Check 1 (onboarding-step-count) is the primary expected output:

```json
{"_meta":true,"rubric_version":"v1","run_id":"<run-id>","evaluated_at":"<ISO-8601>","checks_applied":2,"findings_count":1,"collisions":0}
{"run_id":"<run-id>","rubric_version":"v1","severity":"critical","check":"onboarding-step-count","fingerprint":"<16-hex>","evidence_path":"screenshots/Mail-Surface.png","suggested_priority":"critical","scope":"onboarding","checkId":"step-count-over-7","locator":"MacTarget.OnboardingFlow","title":"Onboarding flow has ≥10 steps (limit: 7)","description":"The MacTarget onboarding flow at V3.3 (b29ea71) requires the user to complete ≥10 distinct screens before reaching the main surface. The 7-step limit is defined in rubric-v1 Check 1. This is the canonical motivating example for the /test rubric (PRD §1.1).","recommendation":"Audit the onboarding sequence and collapse or make optional the steps beyond the 4 critical-path stages (LLM-Provider → Test-Run → Keychain → Mail-Surface). Target ≤7 steps in the non-skippable critical path."}
```

`liquid-glass-conformance` will emit no findings — it is declared in `checks` for
future activation but `liquid_glass_skipped: true` causes the check to log a skip
event and produce zero findings at macOS .v14.

---

## Manual Run Instructions

> Prerequisites checklist before invoking `/test`:
> - [ ] peekaboo installed: `brew install steipete/tap/peekaboo && peekaboo --version` (expect 3.1.x)
> - [ ] Screen Recording permission granted to Terminal / Claude Code in System Settings > Privacy & Security
> - [ ] Accessibility permission granted to Terminal / Claude Code in System Settings > Privacy & Security
> - [ ] V3.3 of mac-target checked out (see Step 1 below)
> - [ ] MacTarget.app built successfully (see Step 2 below)
> - [ ] App is NOT already running (peekaboo launches it fresh)

```bash
# Step 1: Check out V3.3 of mac-target (the 10-step regression ref)
git -C <app-source-path> checkout b29ea71

# Step 2a: Build via Xcode GUI
# Open <app-source-path>/apps/menubar/MacTarget.xcodeproj
# Select the mac-target scheme + My Mac destination
# Press Cmd-B (Product > Build)

# Step 2b: Build via xcodebuild (headless / CI-friendly)
xcodebuild \
  -project <app-source-path>/apps/menubar/MacTarget.xcodeproj \
  -scheme mac-target \
  -configuration Debug \
  -destination "platform=macOS" \
  build

# Step 3: Verify the build succeeded
# The .app lands in DerivedData — confirm no errors in xcodebuild output.
# For Xcode GUI: confirm "Build Succeeded" in the activity bar.

# Step 4: Run /test via peekaboo-driver
export RUN_DIR=".orchestrator/metrics/test-runs/$(date +%s)-mac-target-onboarding"
export TARGET="mac-target"
export PROFILE="mac-target-onboarding"
bash skills/peekaboo-driver/SKILL.md

# Step 5: Inspect the structured findings
cat "$RUN_DIR/findings.jsonl" | jq .

# Step 6: Inspect the results summary
cat "$RUN_DIR/results.json" | jq .

# Step 7: Browse artifact screenshots and AX-snapshots
ls "$RUN_DIR/screenshots/"
ls "$RUN_DIR/ax-snapshots/"

# Step 8: Return mac-target to HEAD (v3.21) when done
git -C <app-source-path> checkout main
```

> **Note on the app path:** peekaboo discovers the running app by product name
> (`mac-target`). You must have the app built and **launchable** — peekaboo
> will attempt to launch it if it is not already running. If it cannot locate the
> .app bundle, set `PEEKABOO_APP_PATH` to the full path of `MacTarget.app`
> in your DerivedData before running.

---

## Rubric Expectations

All rubric references point to `skills/test-runner/rubric-v1.md`.

### Check 1: onboarding-step-count (lines 93–149 of rubric-v1.md)

Expected result for V3.3: **CRITICAL** (≥ 10 steps).

| Step count | Rubric severity |
|---|---|
| ≤ 7 | No finding |
| 8–9 | HIGH |
| **≥ 10** | **CRITICAL** ← expected for V3.3 |

Fingerprint inputs (rubric-v1 §Fingerprint formula):
- `scope = 'onboarding'`
- `checkId = 'step-count-over-7'`
- `locator = 'MacTarget.OnboardingFlow'`

### Check 4: liquid-glass-conformance (lines 287–331 of rubric-v1.md)

Expected result: **SKIPPED** — applicability condition not met.

> "This check is only executed when … `Package.swift` declares `.iOS("26")` or higher,
> OR `.macOS("26")` or higher." (rubric-v1, Check 4, Applicability condition)

The mac-target app targets macOS .v14. This check will produce zero findings and
log a skip event. It is listed in the profile so it activates automatically when the
deployment target bumps to macOS 26.

### Checks 2 and 3: axe-violations / console-errors

Not listed in the profile's `checks` array. Not executed. These checks are N/A for
native SwiftUI — axe-core requires a browser DOM and console-errors requires a
Playwright `page.on('console', ...)` handler.

---

## What Is NOT In Scope (This Session)

The following were explicitly de-scoped by the user for this session:

- **Live peekaboo execution** — no real screenshots or AX-snapshots captured
- **Real AX-tree analysis** — no actual step-count measured against V3.3
- **findings.jsonl generation** — the file shown above is the expected shape, not actual output
- **Issue creation in mac-target repo** — deferred to the live run (operator-triggered)
- **V3.3 build verification** — operator must build before running

This document constitutes the proof-of-skeleton: the profile is declared, the rubric
expectations are specified, and the exact invocation is documented. The live run is
operator-triggered.

---

## Sign-Off Checklist (Operator)

Tick these before and after the live run:

**Pre-run:**
- [ ] `peekaboo --version` reports 3.1.x
- [ ] `git -C <app-source-path> log --oneline -1` shows `b29ea71`
- [ ] MacTarget.app builds successfully (Xcode or xcodebuild, zero errors)
- [ ] Screen Recording permission: granted to Terminal in System Settings
- [ ] Accessibility permission: granted to Terminal in System Settings
- [ ] MacTarget.app is not already running

**Post-run:**
- [ ] `$RUN_DIR/results.json` exists and `scenarios_attempted == 4`
- [ ] `$RUN_DIR/screenshots/` contains 4 `.png` files (one per scenario)
- [ ] `$RUN_DIR/ax-snapshots/` contains 4 `.yaml` files (one per scenario)
- [ ] `$RUN_DIR/findings.jsonl` exists; first line is the metadata record
- [ ] CRITICAL finding for `onboarding-step-count` present in `findings.jsonl`
- [ ] `liquid-glass-conformance` shows as skipped (zero findings for that check)
- [ ] Return to HEAD: `git -C <app-source-path> checkout main`

---

**Generated by:** W2-I3 (test-writer) · session-orchestrator v3.6.0 · skeleton — no live execution
**Issue reference:** #386
**Profile:** `.orchestrator/policy/test-profiles.json` → `mac-target-onboarding`
**Commit reference:** to be filled by session-end commit
