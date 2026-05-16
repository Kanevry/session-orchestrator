/**
 * echo-stub-detect.mjs — Detect quality-gate commands that are no-op stubs.
 * Prevents `echo "no automated tests yet"` from producing a false-positive pass.
 */

/**
 * Detect whether a quality-gate command is a no-op echo-stub or a `:` no-op.
 *
 * Detection rules (applied in order):
 *   1. Empty / undefined / `'skip'` → not a stub (skip branch handles these).
 *   2. Whole command equals `:`  → stub of kind `'noop'`.
 *   3. Whole command is `echo` followed by a single quoted or simple argument
 *      with no shell-meta tail (pipe, redirect, command-substitution, etc.)
 *      → stub of kind `'echo'`.
 *   4. Otherwise → not a stub.
 *
 * @param {string|undefined} cmd
 * @returns {{ isStub: boolean, kind?: 'echo'|'noop' }}
 */
export function detectStubCommand(cmd) {
  if (!cmd || cmd === 'skip') {
    return { isStub: false };
  }

  const trimmed = cmd.trim();

  if (trimmed === ':') {
    return { isStub: true, kind: 'noop' };
  }

  // Matches: echo "quoted" | echo 'quoted' | echo simpleArg
  // Rejects any shell-meta characters after the argument (|, ;, &, <, >, $, `, (, ))
  const ECHO_STUB_RE = /^echo\s+(?:"[^"]*"|'[^']*'|[^\s|;&<>$`()]+)\s*$/;
  if (ECHO_STUB_RE.test(trimmed)) {
    return { isStub: true, kind: 'echo' };
  }

  return { isStub: false };
}
