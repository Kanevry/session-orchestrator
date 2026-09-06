# Wave 2 + 3 — verification measurements

Every figure below was produced by a command an implementing agent ran in this session, quoted here so a later reader can re-run it instead of trusting a report. Where a post-fix number was NOT measured, the row says so — a missing measurement is recorded as missing, never rounded into a claim (`.claude/rules/host-resources.md` HR-105).

| Subject | Before | After | How measured |
|---|---|---|---|
| Hooks loading without `node_modules` | 23 of 27 (4 crash: `ERR_MODULE_NOT_FOUND` js-yaml via `owner-yaml.mjs`) | **27 of 27** | `hooks/`+`scripts/` copied to a tmp dir without `node_modules`, every hook run with a minimal stdin payload; pinned by `tests/hooks/hooks-run-without-node-modules.test.mjs` |
| `picomatch` declaration | dev-only transitive (absent under `npm ci --omit=dev`) | declared runtime dep | `npm ls picomatch`; lock diff limited to the picomatch subtree |
| Rule files | 61 | **26** (43 generated → 8 merged + 10 dropped) | `ls .claude/rules/*.md \| wc -l` |
| Generated-rule mass | 1,601 lines / 112,443 B | 515 lines / 50,812 B | frontmatter-stripped `countContentBytes` over the generated set |
| Wave rule-injection block | 253,666 B | 195,800 B (−22.8 %) | `node scripts/print-applicable-rules.mjs --wave-scope .claude/wave-scope.json --context wave \| wc -c`, same scope file both times |
| Always-on surface of the 8 merged rules (native Claude Code delivery, which reads `paths:` only) | 0 B at HEAD → **47,630 B after the consolidation** → 0 B after the W3 repair | — | body bytes keyed on presence of `paths:`; the regression and its repair are the reason the `paths:` key was restored |
| Learning-key coverage | 43 keys at HEAD | 33 in rule provenance + 10 stamped `processed_at`/`rejected` in `.orchestrator/runtime/reconcile-candidates.jsonl` = **43** | `jq` over the sidecar; verified by the coordinator after w3-p1 reported an apparent loss |
| `session-start/SKILL.md` | 1,275 lines (1,270 at tag `v3.24.0`) | **388** | `wc -l`; 9 blocks moved byte-identical, sha256 per block |
| `session-end/SKILL.md` | 1,203 | **316** | as above, 7 blocks; plus 209 duplicated lines removed from `plan-verification.md`, some of which contradicted the current rule |
| `wave-loop.md` | 1,337 (1,334 at tag) | **39-line index** + 611 + 570 + 161 | sha256 per block. **The full reconstruction does NOT hash back**: 10 unique non-blank lines differ, all of them cross-reference rewrites the split required (`wave-loop.md § X` → `wave-loop-dispatch.md § X`). `wave-loop-scope-manifest.md` IS byte-identical from line 8; the other two are not. Measured by the session reviewer, 2026-09-06 — the original claim was stronger than its evidence |
| Cursor command wrappers with the GH#54 array-shaped `argument-hint` | 24 of 28 (22 did not parse as YAML at all) | **0** | `rg -l 'argument-hint: \[' .cursor/commands/ \| wc -l` |
| discovery-validator precision (24-row labelled sample) | 0.3158 (6 TP / 13 FP) | **1.00** (6 TP / 0 FP), recall unchanged 1.00 | table-driven test in `tests/hooks/post-subagent-discovery-validator.test.mjs`; the earlier scope-cleaned estimate over a 60-row seeded sample was 0 % |
| discovery-validator duplication | ×16.59 on a 3,360-record replay (the audit's independent figure from another repo: ×16.4) | **×1.00**, `occurrences` retained | replay of the real `claim_text` corpus through the extraction path |
| discovery-validator firings, full 205-claim corpus | 201 | **158** (−21.4 %, 0 new) | same replay |
| vault-staleness false alarms (2026-09-06 data shape) | 33 of 48 overviews stale, 26 of them >7 d, chain healthy | **0** | fixture reproducing that shape in `tests/skills/discovery/` |
| ecosystem-health watcher lifetime | exits code 0 after 48 ms | **alive after 5 s** | spawn probe measuring DURATION, not exit code; pinned by `tests/lib/ecosystem-health-watch.test.mjs` |
| npm tarball portable surface | absent | `AGENTS.md` + `plugin.json` + 43 `.agents/skills/` files, +62,794 B unpacked (+0.571 %) | `npm pack --dry-run --json` |
| `validate-plugin` | 234 passed / 12 failed at session start | **231 passed / 0 failed** | `node scripts/validate-plugin.mjs` |
| Telemetry `fleet` field on this host | `false` (394 of 490 server records misattributed as external) | `fleet_self_declared: true` | `SO_TELEMETRY_DISABLED=1 node scripts/telemetry.mjs show --json` |

## Refusals recorded

Four agents declined part of an instruction and carried a measurement instead. Each is a decision the next session should not re-litigate blindly.

1. **Codex hook wiring** — refused. `codex-cli 0.144.4` embeds ten hook-event schemas; `SessionEnd` is not among them, and the manifest deserializer rejects unknown keys, so adding it risks discarding every working hook. Separately, Codex has no tool named `Bash`/`Edit`/`Write`, so both guards would have matched nothing and allowed everything. Measured by extracting the schemas from the shipped binary.
2. **`status: 'unresolved'` emitter flip** — deferred. Six executable filters key on the literal `abandoned`, none of which errors on an unknown status; flipping first would make every new record silently invisible. The enum value landed so the flip is a one-line follow-up.
3. **Ten "lost" learning provenance markers** — refused to stamp them into the merged files, because none of those files absorbed those learnings and a marker there would be a false provenance claim. Verified afterwards: all ten are stamped in the idempotency sidecar.
4. **Five figures in the changelog brief** — narrowed to their measured form rather than repeated (two lived only in agent reports, one was a rounding error, one compared against HEAD rather than the tag, one described a symlink that is a regular file).
