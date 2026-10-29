> See probes-intro.md for confidence scoring reference.

## Category: `infra`

### Probe: ci-pipeline-health

**Activation:** CI config exists (`.gitlab-ci.yml`, `.github/workflows/`, `Jenkinsfile`, etc.).

**Detection Method:**

```bash
# GitLab: query recent pipeline status
glab pipeline list -R <OWNER>/<REPO> --per-page 10

# GitHub: query recent workflow runs
gh run list -R <OWNER>/<REPO> --limit 10

# Parse output for:
# - Repeated failures (same pipeline failing 3+ times in a row)
# - Long-running failures (pipeline failed >24h ago with no subsequent success)
# - Currently failing pipelines
```

**Evidence Format:**
```
Pipeline: <pipeline_id or run_id>
Status: failed | success
Duration: <time>
Failed Since: <timestamp>
Consecutive Failures: <count>
```

**Default Severity:** High. Critical if failed >24h with no fix.

---

### Probe: env-config-drift

**Activation:** `.env.example` exists.

**Detection Method:**

```bash
# Extract keys from .env.example
grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' .env.example | sed 's/=.*//' | sort > /tmp/env_example_keys

# Extract keys from .env (if exists)
grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' .env 2>/dev/null | sed 's/=.*//' | sort > /tmp/env_keys

# Extract keys from .env.local (if exists)
grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' .env.local 2>/dev/null | sed 's/=.*//' | sort > /tmp/env_local_keys

# Keys in .env.example but NOT in .env — missing config
comm -23 /tmp/env_example_keys /tmp/env_keys

# Keys in .env but NOT in .env.example — undocumented config
comm -13 /tmp/env_example_keys /tmp/env_keys
```

**Evidence Format:**
```
Key: <ENV_VAR_NAME>
Status: missing-from-env | undocumented | missing-from-env-local
Source: .env.example
```

**Default Severity:** Medium. High if key name contains SECRET, KEY, TOKEN, PASSWORD.

---

### Probe: outdated-dependencies

**Activation:** Package manager detected (`package.json`, `requirements.txt`, `Pipfile`, `Cargo.toml`, `go.mod`).

**Detection Method:**

```bash
# Node.js
npm outdated --json 2>/dev/null
npm audit --json 2>/dev/null

# Python
pip list --outdated --format=json 2>/dev/null
pip-audit --format json 2>/dev/null

# Go
go list -u -m all 2>/dev/null

# Rust
cargo outdated --format json 2>/dev/null
cargo audit --json 2>/dev/null
```

Parse JSON output. Flag:
- Major version bumps (current major != latest major)
- Known CVEs from audit output

**Evidence Format:**
```
Package: <name>
Current: <version>
Latest: <version>
Bump Type: major | minor | patch
CVE: <CVE-ID or NONE>
CVE Severity: <critical|high|medium|low|none>
```

**Default Severity:** Low (outdated minor/patch), Medium (outdated major), Critical (known CVE).

---

### Probe: deployment-health

**Activation:** `health-endpoints` configured in Session Config.

**Detection Method:**

```bash
# For each endpoint in health-endpoints:
curl -s -o /dev/null -w "%{http_code} %{time_total}" <endpoint>

# Flag:
# - Non-200 status codes
# - Response time > 2s
# - Connection timeouts
```

**Evidence Format:**
```
Endpoint: <url>
Status Code: <code>
Response Time: <seconds>s
Healthy: true | false
```

**Default Severity:** High.

---

### Probe: insecure-infra-defaults

**Activation:** always attempted in the `infra` category; self-skips without the private baseline. Discovery-only — never run from session-end Phase 2.4.

**Pattern SSOT:** `scripts/check-insecure-defaults.sh` in the private companion baseline. The baseline is resolved HOST-LOCALLY only — env `SO_BASELINE_PATH` > owner.yaml `paths.baseline-path`; the scanned repo's committed config (`plan-baseline-path`) is never consulted, so a foreign repo cannot choose the script. The probe only RUNS it (`bash <script> --json <repoRoot>`, `execFile`, no shell, cwd = baseline root, `PYTHONSAFEPATH=1` — the SSOT's `python3 -` would otherwise import modules from the scanned repo) and reads its JSON, relativizing each ROOT-joined `file` to the repo; it carries no copy of the patterns. Classes today: `compose-public-port`, `ssh-host-key-disabled`, `caddy-panel-public`. New classes arrive through the SSOT and are passed through unchanged — never add a pattern here.

**Detection Method:**

```bash
# Step 1: Verify the probe exists; skip if missing
# Probes live in the PLUGIN, not the project: ${PLUGIN_ROOT} is resolved per
# skills/_shared/config-reading.md. The probe still scans process.cwd() (project root).
test -f "${PLUGIN_ROOT}/skills/discovery/probes/insecure-infra-defaults.mjs" || { echo "SKIPPED: insecure-infra-defaults -- ${PLUGIN_ROOT}/skills/discovery/probes/insecure-infra-defaults.mjs not found (PLUGIN_ROOT='${PLUGIN_ROOT}'; empty = unresolved, see skills/_shared/config-reading.md)"; exit 0; }

# Step 2: Run the probe. It resolves the baseline, runs the SSOT script with a
# 20 s timeout and maps its exit code (0 clean, 1 findings, 2 skipped).
node --input-type=module -e "
import {runProbe} from '${PLUGIN_ROOT}/skills/discovery/probes/insecure-infra-defaults.mjs';
const cfg = JSON.parse(process.env.SO_CONFIG || '{}');
const r = await runProbe(process.cwd(), cfg);
for (const f of r.findings) {
  console.log('FINDING:', JSON.stringify(f));
}
console.log('METRICS:', JSON.stringify(r.metrics));
if (r.skipped_reason) console.log('SKIPPED:', r.skipped_reason);
"
```

**Output:** one `FINDING:` line per (class, file) — several lines of the same class in one file are grouped (`evidence.lines`, `evidence.count`), with a stable `fingerprint` per class + file. `METRICS.status` is `ok`, `findings`, `skipped` or `degraded`.

**Skip / degrade reasons:** `no-baseline` (no host-local baseline path, or it does not exist — the normal public fallback), `baseline-unavailable` (resolver error, not a directory, or a symlink), `baseline-inside-repo` (baseline path equals or lies inside the scanned repo), `no-ssot-script`, `ssot-script-unsafe`, `ssot-exit-2` (usage/read error, zero checkable files, or `python3` missing), `ssot-exit-other`, `ssot-timeout`, `ssot-spawn-error`, `ssot-output-too-large`; `degraded` with `ssot-unparseable` / `ssot-no-valid-records` when exit 1 yields no usable record — never read as a clean run. The script's stderr is never surfaced.

**Untrusted data:** `text` comes from the scanned repo and is stripped of control/ANSI/bidi characters, collapsed to one line and truncated to 200 chars (`evidence.sample`); records with an absolute path outside the repo root, a `..` path, control characters in `file`, or a non-positive `line` are dropped (`METRICS.dropped_records`).

**Default Severity:** Medium.

---
