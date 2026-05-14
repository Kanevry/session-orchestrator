---
name: peekaboo-driver
user-invocable: false
tags: [test, driver, macos, peekaboo]
model-preference: sonnet
description: Thin driver wrapper around steipete/peekaboo (MIT, macOS-only). Dispatched by `skills/test-runner/` to capture native-UI AX-tree snapshots + screenshots on macOS 15+ targets, and exits with deterministic JSON output the orchestrator can parse.
---

# Peekaboo Driver Skill

## Soul

> See [soul.md](./soul.md).

## Phase 0: Bootstrap Gate

Read `skills/_shared/bootstrap-gate.md` and execute the gate check. If GATE_CLOSED, invoke `skills/bootstrap/SKILL.md` and wait for completion. If GATE_OPEN, continue.

<HARD-GATE>
This driver is macOS-only. It wraps the `peekaboo` binary (steipete/peekaboo, MIT). It does NOT use any MCP adapter layer. The platform gate in Phase 1 is mandatory pre-flight.
</HARD-GATE>

## Package Note — Installation & Binary Name

Both install paths surface the same `peekaboo` binary at the same version:

| Install path | Command | Notes |
|---|---|---|
| Homebrew (preferred) | `brew install steipete/tap/peekaboo` | Installs to `/opt/homebrew/bin/peekaboo` |
| npm / npx (CI-friendly) | `npx -y @steipete/peekaboo` | Requires Node 22+. No global install needed. |

The GitHub repository is `github.com/steipete/peekaboo`. Older links may surface `openclaw/Peekaboo` — both redirect to the same canonical repo and binary.

**Canonical name verification:** Always verify a package name via `brew info` or `npm view` before documenting. The playwright-driver PRD originally referenced `@playwright/cli@0.1.13` (an unrelated stub) instead of canonical `playwright@1.60.0`. Verify `@steipete/peekaboo` against any look-alike before trusting an install path.

## Install

```bash
brew install steipete/tap/peekaboo    # Option A — Homebrew
npx -y @steipete/peekaboo --version   # Option B — npx (CI)
peekaboo --version                    # Verify: expect 3.1.x
```

Baseline: **v3.1.0**. Latest at time of writing: **v3.1.2** (May 11 2026).

## Phase 1: Platform & Version Gate

**Mandatory pre-flight. Run before any other peekaboo command.**

```bash
[ "$(uname -s)" != "Darwin" ] && { echo "peekaboo-driver: non-darwin, skipping." >&2; exit 0; }
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MACOS_MAJOR" -lt 15 ] && { echo "peekaboo-driver: requires macOS 15+, skipping." >&2; exit 0; }
command -v peekaboo >/dev/null 2>&1 || { echo "peekaboo-driver: binary not found — install first." >&2; exit 2; }
```

Exit 0 (non-fatal skip) on non-darwin or macOS < 15.0 (Sequoia). Exit 2 (fatal) only when the binary is missing on an otherwise-compatible system.

## Phase 2: Permission Probe

```bash
PERMS_JSON="$(peekaboo permissions status --json)"
MISSING="$(echo "$PERMS_JSON" | jq -r '.data.permissions[] | select(.isRequired == true and .isGranted == false) | .name')"
[ -n "$MISSING" ] && echo "peekaboo-driver: missing required permissions: ${MISSING}" >&2
```

The `permissions status --json` schema (verified 2026-05-14):

```json
{
  "success": true,
  "data": {
    "permissions": [
      { "name": "Screen Recording",   "isRequired": true,  "isGranted": false, "grantInstructions": "System Settings > Privacy & Security > Screen Recording" },
      { "name": "Accessibility",      "isRequired": true,  "isGranted": false, "grantInstructions": "System Settings > Privacy & Security > Accessibility" },
      { "name": "Event Synthesizing", "isRequired": false, "isGranted": false, "grantInstructions": "System Settings > Privacy & Security > Accessibility" }
    ],
    "source": "local"
  }
}
```

Required: **Screen Recording** (hard), **Accessibility** (hard). Optional: **Event Synthesizing**. Permission failures are never silent. Route to Phase 3 when any required permission is not granted.

## Phase 3: Permission Remediation

Surface missing required permissions via AskUserQuestion (per `ask-via-tool.md` AUQ-003). Do not auto-grant — macOS requires manual user action in System Settings.

```
AskUserQuestion({
  questions: [{
    question: "Screen Recording permission is required but not granted. Open System Settings > Privacy & Security > Screen Recording, enable the terminal entry, then confirm here.",
    header: "Missing Permission: Screen Recording",
    options: [
      { label: "Granted — continue (Recommended)", description: "I have enabled Screen Recording in System Settings." },
      { label: "Skip this run", description: "Abort peekaboo-driver. Test-runner will record a framework-error finding." }
    ],
    multiSelect: false
  }]
})
```

After confirmation, re-probe. If still not granted or user selects Skip, exit 2 (fatal). Do NOT attempt any capture without required permissions — the binary will fail ungracefully.

## Canonical Usage

The orchestrator (`skills/test-runner/`) dispatches via Bash. Inputs via environment variables: `RUN_ID`, `RUN_DIR`, `TARGET` (app name), `PROFILE`.

```bash
# Validate TARGET (app name) — alphanumeric, spaces, dots, hyphens only
# (Prevents shell injection per SEC-PD-MED-1 + path traversal per SEC-PD-LOW-1)
[[ "${TARGET}" =~ ^[A-Za-z0-9\ \.\-]+$ ]] || { echo "peekaboo-driver: invalid TARGET (must match ^[A-Za-z0-9 .-]+$)" >&2; exit 2; }
TARGET_SAFE="${TARGET//[^A-Za-z0-9_.-]/_}"   # filename-safe variant for artifact paths

RUN_DIR=".orchestrator/metrics/test-runs/${RUN_ID}"
mkdir -p "${RUN_DIR}/ax-snapshots" "${RUN_DIR}/screenshots"
peekaboo see --app "${TARGET}" --json > "${RUN_DIR}/ax-snapshots/main-${TARGET_SAFE}.json"
peekaboo image --app "${TARGET}" --format png --path "${RUN_DIR}/screenshots/main-$(date +%s%3N).png"
```

## Artifact Layout

```
.orchestrator/metrics/test-runs/<run-id>/
  results.json                      # driver summary {run_id, exit_code, scenarios_*}
  exit_code                         # plain integer: 0, 1, or 2
  ax-snapshots/
    <scenario>.json                 # peekaboo see --json output (one per scenario)
    glass-modifiers-<ts>.json       # Liquid Glass conformance artifact (Check 4)
  screenshots/
    <step>-<timestamp>.png          # peekaboo image output
  console.ndjson                    # driver log events (NDJSON)
```

**Token discipline:** NEVER inline AX-tree dumps into the coordinator context. Always write to disk. The `ux-evaluator` agent reads from disk, not from prompt context.

## AX-Snapshot Pattern

```bash
peekaboo see --app "${APP_NAME}" --json > "${RUN_DIR}/ax-snapshots/${SCENARIO}.json"
```

Key fields in the `see --json` output the ux-evaluator reads: `snapshot_id` (capture ID), `ui_elements` (flat AX element list — primary consumer input), `ui_map` (hierarchical tree), `interactable_count`, `capture_mode` (`"screen"` or `"window"`). Each `ui_elements` entry carries `role`, `role_description`, `bounds` (`{x, y, width, height}`), `identifier`, and `children`. ux-evaluator Check 4 scans `ui_elements` for frame identifiers and cross-references the `glass-modifiers` artifact.

## Liquid-Glass Conformance Artifact

For SwiftUI 26+ targets (projects with `Package.swift` declaring `.iOS("26")` or `.macOS("26")+`), emit a conformance artifact alongside the AX snapshot:

```bash
cat > "${RUN_DIR}/ax-snapshots/glass-modifiers-$(date +%s%3N).json" <<EOF
{
  "schema_version": "v1",
  "run_id": "${RUN_ID}",
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "glassEffect_frames": [],
  "legacy_material_frames": [],
  "blur_modifier_frames": []
}
EOF
```

The ux-evaluator Check 4 reads this file. `glassEffect_frames` = compliant (uses `.glassEffect()`). `legacy_material_frames` = non-compliant (uses `.background(.thinMaterial)` etc.). `blur_modifier_frames` = non-compliant (uses `.blur(radius:)` as background). In v1 the arrays are always empty — the evaluator falls back to screenshot-only analysis. Do NOT emit a bare `{}` — use the full schema structure with empty arrays.

## Composability Contract

### Invocation Shape

```bash
RUN_DIR="${RUN_DIR}" TARGET="${APP_NAME}" PROFILE="${PROFILE}" bash skills/peekaboo-driver/SKILL.md
```

All inputs via environment variables. No positional arguments accepted.

### Exit Codes

| Code | Meaning | Orchestrator Action |
|---|---|---|
| 0 | All captures succeeded (or platform skip) | Record pass or skip, continue |
| 1 | At least one capture failed | Failures become findings (non-fatal) |
| 2 | Framework error (missing binary, permission denied, OS mismatch) | Surface as driver error, halt peekaboo portion of run |

### Outputs the Orchestrator MUST Parse

- `${RUN_DIR}/exit_code` — plain integer file written by driver before exit
- `${RUN_DIR}/results.json` — driver summary with `exit_code`, `scenarios_attempted`, `scenarios_passed`, `scenarios_failed`
- `${RUN_DIR}/ax-snapshots/<scenario>.json` — peekaboo AX-tree output per scenario
- `${RUN_DIR}/ax-snapshots/glass-modifiers-<ts>.json` — Liquid Glass conformance artifact (consumed by ux-evaluator Check 4)
- `${RUN_DIR}/screenshots/<step>-<ts>.png` — per-step screenshots (evidence for ux-evaluator findings)
- `${RUN_DIR}/console.ndjson` — driver log events as NDJSON

## Version Pin + Upper-Bound Advisory

Baseline: **v3.1.0** (2026-05-14). Latest: **v3.1.2** (May 11 2026). Re-validate on v3.2+. Key surfaces: `permissions status --json` schema, `see --json` schema (`ui_elements`, `ui_map`), `image --path` flag behavior.

## Peekaboo Subcommands Reference

| Subcommand | Purpose |
|---|---|
| `peekaboo permissions status [--json]` | Check Screen Recording / Accessibility / Event Synthesizing grant status |
| `peekaboo see --app <name> [--json] [--mode screen\|window]` | Capture AX-tree snapshot for a running application |
| `peekaboo image --app <name> [--format jpg\|png] [--path <output>]` | Capture screenshot of a running application |
| `peekaboo click [query\|--on <id>\|--coords x,y]` | Synthesize a click event (requires Event Synthesizing) |
| `peekaboo type [text] [--delay ms] [--wpm 80-220]` | Synthesize keyboard input |
| `peekaboo scroll --direction up\|down\|left\|right [--amount n]` | Synthesize a scroll gesture |
| `peekaboo run <scriptPath> [--output file] [--no-fail-fast] [--json]` | Execute a `.peekaboo.json` script in scripted mode |
| `peekaboo agent [task] [--max-steps n] [--dry-run]` | Autonomous agent mode (non-deterministic — not for CI) |

## Anti-Patterns

- **DO NOT** auto-grant permissions — macOS requires manual user action. Never use `tccutil` or similar workarounds.
- **DO NOT** ignore exit codes — exit 2 is a fatal framework error. Surface it; do not treat it as a test failure.
- **DO NOT** inline AX-tree JSON into agent prompt context — always write to `${RUN_DIR}/ax-snapshots/`. Trees for complex apps exceed 50K tokens.
- **DO NOT** invoke from Linux or Windows without the platform gate — Phase 1 exits 0 (skip) but nothing downstream handles peekaboo output on non-darwin.
- **DO NOT** use `peekaboo agent` mode in automated CI runs — non-deterministic and expensive. Reserve for manual exploratory sessions.
- **DO NOT** emit a bare `{}` for the glass-modifiers artifact — use the full schema with empty arrays. The ux-evaluator validates schema fields.

## Sub-File Reference

| File | Purpose |
|---|---|
| `soul.md` | Driver identity: thin wrapper around native macOS UI capture, not an orchestrator |
