---
tier: coordinator-only
review-date: 2026-10-23
---

# Language-Server / LSP Posture (Always-on)

Deliberately no LSP MCP: Node ESM `*.mjs` + Markdown lacks a type-graph; read `.orchestrator/steering/structure.md` (session-start Phase 2.6), then `rg "export function <name>"` / `rg "<name>\\("`; explicit imports/exports make rg a references proxy at lower token/process cost. Distributional callsite claims still require quoted rg/grep transcripts (`parallel-sessions.md` § PSA-006). `scripts/lib/harness-audit/categories/category8.mjs` (`lsp-configured`) credits this file's existence instead of a server; revisit only if `scripts/` gains a typed-compilation graph, then wire `.mcp.json` `mcpServers` for full credit.

## See Also
development.md · cli-design.md · parallel-sessions.md · testing.md
