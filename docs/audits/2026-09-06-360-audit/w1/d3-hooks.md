# d3 — Hooks-Audit — 2026-09-06 @ e4674109
## Summary
- One Bash tool call costs 479 ms hook CPU over 9 node processes (7× PreToolUse 371 ms + 2× PostToolUse 108 ms); 333 ms (70 %) is node boot (baseline `node -e ''` 37 ms). Edit/Write: 317 ms / 6 processes. Only on-session-start does real work (385 ms). Bash guards 50–64 ms each = 13–27 ms of actual work.
- Bare-dep hooks: 4 (on-session-start, on-session-end, post-edit-validate, skill-invocation-telemetry) crash rc=1 without node_modules — ONLY because of js-yaml in scripts/lib/owner-yaml.mjs. zx is NOT a crash cause at HEAD (empirically: js-yaml stub → all 4 rc=0; zx imports are lazy + caught). #1230's zx half is stale.
- hooks/_lib/hook-import-set.json is a 150-module reachability manifest (in sync, CI job hook-import-set-check + validate-plugin), NOT a 2-entry allowlist; no vitest for the no-node_modules run.
- 7 of 24 emitted event names have zero consumers: wave.started (36 records), memory.propose_invoked (11), destructive_guard.warned, config.protection_warning, frontend_slop.warning, hook.import_probe_failed, wave.final_refused.
- agent.stopped: 85 % without `agent` even after #1190 (2026-09-04: 104 NULL vs 18 SET); volume driver glab-navigator 2535/3762. session.stopped:session.started = 0.25×–6.5× per repo → counts Stop-hook firings, not sessions. discovery_validator_violation: 388/410 from one repo (glab-navigator), likely pre-#1191; but THIS repo has discovery-validator.enabled: true while reference default is OFF after #1191 revert.
- Merge candidate: 6 non-blocking PreToolUse:Bash guards into one chain (keep pre-bash-destructive-guard — the only process.exit(2) — isolated): saves ~197–222 ms CPU per Bash call (46 %). Risks: fail-closed semantics (one throw kills all → per-guard try/catch, WARN+ALLOW), ordering, single stdout JSON object merge.
- Harness parity: check-hooks-symmetry 12 passed; hooks.json 26, cursor 20, pi 14, codex 3 (on-session-start, loop-guard, on-stop; PreToolUse: [] → NO destructive guard on Codex). Claude-only: pre-task-scope-disjoint (Agent matcher), pre-auq-clarity, post-tool-batch-wave-signal, operator-steer, cwd-change-restore. wave-scope-commit-guard.mjs Husky-only (.husky/pre-commit:174) confirmed. structure.md hook table matches.
- heavy-repo: parse-config printed false for d3 (coordinator saw true at session start — discrepancy to resolve); scripts/lib/config.mjs:219 coerces default false. Latent defect real: resolveApwCap resolves {default:6,deep:18} → 6, documented as deliberate (wave-resource-gate.mjs:214-234).
- Side finding: pre-bash-destructive-guard blocked a heredoc `> CLAUDE.md` inside a mktemp dir (rule redirect-truncate-protected #983 matches basename, not repo-relative path) → FP source for bench/fixture work.
## Recommendations
R1 js-yaml out of eager hook import graph (leaf module for resolveOwnerYamlPath per #1223 private-config-dir pattern; loadOwnerConfig via await import in try/catch) — S — acceptance: tmp copy without node_modules → rc=0 for all 27 hooks; generate-hook-import-set --check in sync.
R2 vitest case running every hooks/*.mjs without node_modules — S.
R3 merge 6 non-blocking Bash guards into one chain, destructive-guard isolated — M — PreToolUse:Bash sum ≤ 130 ms; existing tests green; synthetic throw in one guard does not block the others (new test).
R4 decide the 7 consumer-less events: build consumer or remove emission — S.
R5 discovery-validator.enabled → false in this repo (reference default OFF) — S.
R6 agent.stopped: 85 % empty agent → drop field or document harness gap — M.
R7 session.stopped semantics: rename or document as turn marker — M.
R8 measure run-node.sh sh-exec overhead per hook — S.
## Open questions
1 parallel vs serial handler execution in Claude Code (decides wall-clock impact). 2 run-node.sh cost. 3 are the 388 glab-navigator validator records pre- or post-#1191 (old plugin version?). 4 wave.started without consumer vs wave.completed with — unintended asymmetry? 5 Codex has no destructive guard at all — deliberate?
STATUS: done
