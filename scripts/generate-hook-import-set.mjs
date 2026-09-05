#!/usr/bin/env node
/**
 * generate-hook-import-set.mjs — build the committed allowlist of modules that
 * are transitively reachable from a hook entry file (GitLab #1224).
 *
 * WHY: a hook entry file imports a helper module on EVERY tool call. A helper
 * saved in a broken intermediate state (2026-09-04: a call to a function that
 * did not exist yet) turns every Bash/Edit/Write call into "Internal hook error
 * — request blocked", host-wide, for every session sharing the working copy.
 * `hooks/post-edit-import-probe.mjs` checks a file right after it is edited —
 * but only when the file is in THIS set, so the probe stays cheap.
 *
 * The set is a COMMITTED artefact (`hooks/_lib/hook-import-set.json`) rather
 * than a runtime crawl: the probe runs inside a 5 s PostToolUse budget and must
 * not walk 142 modules per edit. `--check` re-generates and diffs, which is the
 * drift guard that keeps the committed copy honest.
 *
 * Usage:
 *   node scripts/generate-hook-import-set.mjs [--plugin-root <dir>] [--out <file>] [--check]
 *
 * Exit codes: 0 = written / in sync; 1 = drift (with --check) or usage error.
 */

import { readFileSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/** The four hook manifests whose entry files seed the crawl. */
export const HOOK_MANIFESTS = [
  'hooks.json',
  'hooks-codex.json',
  'hooks-cursor.json',
  'hooks-pi.json',
];

/** Module extensions the crawl resolves an extension-less specifier against. */
const RESOLVE_EXTS = ['.mjs', '.js', '.cjs'];

/**
 * Collect every `<something>.mjs` path mentioned in a hook manifest's command
 * strings. The manifests differ per platform ($CLAUDE_PLUGIN_ROOT /
 * $PI_PLUGIN_ROOT / ${PLUGIN_ROOT}), so match on the hooks/-relative tail
 * rather than on any one variable spelling.
 *
 * @param {string} json - raw manifest contents
 * @returns {string[]} plugin-root-relative entry paths (e.g. "hooks/enforce-scope.mjs")
 */
export function extractEntryFiles(json) {
  const out = new Set();
  for (const m of json.matchAll(/hooks\/((?:[\w.-]+\/)*[\w.-]+\.mjs)/g)) {
    const rel = `hooks/${m[1]}`;
    // run-node.sh is the launcher, never an entry module; .../hooks/_lib/* is
    // reached through imports, not through a manifest command.
    out.add(rel);
  }
  return [...out].sort();
}

/**
 * Extract relative module specifiers (static import/export-from and dynamic
 * `import()`) from a module's source.
 *
 * @param {string} src
 * @returns {string[]} relative specifiers, e.g. ["./_lib/profile-gate.mjs"]
 */
export function extractRelativeSpecifiers(src) {
  const out = new Set();
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;'"]*?\sfrom\s*['"](\.[^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

/**
 * Resolve a relative specifier against the importing file.
 *
 * @param {string} fromFile - absolute path of the importing module
 * @param {string} spec     - relative specifier
 * @returns {string|null} absolute path of an existing file, or null
 */
function resolveSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...RESOLVE_EXTS.map((e) => base + e),
    ...RESOLVE_EXTS.map((e) => path.join(base, `index${e}`))];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch { /* unreadable → not a resolution */ }
  }
  return null;
}

/**
 * Crawl every hook entry file transitively and return the reachable module set.
 *
 * @param {string} pluginRoot
 * @returns {{file: string, reachable_from: string[]}[]} sorted by `file`
 */
export function buildImportSet(pluginRoot) {
  /** @type {Map<string, Set<string>>} rel path → set of hook entry basenames */
  const reach = new Map();

  const entries = new Set();
  for (const manifest of HOOK_MANIFESTS) {
    const abs = path.join(pluginRoot, 'hooks', manifest);
    if (!existsSync(abs)) continue;
    for (const rel of extractEntryFiles(readFileSync(abs, 'utf8'))) {
      if (existsSync(path.join(pluginRoot, rel))) entries.add(rel);
    }
  }

  for (const entryRel of [...entries].sort()) {
    const entryName = path.basename(entryRel);
    const stack = [path.join(pluginRoot, entryRel)];
    const seen = new Set();
    while (stack.length > 0) {
      const abs = stack.pop();
      if (seen.has(abs)) continue;
      seen.add(abs);

      const rel = path.relative(pluginRoot, abs).split(path.sep).join('/');
      if (!reach.has(rel)) reach.set(rel, new Set());
      reach.get(rel).add(entryName);

      let src;
      try { src = readFileSync(abs, 'utf8'); } catch { continue; }
      for (const spec of extractRelativeSpecifiers(src)) {
        const next = resolveSpecifier(abs, spec);
        if (next) stack.push(next);
      }
    }
  }

  return [...reach.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([file, from]) => ({ file, reachable_from: [...from].sort() }));
}

/**
 * Current HEAD sha of the plugin root, or "unknown" outside a git checkout.
 *
 * @param {string} pluginRoot
 * @returns {string}
 */
function headSha(pluginRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: pluginRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Build the full artefact payload.
 *
 * @param {string} pluginRoot
 * @returns {{generated_at: string, head: string, entries: {file: string, reachable_from: string[]}[]}}
 */
export function buildArtifact(pluginRoot) {
  return {
    generated_at: new Date().toISOString(),
    head: headSha(pluginRoot),
    entries: buildImportSet(pluginRoot),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {number} process exit code
 */
export function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const pluginRoot = path.resolve(flag('--plugin-root') ?? path.resolve(import.meta.dirname, '..'));
  const out = path.resolve(flag('--out') ?? path.join(pluginRoot, 'hooks', '_lib', 'hook-import-set.json'));
  const check = args.includes('--check');

  const fresh = buildArtifact(pluginRoot);

  if (check) {
    if (!existsSync(out)) {
      process.stderr.write(`✗ hook-import-set: ${path.relative(pluginRoot, out)} is missing — run generate-hook-import-set.mjs\n`);
      return 1;
    }
    let committed;
    try { committed = JSON.parse(readFileSync(out, 'utf8')); } catch {
      process.stderr.write('✗ hook-import-set: committed file is not valid JSON\n');
      return 1;
    }
    // Only `entries` is compared — generated_at/head are provenance, not content.
    const a = JSON.stringify(committed.entries ?? null);
    const b = JSON.stringify(fresh.entries);
    if (a !== b) {
      process.stderr.write('✗ hook-import-set: committed set differs from a fresh crawl — run `node scripts/generate-hook-import-set.mjs`\n');
      return 1;
    }
    process.stdout.write(`✓ hook-import-set: ${fresh.entries.length} modules, in sync\n`);
    return 0;
  }

  writeFileSync(out, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
  process.stdout.write(`✓ hook-import-set: wrote ${fresh.entries.length} modules to ${path.relative(pluginRoot, out)}\n`);
  return 0;
}

/**
 * True when this module was launched as the process entry script.
 *
 * A string compare of `import.meta.url` against `file://${process.argv[1]}` is
 * fragile in exactly the invocations CI and husky use: any symlinked or
 * realpath-differing path (measured: `/tmp` → `/private/tmp` on macOS) makes
 * the compare false, so the whole CLI body becomes a silent no-op that still
 * exits 0 — a fail-OPEN drift gate. A space or `#` in the path breaks the
 * hand-built URL the same way. Same shape as `hooks/post-bash-write-verify.mjs`.
 *
 * @returns {boolean}
 */
function invokedAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    // argv[1] unresolvable (deleted/renamed mid-run) — best-effort raw compare.
    return entry === self;
  }
}

if (invokedAsScript()) {
  process.exit(main(process.argv));
}
