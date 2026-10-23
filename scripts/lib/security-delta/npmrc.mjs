/**
 * npmrc.mjs — the trust boundary in front of the OSV query (#1769, stage 1).
 *
 * Private package names must never leave the host. A package is sent to OSV
 * only when it provably comes from a public registry; every doubt excludes it
 * (fail closed). Excluded packages are neither findings nor unchecked items —
 * they are out of scope for a public advisory database.
 *
 * Ceiling (BV-004): only the repo's own `.npmrc` files are read (root and next
 * to each lockfile) — not `~/.npmrc`, not `$NPM_CONFIG_*`. A private scope or registry declared
 * only host-wide is caught solely by its `resolved` URL (package-lock); a pnpm
 * lock without tarball URLs then has no second line of defence. Revisit when a
 * fleet repo relies on a host-level scope registry.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const NPM_PUBLIC_HOST = 'registry.npmjs.org';
const PYPI_PUBLIC_HOSTS = new Set(['files.pythonhosted.org', 'pypi.org']);

/** Hostname of a URL, or null when it does not parse. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The registry policy of the `.npmrc` files that govern one lockfile: the repo
 * root's and, when `dir` is a subdirectory, the one next to the lockfile. Both
 * are unioned (fail closed): a private scope or a non-npmjs default registry
 * in either counts. An unparseable registry URL counts as private.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot  repository root
 * @param {string} [opts.dir]     repo-relative directory of the lockfile (default `.`)
 * @returns {{privateScopes: Set<string>, privateDefaultRegistry: boolean}}
 */
export function readNpmrcPolicy({ repoRoot, dir = '.' } = {}) {
  const privateScopes = new Set();
  let privateDefaultRegistry = false;
  const dirs = [...new Set(['.', path.normalize(dir || '.')])];
  for (const d of dirs) {
    let text;
    try {
      text = readFileSync(path.join(repoRoot, d, '.npmrc'), 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const scoped = /^(@[^:\s=]+)\s*:\s*registry\s*=\s*(.+)$/.exec(line);
      const bare = scoped ? null : /^registry\s*=\s*(.+)$/.exec(line);
      const rawUrl = scoped ? scoped[2] : bare?.[1];
      if (rawUrl === undefined) continue;
      const url = rawUrl.trim().replace(/^["']|["']$/g, '');
      if (hostOf(url) === NPM_PUBLIC_HOST) continue;
      if (scoped) privateScopes.add(scoped[1]);
      else privateDefaultRegistry = true;
    }
  }
  return { privateScopes, privateDefaultRegistry };
}

/**
 * Scopes whose registry in the repo-root `.npmrc` is not the public npm registry.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot  repository root
 * @returns {Set<string>} e.g. `@acme-internal`; empty when `.npmrc` is absent
 */
export function readPrivateScopes({ repoRoot } = {}) {
  return readNpmrcPolicy({ repoRoot }).privateScopes;
}

function isPublic(pkg, privateScopes, privateDefaultRegistry) {
  if (!pkg || typeof pkg.name !== 'string' || pkg.name.length === 0) return false;
  for (const scope of privateScopes) {
    if (pkg.name.startsWith(`${scope}/`)) return false;
  }
  const resolved = pkg.resolved ?? null;
  if (pkg.ecosystem === 'npm') {
    // No resolved URL: the package came from the default registry — public only if that is npmjs.
    if (resolved === null) return !privateDefaultRegistry;
    return hostOf(resolved) === NPM_PUBLIC_HOST;
  }
  if (pkg.ecosystem === 'PyPI') {
    return resolved === null || PYPI_PUBLIC_HOSTS.has(hostOf(resolved));
  }
  return false; // unknown ecosystem: no public registry to vouch for it
}

/**
 * Split packages into the ones that may be sent to OSV and a count of the rest.
 * Excluded: a private scope prefix, an npm package not resolved from
 * registry.npmjs.org (or without a resolved URL while the default registry is
 * private), a PyPI package resolved from a non-PyPI host, an unparseable
 * `resolved` URL, or an unknown ecosystem.
 *
 * @param {{ecosystem:string, name:string, resolved?:string|null}[]} packages
 * @param {{privateScopes?: Set<string>, privateDefaultRegistry?: boolean}} [opts]
 * @returns {{public: object[], excluded: number}}
 */
export function filterPublicPackages(packages, { privateScopes = new Set(), privateDefaultRegistry = false } = {}) {
  const pub = [];
  let excluded = 0;
  for (const pkg of packages ?? []) {
    if (isPublic(pkg, privateScopes, privateDefaultRegistry)) pub.push(pkg);
    else excluded += 1;
  }
  return { public: pub, excluded };
}
