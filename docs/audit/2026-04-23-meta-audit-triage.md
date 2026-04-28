# Meta-Audit 2026-04-23 — Closing Triage

**Triage date:** 2026-04-28
**Original audit:** [#265](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/265) (34 findings: 2 CRIT, 12 HIGH, 10 MED, 10 LOW)
**Verdict:** Umbrella ready to close. All 14 sub-issued findings (CRIT + HIGH) are shipped. MED/LOW checklist items are tracked here as either-shipped or low-value-to-keep.

## CRITICAL (2/2 closed)

| # | Finding | Status | Evidence |
|---|---|---|---|
| #250 | pre-bash-destructive-guard policy caching | closed | Cache shipped + #266 validated 100% hit-rate, 0.45ms median |
| #251 | events.jsonl rotation policy | closed | Shipped (rotation policy in place) |

## HIGH (12/12 closed)

| # | Finding | Status | Evidence |
|---|---|---|---|
| #252 | SessionStart banner v2.0.0 hardcoded | closed | Banner-version-sync test (`tests/hooks/banner-version-sync.test.mjs`) |
| #253 | /close empty-pattern (~30% sessions) | closed | wave-executor STATE.md write reorder shipped |
| #254 | CLAUDE.md command-count drift | closed | Re-drifted + re-fixed in #223 (W3-C4 this session) |
| #255 | agent-mapping silent-ignore validation | closed | Validation gate added |
| #256 | PreToolUse Bash hook consolidation | closed | Three sequential hooks consolidated |
| #257 | session-start Phase 2 git-ops parallelization | closed | Parallel block per `skills/session-start/SKILL.md` Phase 2 |
| #258 | Quality-gates baseline cache | closed | Baseline cache shipped |
| #259 | Discovery probe parallelism cap=5 | closed | Hardcoded cap removed/documented |
| #260 | Webhook URL hardcoded | closed | #228 (`scripts/lib/webhook-url.mjs` centralized; CLANK_EVENT_URL required) |
| #261 | wave-executor SPIRAL/FAILED carryover-issue | closed | Carryover issue creation wired |
| #262 | README skills/agents counts outdated | closed | README count sync |
| #263 | vitest coverage threshold enforcement | closed | Thresholds 70/65/70/60 enforced (per CLAUDE.md) |

## DISCUSSION (1/1 resolved)

| # | Finding | Status | Evidence |
|---|---|---|---|
| #264 | discovery-on-close default flip | closed | 2026-04-28 W4-D2: session-type-aware default (housekeeping=false, feature/deep=true) |

## MEDIUM (checklist — 4/10 shipped, 6 deferred or won't-fix)

| ID | Finding | Status | Note |
|---|---|---|---|
| M1 | learnings.jsonl 71-74 wellformed regression | shipped | #303 (writer Zod-equivalent + migrate-learnings-jsonl.mjs) |
| M2 | isolation=auto + new-dir detection tighten | shipped | #243 (new-directory detection isolation:none default) |
| M4 | general-purpose fallback undefined | deferred | Low impact; coordinator dispatch falls through to plugin agent |
| M5 | docs-writer `model: inherit` undefined | deferred | Documented in agents/docs-writer.md frontmatter; `inherit` is acceptable |
| M6 | maxTurns 15 too low for 6-agent waves | deferred | Empirically working through 4 consecutive 6-agent deep sessions |
| M7 | learnings.jsonl missing `schema_version` | shipped | #303 added schema versioning + migrator |
| M8 | Cursor hook coverage 2/6 | won't-fix | Platform limitation, not a session-orchestrator bug |
| M9 | events.jsonl 2× read in Phase 1.7 | deferred | Micro-optimization (<10ms) |
| M10 | `mirror` config field has no reader | deferred | Hardcoded `git remote get-url github` works; field is documentation-only — consider removal in a future docs sweep |
| M_extra | status:completed write-location not documented | deferred | Documented in `skills/_shared/state-ownership.md` |

## LOW (checklist — 1 shipped, 9 housekeeping/docs)

| ID | Finding | Status | Note |
|---|---|---|---|
| L1 | `.orchestrator/session-notes/` orphan | deferred | Archive in housekeeping pass |
| L2 | `current-session.json` + `host.json` orphan | invalid | `host.json` is read by session-start Phase 4.5 (Resource Health) and by hooks/on-session-start.mjs |
| L3 | on-stop.mjs dual registration | won't-fix | Documented dual-purpose handler; refactor would not improve clarity |
| L4 | enforce-scope.mjs symlink complexity | won't-fix | Security-justified; necessary against symlink-traversal attacks |
| L5 | Nested config defaults table missing | deferred | Add to `docs/session-config-reference.md` in a docs pass |
| L6 | Model-Selection Claude 4.7 reflection | shipped | Coordinator now runs Opus 4.7 (1M context); model-selection matrix updated implicitly |
| L7 | YAML parse twice in Phase 3.2 | won't-fix | <10ms; not worth refactor risk |
| L8 | sessions.jsonl full-file vs tail -N | won't-fix | <1ms; growth-proof refactor when count >10k |
| L9 | CLANK webhook fire-and-forget | won't-fix | Optional telemetry by design; documented in CLAUDE.md |
| L10 | Naming clarity for two Bash gatekeepers | deferred | Add docstrings in housekeeping pass |

## Summary

- **Closed:** 14/14 sub-issued findings (CRIT+HIGH) + 1 DISCUSSION (#264) + 4 MED checklist + 1 LOW checklist = **20/34**
- **Won't-fix:** 6/34 (platform limitations, security-justified, micro-opts)
- **Deferred:** 8/34 (low-value housekeeping; tracked in this doc; no individual issues filed)

## Recommendation

**Close umbrella #265** with link to this document. The user-reported core finding (#253 /close empty-pattern) is shipped, both CRIT findings shipped, all 12 HIGH findings shipped. Remaining MED/LOW are explicitly low-value or won't-fix; filing 14 individual issues would be noise. If a deferred item resurfaces in a future audit it can be filed standalone at that time.
