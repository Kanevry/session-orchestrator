// @secret-shape-allowed
// (This module defines the credential-shape regex literals themselves.)
/**
 * token-shapes.mjs — the access-token patterns F5–F8, shared by
 * `check-test-fixture-shapes.mjs` (live-credential shapes in tests/) and
 * `scripts/lib/security/agent-setup.mjs` (tokens in a permission allowlist, SEC-025).
 *
 * One copy of the regexes; side-effect free. `name` and `hint` are the exact
 * strings `check-test-fixture-shapes.mjs` prints.
 */

/** @type {ReadonlyArray<{id: string, name: string, regex: RegExp, hint: string}>} */
export const TOKEN_SHAPES = Object.freeze([
  {
    id: 'F5',
    name: 'F5 (Anthropic sk-ant-)',
    regex: /sk-ant-[A-Za-z0-9_-]{30,}/,
    hint: 'use sk-ant-<PLACEHOLDER>-<padding to ≥30 chars after the prefix>',
  },
  {
    id: 'F6',
    name: 'F6 (GitHub PAT classic ghp_)',
    regex: /ghp_[A-Za-z0-9]{36,}/,
    hint: 'use ghp_PLACEHOLDER<padding> (must be ≥36 chars after the underscore)',
  },
  {
    id: 'F7',
    name: 'F7 (GitHub PAT fine-grained github_pat_)',
    regex: /github_pat_[A-Za-z0-9_]{30,}/,
    hint: 'use github_pat_PLACEHOLDER<padding> (must be ≥30 chars after the prefix)',
  },
  {
    id: 'F8',
    name: 'F8 (GitLab PAT glpat-)',
    regex: /glpat-[A-Za-z0-9_-]{20,}/,
    hint: 'use glpat-PLACEHOLDER<padding> (must be ≥20 chars after the prefix)',
  },
]);
