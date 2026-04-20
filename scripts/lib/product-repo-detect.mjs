/**
 * product-repo-detect.mjs — #190
 * Detects product-repo signals in a repo root. Returns scored signal object.
 *
 * Stdlib-only, cross-platform, no zx, never throws.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FRAMEWORK_DEPS = [
  'next',
  'nuxt',
  'astro',
  '@remix-run/react',
  '@remix-run/node',
  '@sveltejs/kit',
];

const PRODUCT_ENV_PATTERNS = [
  /^SUPABASE_URL=/m,
  /^SUPABASE_ANON_KEY=/m,
  /^STRIPE_[A-Z_]+=/ ,
  /^(NEXT_PUBLIC_)?AUTH0_[A-Z_]+=/m,
  /^(NEXT_PUBLIC_)?CLERK_[A-Z_]+=/m,
  /^(NEXT_PUBLIC_)?FIREBASE_[A-Z_]+=/m,
  /^(NEXT_PUBLIC_)?POSTHOG_[A-Z_]+=/m,
  /^SENTRY_DSN=/m,
];

const CONTENT_DIRS = ['src/lib/personas', 'src/content', 'content', 'src/data/personas'];

/**
 * @param {{ repoRoot: string }} opts
 * @returns {{
 *   isProductRepo: boolean,
 *   framework: string | null,
 *   contentDirs: string[],
 *   productEnvMatches: string[],
 *   score: number,
 *   signals: { framework: boolean, contentDir: boolean, envVars: boolean }
 * }}
 */
export function detectProductRepo({ repoRoot } = {}) {
  // 1) framework detection
  let framework = null;
  const pkgPath = join(repoRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {}),
      };
      for (const dep of FRAMEWORK_DEPS) {
        if (dep in deps) {
          framework = dep;
          break;
        }
      }
    } catch {
      /* malformed package.json — no framework match */
    }
  }

  // 2) content dirs
  const contentDirs = CONTENT_DIRS.filter((d) => existsSync(join(repoRoot, d)));

  // 3) env var matches
  const productEnvMatches = [];
  const envPath = join(repoRoot, '.env.local.example');
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const re of PRODUCT_ENV_PATTERNS) {
        const m = content.match(re);
        if (m) productEnvMatches.push(m[0].split('=')[0]);
      }
    } catch {
      /* unreadable — ignore */
    }
  }

  const signals = {
    framework: framework !== null,
    contentDir: contentDirs.length > 0,
    envVars: productEnvMatches.length > 0,
  };
  const score =
    (signals.framework ? 2 : 0) + (signals.contentDir ? 1 : 0) + (signals.envVars ? 2 : 0);
  return {
    isProductRepo: score >= 2,
    framework,
    contentDirs,
    productEnvMatches,
    score,
    signals,
  };
}

/**
 * Check whether CLAUDE.md (or AGENTS.md) already has a `vault:` key in Session Config.
 * @param {string} configFilePath
 * @returns {boolean}
 */
export function hasVaultConfig(configFilePath) {
  if (!existsSync(configFilePath)) return false;
  let text;
  try {
    text = readFileSync(configFilePath, 'utf8');
  } catch {
    return false;
  }
  // Locate Session Config block and scan for vault:.
  // Capture everything from the Session Config heading up to (but not including)
  // the next ## heading, or the end of the string. Use a two-step approach:
  // 1) find the start offset of the Session Config section
  // 2) find the next ## heading after it (or end of string)
  const startMatch = text.match(/^## Session Config[ \t]*(?:\r?\n|$)/m);
  if (!startMatch || startMatch.index === undefined) return false;
  const blockStart = startMatch.index + startMatch[0].length;
  const afterBlock = text.slice(blockStart);
  // Find the start of the next level-2 heading
  const nextHeadingMatch = afterBlock.match(/^## /m);
  const blockContent = nextHeadingMatch
    ? afterBlock.slice(0, nextHeadingMatch.index)
    : afterBlock;
  return /^\s*vault\s*:/m.test(blockContent);
}
