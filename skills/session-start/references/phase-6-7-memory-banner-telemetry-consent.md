# Phase 6.7 + 6.8: Memory Banner and Telemetry Consent

> Sub-file of the session-start skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-start/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 6.7: Memory Banner (#505)

> Skip this phase silently when `persistence: false` OR `memory.banner.enabled: false` in Session Config (default: enabled). Silent no-op pattern mirrors Phase 6.5 / Phase 7.5.

Render a compact, operator-visible banner summarizing what session-start loaded from persistent memory. The banner anchors operator confidence (cf. doobidoo/mcp-memory-service v8.5.7's SessionStart Hook for the precedent UX) and signals to fresh-cohort operators that the system is learning.

```javascript
import { renderMemoryBanner } from '${PLUGIN_ROOT}/scripts/lib/memory-banner.mjs';

const bannerText = await renderMemoryBanner({
  repoRoot: process.cwd(),
  config: $CONFIG,
});
if (bannerText) {
  console.log(bannerText);   // print to user-facing stdout
}
```

### Behaviour summary

- **Persistence off** (`persistence: false`) → silent no-op.
- **Banner disabled** (`memory.banner.enabled: false`) → silent no-op.
- **Fresh repo** (0 learnings + 0 sessions) → single line: `📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.`
- **Populated**: header `📚 Loaded from memory` + top-5 surfaced learnings (subject + confidence + type) + memory-stats line (`N memory files · M sessions ever · last cleanup K days ago`) + (when present) one excerpt line each from `USER.md` + `AGENT.md` peer cards (first non-empty section header + first content line).

### Implementation notes

- All inputs are derived through `readBannerInputs()` in `scripts/lib/memory-banner.mjs`; the skill never reads JSONL directly — keeps the banner authoritative for output format.
- Memory-file count = `*.md` files under the memory directory (resolved by `resolveMemoryDir()` from `scripts/lib/memory-paths.mjs`, extracted from `auto-dream.mjs` in #512). Sessions count = lines in `.orchestrator/metrics/sessions.jsonl`. `daysSinceCleanup` = floor((now - lastCleanupAt) / 86400000); `null` when never cleaned.
- Banner truncates subject and excerpt strings at ~80 visible chars (with `…`).
- The banner NEVER exposes raw JSON; all values are pre-cleaned scalars.

Cross-reference: PRD F2.3 acceptance criteria (#505); `scripts/lib/memory-banner.mjs` API (`renderMemoryBanner`, `readBannerInputs`; test-only exports `_formatBanner`, `_extractCardExcerpt` carry the `_`-prefix per #542 convention).

## Phase 6.8: Telemetry Consent (one-time, #845)

> Skip this phase silently when `persistence: false` in Session Config. Also skip silently when non-interactive (headless / CI — no TTY to prompt on), and when the consent decision has already been made (stored `granted`/`denied`, an env override, or the fleet flag). In all of these `resolveConsent().prompt` is `false` and the phase is a no-op — it must NEVER print anything or slow session-start in the common (already-decided / headless) case.

> **The trigger is MECHANICAL since #1138.** `hooks/on-session-start.mjs` calls `resolveConsent()` itself and, when `prompt === true` and the run is not CI, injects a one-line instruction into the session via `hookSpecificOutput.additionalContext`. This phase is the WORDING and the fallback — the AUQ text below is the single source of truth for what gets asked — but it is no longer what decides *whether* to ask. Two consequences: (a) the coordinator may receive that instruction before it ever reaches this line, and should act on it then; (b) the hook gates on `isCiEnv()`, **not** `!isHeadless()` as the snippet below does — measured 2026-08-23, `isHeadless()` returns `true` in ANY non-TTY subprocess (`isHeadless()=true isCiEnv()=false stdout.isTTY=undefined`), which includes both a hook process and the `node -e` a coordinator would run this snippet in. Executed verbatim in a Bash tool call, the snippet below therefore resolves `prompt: false` every time; keep it as the semantic reference, and trust the hook for the firing decision.

Anonymous usage telemetry is **strictly opt-in** and, on a host that has never decided, is offered exactly once via a single interactive AskUserQuestion. The consent machine lives in `scripts/lib/telemetry/consent.mjs`; this phase only decides *whether* to prompt and then records the operator's answer. The `resolveConsent()` precedence machine is fail-closed — `prompt` is `true` only for a fresh, interactive, not-yet-decided, not-fleet, not-env-overridden host.

```javascript
import { readTelemetryState, resolveConsent, isHeadless, grantConsent, denyConsent } from '${PLUGIN_ROOT}/scripts/lib/telemetry/consent.mjs';
import { loadOwnerConfig } from '${PLUGIN_ROOT}/scripts/lib/owner-yaml.mjs';

const c = resolveConsent({
  env: process.env,
  ownerConfig: loadOwnerConfig().config,       // fleet flag lives at .telemetry.enabled (host-local owner.yaml, never committed)
  state: readTelemetryState().record,          // persisted per-user decision (~/.config/session-orchestrator/telemetry.json)
  interactive: !isHeadless(),                  // fail-closed toward headless — anything but a confirmed TTY counts as headless
});
if (!c.prompt) {
  // silent no-op — already decided, env-override, fleet-enabled, or headless. Do NOT print, do NOT prompt.
}
```

**When `c.prompt === true`**, the coordinator renders EXACTLY ONE `AskUserQuestion` (per `.claude/rules/ask-via-tool.md` AUQ-003 — the tool, never inline prose):

```js
AskUserQuestion({
  questions: [{
    question: "Anonyme Usage-Telemetrie aktivieren? Strikt opt-in, jederzeit abschaltbar; was genau gesendet wird: docs/telemetry.md",
    header: "Telemetrie",
    multiSelect: false,
    options: [
      { label: "Ja, aktivieren", description: "Sendet anonyme Zähl- und Strukturdaten (welche Phase lief, Erfolg oder Abbruch), whitelist-projiziert: keine Pfade, keine Prompts, keine Repo-Namen." },
      { label: "Nein", description: "Sendet nichts; die Frage kommt hier nicht wieder. Einschalten geht später mit `node scripts/telemetry.mjs` (das ist der Befehl dafür)." },
    ],
  }],
});
```

> **Consent-Neutralität (deliberate AUQ-003 deviation):** this is the ONE AskUserQuestion in the session flow that carries **no `(Recommended)` label on either option** — neither "Ja" nor "Nein" is tagged. AUQ-003's "option 1 is always the recommendation" convention is intentionally NOT applied here, so the operator's consent is unbiased. Do not add a recommendation to either option.

- **Codex CLI / Cursor IDE fallback (numbered Markdown list — AUQ-004 exception 1):**
  ```
  Anonyme Usage-Telemetrie aktivieren? Strikt opt-in, jederzeit abschaltbar; was genau gesendet wird: docs/telemetry.md
  1. Ja, aktivieren — sendet anonyme Zähl- und Strukturdaten (welche Phase lief, Erfolg oder Abbruch), whitelist-projiziert: keine Pfade, keine Prompts, keine Repo-Namen.
  2. Nein — sendet nichts; die Frage kommt hier nicht wieder. Einschalten geht später mit `node scripts/telemetry.mjs` (das ist der Befehl dafür).
  Reply with the number of your choice. (No option is pre-recommended — the choice is yours.)
  ```

On the operator's answer:
- **"Ja, aktivieren"** → call `grantConsent()`. Then add a single confirmation line to the Session Overview: `Telemetry: enabled — ändern via node scripts/telemetry.mjs`.
- **"Nein"** → call `denyConsent()`. Then add: `Telemetry: disabled — ändern via node scripts/telemetry.mjs`.

Both helpers atomically persist the decision (read-modify-write, `anon_id` fields preserved) to `~/.config/session-orchestrator/telemetry.json`.

### Fleet mode (host-local, no prompt)

Setting `telemetry:\n  enabled: true` in the host-local `~/.config/session-orchestrator/owner.yaml` (never committed — same host-local-data contract as `.claude/rules/owner-persona.md`) enables telemetry across every repo on the host WITHOUT ever prompting: `resolveConsent()` then returns `prompt: false` with state `enabled-fleet`, so this phase is a silent no-op. The per-shell escape hatches `SO_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK` outrank the fleet flag for a single shell. See `docs/telemetry.md` for the full precedence table (PRD FA5).

### One-time guarantee

The decision persists host-locally in `~/.config/session-orchestrator/telemetry.json`; once `consent` is non-`null` (granted or denied), `resolveConsent().prompt` stays `false` and this phase never fires again on that host — no repeat prompting across repos or sessions.

Cross-reference: GitLab #845 (Epic #841); `docs/prd/2026-07-20-anonymous-usage-telemetry.md` §3 FA1/FA5; `docs/telemetry.md`; consent API in `scripts/lib/telemetry/consent.mjs` (`resolveConsent`, `grantConsent`, `denyConsent`, `isHeadless`, `readTelemetryState`).

