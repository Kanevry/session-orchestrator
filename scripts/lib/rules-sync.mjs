/**
 * rules-sync.mjs — #191
 * Syncs canonical rules from the plugin's rules/ library into a consumer repo's .claude/rules/.
 *
 * Stdlib-only, cross-platform, no Zod, no third-party parsers. ESM module.
 * Preserves local rules (files without the plugin source header).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRuleContent } from './validate-vendored-rules.mjs';

// Exported (issue #722 Epic A Wave 2) for external consumers (e.g. tests).
// NOT imported by validate-vendored-rules.mjs — that module imports
// validateRuleContent FROM this file (see the pre-write gate below), so
// importing this constant back would create a module-load cycle; it keeps
// its own textually-identical copy instead.
export const PLUGIN_HEADER_PREFIX = '<!-- source: session-orchestrator plugin';

/**
 * Parses the _index.md file and returns an array of entries for each
 * requested category. Each entry's `relPath` is relative to pluginRoot.
 *
 * Supports the optional trailing `[archetypes: a, b]` tag (issue #722 Epic A
 * Wave 3) on a bullet line:
 *
 *   - `opt-in-stack/foo.md` — description [archetypes: nextjs-minimal, node-minimal]
 *
 * A bullet without the tag resolves to `archetypes: null` (universal —
 * vendored to every consumer repo, matching pre-Wave-3 behavior exactly).
 * Archetype values are lower-cased at parse time so downstream comparison is
 * always case-insensitive.
 *
 * @param {string} indexContent - raw content of rules/_index.md
 * @param {string[]} categories - e.g. ['always-on']
 * @returns {Array<{relPath: string, archetypes: string[]|null}>} entries like
 *   { relPath: 'rules/always-on/parallel-sessions.md', archetypes: null }
 */
function parseIndex(indexContent, categories) {
  const entries = [];

  for (const category of categories) {
    // Match the section header for this category
    const sectionRe = new RegExp(`^##\\s+${escapeRegex(category)}[^\\n]*$`, 'm');
    const sectionMatch = sectionRe.exec(indexContent);
    if (!sectionMatch) continue;

    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    // Everything until the next ## heading (or end of file)
    const nextSectionMatch = /^##\s+/m.exec(indexContent.slice(sectionStart));
    const sectionEnd =
      nextSectionMatch !== null
        ? sectionStart + nextSectionMatch.index
        : indexContent.length;

    const sectionBody = indexContent.slice(sectionStart, sectionEnd);

    // Extract bullet items: - `always-on/some-file.md` — description [archetypes: a, b]
    const bulletRe = /^-\s+`([^`]+\.md)`([^\n]*)$/gm;
    let match;
    while ((match = bulletRe.exec(sectionBody)) !== null) {
      const relPath = `rules/${match[1]}`;
      const rest = match[2] ?? '';
      const archetypeMatch = /\[archetypes:\s*([^\]]+)\]/i.exec(rest);
      const archetypes = archetypeMatch
        ? archetypeMatch[1]
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : null;
      entries.push({ relPath, archetypes });
    }
  }

  return entries;
}

function listManifestCategories(indexContent) {
  const categories = [];
  const headingRe = /^##\s+([^\n]+)$/gm;
  let headingMatch;
  while ((headingMatch = headingRe.exec(indexContent)) !== null) {
    const headingText = headingMatch[1].trim();
    const category = headingText.split(/\s+/)[0];
    const sectionStart = headingMatch.index + headingMatch[0].length;
    const nextSectionMatch = /^##\s+/m.exec(indexContent.slice(sectionStart));
    const sectionEnd =
      nextSectionMatch !== null
        ? sectionStart + nextSectionMatch.index
        : indexContent.length;
    const sectionBody = indexContent.slice(sectionStart, sectionEnd);
    const bulletRe = /^-\s+`([^`]+\.md)`/gm;
    let bulletMatch;
    while ((bulletMatch = bulletRe.exec(sectionBody)) !== null) {
      const rel = bulletMatch[1];
      if (rel.includes('<')) continue;
      categories.push(category);
      break;
    }
  }
  return categories;
}

/**
 * Resolves the target repo's archetype (issue #722 Epic A Wave 3).
 *
 * Precedence: explicit `archetype` argument (CLI `--archetype` / caller
 * override) beats `.orchestrator/bootstrap.lock` resolution. When neither is
 * available, or the lock file's `archetype:` value is absent/`null`, the
 * archetype is "unknown" — archetype-scoped entries are skipped, universal
 * entries still vendor.
 *
 * @param {string} repoRoot
 * @param {string|null} explicitArchetype
 * @returns {{archetype: string|null, known: boolean}}
 */
function resolveArchetype(repoRoot, explicitArchetype) {
  if (explicitArchetype) {
    return { archetype: explicitArchetype.trim().toLowerCase(), known: true };
  }

  const lockPath = join(repoRoot, '.orchestrator', 'bootstrap.lock');
  if (!existsSync(lockPath)) {
    return { archetype: null, known: false };
  }

  let lockContent;
  try {
    lockContent = readFileSync(lockPath, 'utf8');
  } catch {
    return { archetype: null, known: false };
  }

  const m = /^archetype:\s*(.+?)\s*$/m.exec(lockContent);
  if (!m) return { archetype: null, known: false };

  let value = m[1].replace(/\s+#.*$/, '').trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!value || value.toLowerCase() === 'null') {
    return { archetype: null, known: false };
  }

  return { archetype: value.toLowerCase(), known: true };
}

/**
 * Escapes a string for use in a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Syncs canonical rules from the plugin's rules/ library into a consumer repo.
 *
 * When `validate` is true (the default — issue #722 Epic A Wave 2),
 * validateRuleContent() runs as a pre-write gate on every source file before
 * it is copied. A file with any error-severity violation (paths-frontmatter,
 * missing provenance header, unfilled placeholder) is recorded in `errors[]`
 * and its write is skipped entirely — it is never added to
 * written/skipped/preserved. Warn-severity violations (zero-match-globs,
 * foreign-glob) do NOT block the write; they are collected into the
 * additive `warnings[]` array instead. `requireProvenance` (default `true`)
 * is forwarded to that gate call — pass `false` only for test fixtures that
 * intentionally exercise unprovenanced content.
 *
 * Archetype filtering (issue #722 Epic A Wave 3): an `_index.md` entry may
 * carry a trailing `[archetypes: a, b]` tag (see `rules/_index.md` § Entry
 * syntax). When present, the entry is vendored ONLY when it matches the
 * target repo's resolved archetype — explicit `archetype` argument first,
 * falling back to `<repoRoot>/.orchestrator/bootstrap.lock`'s `archetype:`
 * line. A mismatch is recorded in `skipped[]` as
 * `{ file, reason: 'archetype-mismatch' }`; an unresolvable target archetype
 * is recorded as `{ file, reason: 'archetype-unknown' }`. Untagged
 * (universal) entries always vendor, unaffected by archetype resolution —
 * this preserves full backward compatibility with pre-Wave-3 `_index.md`
 * files and callers that never pass `archetype`.
 *
 * When `categories` is null/omitted, sync every `_index.md` category that has
 * at least one concrete bullet entry. This keeps `/bootstrap --sync-rules`
 * ready for future opt-in categories without requiring CLI changes.
 *
 * @param {{
 *   pluginRoot: string,
 *   repoRoot: string,
 *   categories?: string[]|null,
 *   dryRun?: boolean,
 *   validate?: boolean,
 *   requireProvenance?: boolean,
 *   archetype?: string|null
 * }} opts
 * @returns {{
 *   written: string[],
 *   skipped: Array<string|{file: string, reason: string}>,
 *   preserved: string[],
 *   errors: Array<{file: string, reason: string}>,
 *   warnings: Array<{file: string, reason: string}>
 * }}
 */
export function syncRules({
  pluginRoot,
  repoRoot,
  categories = null,
  dryRun = false,
  validate = true,
  requireProvenance = true,
  archetype = null,
} = {}) {
  const written = [];
  const skipped = [];
  const preserved = [];
  const errors = [];
  const warnings = [];

  if (!pluginRoot || typeof pluginRoot !== 'string') {
    errors.push({ file: '_index.md', reason: 'pluginRoot not provided' });
    return { written, skipped, preserved, errors, warnings };
  }
  if (!repoRoot || typeof repoRoot !== 'string') {
    errors.push({ file: '_index.md', reason: 'repoRoot not provided' });
    return { written, skipped, preserved, errors, warnings };
  }

  const indexPath = join(pluginRoot, 'rules', '_index.md');
  if (!existsSync(indexPath)) {
    errors.push({ file: '_index.md', reason: `_index.md not found at ${indexPath}` });
    return { written, skipped, preserved, errors, warnings };
  }

  let indexContent;
  try {
    indexContent = readFileSync(indexPath, 'utf8');
  } catch (err) {
    errors.push({ file: '_index.md', reason: `failed to read _index.md: ${err.message}` });
    return { written, skipped, preserved, errors, warnings };
  }

  const selectedCategories = Array.isArray(categories)
    ? categories
    : listManifestCategories(indexContent);
  const entries = parseIndex(indexContent, selectedCategories);

  if (entries.length === 0) {
    // No sources resolved — could be empty categories or malformed index
    for (const cat of selectedCategories.length > 0 ? selectedCategories : ['<none>']) {
      errors.push({
        file: `rules/${cat}/*.md`,
        reason: `no sources resolved for category '${cat}' in _index.md`,
      });
    }
    return { written, skipped, preserved, errors, warnings };
  }

  const targetDir = join(repoRoot, '.claude', 'rules');
  const resolvedArchetype = resolveArchetype(repoRoot, archetype);
  const targetBasenames = new Map();

  for (const entry of entries) {
    const { relPath, archetypes } = entry;

    // Archetype filter (issue #722 Epic A Wave 3) — evaluated before any
    // file IO, so a skip never triggers a spurious "source file not found".
    if (archetypes !== null) {
      if (!resolvedArchetype.known) {
        skipped.push({ file: relPath, reason: 'archetype-unknown' });
        continue;
      }
      if (!archetypes.includes(resolvedArchetype.archetype)) {
        skipped.push({ file: relPath, reason: 'archetype-mismatch' });
        continue;
      }
    }

    const srcPath = join(pluginRoot, relPath);
    const fileName = basename(relPath);
    const targetPath = join(targetDir, fileName);
    if (targetBasenames.has(fileName)) {
      errors.push({
        file: relPath,
        reason: `duplicate target filename '${fileName}' also used by ${targetBasenames.get(fileName)}`,
      });
      continue;
    }
    targetBasenames.set(fileName, relPath);

    if (!existsSync(srcPath)) {
      errors.push({ file: relPath, reason: `source file not found: ${srcPath}` });
      continue;
    }

    let srcContent;
    try {
      srcContent = readFileSync(srcPath, 'utf8');
    } catch (err) {
      errors.push({ file: relPath, reason: `failed to read source: ${err.message}` });
      continue;
    }

    // Pre-write validation gate (issue #722 Epic A Wave 2). Runs BEFORE the
    // existsSync(targetPath) write-decision branch below, so a validation
    // failure skips the write regardless of whether the target already
    // exists, is stale, or is missing.
    if (validate) {
      const validation = validateRuleContent({
        content: srcContent,
        relPath,
        requireProvenance,
        targetRoot: repoRoot,
      });
      const errorViolations = validation.violations.filter((v) => v.severity === 'error');
      if (errorViolations.length > 0) {
        errors.push({
          file: relPath,
          reason: `validation-failed: ${errorViolations.map((v) => v.rule).join(', ')}`,
        });
        continue;
      }
      const warnViolations = validation.violations.filter((v) => v.severity === 'warn');
      for (const v of warnViolations) {
        warnings.push({ file: relPath, reason: `${v.rule}: ${v.message}` });
      }
    }

    if (existsSync(targetPath)) {
      let targetContent;
      try {
        targetContent = readFileSync(targetPath, 'utf8');
      } catch (err) {
        errors.push({ file: targetPath, reason: `failed to read target: ${err.message}` });
        continue;
      }

      const firstLine = targetContent.split('\n')[0] ?? '';
      if (!firstLine.startsWith(PLUGIN_HEADER_PREFIX)) {
        // Local file — preserve it
        preserved.push(fileName);
        continue;
      }

      if (targetContent === srcContent) {
        // Already up to date
        skipped.push(fileName);
        continue;
      }

      // Plugin-owned file with stale content — overwrite
      if (!dryRun) {
        try {
          writeFileSync(targetPath, srcContent, 'utf8');
        } catch (err) {
          errors.push({ file: targetPath, reason: `failed to write: ${err.message}` });
          continue;
        }
      }
      written.push(fileName);
    } else {
      // Target does not exist — write it
      if (!dryRun) {
        try {
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(targetPath, srcContent, 'utf8');
        } catch (err) {
          errors.push({ file: targetPath, reason: `failed to write: ${err.message}` });
          continue;
        }
      }
      written.push(fileName);
    }
  }

  return { written, skipped, preserved, errors, warnings };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Detect direct execution: node scripts/lib/rules-sync.mjs
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== null &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(__filename);

if (isMain) {
  const args = process.argv.slice(2);

  function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  function getAllArgs(name) {
    const values = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === name && args[i + 1]) values.push(args[i + 1]);
    }
    return values;
  }

  const repoRoot = getArg('--repo-root');
  const dryRun = args.includes('--dry-run');
  // Explicit archetype override (issue #722 Epic A Wave 3) — beats
  // .orchestrator/bootstrap.lock resolution inside syncRules().
  const archetype = getArg('--archetype') ?? null;
  const categoryArgs = [
    ...getAllArgs('--category'),
    ...(getArg('--categories') ?? '').split(','),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const categories = categoryArgs.length > 0 ? categoryArgs : null;

  if (!repoRoot) {
    process.stderr.write('rules-sync: error: --repo-root <path> is required\n');
    process.exit(1);
  }

  // Plugin root is two directories up from scripts/lib/
  const pluginRoot = resolve(__dirname, '..', '..');

  const result = syncRules({ pluginRoot, repoRoot, dryRun, archetype, categories });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.errors.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}
