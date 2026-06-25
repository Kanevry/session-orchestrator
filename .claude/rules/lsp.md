---
tier: coordinator-only
---

# Language-Server / LSP Posture (Always-on)

## Why this file exists

The harness-audit Large-Codebase rubric (`scripts/lib/harness-audit/categories/category8.mjs`, check `lsp-configured`) expects a repo to either declare a language-server / LSP MCP server in `.mcp.json` **or** document its language-tooling posture. This repo declares **no** LSP MCP server by deliberate choice. This file records that decision and the navigation posture that replaces it, so the absence reads as intentional rather than as an oversight.

## The decision: no LSP MCP server

Plain Node ESM (`*.mjs`) + Markdown — no TypeScript compiler step, no type-graph for a language server to resolve. An LSP MCP server would add non-trivial token + process cost for navigation that ripgrep + the steering map already deliver. Revisit only if the repo gains a genuine typed-compilation graph (e.g., a TypeScript migration of `scripts/`); wire it into `.mcp.json` `mcpServers` and the `lsp-configured` check earns full credit automatically.

## Navigation posture (what to use instead)

- **Codebase map first.** `.orchestrator/steering/structure.md` is the hand-maintained module map (injected at session-start Phase 2.6). Read it before fanning out — it orients you faster than blind search.
- **ripgrep / Grep for symbol lookup.** Definitions and call-sites are found with `rg "export function <name>"` / `rg "<name>\("`. Because every module is `.mjs` with explicit `export`/`import`, grep is a reliable proxy for "find references."
- **Layered instruction files** (`agents/AGENTS.md`, `.claude/rules/*.md`) carry the local conventions an LSP would not surface anyway.
- **PSA-006 still applies.** Any distributional claim about call-sites ("all N callers do X", "no remaining references to Y") MUST quote an executed `grep`/`rg` transcript — grep is the verification tool here precisely *because* there is no LSP to lean on. See `parallel-sessions.md` § PSA-006.

## See Also
development.md · cli-design.md · parallel-sessions.md · testing.md
