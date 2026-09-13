/**
 * git-porcelain.mjs — the ONE parser for `git status --porcelain -z` output.
 *
 * Three consumers used to hand-roll this: `quality-gate.mjs` (hardened),
 * `project-hygiene.mjs` (inline, R/C-aware) and `pre-dispatch-check.mjs`
 * (non-`-z`, hand-unquoting only `\"` and `\\`, so any path carrying a TAB or a
 * non-ASCII byte resolved to a NON-EXISTENT path — #1354). They now share this
 * module.
 *
 * `-z` is not a convenience flag here — it is the only shape of this command
 * whose paths are unambiguous. Measured 2026-08-23 (git 2.53.0) on a fixture
 * carrying a space, a non-ASCII name, a literal `"` and a rename:
 *
 * ```
 *   git status --porcelain            git status --porcelain -z
 *   ------------------------------    ---------------------------------
 *    M "scripts/lib/old name.mjs"      M scripts/lib/old name.mjs
 *    M "scripts/lib/\303\274ml.mjs"    M scripts/lib/üml.mjs
 *   ?? "scripts/lib/quo\"te.mjs"      ?? scripts/lib/quo"te.mjs
 *   R  old.mjs -> new.mjs             R  new.mjs \0 old.mjs
 * ```
 *
 * The non-`-z` form C-quotes any path containing a space, a `"` or — under the
 * default `core.quotePath=true` — a non-ASCII byte. `-c core.quotePath=false`
 * repairs only the non-ASCII third of that (measured: the space and the `"`
 * stayed quoted). A field-splitting parser over the non-`-z` form fails three
 * separate ways on one input — measured `awk '{print $2}'` output for the four
 * lines above: `"scripts/lib/old` (truncated at the space), the undecoded
 * `\303\274` octal escape, and `old.mjs` (the PRE-rename path) for the `R`
 * line. `-z` emits every path verbatim, so there is no unquoting step to get
 * wrong.
 *
 * Rename/copy entries carry their ORIGINAL path as the NEXT NUL field, with NO
 * `XY ` prefix. Consuming that extra field is mandatory, not optional: a naive
 * per-field `slice(3)` would emit `.mjs`-suffixed garbage (`d.mjs` for
 * `old.mjs`) as if it were a real path. `R`/`C` are checked in BOTH status
 * columns because git-status(1) documents `R `/`C ` (renamed/copied in index)
 * as well as ` R`/` C` (renamed/copied in work tree).
 *
 * Ceiling (BV-004): this parses **porcelain v1** (`--porcelain` / `--porcelain=v1`)
 * with `-z`, as emitted by git ≥ 2.x — the `XY <path>` entry shape plus the
 * bare original-path field for `R`/`C`. It also accepts the `!!` entries that
 * `--ignored` adds and the individual-file entries `-uall` produces. It does
 * NOT parse porcelain **v2** (`--porcelain=v2`), whose entries are
 * space-delimited records beginning with `1`/`2`/`u`/`?`/`!`, and it does not
 * decode C-quoting, because `-z` never emits any. Revisit trigger: the first
 * caller that needs v2's per-entry metadata (mode bits, object ids, submodule
 * state) or that must parse output produced without `-z`.
 */

/**
 * @typedef {Object} PorcelainEntry
 * @property {string} x        first status column (index)
 * @property {string} y        second status column (work tree)
 * @property {string} status   both columns, e.g. `??`, `!!`, `R `, ` M`
 * @property {string} path     path as git emitted it (verbatim, never quoted)
 * @property {string|null} original  source path for a rename/copy, else `null`
 */

/**
 * Parse `git status --porcelain -z` stdout into structured entries.
 *
 * Malformed fields are DROPPED rather than guessed at: `XY P` is the shortest
 * well-formed entry, so anything shorter — including the empty trailing field
 * `split` always produces — is not an entry header, and the `[2] === ' '`
 * check rejects a stray original-path field that a malformed stream could
 * leave unconsumed.
 *
 * @param {string} raw — raw stdout of `git status --porcelain -z …`.
 * @returns {PorcelainEntry[]} entries, in git's emission order.
 */
export function parsePorcelainEntries(raw) {
  const fields = String(raw ?? '').split('\0');
  /** @type {PorcelainEntry[]} */
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (typeof entry !== 'string' || entry.length < 4 || entry[2] !== ' ') continue;
    const x = entry[0];
    const y = entry[1];
    let original = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1;
      const src = fields[i];
      if (typeof src === 'string' && src) original = src;
    }
    entries.push({ x, y, status: `${x}${y}`, path: entry.slice(3), original });
  }
  return entries;
}

/**
 * Parse `git status --porcelain -z` stdout into repo-root-relative paths.
 *
 * Both halves of a rename/copy are kept — a file moved OUT of a watched
 * directory is as much a touch as one moved in, and a fixer needs the old path
 * to make sense of the new one.
 *
 * Untracked DIRECTORIES are not a case this function has to handle when the
 * caller passes `-uall`, which expands them to individual files (measured:
 * `?? nd/` became `?? nd/a.mjs` + `?? nd/b.mjs`).
 *
 * @param {string} raw — raw stdout of `git status --porcelain -z …`.
 * @returns {string[]} repo-root-relative paths, in git's emission order.
 */
export function parsePorcelainZ(raw) {
  const paths = [];
  for (const entry of parsePorcelainEntries(raw)) {
    if (entry.path) paths.push(entry.path);
    if (entry.original) paths.push(entry.original);
  }
  return paths;
}
