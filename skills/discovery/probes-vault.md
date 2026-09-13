> See probes-intro.md for confidence scoring reference.

## Category: `vault`

### Probe: vault-staleness

**Activation:** `.vault.yaml` present in repo root OR Session Config `vault-integration.enabled: true`.

**Detection Method:**

```bash
# Step 1: Verify the probe exists; skip if missing
# Probes live in the PLUGIN, not the project: ${PLUGIN_ROOT} is resolved per
# skills/_shared/config-reading.md. The probe still scans process.cwd() (project root).
test -f "${PLUGIN_ROOT}/skills/discovery/probes/vault-staleness.mjs" || { echo "SKIPPED: vault-staleness -- ${PLUGIN_ROOT}/skills/discovery/probes/vault-staleness.mjs not found (PLUGIN_ROOT='${PLUGIN_ROOT}'; empty = unresolved, see skills/_shared/config-reading.md)"; exit 0; }

# Step 2: Run the probe. It reads vault-integration.vault-dir from $CONFIG
# (passed from the discovery skill) and scans the vault.
node --input-type=module -e "
import {runProbe} from '${PLUGIN_ROOT}/skills/discovery/probes/vault-staleness.mjs';
const cfg = JSON.parse(process.env.SO_CONFIG || '{}');
const r = await runProbe(process.cwd(), cfg);
for (const f of r.findings) {
  console.log('FINDING:', JSON.stringify(f));
}
console.log('METRICS:', JSON.stringify(r.metrics));
if (r.skipped_reason) console.log('SKIPPED:', r.skipped_reason);
"
```

**Output:** one `FINDING:` line per finding, one `METRICS:` line per run. Summary JSONL record appended to `.orchestrator/metrics/vault-staleness.jsonl`.

**Default severity:** low (<7d delta), medium (≥7d delta). Missing frontmatter fields → low.

**Denominator:** staleness is `lastCommit - lastSync` — both read from the same `_overview.md` frontmatter — never `now - lastSync`. An overview without `lastCommit` falls back to the probe runtime (`basis: 'probe-runtime'` in the evidence, lower confidence).

**Passive skip (#1238):** a `01-projects/<slug>/` carrying a `_passive.md` marker is skipped BEFORE any staleness comparison — it is excluded from `scanned_projects` and counted instead in `metrics.passive_skipped` — the SAME key in the in-memory metrics and in the JSONL record — so the skip is visible rather than indistinguishable from a healthy project. The marker is checked before the `_overview.md` existence test, so a passive folder without an overview is counted too rather than falling into the silent non-project branch.

---

### Probe: vault-narrative-staleness

**Activation:** same as vault-staleness.

**Detection Method:**

```bash
# Probes live in the PLUGIN, not the project: ${PLUGIN_ROOT} is resolved per
# skills/_shared/config-reading.md. The probe still scans process.cwd() (project root).
test -f "${PLUGIN_ROOT}/skills/discovery/probes/vault-narrative-staleness.mjs" || { echo "SKIPPED: vault-narrative-staleness -- ${PLUGIN_ROOT}/skills/discovery/probes/vault-narrative-staleness.mjs not found (PLUGIN_ROOT='${PLUGIN_ROOT}'; empty = unresolved, see skills/_shared/config-reading.md)"; exit 0; }

node --input-type=module -e "
import {runProbe} from '${PLUGIN_ROOT}/skills/discovery/probes/vault-narrative-staleness.mjs';
const cfg = JSON.parse(process.env.SO_CONFIG || '{}');
const r = await runProbe(process.cwd(), cfg);
for (const f of r.findings) {
  console.log('FINDING:', JSON.stringify(f));
}
console.log('METRICS:', JSON.stringify(r.metrics));
if (r.skipped_reason) console.log('SKIPPED:', r.skipped_reason);
"
```

**Output:** same shape as vault-staleness. JSONL appended to `.orchestrator/metrics/vault-narrative-staleness.jsonl`.

**Default severity:** low (within 2× tier threshold), medium (within 3×), high (beyond 3×). Missing `updated` field → low.

**Tier thresholds (days):** top=30, active=60, archived=180. Tier sourced from `_overview.md` frontmatter; defaults to `active` if missing.

---

**Session-end integration:** When `vault-staleness.enabled: true` in Session Config, these same probes are also invoked at session-end Phase 2.3 — see `skills/session-end/SKILL.md` for the gating logic and strict-mode override behavior. The `/discovery vault` invocation here is the on-demand discovery path; Phase 2.3 is the close-time gate.
