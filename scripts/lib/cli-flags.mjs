/**
 * cli-flags.mjs — shared CLI-flag parser for the column-style migration scripts.
 *
 * Issue #510: three (now four) scripts each hand-rolled their own argv parsing —
 * `vault-consolidate.mjs` used `node:util` parseArgs strict, `vault-mirror.mjs`
 * used a `getArg`/`includes` style that SILENTLY ignored unknown flags,
 * `migrate-cold-start-seed.mjs` used `includes` + a `knownFlags` Set, and
 * `migrate-vault-paths.mjs` used a custom for-loop. This module unifies the
 * PARSING + unknown-flag rejection behind a single function so the CLI
 * convention (reject-on-unknown, `--json`/`--dry-run`/`--apply` support) has
 * one source of truth.
 *
 * `parseColumnFlags` is intentionally THIN: it owns argv tokenisation,
 * known-flag declaration, defaults, and unknown-flag rejection. It does NOT
 * own per-script semantics like int/float coercion, `--dry-run`/`--apply`
 * mutex checks, `--repos` comma-splitting, or required-flag validation — those
 * stay in each script's post-parse block because they differ per script. The
 * reference implementation is `node:util` parseArgs in strict mode, matching
 * `vault-consolidate.mjs`'s prior style.
 *
 * `--dry-run`/`--apply` mutex — why it is NOT a shared helper here (#589
 * LOW-qa-5, document-as-accepted): the three scripts that carry the mutex
 * (`vault-consolidate.mjs`, `migrate-cold-start-seed.mjs`,
 * `migrate-vault-paths.mjs`) each emit DIVERGENT, test-pinned error prose
 * (different script-name prefixes; `die()` vs raw `process.stderr.write`) and
 * derive `apply`/`dryRun` at different points in their own entry-point flow.
 * The detection predicate (`values['dry-run'] && values.apply`) is a one-liner
 * per script; centralising only that predicate would yield a seam that no
 * caller can use without ALSO duplicating the per-script message — i.e. it
 * would reproduce the exact dead-but-tested speculative-seam smell that #589
 * MED-1 removed (the old `onUnknown:'ignore'` option). The mutex stays
 * per-script by design.
 *
 * Usage:
 *   import { parseColumnFlags, CliFlagError } from './lib/cli-flags.mjs';
 *
 *   let values;
 *   try {
 *     ({ values } = parseColumnFlags({
 *       argv: process.argv.slice(2),
 *       knownBool: { 'dry-run': false, apply: false, json: false, help: { short: 'h', default: false } },
 *       knownString: { source: null, repos: null },
 *     }));
 *   } catch (err) {
 *     if (err instanceof CliFlagError) {
 *       process.stderr.write(`${SCRIPT_NAME}: ${err.message}\n`);
 *       process.exit(1);
 *     }
 *     throw err;
 *   }
 *
 * Design note — why throw instead of exit:
 *   The migration scripts run their parsing at module top-level (entry-point
 *   style — `main()` runs on import), so we cannot make the parser call
 *   `process.exit()` directly without making it untestable. Instead the parser
 *   throws a typed `CliFlagError` on a parse failure (unknown flag, missing
 *   value, etc.); each script catches it and maps to its own exit code (always
 *   1 — argument error — per `.claude/rules/cli-design.md`). Tests assert on the
 *   thrown error, which is the behaviour-equivalent of "exit 1 on unknown flag".
 */

import { parseArgs } from 'node:util';

/**
 * Typed error thrown by parseColumnFlags on any parse failure.
 * Callers catch this and map to exit code 1 (argument error).
 */
export class CliFlagError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliFlagError';
  }
}

/**
 * Normalise a known-flag descriptor into a `node:util` parseArgs option entry.
 *
 * Accepts two shapes per flag:
 *   - a bare default value (`false`, `null`, `[]`, …) → `{ default }`
 *   - an object `{ short?, default?, multiple? }` → passed through
 *
 * @param {'boolean'|'string'} type
 * @param {*} descriptor
 * @returns {{type:string, short?:string, multiple?:boolean, default?:*}}
 */
function toParseArgsOption(type, descriptor) {
  const opt = { type };
  if (descriptor !== null && typeof descriptor === 'object' && !Array.isArray(descriptor)) {
    if (typeof descriptor.short === 'string') opt.short = descriptor.short;
    if (descriptor.multiple === true) opt.multiple = true;
    if ('default' in descriptor) opt.default = descriptor.default;
  } else if (descriptor !== undefined && descriptor !== null) {
    // Bare default value (false, [], a string). `null` is treated as
    // "no default" so a missing string flag reads back as undefined — callers
    // apply their own `?? fallback` post-parse (e.g. vault-mirror required-flag
    // checks rely on undefined, not "").
    opt.default = descriptor;
  } else if (Array.isArray(descriptor)) {
    opt.default = descriptor;
  }
  return opt;
}

/**
 * Parse column-style CLI flags via node:util parseArgs in strict mode.
 *
 * @param {object} spec
 * @param {string[]} [spec.argv]                Token array (default: process.argv.slice(2)).
 * @param {Object<string, *>} [spec.knownBool]  Boolean flags. Value = bare default OR { short, default }.
 * @param {Object<string, *>} [spec.knownString] String flags. Value = bare default (string|null) OR { short, default, multiple }.
 * @param {Object<string, *>} [spec.defaults]   Optional explicit default overrides, merged onto values AFTER parse
 *                                               (only applied where parseArgs left the key undefined).
 * @returns {{ values: object, positionals: string[] }}
 * @throws {CliFlagError} on any parse failure (unknown flag, missing string value, …).
 */
export function parseColumnFlags({
  argv = process.argv.slice(2),
  knownBool = {},
  knownString = {},
  defaults = {},
} = {}) {
  const options = {};
  for (const [name, descriptor] of Object.entries(knownBool)) {
    options[name] = toParseArgsOption('boolean', descriptor);
  }
  for (const [name, descriptor] of Object.entries(knownString)) {
    options[name] = toParseArgsOption('string', descriptor);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: false,
      // strict=true rejects unknown flags AND missing values for string flags.
      strict: true,
    });
  } catch (err) {
    // Re-wrap node:util's ERR_PARSE_ARGS_* errors as our typed CliFlagError so
    // callers have a single catch target regardless of the underlying cause.
    throw new CliFlagError(err.message);
  }

  // Strict parseArgs only returns declared keys (unknown flags throw above), so
  // parsed.values already contains exactly the declared set — copy it directly.
  const values = { ...parsed.values };

  // Apply explicit post-parse defaults only where parseArgs left the key
  // undefined (a string flag with no `default` reads back undefined). This lets
  // callers express "default to X" without baking X into the parseArgs option
  // when they need to distinguish "flag absent" during the parse.
  for (const [name, value] of Object.entries(defaults)) {
    if (values[name] === undefined) values[name] = value;
  }

  return { values, positionals: parsed.positionals ?? [] };
}
