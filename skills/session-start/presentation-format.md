# Presentation Format

> Output templates for Phase 7 of the session-start skill.

## Session Overview Template

```
## Session Overview
- Type: [housekeeping|feature|deep]
- Repo: [name] on branch [branch]
- Git: [X uncommitted, Y unpushed, Z open branches]
- VCS: [N open issues (H high, M medium), K open MRs/PRs]
- Health: [TypeScript: 0 errors | Tests: passing/failing | CI: green/red]
- SSOT: [fresh/stale files listed]
- Cross-repos: [status summary]
- Plugin: [fresh / ⚠ N days without update]
- Metrics: [N previous sessions tracked | no history yet]

## Session Config (active)
- Waves: [N] | Agents/wave: [M] | Isolation: [worktree|none|auto]
- Enforcement: [strict|warn|off] | Max turns: [N|auto]
- Persistence: [true|false] | Agent mapping: [configured roles|auto-discovery]

## What Not To Retry
> FORCED-READ slot (#623). Render ONLY when STATE.md `## What Not To Retry` is non-empty (session-start Phase 6.5.1). Always shown when present — never gated behind a question. Wrapped in the HISTORICAL guard banner so the coordinator verifies before treating entries as live. Omit the entire slot when the section is empty.

⚠ HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS. …
⛔ Do NOT re-attempt the following — prior sessions failed/abandoned these:
- [approach] ([session_id], [date]) — why: [why_failed]
— END HISTORICAL REFERENCE —

## Recommended Focus
Based on priority, synergies, and session type, I recommend:

**Option A (recommended):** [issues + rationale]
**Option B:** [alternative focus]
**Option C:** [if applicable]

[Pros/cons for each, clear recommendation with WHY]

## Historical Trends (last 5 sessions)
> Only show if 2+ sessions exist in `.orchestrator/metrics/sessions.jsonl`. Otherwise: "Not enough history for trends (need 2+)."
> Read the last 5 lines from `sessions.jsonl`, parse each as JSON, and display most recent first (by `completed_at` timestamp). If fewer than 5 sessions exist, show all available.

| Session | Type | Duration | Waves | Agents | Files Changed |
|---------|------|----------|-------|--------|---------------|
| <date>  | <type> | Xm     | N     | M      | K             |

## Housekeeping Items (if any)
- [ ] Branches to merge: [list]
- [ ] SSOT files to refresh: [list]
- [ ] Issues to triage/close: [list]

## Questions
[Use AskUserQuestion on Claude Code, numbered Markdown options on Codex/Cursor]
```

## AskUserQuestion Usage

**MANDATORY:** Present structured options to the user.
- Claude Code: use the AskUserQuestion tool.
- Codex CLI / Cursor IDE: use a numbered Markdown list and ask the user to reply with the choice number.

Example:
```
AskUserQuestion({
  questions: [{
    question: "Welchen Fokus soll diese Session haben?",
    header: "Focus",
    options: [
      { label: "Issues #91 + #92 (Recommended)", description: "Weil beide einen Export-Pfad teilen, braucht es einen Umbau. Dient: Fehler schnell finden; beobachtbar durch Traces." },
      { label: "Infra-Aufräumen #44 + #60", description: "Zwei halb fertige Issues, kleiner Aufwand. Dient: leeres Board; beobachtbar durch null Issues in Arbeit." },
      { label: "Kern-Refactor #37", description: "Hohe Priorität, braucht eine eigene Session. Dient: kein benanntes Outcome." }
    ]
  }]
})
```

### Outcome in the Focus options (#1824)

Every Focus option names the outcome it serves — the goal behind the session's tasks — so the operator decides on the outcome together with the scope, in the one question that is asked anyway. There is no second question for it (AUQ-001.2: never ask what you can read).

- **Description suffix.** Each option description ends with `Dient: <Outcome>; beobachtbar durch <Messweg>` (operator language `en`: `Serves: <outcome>; observable via <check>`). The language follows `owner.language` in `~/.config/session-orchestrator/owner.yaml`, else the language the operator writes in. When nothing can be derived, the suffix is `Dient: kein benanntes Outcome.` (`Serves: no named outcome.`).
- **Derivation order, first hit wins:** (1) the text of the option's issues (`source: issue`), (2) the Success Metrics section of the repo's MVP scope file `MVP.md` (`source: mvp`), (3) the repo's vault `context.md` when `vault-integration.enabled` (`source: vault`). An outcome the operator names in his answer instead overrides all three (`source: operator`). The `<Messweg>` is a check someone can run or read — a command, a metric, a page — never "it works".
- **Carry the chosen option's outcome into Phase 9** (`skills/session-start/SKILL.md`): `{ statement, observable, source }`, or nothing when the chosen option has no named outcome. The wave-executor writes it into STATE.md at Pre-Wave 1b via `setOutcome` (`scripts/lib/state-md.mjs`).
- **Own question only as a last resort:** when no option has a derivable outcome AND the session is interactive (Claude Code with the AskUserQuestion tool, not headless, not lead-guided), one extra question may ask for it (AUQ-001.3). Headless, lead-guided and Codex/Cursor sessions never block on it: take the derived outcome, or record none.

Always include your recommendation as the first option with "(Recommended)" in the label.

> **Codex CLI fallback:** If the AskUserQuestion tool is not available (e.g., on Codex CLI), present the same options as a numbered Markdown list and ask the user to respond with their choice number. Include "(Recommended)" on the first option.
