#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync, realpathSync, lstatSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { join, extname, relative, basename, sep, resolve, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

function canonicalPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
const isMain =
  argv[1] !== undefined &&
  canonicalPath(resolve(argv[1])) === canonicalPath(fileURLToPath(import.meta.url));

const pluginRoot = argv[2] ? canonicalPath(resolve(argv[2])) : argv[2];
const includeUntracked = argv.slice(3).includes('--include-untracked');
const requireOwnerPatterns = argv.slice(3).includes('--require-owner-patterns');
const packedIndex = argv.indexOf('--packed-files');
const packedInventoryPath = packedIndex >= 0 ? argv[packedIndex + 1] : null;
if (isMain && packedIndex >= 0 && (!packedInventoryPath || packedInventoryPath.startsWith('--'))) {
  console.error('packed-files requires an inventory path'); process.exit(1);
}
if (isMain && !pluginRoot) {
  console.error('Usage: check-owner-leakage.mjs <plugin-root> [--include-untracked]');
  process.exit(1);
}

// Host policy stays outside source and package; this file remains standalone.
export const VAULT_CLEAR_SLUGS = new Set();

// Mirrors the zero-import private-config-dir resolver because vendored copies carry this file alone.
const POLICY_KEYS = ['usernamePrefixes', 'privateHosts', 'eventsHosts', 'privateDomains', 'packageScopes', 'privateSlugs', 'vaultClearSlugs', 'personalNames', 'publicEmails', 'publicUrls'];
const POLICY_LIMIT_BYTES = 65536; // At most 256 literals per class; revisit only with measured larger policies.
let ownerCache;
let compiledOwnerState;
let compiledOwnerRules;
function policySource(env = process.env) {
  const own = (env.SO_CONFIG_HOME || '').trim();
  const xdg = (env.XDG_CONFIG_HOME || '').trim();
  const dir = own || (xdg ? join(xdg, 'session-orchestrator') : join(homedir(), '.config', 'session-orchestrator'));
  return (env.SO_OWNER_PATTERNS_FILE || '').trim() || join(dir, 'owner-patterns.json');
}
function checkedHostFile(filename) {
  if (!isAbsolute(filename)) throw new Error('unsafe');
  // Canonical OS aliases (/tmp on macOS) are allowed above the private source parent.
  let cursor = dirname(filename);
  const parent = lstatSync(cursor);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022)) throw new Error('unsafe');
  const canonicalParent = realpathSync(cursor);
  // Reject repo-local data even if ignored; walk every ancestor for a .git marker.
  cursor = canonicalParent;
  while (true) {
    if (existsSync(join(cursor, '.git'))) throw new Error('unsafe');
    const next = dirname(cursor); if (next === cursor) break; cursor = next;
  }
  // Reject user-controlled intermediate symlinks; OS-owned /var and /tmp aliases are trusted.
  cursor = dirname(filename);
  while (cursor !== dirname(cursor)) {
    const st = lstatSync(cursor);
    if ((st.isSymbolicLink() && st.uid !== 0) || (st.uid !== 0 && (st.mode & 0o022))) throw new Error('unsafe');
    cursor = dirname(cursor);
  }
  const st = lstatSync(filename);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o7777) !== 0o600 || st.nlink !== 1 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new Error('unsafe');
  if (st.size > POLICY_LIMIT_BYTES) throw new Error('invalid');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev || (opened.mode & 0o7777) !== 0o600 || opened.size > POLICY_LIMIT_BYTES) throw new Error('unsafe');
    const raw = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) > POLICY_LIMIT_BYTES) throw new Error('invalid');
    return raw;
  } finally { closeSync(fd); }
}
export function inspectOwnerPatterns({ filePath, env = process.env, refresh = false } = {}) {
  const filename = filePath ?? policySource(env);
  if (!refresh && ownerCache?.filename === filename) return ownerCache.result;
  let result;
  try {
    const policy = JSON.parse(checkedHostFile(filename));
    if (!policy || Array.isArray(policy) || policy.version !== 1 || Object.keys(policy).some((key) => key !== 'version' && !POLICY_KEYS.includes(key))) throw new Error('invalid');
    for (const key of POLICY_KEYS) {
      if (!Object.hasOwn(policy, key)) policy[key] = [];
      if (!Array.isArray(policy[key]) || policy[key].length > 256 || policy[key].some((v) => typeof v !== 'string' || !v.trim() || v.length > 256 || v !== v.trim() || [...v].some((c) => c.charCodeAt(0) < 32))) throw new Error('invalid');
    }
    if (policy.vaultClearSlugs.some((slug) => !policy.privateSlugs.some((s) => s.toLowerCase() === slug.toLowerCase()))) throw new Error('invalid');
    if (!POLICY_KEYS.slice(0, 6).concat('personalNames').some((key) => policy[key].length)) throw new Error('invalid');
    result = { status: 'ok', policy };
  } catch (err) {
    result = { status: err.code === 'ENOENT' ? 'missing' : err.message === 'unsafe' || err.code === 'ELOOP' ? 'unsafe' : 'invalid', reason: err.code ?? (err.message === 'unsafe' ? 'unsafe-source' : 'invalid-source') };
  }
  ownerCache = {filename, result};
  VAULT_CLEAR_SLUGS.clear();
  for (const slug of result.policy?.vaultClearSlugs ?? []) VAULT_CLEAR_SLUGS.add(slug.toLowerCase());
  return result;
}
function countMatches(re, value) { return (value.match(re) || []).length; }

function literalRegex(values, flags = '', prefix = '', suffix = '') {
  return new RegExp(values.length ? prefix + '(?:' + values.map(escapeRegex).join('|') + ')' + suffix : '(?!)', flags);
}
function currentOwnerRules() {
  const state = inspectOwnerPatterns();
  if (compiledOwnerState === state) return compiledOwnerRules;
  const policy = state.policy ?? Object.fromEntries(POLICY_KEYS.map((key) => [key, []]));
  const insensitiveToken = (token) => [...token].map((c) => /[a-z]/i.test(c) ? '[' + c.toLowerCase() + c.toUpperCase() + ']' : escapeRegex(c)).join('');
  const prefix = policy.usernamePrefixes.map(insensitiveToken).join('|') || '(?!)';
  compiledOwnerState = state;
  compiledOwnerRules = {
    ...state, policy,
    CP1_CANON: new RegExp('/Users/(?:' + prefix + ')[a-z.]*(/|\\b)'),
    CP1_BARE: new RegExp('^(?:' + prefix + ')[a-z]*$'),
    SCANNER_REGEX_QUOTE_BLANK_G: new RegExp('(Users.)(?:' + prefix + ')(\\[)', 'g'),
    CP2: literalRegex(policy.privateHosts, '', '\\b', '\\b'),
    CP3: literalRegex(policy.eventsHosts, '', '\\b', '\\b'),
    CP3_G: literalRegex(policy.eventsHosts, 'g', '\\b', '\\b'),
    CP4: literalRegex(policy.packageScopes, '', '@', '/[A-Za-z0-9*_-]+'),
    CP5_WITH_GOTZ: /DEFAULT_GITLAB_HOST/,
    CP5_EXPORT: /\bexport\b.*\bconst\b.*\bDEFAULT_GITLAB_HOST\b/,
    CP6_PATTERNS: policy.privateSlugs.map((slug) => literalRegex([slug], 'i', '\\b', '\\b')),
    CP6_INPROCESS_PATTERNS: policy.privateSlugs.filter((slug) => !VAULT_CLEAR_SLUGS.has(slug.toLowerCase())).map((slug) => literalRegex([slug], 'i', '\\b', '\\b')),
    CP7: literalRegex(policy.privateDomains), CP7_G: literalRegex(policy.privateDomains, 'g'),
    CP10_PATTERNS: policy.personalNames.map((name) => literalRegex([name], '', '(?:~|/Users/[^/]+|/home/[^/]+)/Projects/', '(\\/|\\b)')),
    redactionPatterns: POLICY_KEYS.filter((key) => !key.startsWith('public')).flatMap((key) => policy[key].map((value) => literalRegex([value], 'i'))),
  };
  return compiledOwnerRules;
}
function getPackedFiles() {
  // npm's JSON inventory is bounded; filenames alone never constitute a content scan.
  const inventoryFd = openSync(packedInventoryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw;
  try {
    const stat = fstatSync(inventoryFd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('invalid-inventory');
    raw = readFileSync(inventoryFd, 'utf8');
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('inventory-too-large');
  } finally { closeSync(inventoryFd); }
  const inventory = JSON.parse(raw);
  const files = Array.isArray(inventory) && inventory.length === 1 ? inventory[0]?.files : null;
  if (!Array.isArray(files) || !files.length || files.length > 20000) throw new Error('invalid-inventory');
  const root = pluginRoot;
  return [...new Set(files.map((entry) => {
    const name = entry?.path;
    if (typeof name !== 'string' || !name || name.length > 4096 || isAbsolute(name) || name.split('/').some((part) => part === '..' || part === '.' || !part) || (name.includes('\\') || [...name].some((c) => c.charCodeAt(0) < 32))) throw new Error('unsafe-inventory');
    let current = root;
    for (const part of name.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('unsafe-inventory'); }
    if (!lstatSync(current).isFile()) throw new Error('invalid-inventory-entry');
    return current;
  }))];
}

const HOMOGLYPH_SLASHES = /[⁄∕／⧸╱]/g; // ⁄ ∕ ／ ⧸ ╱
const HOMOGLYPH_DASHES =
  /[‐‑‒–—―−﹘﹣－]/g; // ‐ ‑ ‒ – — ― − ﹘ ﹣ －

const ZERO_WIDTH_FORMAT = new RegExp(
  '(?:' +
    ['\\u0009', '\\u00ad', '\\u200b', '\\u200c', '\\u200d', '\\u2060', '\\ufeff'].join('|') +
    ')',
  'gu',
);

function printableAsciiFromCodePoint(cp) {
  return cp >= 0x20 && cp <= 0x7e ? String.fromCharCode(cp) : null;
}

function decodePercent(s) {
  let out = s.replace(/%u([0-9a-fA-F]{4})/g, (_m, hex) => {
    const cp = parseInt(hex, 16);
    const ch = printableAsciiFromCodePoint(cp);
    return ch === null ? _m : ch;
  });
  out = out.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => {
    const cp = parseInt(hex, 16);
    const ch = printableAsciiFromCodePoint(cp);
    return ch === null ? _m : ch;
  });
  return out;
}

function decodeUnicodeEscapes(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => {
    const cp = parseInt(hex, 16);
    const ch = printableAsciiFromCodePoint(cp);
    return ch === null ? _m : ch;
  });
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&sol;/gi, '/')
    .replace(/&period;/gi, '.')
    .replace(/&(?:dash|hyphen);/gi, '-')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const ch = printableAsciiFromCodePoint(parseInt(hex, 16));
      return ch === null ? _m : ch;
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const ch = printableAsciiFromCodePoint(parseInt(dec, 10));
      return ch === null ? _m : ch;
    });
}

export function canonicalizeLine(line, { preserveDashes = false } = {}) {
  let s = String(line);
  s = s.replace(ZERO_WIDTH_FORMAT, '');
  for (let i = 0; i < 12; i++) {
    const before = s;
    s = s.replace(ZERO_WIDTH_FORMAT, '');
    s = decodePercent(s);
    s = decodeUnicodeEscapes(s);
    s = decodeHtmlEntities(s);
    if (s === before) break; // fixpoint reached
  }
  s = s.replace(HOMOGLYPH_SLASHES, '/').replace(HOMOGLYPH_DASHES, '-');
  s = s.replace(/\\/g, '/');
  if (!preserveDashes) s = s.replace(/-+/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  return s;
}

const CP8 = /(?:\b10(?:\.\d{1,3}){3}|\b192\.168(?:\.\d{1,3}){2}|\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})/;

const CP8_ALLOWLIST = new Set(['tests/scripts/export-hw-learnings.test.mjs']);

export function matchOwnerPath(line) {
  const { CP1_CANON, SCANNER_REGEX_QUOTE_BLANK_G } = currentOwnerRules();
  const residue = canonicalizeLine(line).replace(SCANNER_REGEX_QUOTE_BLANK_G, '$1__REGEXQUOTE__$2');
  return CP1_CANON.test(residue) ? 'CP1 (personal home path — canonicalized)' : null;
}

const CP10_ALLOWLIST = new Set([
  'tests/scripts/vault-consolidate.test.mjs',
  'tests/scripts/migrate-vault-paths.test.mjs',
  'tests/lib/migrate-vault-paths-pure.test.mjs',
  'tests/lib/cli-flags.test.mjs',
  'tests/lib/config/vault-integration.test.mjs',
  'tests/skills/claude-md-drift-check/checker.test.mjs',
  'scripts/migrate-vault-paths.mjs',
  'scripts/vault-consolidate.mjs',
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CP11_DIRECT_SIBLING_URLS = new Set(
  ['../config/host-paths.mjs', './confidential-names.mjs', '../owner-yaml.mjs'].map(
    (spec) => new URL(spec, import.meta.url).href,
  ),
);

function isMissingDirectSibling(err) {
  return typeof err?.url === 'string' && CP11_DIRECT_SIBLING_URLS.has(err.url);
}

function rawConfidentialNamesKeyState(ownerYamlPath) {
  let parsed;
  try {
    const yaml = createRequire(import.meta.url)('js-yaml');
    parsed = yaml.load(readFileSync(ownerYamlPath, 'utf8'));
  } catch {
    return 'unknown';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  const paths = parsed.paths;
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) return 'absent';
  const value = paths['confidential-names-file'];
  if (value === undefined || value === null) return 'absent';
  if (typeof value === 'string' && value.trim() === '') return 'absent';
  return 'configured';
}

export async function getConfidentialNamePatterns({ loadHostPaths } = {}) {
  let helpers;
  try {
    helpers = {
      hostPaths: await import('../config/host-paths.mjs'),
      confidentialNames: await import('./confidential-names.mjs'),
      ownerYaml: await import('../owner-yaml.mjs'),
    };
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && isMissingDirectSibling(err)) {
      const envNamesPath = process.env.SO_CONFIDENTIAL_NAMES_FILE;
      if (typeof envNamesPath === 'string' && envNamesPath.trim() !== '') {
        return {
          patterns: [],
          disabledReason:
            'CP11 configured via SO_CONFIDENTIAL_NAMES_FILE but the confidential-names helpers are not resolvable (standalone copy) — failing closed',
        };
      }
      return {
        patterns: [],
        inertWarn: 'CP11 inert — confidential-names helpers not resolvable (standalone copy)',
      };
    }
    return { patterns: [], disabledReason: `confidential-names helpers failed to load (${err?.name ?? 'Error'})` };
  }

  try {
    const { resolveHostPath } = helpers.hostPaths;
    const { inspectConfidentialNames } = helpers.confidentialNames;
    const { resolveOwnerYamlPath } = helpers.ownerYaml;

    const hostCtx = (loadHostPaths ?? helpers.hostPaths.loadHostPaths)();

    if (
      hostCtx.ownerConfig === undefined &&
      hostCtx.source === undefined &&
      hostCtx.reason === undefined
    ) {
      return {
        patterns: [],
        disabledReason:
          'CP11 could not determine whether a confidential-names file is configured (owner config loader failed) — failing closed',
      };
    }

    const namesPath = resolveHostPath('confidential-names-file', '', hostCtx);

    if (typeof namesPath !== 'string' || namesPath.trim() === '') {
      if (existsSync(resolveOwnerYamlPath())) {
        if (hostCtx.reason === 'yaml-parser-missing') {
          return {
            patterns: [],
            disabledReason:
              "owner.yaml exists but 'js-yaml' is not installed, so a configured confidential-names-file cannot be resolved (run 'npm install')",
          };
        }
        if (hostCtx.reason === 'unparseable') {
          return {
            patterns: [],
            disabledReason:
              'owner.yaml exists but could not be parsed, so a configured confidential-names-file cannot be resolved',
          };
        }
        if (hostCtx.droppedSections?.some((d) => d.section === 'paths')) {
          const rawKey = rawConfidentialNamesKeyState(resolveOwnerYamlPath());
          if (rawKey === 'configured') {
            return {
              patterns: [],
              disabledReason:
                'owner.yaml has an invalid paths: section, so a configured confidential-names-file cannot be resolved',
            };
          }
          if (rawKey === 'unknown') {
            return {
              patterns: [],
              disabledReason:
                'owner.yaml has an invalid paths: section and could not be re-read, so a configured confidential-names-file cannot be ruled out',
            };
          }
          return {
            patterns: [],
            inertWarn:
              'CP11 inactive — owner.yaml\'s paths: section was dropped as invalid, but it configures no confidential-names-file',
          };
        }
      }
      return { patterns: [] }; // (b) the ~99% default — inactive, silent.
    }

    const { status, names } = inspectConfidentialNames({ namesPath });
    if (status === 'missing') {
      return { patterns: [], disabledReason: 'a confidential-names-file is configured but does not exist' };
    }
    if (status === 'malformed') {
      return {
        patterns: [],
        disabledReason: 'the configured confidential-names-file is unreadable or not a JSON array of names',
      };
    }
    if (status === 'all-dropped') {
      return {
        patterns: [],
        disabledReason:
          'every entry in the configured confidential-names-file was rejected as invalid or oversized',
      };
    }
    if (status !== 'ok') return { patterns: [] }; // 'empty' — the operator's `[]` opt-out.
    return { patterns: names.map((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, 'i')) };
  } catch (err) {
    return { patterns: [], disabledReason: `confidential-names resolution failed (${err?.name ?? 'Error'})` };
  }
}

const TEXT_EXTS = new Set([
  '.md',
  '.mdx',
  '.mjs',
  '.js',
  '.ts',
  '.json',
  '.jsonl',
  '.yml',
  '.yaml',
  '.sh',
  '.txt',
  '.html',
  '.xml',
  '.svg',
  '.css',
]);

const DOTFILE_ALLOWLIST = new Set(['.env.example', '.nvmrc', '.vault.yaml']);

function isTextFile(filePath) {
  const base = basename(filePath);
  if (DOTFILE_ALLOWLIST.has(base)) return true;
  const ext = extname(filePath);
  return ext ? TEXT_EXTS.has(ext) : false;
}

function getTrackedFiles() {
  try {
    const args = ['ls-files', '-z', '--cached'];
    if (includeUntracked) args.push('--others', '--exclude-standard');
    const output = execFileSync('git', args, { cwd: pluginRoot, encoding: 'utf8' });
    return output
      .split('\0')
      .filter(Boolean)
      .map((f) => join(pluginRoot, f));
  } catch {
    return walkDir(pluginRoot);
  }
}

function walkDir(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry === '.git' || entry === 'node_modules') continue;
    const rel = relative(pluginRoot, full);
    if (rel === join('.orchestrator', 'audits') || rel.startsWith(join('.orchestrator', 'audits') + sep)) continue;
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walkDir(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

function isAllowlisted(relPath, line) {
  const {policy, CP7_G} = currentOwnerRules();
  const norm = relPath.replace(/\\/g, '/');
  // Only published attribution files permit public URLs; email contacts work everywhere.
  const urlsAllowed = new Set(['README.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json', 'site/index.html', 'site/de/index.html', 'site/impressum/index.html', 'site/datenschutz/index.html']).has(norm);
  let residue = line;
  for (const email of policy.publicEmails) residue = residue.replace(new RegExp(escapeRegex(email) + '(?![\\w-]|\\.[\\w])', 'g'), '');
  if (urlsAllowed) {
    for (const url of policy.publicUrls) residue = residue.replace(new RegExp(escapeRegex(url) + '(?![\\w-]|\\.[\\w])', 'g'), '');
  }
  // Preserve the single documented contract comment; no arbitrary line exemption.
  if (norm === 'tests/lib/events-default-url.test.mjs') {
    for (const host of policy.eventsHosts) {
      const contract = ' *   - No literal `' + host + '` URL appears anywhere in scripts/ or hooks/.';
      if (line === contract) return true;
    }
  }
  return countMatches(CP7_G, line) > 0 && countMatches(CP7_G, residue) === 0;
}

function safeDiagnosticPath(value, confidentialPatterns = []) {
  const rules = currentOwnerRules();
  const patterns = [...confidentialPatterns, ...rules.redactionPatterns];
  // Replace whole offending filename segments, retaining only safe location context.
  return value.split('/').map((segment) => {
    const forms = [segment, canonicalizeLine(segment, {preserveDashes:true}), canonicalizeLine(segment)];
    const privateSegment = forms.some((form) => isOwnerLeakySegment(form) ||
      patterns.some((re) => { re.lastIndex = 0; return re.test(form); }));
    return privateSegment ? '[REDACTED]' : segment;
  }).join('/');
}

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}

function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  failed++;
}

async function runScan() {
console.log('--- Check 11: owner-privacy leakage ---');

if (!existsSync(pluginRoot)) {
  fail('plugin root does not exist');
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const owner = inspectOwnerPatterns();
if (owner.status !== 'ok') {
  console.error(`WARN owner-patterns: ${owner.status} (${owner.reason ?? 'source-unavailable'}); host-specific rules unavailable`);
  if (owner.status !== 'missing' || requireOwnerPatterns) fail('<scan-wide> — CP1 (guard disabled): owner patterns unavailable');
}
const { CP2, CP3, CP4, CP5_WITH_GOTZ, CP5_EXPORT, CP6_PATTERNS, CP7, CP3_G, CP7_G, CP10_PATTERNS, policy } = currentOwnerRules();
const allFiles = packedInventoryPath ? getPackedFiles() : getTrackedFiles();
const textFiles = packedInventoryPath ? allFiles : allFiles.filter(isTextFile);

const SELF_EXCLUSIONS = new Set([
  'tests/lib/validate/check-owner-leakage.test.mjs',
  'tests/husky/pre-commit-owner-leakage.test.mjs',
  'tests/lib/memory-paths.test.mjs',
  'tests/lib/vault-mirror/namespace.test.mjs',
  'tests/lib/vault-relocation-rules.test.mjs',
  'tests/scripts/relocate-vault-corpus.test.mjs',
]);
const scanFiles = textFiles.filter((f) => {
  const rel = relative(pluginRoot, f).replace(/\\/g, '/');
  if (!packedInventoryPath && rel.startsWith('.orchestrator/audits/')) return false;
  if (!packedInventoryPath && SELF_EXCLUSIONS.has(rel)) return false;
  return true;
});

const cp11 = await getConfidentialNamePatterns();
const cp11Patterns = cp11.patterns;
if (cp11.inertWarn) {
  console.error(`WARN: ${cp11.inertWarn}`);
}
if (cp11.disabledReason) {
  console.error(`CP11 DISABLED: ${cp11.disabledReason}`);
  fail(`<scan-wide> — CP11 (guard disabled): ${cp11.disabledReason}`);
}

const violations = [];

for (const filePath of scanFiles) {
  let content;
  try {
    if (packedInventoryPath) {
      const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!fstatSync(fd).isFile() || realpathSync(filePath) !== filePath) throw new Error('unsafe-inventory');
        content = readFileSync(fd, 'utf8');
      } finally { closeSync(fd); }
    } else { content = readFileSync(filePath, 'utf8'); }
  } catch {
    fail(`${safeDiagnosticPath(relative(pluginRoot, filePath), cp11Patterns)} — file unreadable`);
    continue;
  }

  const relPath = relative(pluginRoot, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    const canon = canonicalizeLine(line);

    const ownerPathHit = matchOwnerPath(line);
    if (ownerPathHit) {
      violations.push({ relPath, lineNum, pattern: ownerPathHit, lineContent: line.trim() });
    }

    if (CP2.test(line) || CP2.test(canon)) {
      violations.push({ relPath, lineNum, pattern: 'CP2 (private host)', lineContent: line.trim() });
    }

    const cp3Decoded = countMatches(CP3_G, canon) > countMatches(CP3_G, line);
    if (CP3.test(line) || cp3Decoded) {
      if (cp3Decoded || !isAllowlisted(relPath, line)) {
        violations.push({ relPath, lineNum, pattern: 'CP3 (private events host)', lineContent: line.trim() });
      }
    }

    if (CP4.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'CP4 (private scope/ scope)', lineContent: line.trim() });
    }

    if (CP5_WITH_GOTZ.test(line) && policy.privateDomains.some((token) => line.includes(token.split('.')[0]))) {
      violations.push({ relPath, lineNum, pattern: 'CP5 (DEFAULT_GITLAB_HOST on owner line)', lineContent: line.trim() });
    } else if (CP5_EXPORT.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'CP5 (DEFAULT_GITLAB_HOST exported const)', lineContent: line.trim() });
    }

    for (let i = 0; i < CP6_PATTERNS.length; i++) {
      if (CP6_PATTERNS[i].test(line)) {
        violations.push({ relPath, lineNum, pattern: 'CP6 (private slug)', lineContent: line.trim() });
        break; // one violation per line per slug is enough
      }
    }

    const cp7Decoded = countMatches(CP7_G, canon) > countMatches(CP7_G, line);
    if (CP7.test(line) || cp7Decoded) {
      if (cp7Decoded || !isAllowlisted(relPath, line)) {
        violations.push({ relPath, lineNum, pattern: 'CP7 (private domain catch-all)', lineContent: line.trim() });
      }
    }

    if ((CP8.test(line) || CP8.test(canon)) && (packedInventoryPath || !CP8_ALLOWLIST.has(relPath))) {
      violations.push({ relPath, lineNum, pattern: 'CP8 (RFC1918 private IP)', lineContent: line.trim() });
    }

    if (packedInventoryPath || !CP10_ALLOWLIST.has(relPath)) {
      for (const re of CP10_PATTERNS) {
        if (re.test(line)) {
          violations.push({ relPath, lineNum, pattern: 'CP10 (~/Projects/<name>/ personal segment)', lineContent: line.trim() });
          break;
        }
      }
    }

    if (cp11Patterns.length > 0 && cp11Patterns.some((re) => re.test(line))) {
      violations.push({ relPath, lineNum, pattern: 'CP11 (confidential name)', lineContent: line.trim() });
    }
  });
}

if (violations.length === 0) {
  if (cp11.disabledReason) {
    console.log(`  (CP1–CP10 found no leakage across ${scanFiles.length} scanned files; CP11 did not run)`);
  } else {
    pass(`no owner-privacy leakage found across ${scanFiles.length} scanned files`);
  }
} else {
  for (const v of violations) {
    // Violation content is omitted: canonical detection may hide reversible spellings.
    fail(`${safeDiagnosticPath(v.relPath, cp11Patterns)}:${v.lineNum} — ${v.pattern}: [REDACTED]`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed (${scanFiles.length} scanned files)`);
process.exit(failed === 0 ? 0 : 1);
}

export function isOwnerLeakySegment(value) {
  if (typeof value !== 'string' || !value) return null;
  const rules = currentOwnerRules();
  if (rules.status !== 'ok' && (rules.status !== 'missing' || (process.env.SO_OWNER_PATTERNS_FILE || '').trim())) return 'CP1';
  if (matchOwnerPath(value) || rules.CP1_BARE.test(value)) return 'CP1';
  if (rules.CP6_INPROCESS_PATTERNS.some((re) => re.test(value))) return 'CP6';
  if (rules.CP10_PATTERNS.some((re) => re.test(value))) return 'CP10';
  return null;
}

if (isMain) {
  runScan().catch((err) => {
    console.error('check-owner-leakage failed:', (['ENOENT','EACCES','EPERM','ELOOP','ENOTDIR','EISDIR'].includes(err?.code) ? err.code : ['unsafe-inventory','invalid-inventory','inventory-too-large','invalid-inventory-entry'].includes(err?.message) ? err.message : 'scan-error'));
    process.exit(1);
  });
}
