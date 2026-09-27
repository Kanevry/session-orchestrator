/**
 * sh-quote.mjs — the one POSIX shell-quoting helper (#1438).
 *
 * Four byte-identical private copies (cursor-install, tmux-layout/layouts,
 * tmux-layout/tmux-shell, run-quality-gate) and one inline copy
 * (vault-integration-watcher) were folded into this module.
 */

/**
 * Quote one value as a single POSIX shell word.
 *
 * Wraps the value in single quotes, inside which POSIX `sh` treats EVERY byte
 * literally — no `$` expansion, no backtick substitution, no word splitting, a
 * newline included. The one byte that cannot appear inside single quotes is
 * the single quote itself, and it cannot be backslash-escaped there either
 * (`\'` inside quotes is a literal backslash that then ENDS the string); so
 * each `'` closes the quoted run, emits an escaped `\'` outside it, and
 * reopens: `'` → `'\''`.
 *
 * The value is coerced with `String(value)`, as all four former copies did —
 * their call sites pass paths, command strings and pane commands, and a
 * number or other primitive must quote to its string form rather than throw.
 *
 * @param {unknown} value  The value to quote; coerced via `String()`.
 * @returns {string}  e.g. `'it'\''s'` for `it's`, `''` for the empty string.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
