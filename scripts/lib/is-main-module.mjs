/**
 * is-main-module.mjs — the one entry-guard predicate, symlink-safe.
 *
 * ## The incident class
 *
 * An ESM module that wants to run `main()` only when invoked as a CLI has to
 * compare "the module I am" against "the script Node was told to run". The two
 * sides are NOT the same kind of path:
 *
 *   - `import.meta.url` is resolved by Node to the module's **realpath**.
 *   - `process.argv[1]` is the path **as typed on the command line**.
 *
 * With a symlink anywhere in the invocation path — a `node_modules/.bin/` shim,
 * a `~/bin/foo -> /repo/scripts/foo.mjs` convenience link, a plugin directory
 * symlinked into `~/.claude/plugins/`, or `/tmp` itself (on macOS `/tmp` is a
 * symlink to `/private/tmp`) — the two strings differ and the guard is FALSE.
 *
 * The failure is silent and total: `main()` never runs, nothing is printed, and
 * the process exits 0. Every caller — a hook, a CI job, an npm script, an
 * operator — reads that as success. This is the single worst shape a defect can
 * have in this repo, which is why the predicate is centralised here instead of
 * being re-typed per file.
 *
 * ## The textual variants this replaces
 *
 * Measured 2026-09-16 @ ca214376 over the 50 files swept for #1371, the guard
 * had been hand-written in 15 distinct textual forms (measured by extracting the
 * guard expression from every file at HEAD), collapsing into four
 * semantic variants — all four wrong in the same way:
 *
 *   V1  import.meta.url === `file://${process.argv[1]}`
 *       (also breaks on any space or non-ASCII char in the path — no escaping)
 *   V2  import.meta.url === pathToFileURL(process.argv[1] ?? '').href
 *   V3  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
 *       / resolve(process.argv[1]) === resolve(__filename)
 *   V4  fileURLToPath(import.meta.url) === process.argv[1]
 *
 * V2/V3 fix the `undefined`-argv and relative-path cases; none of them resolve
 * symlinks, because only `realpath` does.
 *
 * ## Non-goal: Windows drive-letter / case folding
 *
 * `realpathSync.native` delegates to the OS, so on NTFS it canonicalises the
 * stored casing of every path component and the two sides agree. Where the
 * realpath call FAILS (deleted path, permission error) the fallback is a raw
 * string compare, which on Windows can be case-sensitive against a
 * case-insensitive filesystem. That residual case is deliberately out of scope:
 * this repo runs on macOS and Linux CI, and a case-only mismatch degrades to
 * today's behaviour rather than to something worse.
 *
 * @module scripts/lib/is-main-module
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module identified by `importMetaUrl` is the script Node was
 * invoked with.
 *
 * Symlink-safe: both sides are canonicalised via `realpathSync.native` before
 * comparison, so an invocation through a symlink (shim, `~/bin` link, `/tmp` on
 * macOS) still matches. When either path cannot be realpath'd — it was deleted
 * between spawn and this call, or is unreadable — the comparison degrades to a
 * raw string compare rather than throwing, because an entry guard must never be
 * the thing that crashes an import.
 *
 * @param {string} importMetaUrl the calling module's `import.meta.url`
 * @param {string | undefined} [argv1] the invoked script path; defaults to
 *   `process.argv[1]`, which is `undefined` under `node -e`, the REPL and some
 *   dynamic-import contexts — those return `false`
 * @returns {boolean} true when this module IS the entrypoint
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const self = fileURLToPath(importMetaUrl);
  try {
    return realpathSync.native(argv1) === realpathSync.native(self);
  } catch {
    return argv1 === self;
  }
}
