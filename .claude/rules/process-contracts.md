---
auto-generated: true
consolidated: true
alwaysApply: false
description: "What an exit code, a stdout envelope, and a still-running process actually prove — and the three places this repo read success into each of them."
paths:
  - "scripts/**"
  - "scripts/lib/**"
  - "scripts/lib/validate/**"
  - "tests/docs/**"
  - "tests/lib/**"
  - "hooks/**"
  - "docs/**"
  - "skills/session-end/**"
learning-key: anti-pattern/console-log-process-exit-drops-stdout-above-the-pipe-buffer-on-an-exit-0-protocol-that-means-fail-open
expires-at: 2026-10-27
---

# Process Contracts (consolidated)

**`expires-at` 2026-10-27 = the EARLIEST of the 11 absorbed dates** (merge contract: `docs/rule-authoring.md`).

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### Pipe output needs bounded payloads AND synchronous retrying writes

On macOS pipes, Node stdout is async: beyond the 64 KiB pipe buffer, `process.exit()` discards libuv writes. Under exit 0 + decision JSON, truncation becomes no-decision/ALLOW. Clamp payloads to a worst-case budget AND use `fs.writeSync(1)` with an EAGAIN retry loop; neither alone suffices.

**Evidence** — 2026-07-29 `emitDeny`: `reasonLen 70000` → `stdoutBytes 65536`, `parses=false`, `decision=NONE` (before); `parses=true`, `decision=deny` (after). Reachable via `pre-bash-templates-first` (unbounded Bash command in the reason). Same defect in `check-test-value-bans.mjs --json` piped into `jq` (135576 bytes truncated at ~64 KiB).

### Monitor liveness requires duration

An `unref()`-ed poll timer as the ONLY handle lets a tailer drain on tick one and exit 0 with `tail.started` and empty stderr. Spawn, wait N seconds, assert NOT exited; check every copied primitive too.

**Evidence** — 2026-08-25: `node scripts/lib/convergence-monitor.mjs --tail --interval=1` → `EXIT=0 DURATION_MS=47`, one `tail.started` line, stderr empty. Without `t.unref?.()` under `timeout 6` → `EXIT=124 DURATION_MS=6029` plus a clean `tail.shutdown` on SIGTERM. The `sleep()` was copied from `scripts/lib/wave-transcript-tail.mjs` — explaining #980 (*"convergence-monitor never fires"*).

### Ein Beweis-Event belegt nur die erreichte Stufe

Emit-Position pruefen: `orchestrator.reconcile.completed` kommt VOR AUQ + `writeApprovedRules`, belegt Engine-Lauf/Kandidaten-Merge, keine Regeldatei. Alles ablehnen und fuenf annehmen ergeben denselben Record. Per FELD diskriminieren, nie per Event-Abwesenheit.

**Evidence** — `events.jsonl` 2026-09-11: 4 von 29 Records `dry_run=false`. Fix: `RULES_WRITTEN_EVENT` aus `writeApprovedRules` (`scripts/lib/reconcile/writer.mjs:673`).

### Default-Reparaturen sichern den Rohwert genau einmal

Vor Default-Ersatz eines unlesbaren Felds unter `_<feld>_raw` sichern, mit `if (!(sidecar in out))`. Sonst vernichtet Reparaturlauf zwei den Beweis aus Lauf eins.

**Evidence** — projects-baseline S119 2026-09-10: 7 von 40 reparierten Records verloren `agent_summary`-Strings und `total_files_changed`-Pfadlisten an `{complete:0,...}` bzw. `0`, von Hand restauriert; Vorbild `scripts/lib/session-schema/normalizer.mjs:76-77` (`_express_path_detail`).

### Exit-0 JSON signalling reverses guard failure direction

`exit 2` blocks regardless of stdout; exit 0 with malformed, truncated or absent JSON yields no-decision/ALLOW. Re-verify every crash/throw/short-circuit formerly failing closed. Exit-code allow-assertions no longer discriminate.

**Evidence** — 2026-07-29 #906: three agents found `expect(code).toBe(0)` had become assert-nothing; the panel found a pipe-truncation fail-open, a bridge missing its second block signal, 23 bare exit-0 assertions in one migrated file.

### Parser-Defaults entscheiden vor Prosa-Defaults

Belegt der Parser einen Key IMMER, greift das `??` des Konsumenten nie: Default-Aenderungen am PARSER testen. Ein dem strikten Coercer unbekannter Template-Wert (`auto`) wirft die GANZE Config-Parse, nicht nur diesen Key.

**Evidence** — #1340: Commit `24475154` (2026-07-29) stellte 4 Doku-Dateien auf Default true, `config.mjs` blieb seit 2026-04-19 bei `_coerceBoolean(kv, 'discovery-on-close', false)`. Gemessen 2026-09-13: `parse-config.mjs` ohne Key → false; mit dem vom Template empfohlenen `auto` → Parse error, exit 1.

### Dependent skill steps belong in one verifying CLI

Replace prose “strip labels, then close” with one CLI: strip → close → re-read; non-zero exit on unverified closes. Per-id `closed` must come from platform RE-READ, never the close exit code.

**Evidence** — `glab api projects/:id/issues_statistics?labels=status:in-progress` → all 351 / closed 339 (2026-09-19); `scripts/lib/issue-close-strip-labels.mjs` `closeIssues` + `--close`.

### Klassen-Erklaerungen gehoeren an jede neue Ledger-Senke

Bei einer zweiten Producer-Senke die Klassen-Erklaerung mitfuehren: #939/#949 klaerten Phantom-Stops in `subagents.jsonl` (`subagent_transcript_found`); #1289 diagnostizierte dieselbe Klasse in `events.jsonl` (`transcript_found`) erneut als kaputten Lookup.

**Evidence** — 2026-09-16 @ `ca214376`, `events.jsonl`, 15.457 `orchestrator.agent.stopped`: 5086 `transcript_found:false` vs 553 true; 0 von 5077 distinkten false-`agent_id`s haben einen Sidecar (`find ~/.claude/projects -path '*subagents/agent-*.jsonl'` → 8626 ids) oder einen SubagentStart-Record; Kreuztabelle `transcript_found` × `agent_type` bimodal, off-diagonal 0.

<!-- untrusted-content:end -->

## Provenance

Dropping a pair re-proposes its learning.
- learning-key: `anti-pattern/console-log-process-exit-drops-stdout-above-the-pipe-buffer-on-an-exit-0-protocol-that-means-fail-open`
- learning-id: `6cf829ba-64d1-4942-aa67-2fb106dfa5b0`
- learning-key: `anti-pattern/ein-sofort-mit-0-endender-monitor-sieht-aus-wie-ein-gesunder-nur-die-dauer-trennt-sie`
- learning-id: `e0bf9b8a-968a-4499-afd7-635eb182fe7a`
- learning-key: `anti-pattern/validate-config-cli-exit-code-is-not-a-schema-gate-under-enforcement-warn`
- learning-id: `3b80997d-6d36-41a8-94ad-6fffb898adee`  <!-- markers only (substance: pinned by `tests/docs/setup-config-examples.test.mjs`; call `validateSessionConfig()` in-process) -->
- learning-key: `anti-pattern/ein-leerer-string-als-exit-code-liest-sich-als-erfolg-pipestatus-0-ist-in-zsh-leer`
- learning-id: `ca473588-c567-45bf-adca-f2b28d5b8162`  <!-- markers only (substance: `bash-harness-pitfalls.md` § 6) -->
- learning-key: `anti-pattern/passing-a-probe-target-as-argv1-fires-the-target-modules-own-main-guard`
- learning-id: `b69e7fac-a380-4d6e-a198-d4336e32355f`  <!-- markers only (substance: fixed — `SO_IMPORT_PROBE_TARGET` in `hooks/post-edit-import-probe.mjs`) -->
- learning-key: `anti-pattern/ein-beweis-event-beweist-nur-die-stufe-vor-der-es-emittiert-wird`
- learning-id: `dd156e4d-9203-42d4-9c0d-9ea93db21517`
- learning-key: `anti-pattern/ein-default-overwrite-ohne-roh-sidecar-macht-die-reparatur-selbst-zum-datenverlust`
- learning-id: `2b75c916-644f-4561-b42a-47fa3f3ab4e1`
- learning-key: `proven-pattern/moving-a-guard-from-exit-code-signalling-to-stdout-json-inverts-its-failure-direction-re-verify-every-deny-path-afterwards`
- learning-id: `ed5ad563-dc22-4759-83c3-308afe5e37c8`
- learning-key: `anti-pattern/ein-prosa-default-den-der-parser-immer-ueberschreibt-ist-eine-doku-aenderung-ohne-code-wirkung`
- learning-id: `394088e1-3ec4-48ff-8e3d-8adc52a6cca5`
- learning-key: `anti-pattern/a-prose-only-call-x-before-y-skill-step-gets-skipped-make-it-one-verifying-cli-call`
- learning-id: `2626da55-765d-458a-953e-b1ae44f26586`
- learning-key: `anti-pattern/die-phantom-stop-klasse-wandert-mit-dem-ledger-dieselbe-fehldiagnose-ein-drittes-mal`
- learning-id: `98898feb-d742-424f-987f-0eaf975e5ac6`
- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
