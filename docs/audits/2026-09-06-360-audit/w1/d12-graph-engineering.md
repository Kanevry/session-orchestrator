# d12 — Graph-Engineering-Praxis — 2026-09-06 @ e4674109
## Summary
- 8 practices: 1 have (SCIP/LSP deliberate non-adoption), 5 partial, 2 missing (CodeQL — correctly missing; GraphRAG).
- KEY FIND: scripts/generate-hook-import-set.mjs is already a generic BFS import crawler (buildImportSet/extractRelativeSpecifiers/resolveSpecifier) with SHA-stamped artefact + `--check` drift gate in validate-plugin.mjs:231 — seeded only on hook entries: 150 of 498 .mjs in scripts/+hooks/ (30.1 %). A second seed set = repo import graph, effort S, no new dep.
- DEFECT: skills/discovery/probes-arch.md:13,20 and skills/architecture/SKILL.md:48 call `extractSemanticSlices(filePath, { type: 'imports' })` — signature doesn't exist (2nd param is content string → TypeError) and 'imports' is not a slice kind (SLICE_KINDS = function|class|interface|type|export|section; 0 ImportDeclaration hits in language-mappers). Cycle-detection probe + architecture pre-pass are dead. check-skill-script-paths checks paths, not signatures — this class passes every gate.
- vitest --changed/related: 0 references in repo; 651 test files run in full at every inter-wave checkpoint.
- Trace graph: events.jsonl correlation 54/139 (38.8 %) session_id, 6/139 (4.3 %) wave → graph is 96 % edgeless on the wave axis.
- Learnings ranking is path-affinity + text only (affinity.mjs pure); no import-graph proximity: a learning about scripts/lib/events.mjs never reaches an agent scoped to hooks/on-session-start.mjs although the hook imports it.
- Vault: 1,936 notes, 548 (28.3 %) without any outgoing wikilink; 40-learnings 1,295 notes, 174 (13.4 %) without; no ingoing-link counter → no true orphan metric, no hub centrality; MOC staleness measured, link density not.
- Wave dependency ordering exists only as prose (session-plan/SKILL.md:123,355,550,559); no machine-readable task-dependency artefact. subagents.jsonl already OTel-GenAI-named (gen_ai.usage.*) but no span hierarchy.
## Adoptable (ranked)
A1 Repo import graph from the existing crawler: `--entries <glob>` flag + artefact .orchestrator/steering/import-graph.json (same schema); acceptance: `--check` exit 0 on clean tree; coverage 150/498 → ≥470/498; structure.md inventory counts checked against artefact instead of hand-measured. Effort S. Ceiling: static specifiers only (BV-004).
A2 Import proximity as third axis in print-learnings-index.mjs: caller expands $AGENT_FILESCOPE_JSON ∪ distance-1 neighbours from A1 (lower weight); affinity.mjs untouched. Effort S–M; exclude hubs (reachable_from.length > N), distance 1 only.
A3 `vitest --run --changed <last-green-sha>` for the inter-wave Incremental gate (Variant 2) only; Full Gate unchanged; tests only, never lint/typecheck (quality-gates/SKILL.md:46/48 lesson). Effort S. Mandatory counter-check: selection ⊇ full-run affected set.
A4 Vault link density + true orphan metric in scripts/lib/vault-status/ (respect SO_VAULT_DIR, read-only); baseline 548/1936, 174/1295. Effort S; diagnostic only (HR-101).
A5 Session/wave/agent trace graph — CONDITIONAL: raise wave correlation to ≥80 % first (sessionAttribution witness condition, docs/events-schema.md), then Mermaid renderer. Effort M. Defer.
Defect fix: reroute the 3 extractSemanticSlices call sites to A1 or remove — follow-up class (RCR-007).
## Not to adopt
Graph DB (Neo4j) — corpus 1,936 notes/1,300 learnings, in-memory adjacency suffices (BV-001.5, "two registries"). SCIP/LSIF/LSP — lsp.md decided, harness-audit cat 8 credits it. GraphRAG — paper benefit bound to global sensemaking on ~1M-token corpora; our question is local path-bound retrieval.
## Sources (2026-09-06): aider.chat/docs/repomap.html; aider.chat/2023/10/22/repomap.html; arxiv 2404.16130 (GraphRAG); arxiv 1810.05286 (Predictive Test Selection, 2× cost reduction, >95 % failures caught); arxiv 2410.14684 (RepoGraph); vitest.dev/guide/cli.html; open-telemetry/semantic-conventions-genai gen-ai-agent-spans.md (Development status); anthropic.com/engineering/multi-agent-research-system (+90.2 %, ~15× tokens); docs.github.com CodeQL; tree-sitter.github.io; obsidian.md/help/plugins/graph; sourcegraph/scip (docs 403).
## Open questions
1 is structure.md § Inventory injected (Phase 2.6) or only drift-checked? 2 why is wave correlation 4.3 % — design (fail-closed witness) or defect? 3 full-run duration for A3 (coordinator: 63.5 s, 16,261 tests). 4 extractSemanticSlices call sites: this session or follow-up?
STATUS: done
