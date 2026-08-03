---
tier: coordinator-only
review-date: 2026-10-23
---

# Language-Server / LSP Posture (Always-on)

This repo declares **no** LSP MCP server by deliberate choice: plain Node ESM (`*.mjs`) + Markdown has no type-graph for a language server to resolve, and ripgrep + `.orchestrator/steering/structure.md` already deliver navigation at lower token/process cost. The harness-audit `lsp-configured` check (`scripts/lib/harness-audit/categories/category8.mjs`) accepts this documented posture in lieu of a `.mcp.json` server, so this file's existence is the mechanical credit — revisit only if `scripts/` gains a typed-compilation graph (then wire an LSP server into `.mcp.json` `mcpServers` and the check earns full credit automatically).

Navigation posture: read the codebase map (`.orchestrator/steering/structure.md`, injected at session-start Phase 2.6) first, then `rg "export function <name>"` / `rg "<name>\("` for symbol lookup — grep is a reliable "find references" proxy because every module is `.mjs` with explicit `export`/`import`. Any distributional call-site claim ("all N callers do X", "no remaining references to Y") still needs a quoted `grep`/`rg` transcript — see `parallel-sessions.md` § PSA-006.

## See Also
development.md · cli-design.md · parallel-sessions.md · testing.md
