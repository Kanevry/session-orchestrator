/**
 * private-config-dir.mjs — THE resolver for the host-private config directory (#1223).
 *
 * Every per-host artefact below that directory (`host-private.json`,
 * `owner.yaml`, the self-alias ledger) moves with it, so the precedence has to
 * live in exactly ONE place. Before #1223 three copies with three different
 * precedences existed: `owner-yaml.mjs`'s import-time homedir-only
 * `OWNER_YAML_PATH`, `owner-config-loader.mjs`'s XDG-only + untrimmed
 * `resolveOwnerConfigPath()`, and `host-identity.mjs`'s `_privateDir()`. The
 * live consequence: `SO_CONFIG_HOME=<sandbox>` moved the alias ledger but NOT
 * owner.yaml, which kept being read from the operator's REAL home — the
 * CLAUDE.md (Codex CLI alias: AGENTS.md) "vault-dir resolves HOST-LOCALLY"
 * hazard class.
 *
 * ── Why this is a standalone ZERO-IMPORT leaf ────────────────────────────────
 *
 * Two independent consumers constrain it, and neither tolerates the other's
 * import graph:
 *
 *   1. `host-identity.mjs` is reachable from LIVE hooks (via `session-lock.mjs`),
 *      `hooks/on-stop.mjs` among them. on-stop must degrade with one actionable
 *      line when `node_modules` is absent (GH#63), so nothing on ITS subgraph —
 *      this leaf included — may pull a bare specifier. Putting the resolver in
 *      `owner-yaml.mjs` dragged `js-yaml` onto that subgraph and turned the GH#63
 *      contract red with `ERR_MODULE_NOT_FOUND: Cannot find package 'js-yaml'`.
 *      The claim is about on-stop's subgraph, NOT about the whole hook graph:
 *      measured 2026-09-05 over `hooks/_lib/hook-import-set.json` (150 entries,
 *      head 4b45130) that graph still carries two pre-existing bare specifiers
 *      (`owner-yaml.mjs → js-yaml`, `worktree/listing.mjs → zx`), and 4 of the 5
 *      hooks touched by them throw ERR_MODULE_NOT_FOUND without node_modules.
 *   2. `tests/husky/pre-commit-owner-leakage.test.mjs` copies the CP11 scanner's
 *      import chain FILE BY FILE into a tmp repo. Every repo-local import added
 *      to a file on that chain must be added to the copied-file list there.
 *
 * Hence: `node:os` + `node:path` only. No repo-local imports, no bare
 * specifiers beyond the two Node builtins.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the host-private config directory.
 *
 * Precedence, most specific first: `SO_CONFIG_HOME` names the private dir
 * ITSELF; `XDG_CONFIG_HOME` names its PARENT (the `session-orchestrator`
 * segment is appended); without either, `~/.config/session-orchestrator`.
 *
 * `.trim() || fallback` throughout — a whitespace-only env var is truthy and
 * would short-circuit a bare `||`, returning the spaces verbatim
 * (`.claude/rules/development.md` § Error Handling, env-var fallback
 * whitespace trap).
 *
 * Reads env at CALL time, so a test may stub `process.env` after import.
 *
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 * @returns {string} absolute path to the host-private config directory
 */
export function resolvePrivateConfigDir({ env = process.env } = {}) {
  const own = (env.SO_CONFIG_HOME || '').trim();
  if (own) return own;
  const xdg = (env.XDG_CONFIG_HOME || '').trim();
  if (xdg) return join(xdg, 'session-orchestrator');
  return join(homedir(), '.config', 'session-orchestrator');
}
