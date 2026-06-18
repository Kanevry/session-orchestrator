# Language-Server / LSP Posture (Always-on)

## Why this file exists

The harness-audit Large-Codebase rubric (`scripts/lib/harness-audit/categories/category8.mjs`, check `lsp-configured`) expects a repo to either declare a language-server / LSP MCP server in `.mcp.json` **or** document its language-tooling posture. This repo declares **no** LSP MCP server by deliberate choice. This file records that decision and the navigation posture that replaces it, so the absence reads as intentional rather than as an oversight.

## The decision: no LSP MCP server

This codebase is **plain Node ESM (`*.mjs`) + Markdown** — there is no TypeScript compiler step, no transpile target, and no type-graph that a language server would resolve. The runtime is Node 20+ with vitest; `npm run typecheck` is a thin `scripts/typecheck.mjs` wrapper, not a `tsc`/`tsgo` project graph. An LSP MCP server (serena, typescript-language-server, pyright, etc.) would index a type system this repo does not have, at non-trivial token + process cost, for navigation that ripgrep + the steering map already deliver.

Consequence: agents do **not** get LSP-grade "go to definition / find references" via an MCP server here. The substitutes below are the supported navigation path.

## Navigation posture (what to use instead)

- **Codebase map first.** `.orchestrator/steering/structure.md` is the hand-maintained module map (injected at session-start Phase 2.6). Read it before fanning out — it orients you faster than blind search.
- **ripgrep / Grep for symbol lookup.** Definitions and call-sites are found with `rg "export function <name>"` / `rg "<name>\("`. Because every module is `.mjs` with explicit `export`/`import`, grep is a reliable proxy for "find references."
- **Layered instruction files** (`agents/AGENTS.md`, `.claude/rules/*.md`) carry the local conventions an LSP would not surface anyway.
- **PSA-006 still applies.** Any distributional claim about call-sites ("all N callers do X", "no remaining references to Y") MUST quote an executed `grep`/`rg` transcript — grep is the verification tool here precisely *because* there is no LSP to lean on. See `parallel-sessions.md` § PSA-006.

## When to revisit

Reconsider adding an LSP MCP server only if the repo gains a genuine typed-compilation graph (e.g., a TypeScript migration of `scripts/`). Until then, an LSP server is surface without leverage. If it is added, wire it into `.mcp.json` `mcpServers` and the `lsp-configured` check earns full credit automatically.

## See Also
development.md · cli-design.md · parallel-sessions.md · testing.md
