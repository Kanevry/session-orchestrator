/**
 * redacted-env.mjs — a child-process env object that serializes to key names only (SO#1785, SEC-008).
 *
 * An exported function that returns a full copy of `process.env` is one ad-hoc
 * `JSON.stringify(...)` or `console.log(...)` away from printing every secret of
 * the host into a transcript (the #1784 incident: seven secrets from one
 * `JSON.stringify(loadHostPaths())`). This helper keeps such an env usable as
 * `spawn`/`execFile` `options.env` while making both serialization paths show
 * key names only.
 */

const VIEW = Symbol.for('nodejs.util.inspect.custom');

/**
 * Make an env object print as `{ keys: [...] }` under `JSON.stringify` and
 * `util.inspect`/`console.log`, without changing what a child process receives.
 *
 * The values stay ordinary enumerable own properties: Node's child_process
 * copies `options.env` with `for…in`, so the child gets every value, while the
 * two NON-enumerable view members are skipped. Pass a fresh object
 * (`{ ...process.env, X: 'y' }`); `process.env` itself is rejected by Node with
 * a TypeError (it does not accept Object.defineProperty).
 * An env variable literally named `toJSON` is overwritten by the view member
 * and does not reach the child — accepted, unrealistic.
 *
 * CEILING (BV-004): this guards the two common print paths only. A copy of the
 * returned object (`{ ...env }`, `Object.assign`, `Object.entries`,
 * `structuredClone`) or `inspect(env, { customInspect: false })` shows values
 * again. Revisit when a caller starts copying or iterating the object instead of
 * passing it straight to spawn/execFile.
 *
 * @template {Record<string, string|undefined>} T
 * @param {T} env  a fresh plain env object; mutated in place and returned
 * @returns {T}
 */
export function redactedEnv(env) {
  const view = () => ({ keys: Object.keys(env) });
  Object.defineProperty(env, 'toJSON', { value: view, enumerable: false });
  Object.defineProperty(env, VIEW, { value: view, enumerable: false });
  return env;
}
