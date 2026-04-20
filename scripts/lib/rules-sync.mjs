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

const PLUGIN_HEADER_PREFIX = '<!-- source: session-orchestrator plugin';

/**
 * Parses the _index.md file and returns an array of source file paths for each
 * requested category. Each path is relative to pluginRoot.
 *
 * @param {string} indexContent - raw content of rules/_index.md
 * @param {string[]} categories - e.g. ['always-on']
 * @returns {string[]} array of relative paths like 'rules/always-on/parallel-sessions.md'
 */
function parseIndex(indexContent, categories) {
  const paths = [];

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

    // Extract bullet items: - `always-on/some-file.md` — description
    const bulletRe = /^-\s+`([^`]+\.md)`/gm;
    let match;
    while ((match = bulletRe.exec(sectionBody)) !== null) {
      paths.push(`rules/${match[1]}`);
    }
  }

  return paths;
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
 * @param {{
 *   pluginRoot: string,
 *   repoRoot: string,
 *   categories?: string[],
 *   dryRun?: boolean
 * }} opts
 * @returns {{
 *   written: string[],
 *   skipped: string[],
 *   preserved: string[],
 *   errors: Array<{file: string, reason: string}>
 * }}
 */
export function syncRules({ pluginRoot, repoRoot, categories = ['always-on'], dryRun = false } = {}) {
  const written = [];
  const skipped = [];
  const preserved = [];
  const errors = [];

  if (!pluginRoot || typeof pluginRoot !== 'string') {
    errors.push({ file: '_index.md', reason: 'pluginRoot not provided' });
    return { written, skipped, preserved, errors };
  }
  if (!repoRoot || typeof repoRoot !== 'string') {
    errors.push({ file: '_index.md', reason: 'repoRoot not provided' });
    return { written, skipped, preserved, errors };
  }

  const indexPath = join(pluginRoot, 'rules', '_index.md');
  if (!existsSync(indexPath)) {
    errors.push({ file: '_index.md', reason: `_index.md not found at ${indexPath}` });
    return { written, skipped, preserved, errors };
  }

  let indexContent;
  try {
    indexContent = readFileSync(indexPath, 'utf8');
  } catch (err) {
    errors.push({ file: '_index.md', reason: `failed to read _index.md: ${err.message}` });
    return { written, skipped, preserved, errors };
  }

  const sourcePaths = parseIndex(indexContent, categories);

  if (sourcePaths.length === 0) {
    // No sources resolved — could be empty categories or malformed index
    for (const cat of categories) {
      errors.push({
        file: `rules/${cat}/*.md`,
        reason: `no sources resolved for category '${cat}' in _index.md`,
      });
    }
    return { written, skipped, preserved, errors };
  }

  const targetDir = join(repoRoot, '.claude', 'rules');

  for (const relPath of sourcePaths) {
    const srcPath = join(pluginRoot, relPath);
    const fileName = basename(relPath);
    const targetPath = join(targetDir, fileName);

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

  return { written, skipped, preserved, errors };
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

  const repoRoot = getArg('--repo-root');
  const dryRun = args.includes('--dry-run');

  if (!repoRoot) {
    process.stderr.write('rules-sync: error: --repo-root <path> is required\n');
    process.exit(1);
  }

  // Plugin root is two directories up from scripts/lib/
  const pluginRoot = resolve(__dirname, '..', '..');

  const result = syncRules({ pluginRoot, repoRoot, dryRun });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.errors.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}
