/**
 * ux-grill/manifest.mjs — Manifest parsing, loopback guards, env-name
 * resolution and the bootstrap writer for `/ux-grill`.
 *
 * Spec: docs/prd/2026-09-12-ux-grill.md § 2 S1 and § 3 "Manifest, Bootstrap &
 * Sicherheit".
 *
 * Near-leaf module: imports `node:fs`, `node:path`, `js-yaml` and
 * `../crypto-digest-utils.mjs` only. It NEVER calls `process.exit` — exit codes
 * belong to the CLI layer, which maps {@link ManifestError} `code` values onto
 * them (`base-url-not-loopback` / `guarded-env-not-loopback` → exit 2).
 *
 * Secret discipline (PRD § 3 AC 3/AC 4): the manifest carries env NAMES only.
 * No function here puts an env VALUE into a message, an error or a log line —
 * `guarded env <NAME> must be loopback` names the variable, never its content.
 *
 * Exports:
 *   ManifestError, DEFAULT_MANIFEST_PATH, DEFAULT_VIEWPORTS, LOOPBACK_HOSTS,
 *   parseManifest(), isLoopbackUrl(), assertLoopbackBaseUrl(), readEnvFile(),
 *   assertGuardedEnvsLoopback(), resolvePersonaCredentials(), manifestHash(),
 *   loadManifest(), buildBootstrapManifest(), writeBootstrapManifest(),
 *   UX_GRILL_ARTEFACT_IGNORE
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { digestSha256 } from '../crypto-digest-utils.mjs';

/**
 * Repo-relative default location of a target repo's ux-manifest.
 * @type {string}
 */
export const DEFAULT_MANIFEST_PATH = '.orchestrator/ux-manifest.md';

/**
 * `.gitignore` line every ux-grill target repo needs, ensured by
 * {@link writeBootstrapManifest}.
 *
 * A run writes screenshots, axe JSON and measures JSON under
 * `.orchestrator/metrics/ux-grill/<runId>/`, and a journey screenshot is taken
 * after EVERY step — including the one right after
 * `fill #pw ${LOGIN_PASSWORD}`, which renders the e-mail by construction and
 * the password whenever the app has a reveal toggle or a `type=text` field.
 * Nothing else in the target repo knows to ignore that path, and the PRD's
 * secret-leak acceptance test is a grep, which cannot see a PNG.
 * @type {string}
 */
export const UX_GRILL_ARTEFACT_IGNORE = '.orchestrator/metrics/ux-grill/';

/**
 * Viewports used when the manifest does not declare any (PRD § 2 S1).
 * Frozen: a caller mutating this would change every later parse.
 * @type {ReadonlyArray<{name: string, viewport?: string, device?: string}>}
 */
export const DEFAULT_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'desktop', viewport: '1440x900' }),
  Object.freeze({ name: 'mobile', device: 'iPhone 15' }),
]);

/**
 * Hostnames accepted as loopback. `new URL('http://[::1]/').hostname` yields
 * `[::1]` WITH the brackets, so both spellings are listed.
 * @type {readonly string[]}
 */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Schemes a loopback URL may carry.
 *
 * Without this, `foo://localhost/` parses, its hostname IS loopback — and its
 * `URL.origin` is the string `'null'` (every non-special scheme has an opaque
 * origin). `collect.mjs` `resolveWithinOrigin()` then compares `'null'` with
 * `'null'` and EVERY absolute off-origin location passes the same-origin gate
 * that exists to keep a substituted password inside the declared app.
 * @type {readonly string[]}
 */
export const LOOPBACK_PROTOCOLS = Object.freeze(['http:', 'https:']);

const VALID_BUILDS = Object.freeze(['dev', 'prod']);

/**
 * Frontmatter block, tolerating leading whitespace and leading HTML comments
 * (the template carries a plugin-provenance comment as its first line, and a
 * bootstrap-written manifest must round-trip through the same parser).
 */
const FRONTMATTER_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;

/**
 * A manifest-level failure carrying a machine-readable `code`.
 *
 * The CLI layer maps codes onto exit codes; nothing here exits. No code path
 * ever places an env VALUE into `message`.
 */
export class ManifestError extends Error {
  /**
   * @param {string} code - stable machine-readable code, e.g. `'base-url-not-loopback'`
   * @param {string} message - human-readable, secret-free
   */
  constructor(code, message) {
    super(message);
    this.name = 'ManifestError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * Parse a ux-manifest into its frontmatter object and its Markdown body.
 *
 * Frontmatter is parsed with js-yaml's `CORE_SCHEMA` (no custom types, no
 * implicit date/timestamp coercion) rather than line regexes — a line-oriented
 * validator is structurally blind to unparseable YAML.
 *
 * Absent optional collections are DEFAULTED here (empty arrays,
 * {@link DEFAULT_VIEWPORTS}), so every downstream consumer sees one shape.
 *
 * @param {string} text - full manifest file contents
 * @returns {{frontmatter: object, body: string}}
 * @throws {ManifestError} `manifest-not-string`, `frontmatter-missing`,
 *   `frontmatter-unparseable`, `frontmatter-not-object`, `base-url-missing`,
 *   `build-missing`, `build-invalid`
 */
export function parseManifest(text) {
  if (typeof text !== 'string') {
    throw new ManifestError('manifest-not-string', 'manifest contents must be a string');
  }
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    throw new ManifestError('frontmatter-missing', 'manifest has no YAML frontmatter block (--- … ---)');
  }

  let parsed;
  try {
    parsed = yaml.load(match[1], { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    throw new ManifestError('frontmatter-unparseable', `manifest frontmatter is not valid YAML: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManifestError('frontmatter-not-object', 'manifest frontmatter must be a YAML mapping');
  }

  const baseUrl = parsed['base-url'];
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new ManifestError('base-url-missing', 'manifest frontmatter must set base-url');
  }
  const build = parsed.build;
  if (build === undefined || build === null || build === '') {
    throw new ManifestError('build-missing', 'manifest frontmatter must set build (dev|prod)');
  }
  if (!VALID_BUILDS.includes(build)) {
    throw new ManifestError('build-invalid', `manifest build must be one of ${VALID_BUILDS.join('|')}`);
  }

  const frontmatter = {
    ...parsed,
    'base-url': baseUrl,
    build,
    'guarded-url-envs': asArray(parsed['guarded-url-envs']),
    personas: asArray(parsed.personas),
    routes: asArray(parsed.routes),
    journeys: asArray(parsed.journeys),
    viewports: asArray(parsed.viewports).length > 0 ? asArray(parsed.viewports) : DEFAULT_VIEWPORTS.map((v) => ({ ...v })),
  };

  return { frontmatter, body: match[2] ?? '' };
}

/**
 * @param {unknown} value
 * @returns {any[]} `value` when it is an array, otherwise an empty array.
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Is `url` an absolute URL pointing at a loopback host?
 *
 * Loopback means BOTH: a {@link LOOPBACK_HOSTS} hostname AND a
 * {@link LOOPBACK_PROTOCOLS} scheme. The scheme half is not cosmetic — see
 * {@link LOOPBACK_PROTOCOLS} for the opaque-origin bypass it closes. It also
 * drops `ws://localhost`, which no ux-grill field has ever named.
 *
 * @param {unknown} url
 * @returns {boolean} `false` for anything that does not parse as a URL —
 *   an unparseable value is never treated as safe.
 */
export function isLoopbackUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!LOOPBACK_PROTOCOLS.includes(parsed.protocol)) return false;
  return LOOPBACK_HOSTS.includes(parsed.hostname);
}

/**
 * Assert the manifest's `base-url` is loopback (PRD § 3 AC 2).
 *
 * @param {{['base-url']?: unknown}} frontmatter
 * @returns {void}
 * @throws {ManifestError} code `base-url-not-loopback`, message exactly
 *   `base-url must be loopback` — the CLI maps this code to exit 2.
 */
export function assertLoopbackBaseUrl(frontmatter) {
  const baseUrl = frontmatter?.['base-url'];
  if (!isLoopbackUrl(baseUrl)) {
    throw new ManifestError('base-url-not-loopback', 'base-url must be loopback');
  }
}

/**
 * Read a `KEY=VALUE` env file into a Map.
 *
 * Convention: split on the FIRST `=` (a value may contain further `=`), skip
 * blank lines and `#` comments, tolerate an `export ` prefix, and strip one
 * layer of matching surrounding quotes.
 *
 * No helper for this existed in `scripts/lib/` (measured 2026-09-12:
 * `grep -rn "split('='" scripts/lib` → 3 hits, all argv parsing), so the rules
 * live here.
 *
 * @param {string} absPath - absolute path of the env file
 * @returns {Map<string,string>}
 * @throws {ManifestError} code `env-file-missing` — the message names only the
 *   BASENAME, never the absolute path (host paths must not reach CI logs).
 */
export function readEnvFile(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    throw new ManifestError('env-file-missing', 'env-file path must be a non-empty string');
  }
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    throw new ManifestError('env-file-missing', `env-file ${path.basename(absPath)} not found`);
  }

  const map = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (key.length === 0) continue;
    map.set(key, stripQuotes(withoutExport.slice(eq + 1).trim()));
  }
  return map;
}

/**
 * Strip ONE layer of matching surrounding quotes.
 * @param {string} value
 * @returns {string}
 */
function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * ONE env-map type across this module and `collect.mjs`: a `Map`.
 *
 * A plain object is a programmer error, not a manifest defect — so it is a
 * `TypeError`, not a {@link ManifestError}, and it is never absorbed into an
 * empty `Map`: an empty map answers `has()` with `false` for every name, which
 * reads downstream as "the operator did not set the variable".
 *
 * @param {unknown} envMap
 * @param {string} caller - function name, for the message only
 * @returns {Map<string,string>}
 * @throws {TypeError} when `envMap` is not a `Map`
 */
function requireEnvMap(envMap, caller) {
  if (!(envMap instanceof Map)) {
    throw new TypeError(`${caller}: envMap must be a Map (got ${envMap === null ? 'null' : typeof envMap})`);
  }
  return envMap;
}

/**
 * Assert every `guarded-url-envs` entry resolves to a loopback URL
 * (PRD § 3 AC 3).
 *
 * The VALUE is never included in any message, error or log — a guarded env
 * pointing at production is exactly the case where printing it would leak a
 * live endpoint into a run record.
 *
 * @param {{['guarded-url-envs']?: unknown}} frontmatter
 * @param {Map<string,string>} envMap - MUST be a `Map` (the one env-map type in
 *   this module chain). A plain object used to degrade SILENTLY to an empty
 *   `Map` here, which turned "every guarded env is missing" into the same
 *   `guarded-env-missing` a genuinely unset variable produces — a type error
 *   wearing the costume of a manifest error.
 * @returns {void}
 * @throws {TypeError} when `envMap` is not a `Map`
 * @throws {ManifestError} `guarded-env-missing` (`guarded env <NAME> is not set`)
 *   or `guarded-env-not-loopback` (`guarded env <NAME> must be loopback`).
 */
export function assertGuardedEnvsLoopback(frontmatter, envMap) {
  const names = asArray(frontmatter?.['guarded-url-envs']);
  const map = requireEnvMap(envMap, 'assertGuardedEnvsLoopback');
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new ManifestError('guarded-env-missing', 'guarded-url-envs entries must be non-empty env NAMES');
    }
    if (!map.has(name)) {
      throw new ManifestError('guarded-env-missing', `guarded env ${name} is not set`);
    }
    if (!isLoopbackUrl(map.get(name))) {
      throw new ManifestError('guarded-env-not-loopback', `guarded env ${name} must be loopback`);
    }
  }
}

/**
 * Resolve a persona's login credentials from the env NAMES it declares.
 *
 * WARNING — the returned object carries SECRET VALUES. It must never be
 * serialised into a run record, a findings file, a dossier, an issue body or a
 * log line; pass it straight to the browser-login step and drop it. Everything
 * persisted about a persona is the env NAME (PRD § 3 AC 4).
 *
 * @param {{name?: string, ['login-env-email']?: string, ['login-env-password']?: string}} persona
 * @param {Map<string,string>} envMap - MUST be a `Map`; see
 *   {@link assertGuardedEnvsLoopback} for why the silent fallback was removed.
 * @returns {{email: string, password: string}}
 * @throws {TypeError} when `envMap` is not a `Map`
 * @throws {ManifestError} code `persona-env-missing` — names the env VARIABLE
 *   (or the missing manifest key), never a value.
 */
export function resolvePersonaCredentials(persona, envMap) {
  const map = requireEnvMap(envMap, 'resolvePersonaCredentials');
  const out = {};
  for (const [key, field] of [
    ['login-env-email', 'email'],
    ['login-env-password', 'password'],
  ]) {
    const envName = persona?.[key];
    if (typeof envName !== 'string' || envName.length === 0) {
      throw new ManifestError('persona-env-missing', `persona ${persona?.name ?? '<unnamed>'} has no ${key}`);
    }
    if (!map.has(envName)) {
      throw new ManifestError('persona-env-missing', `env ${envName} is not set`);
    }
    out[field] = map.get(envName);
  }
  return { email: out.email, password: out.password };
}

/**
 * SHA-256 (hex) of the manifest TEXT — the compare key of a run-record: two
 * runs are comparable only when their `manifest_hash` matches, so the hash is
 * taken over the raw text, not over the parsed object.
 *
 * @param {string} text
 * @returns {string} 64-char hex digest
 */
export function manifestHash(text) {
  return digestSha256(String(text ?? ''));
}

/**
 * Read, parse and guard a repo's ux-manifest.
 *
 * Pure orchestration: read → {@link parseManifest} → {@link assertLoopbackBaseUrl}
 * → {@link readEnvFile} (only when `env-file` is set) → {@link assertGuardedEnvsLoopback}.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute path of the target repo
 * @param {string} [opts.manifestPath] - repo-relative, defaults to {@link DEFAULT_MANIFEST_PATH}
 * @returns {{frontmatter: object, body: string, envMap: Map<string,string>, manifestHash: string, path: string}}
 * @throws {ManifestError} `repo-root-invalid`, `manifest-missing`,
 *   `env-file-outside-repo`, or any code thrown by the steps above.
 */
export function loadManifest({ repoRoot, manifestPath = DEFAULT_MANIFEST_PATH } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new ManifestError('repo-root-invalid', 'repoRoot must be a non-empty string');
  }
  const absolute = path.resolve(repoRoot, manifestPath);
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    throw new ManifestError('manifest-missing', `manifest ${path.basename(absolute)} not found`);
  }

  const { frontmatter, body } = parseManifest(text);
  assertLoopbackBaseUrl(frontmatter);

  const envFile = frontmatter['env-file'];
  const envMap = typeof envFile === 'string' && envFile.length > 0
    ? readEnvFile(resolveInsideRepo(repoRoot, envFile))
    : new Map();

  assertGuardedEnvsLoopback(frontmatter, envMap);

  return { frontmatter, body, envMap, manifestHash: manifestHash(text), path: absolute };
}

/**
 * Resolve a repo-relative manifest path and REQUIRE it to stay inside the repo.
 *
 * The template documents `env-file` as "filename relative to the target repo
 * root", but `path.resolve` happily walks out of it: an `env-file` of
 * `../../../.config/session-orchestrator/secrets.env` turns any host
 * `KEY=VALUE` file into a credential source for a persona, and every error path
 * here is secret-free, so nothing would surface.
 *
 * No existing helper was reusable (measured 2026-09-12,
 * `rg -n "startsWith\(.*sep|isInside|containsPath" scripts/lib` → 10 hits, each
 * an inlined comparison bound to its own module's error shape), so the
 * comparison is inlined here too — against `repoRoot + sep`, with the repo root
 * itself accepted.
 *
 * @param {string} repoRoot - absolute path of the target repo
 * @param {string} relative - repo-relative path from the manifest
 * @returns {string} the absolute, contained path
 * @throws {ManifestError} code `env-file-outside-repo`; the message names NO
 *   path (a traversal string is operator-supplied text that may itself carry a
 *   host path).
 */
function resolveInsideRepo(repoRoot, relative) {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ManifestError('env-file-outside-repo', 'env-file must resolve inside the target repo');
  }
  return resolved;
}

/**
 * Escape a literal page title into an anchored regular expression source, so a
 * discovered title becomes a usable `title-pattern` without matching by accident.
 * @param {string} title
 * @returns {string}
 */
function titlePatternFor(title) {
  return `^${String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * Build the TEXT of a bootstrap manifest from a crawl result.
 *
 * The crawl itself is NOT done here — the caller (`collect.mjs` / the skill,
 * via agent-browser) discovers the navigation and hands over `routes` as
 * `{path, title}` records; this function only turns them into manifest
 * `routes[]`.
 *
 * `personas` carries exactly ONE entry when both login env NAMES are given, and
 * is empty otherwise ("ohne Login", PRD § 2 S1). `journeys` is always empty —
 * journeys are hand-written after the bootstrap run.
 *
 * The result is asserted to round-trip through {@link parseManifest} before it
 * is returned (PRD § 3 AC 1): a bootstrap manifest the parser rejects would
 * fail only on the NEXT run, far from its cause.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - must be loopback
 * @param {string} [opts.build] - `'dev'` (default) or `'prod'`
 * @param {string} [opts.envFile] - filename relative to the target repo root
 * @param {string} [opts.loginEnvEmail] - env NAME, never a value
 * @param {string} [opts.loginEnvPassword] - env NAME, never a value
 * @param {string} [opts.personaName] - defaults to `'operator'`
 * @param {Array<{path: string, title?: string}>} [opts.routes] - discovered navigation
 * @param {string} [opts.notes] - free Markdown appended below the frontmatter
 * @returns {string} the manifest text (frontmatter + body)
 * @throws {ManifestError} `base-url-not-loopback` (message `base-url must be
 *   loopback`), `build-invalid`, or `bootstrap-roundtrip-failed`
 */
export function buildBootstrapManifest({
  baseUrl,
  build = 'dev',
  envFile,
  loginEnvEmail,
  loginEnvPassword,
  personaName = 'operator',
  routes,
  notes,
} = {}) {
  if (!isLoopbackUrl(baseUrl)) {
    throw new ManifestError('base-url-not-loopback', 'base-url must be loopback');
  }
  if (!VALID_BUILDS.includes(build)) {
    throw new ManifestError('build-invalid', `manifest build must be one of ${VALID_BUILDS.join('|')}`);
  }

  const hasLogin = typeof loginEnvEmail === 'string' && loginEnvEmail.length > 0
    && typeof loginEnvPassword === 'string' && loginEnvPassword.length > 0;

  const frontmatter = { 'base-url': baseUrl, build };
  if (typeof envFile === 'string' && envFile.length > 0) frontmatter['env-file'] = envFile;
  frontmatter['guarded-url-envs'] = [];
  frontmatter.personas = hasLogin
    ? [{
      name: personaName,
      'login-env-email': loginEnvEmail,
      'login-env-password': loginEnvPassword,
      goal: '',
    }]
    : [];
  frontmatter.routes = asArray(routes).map((route) => {
    const entry = { path: String(route?.path ?? '') };
    if (typeof route?.title === 'string' && route.title.length > 0) {
      entry['title-pattern'] = titlePatternFor(route.title);
    }
    if (hasLogin) entry.persona = personaName;
    return entry;
  });
  frontmatter.journeys = [];
  frontmatter.viewports = DEFAULT_VIEWPORTS.map((v) => ({ ...v }));

  const body = [
    '# UX Manifest (bootstrapped)',
    '',
    'Written by `/ux-grill` from the discovered navigation. Fill in the gaps:',
    'persona `goal`, `guarded-url-envs` (env NAMES of every endpoint the app',
    'talks to), `seed-command`, and at least one entry under `journeys`.',
    '',
    'Credentials are env NAMES only — the values belong in the gitignored file',
    'named by `env-file`, never in this file.',
    ...(typeof notes === 'string' && notes.length > 0 ? ['', notes] : []),
    '',
  ].join('\n');

  const text = `---\n${yaml.dump(frontmatter, { schema: yaml.CORE_SCHEMA, lineWidth: -1 })}---\n\n${body}`;

  try {
    parseManifest(text);
  } catch (err) {
    throw new ManifestError(
      'bootstrap-roundtrip-failed',
      `bootstrap manifest does not parse back (${err.code ?? 'unknown'}): ${err.message}`,
    );
  }
  return text;
}

/**
 * Ensure the target repo's `.gitignore` carries {@link UX_GRILL_ARTEFACT_IGNORE}.
 *
 * APPEND-ONLY, mirroring the `owner.yaml` first-run append to `~/.gitignore`:
 * the file is created when absent, the line is appended when missing, and
 * existing content is NEVER rewritten — a `.gitignore` is operator-owned, and a
 * rewrite here would be a silent edit of a file this module does not own.
 *
 * Failure is NOT fatal: a read-only or otherwise unwritable `.gitignore` must
 * not block the bootstrap. The return value says what happened so the caller
 * can warn.
 *
 * @param {string} repoRoot - absolute path of the target repo
 * @returns {{path: string, action: 'created'|'appended'|'present'|'failed'}}
 */
function ensureArtefactIgnore(repoRoot) {
  const file = path.join(repoRoot, '.gitignore');
  try {
    let existing = '';
    try {
      existing = readFileSync(file, 'utf8');
    } catch {
      writeFileSync(file, `${UX_GRILL_ARTEFACT_IGNORE}\n`, 'utf8');
      return { path: file, action: 'created' };
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === UX_GRILL_ARTEFACT_IGNORE)) {
      return { path: file, action: 'present' };
    }
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    appendFileSync(file, `${prefix}${UX_GRILL_ARTEFACT_IGNORE}\n`, 'utf8');
    return { path: file, action: 'appended' };
  } catch {
    return { path: file, action: 'failed' };
  }
}

/**
 * Write a bootstrap manifest, creating the parent directory, and ensure the
 * target repo ignores the run-artefact directory
 * ({@link UX_GRILL_ARTEFACT_IGNORE} via {@link ensureArtefactIgnore}) — those
 * artefacts can carry a rendered credential, and no other step in the target
 * repo would add that line.
 *
 * REFUSES to overwrite the manifest: one that already exists carries
 * hand-written journeys and personas a crawl cannot reconstruct. The
 * `.gitignore` is only ever APPENDED to, never rewritten.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute path of the target repo
 * @param {string} [opts.manifestPath] - repo-relative, defaults to {@link DEFAULT_MANIFEST_PATH}
 * @param {string} opts.text - manifest text, e.g. from {@link buildBootstrapManifest}
 * @returns {{path: string, manifestHash: string, gitignore: {path: string, action: 'created'|'appended'|'present'|'failed'}}}
 * @throws {ManifestError} `repo-root-invalid`, `manifest-text-invalid`, `manifest-exists`
 */
export function writeBootstrapManifest({ repoRoot, manifestPath = DEFAULT_MANIFEST_PATH, text } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new ManifestError('repo-root-invalid', 'repoRoot must be a non-empty string');
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new ManifestError('manifest-text-invalid', 'manifest text must be a non-empty string');
  }
  const absolute = path.resolve(repoRoot, manifestPath);
  if (existsSync(absolute)) {
    throw new ManifestError('manifest-exists', `manifest ${path.basename(absolute)} already exists — refusing to overwrite`);
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, 'utf8');
  return { path: absolute, manifestHash: manifestHash(text), gitignore: ensureArtefactIgnore(repoRoot) };
}
