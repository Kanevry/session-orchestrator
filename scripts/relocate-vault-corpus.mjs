#!/usr/bin/env node
/**
 * relocate-vault-corpus.mjs — IO/CLI layer for flat-corpus vault relocation.
 *
 * Moves flat markdown files under 40-learnings/ and 50-sessions/ in a vault
 * into per-repo namespace subdirectories using the classification logic from
 * scripts/lib/vault-relocation-rules.mjs (C1).
 *
 * Usage:
 *   node scripts/relocate-vault-corpus.mjs --vault-dir <path> [--dry-run|--apply]
 *     [--derivable-only] [--with-backfill] [--repos-root <dir>]
 *     [--rollback <manifest>] [--learnings-only|--sessions-only] [--json] [--help]
 *
 * Flags:
 *   --vault-dir DIR       Path to the vault git repo root (REQUIRED — no default for safety)
 *   --dry-run             Preview plan, write nothing (DEFAULT; mutex with --apply)
 *   --apply               Move files via git mv and write reverse-manifest (mutex with --dry-run)
 *   --derivable-only      Only move files where confident===true; skip _unsorted/redacted-repo/unknown-repo
 *   --with-backfill       Cross-repo session→repo backfill (Issue #700): read each repo's
 *                         sessions.jsonl under --repos-root to attribute historical sessions
 *                         (and, transitively, their learnings) that carry no in-file repo signal.
 *   --repos-root DIR      Parent dir holding sibling repos to scan for sessions.jsonl
 *                         (default: parent of --vault-dir). Only used with --with-backfill.
 *   --rollback MANIFEST   Reverse a previous --apply run given its manifest JSON path
 *   --learnings-only      Scope to 40-learnings/ only
 *   --sessions-only       Scope to 50-sessions/ only
 *   --json                Emit JSONL records on stdout (one per file)
 *   --help, -h            Show this help
 *
 * Exit codes:
 *   0  Success (including no-op / dry-run)
 *   1  Input/arg error
 *   2  IO error
 *
 * Data → stdout. Diagnostics/summary → stderr.
 *
 * Structural idempotency: flat files at maxdepth 1 are enumerated; files already
 * at depth ≥ 2 (already namespaced) are never enumerated nor moved.
 */

import { promises as fs, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  loadVaultRelocationRules,
  VAULT_RELOCATION_RULES_PATH,
  parseRelocationFrontmatter,
  namespaceForSession,
  classifyOwner,
  isConfident,
  computeDest,
  isAlreadyNamespaced,
  _setResolverForTest,
} from './lib/vault-relocation-rules.mjs';
import { buildBackfillIndex, parseSessionId } from './lib/vault-repo-backfill.mjs';
import { parseColumnFlags, CliFlagError } from './lib/cli-flags.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_NAME = 'relocate-vault-corpus';
const LEARNINGS_SUBDIR = '40-learnings';
const SESSIONS_SUBDIR = '50-sessions';
const MANIFEST_DIR = '.orchestrator';
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let parsedFlags;
  try {
    parsedFlags = parseColumnFlags({
      argv: argv.slice(2),
      knownBool: {
        help: { short: 'h', default: false },
        apply: false,
        'dry-run': false,
        json: false,
        'derivable-only': false,
        'with-backfill': false,
        'learnings-only': false,
        'sessions-only': false,
      },
      knownString: {
        'vault-dir': null,
        'repos-root': null,
        rollback: null,
      },
    });
  } catch (err) {
    if (err instanceof CliFlagError) {
      process.stderr.write(`${SCRIPT_NAME}: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const values = parsedFlags.values;

  // Mutex check: --dry-run and --apply on the same invocation
  const applyFlag = values.apply === true;
  const dryRunFlag = values['dry-run'] === true;
  if (applyFlag && dryRunFlag) {
    process.stderr.write(`${SCRIPT_NAME}: --dry-run and --apply are mutually exclusive\n`);
    process.exit(1);
  }

  // --learnings-only and --sessions-only are mutually exclusive
  if (values['learnings-only'] && values['sessions-only']) {
    process.stderr.write(`${SCRIPT_NAME}: --learnings-only and --sessions-only are mutually exclusive\n`);
    process.exit(1);
  }

  return {
    help: values.help === true,
    apply: applyFlag,
    json: values.json === true,
    derivableOnly: values['derivable-only'] === true,
    withBackfill: values['with-backfill'] === true,
    reposRoot: values['repos-root'] ?? null,
    rollback: values.rollback ?? null,
    vaultDir: values['vault-dir'] ?? null,
    learningsOnly: values['learnings-only'] === true,
    sessionsOnly: values['sessions-only'] === true,
  };
}

function printHelp() {
  process.stdout.write(
    `Usage: ${SCRIPT_NAME}.mjs --vault-dir <path> [--dry-run|--apply]
  [--derivable-only] [--with-backfill] [--repos-root <dir>]
  [--rollback <manifest>] [--learnings-only|--sessions-only] [--json] [--help]

Moves flat markdown files from 40-learnings/ and 50-sessions/ roots in a vault
git repo into per-repo namespace subdirectories.

Flat files at depth 1 are enumerated and classified; files already in a
subdirectory (depth >= 2, already namespaced) are never touched.

REQUIRED:
  --vault-dir DIR         Path to the vault git repo root

MODES (default: --dry-run):
  --dry-run               Preview plan, write nothing (DEFAULT)
  --apply                 Move files via git mv, write reverse-manifest (STAGE ONLY — no commit)
  --rollback MANIFEST     Reverse a previous --apply run given its manifest JSON path

FILTERS:
  --derivable-only        Only move files where confident===true; skip _unsorted/redacted-repo/unknown-repo
  --learnings-only        Scope to 40-learnings/ only
  --sessions-only         Scope to 50-sessions/ only

BACKFILL (Issue #700 — cross-repo session→repo attribution):
  --with-backfill         Read each sibling repo's sessions.jsonl to attribute
                          historical sessions (and transitively their learnings)
                          that carry NO in-file repo signal. Default OFF — when
                          absent, no sessions.jsonl is read and output is
                          byte-identical to the non-backfill run.
  --repos-root DIR        Parent dir holding sibling repos to scan
                          (default: parent of --vault-dir). Only used with --with-backfill.

OUTPUT:
  --json                  Emit JSONL records on stdout (one per file)
  --help, -h              Show this help

Exit codes:
  0  Success (including no-op / dry-run)
  1  Input/arg error
  2  IO error

Data goes to stdout; diagnostics and summary go to stderr.

WARNING: This tool operates on a git repo (--vault-dir). Run with --dry-run
first to verify the plan. The --apply mode stages moves (git mv) but does NOT
commit — the operator must review and commit separately.

The reverse-manifest is written to <vault-dir>/.orchestrator/relocation-manifest-<ISO>.json
on a successful --apply run and can be used with --rollback to undo.

Config: ${VAULT_RELOCATION_RULES_PATH}
`,
  );
}

// ---------------------------------------------------------------------------
// Flat-file discovery (maxdepth 1 only — structural idempotency)
// ---------------------------------------------------------------------------

/**
 * Enumerate flat markdown files directly under <dir> (maxdepth 1, files only).
 * Files at depth >= 2 (already in a subdirectory) are never returned.
 *
 * @param {string} dir - absolute path to the corpus subdir (e.g. vault/40-learnings)
 * @returns {string[]} absolute file paths of flat .md files
 */
function enumerateFlatFiles(dir) {
  if (!existsSync(dir)) return [];

  const result = spawnSync(
    'find',
    [dir, '-maxdepth', '1', '-type', 'f', '-name', '*.md'],
    { encoding: 'utf8' },
  );

  if (result.error) {
    process.stderr.write(
      `${SCRIPT_NAME}: find not found on PATH (${result.error.code ?? result.error.message})\n`,
    );
    process.exit(2);
  }
  if (result.status !== 0) {
    process.stderr.write(`${SCRIPT_NAME}: find failed: ${result.stderr}\n`);
    process.exit(2);
  }

  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Cross-repo sessions.jsonl indices (CLI-side IO — only built under --with-backfill)
// ---------------------------------------------------------------------------

/**
 * Build the authoritative cross-repo backfill indices by scanning each sibling
 * repo's `.orchestrator/metrics/sessions.jsonl` under reposRoot.
 *
 *   sidIndex: Map<session_id, Set<repoSlug>>
 *   bdIndex:  Map<`${branch}|${date}`, Set<repoSlug>>
 *
 * Immediate subdirectories of reposRoot are enumerated; `Archiv` and any
 * dot-prefixed name are excluded. Malformed JSONL lines are skipped (never throw
 * the whole run). The repo identity stored in the indices is the repo's CANONICAL
 * slug derived from its git origin remote (`repoCanonicalSlug`), NOT the directory
 * basename — so a backfilled session lands in the SAME `<repo>/` namespace as that
 * repo's own native vault-mirror writes (which use `deriveRepo()` off the same
 * remote). Using the basename would split e.g. `AcmeWidgetV2/` → `acmewidgetv2`
 * while `repo:`-carrying notes use the canonical `acme-widget-v2`. Leak-guarding
 * still happens later in the pure backfill module.
 *
 * @param {string} reposRoot - absolute path to the parent dir of sibling repos
 * @returns {{ sidIndex: Map<string, Set<string>>, bdIndex: Map<string, Set<string>>, reposScanned: number }}
 */
function repoCanonicalSlug(reposRoot, name) {
  // Derive the repo's canonical namespace identity from its git origin remote so
  // it matches the slug `deriveRepo()` would produce for that repo's own writes.
  // Falls back to the directory basename when there is no readable remote.
  try {
    const res = spawnSync('git', ['-C', path.join(reposRoot, name), 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
    });
    const url = (res.stdout || '').trim();
    if (res.status === 0 && url) {
      const seg = url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop();
      if (seg) return seg;
    }
  } catch {
    // fall through to basename
  }
  return name;
}

async function buildCrossRepoIndices(reposRoot) {
  const sidIndex = new Map();
  const bdIndex = new Map();
  let reposScanned = 0;

  if (!existsSync(reposRoot)) {
    process.stderr.write(`${SCRIPT_NAME}: WARN: --repos-root not found: ${reposRoot} — backfill indices empty\n`);
    return { sidIndex, bdIndex, reposScanned };
  }

  let entries;
  try {
    entries = await fs.readdir(reposRoot, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`${SCRIPT_NAME}: WARN: could not read --repos-root ${reposRoot}: ${err.message} — backfill indices empty\n`);
    return { sidIndex, bdIndex, reposScanned };
  }

  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    if (name === 'Archiv' || name.startsWith('.')) continue;

    const jsonlPath = path.join(reposRoot, name, '.orchestrator', 'metrics', 'sessions.jsonl');
    if (!existsSync(jsonlPath)) continue;

    let content;
    try {
      content = await fs.readFile(jsonlPath, 'utf8');
    } catch (err) {
      process.stderr.write(`${SCRIPT_NAME}: WARN: skipping ${name}/sessions.jsonl (read error: ${err.message})\n`);
      continue;
    }

    reposScanned++;

    // Canonical namespace identity from the git remote (NOT the basename) so a
    // backfilled session shares the folder with that repo's own native writes.
    const repoId = repoCanonicalSlug(reposRoot, name);

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // Malformed JSONL line — skip and continue (never abort the whole run).
        continue;
      }
      if (!record || typeof record !== 'object') continue;

      const sessionId = typeof record.session_id === 'string' ? record.session_id.trim() : '';
      if (!sessionId) continue;

      // sid index — the authoritative join (HIGH tier in the backfill module)
      addToSetIndex(sidIndex, sessionId, repoId);

      // branch/date index — the MEDIUM-tier fallback
      const parsed = parseSessionId(sessionId);
      const branch =
        (typeof record.branch === 'string' && record.branch.trim()) || (parsed ? parsed.branch : null);
      const date =
        (parsed ? parsed.date : null) ||
        (typeof record.started_at === 'string' ? record.started_at.slice(0, 10) : null);

      // Skip records where no (branch,date) signal can be derived — the bdIndex
      // key requires both. A bare date with no branch is not a usable key.
      if (branch && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        addToSetIndex(bdIndex, `${branch}|${date}`, repoId);
      }
    }
  }

  return { sidIndex, bdIndex, reposScanned };
}

/**
 * Learn an authoritative `repoIdentity → canonicalNamespace` map from the vault's
 * OWN `repo:`-carrying session notes. A repo dir without a readable git remote
 * (so `repoCanonicalSlug` fell back to its CamelCase basename, e.g. `AcmeWidgetV2`
 * → `acmewidgetv2`) cannot derive the hyphenated canonical slug (`acme-widget-v2`)
 * from its name alone. But if that dir's `sessions.jsonl` contains the id of a vault
 * session that DOES carry a `repo:` field, that session's resolved namespace is the
 * ground-truth canonical for the dir — so backfilled repo-less sessions in the same
 * dir land in the SAME `<repo>/` folder instead of a split CamelCase variant.
 *
 * Only UNANIMOUS mappings are learned; an identity whose `repo:`-carrying sessions
 * disagree on the namespace is left unmapped (ambiguous → no remap).
 *
 * @param {{ sidIndex: Map<string, Set<string>>, parsedVaultSessions: Array<{id:string, frontmatter:object}> }} args
 * @returns {Map<string, string>} identity → canonical namespace
 */
function learnCanonicalMap({ sidIndex, parsedVaultSessions }) {
  // Strip case + every separator so two slug FORMS of the SAME repo compare equal:
  // 'AcmeWidgetV2' → 'acmewidgetv2' === 'acme-widget-v2' → 'acmewidgetv2'.
  const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const votes = new Map(); // identity → Map<canonicalNs, count>
  for (const { id, frontmatter } of parsedVaultSessions) {
    if (!id || !frontmatter || !frontmatter.repo) continue;
    const { namespace } = namespaceForSession(frontmatter); // repo: → canonical
    if (!isConfident(namespace)) continue; // skip _unsorted/redacted-repo/unknown-repo
    const identities = sidIndex.get(id);
    if (!identities) continue;
    // Only an UNAMBIGUOUS repo: note teaches: if its id appears in >1 repo's jsonl,
    // it would mis-teach every other identity its own namespace (collision pollution).
    if (identities.size !== 1) continue;
    for (const identity of identities) {
      if (identity === namespace) continue; // already canonical — nothing to learn
      // GUARD against coincidental session-id collisions: session_ids are NOT globally
      // unique, so a size-1 match can still be the WRONG repo (a different repo that
      // happens to share the id string). Only learn when identity and namespace are
      // the same repo in a different slug FORM (CamelCase basename vs hyphenated slug).
      if (normalize(identity) !== normalize(namespace)) continue;
      let m = votes.get(identity);
      if (!m) {
        m = new Map();
        votes.set(identity, m);
      }
      m.set(namespace, (m.get(namespace) || 0) + 1);
    }
  }
  const learned = new Map();
  for (const [identity, m] of votes) {
    if (m.size === 1) learned.set(identity, [...m.keys()][0]); // unanimous only
  }
  return learned;
}

/**
 * Rewrite the cross-repo index identities through the learned canonical map (and
 * dedup the resulting sets — two raw dirs that canonicalise to the same repo are
 * one repo). No-op when `learned` is empty (e.g. no `--with-backfill`, or a fixture
 * with no `repo:`-carrying sessions), preserving byte-identical behaviour.
 */
function remapIndices({ sidIndex, bdIndex }, learned) {
  if (learned.size === 0) return { sidIndex, bdIndex };
  const remapSet = (set) => {
    const out = new Set();
    for (const member of set) out.add(learned.get(member) ?? member);
    return out;
  };
  const sid2 = new Map();
  for (const [k, set] of sidIndex) sid2.set(k, remapSet(set));
  const bd2 = new Map();
  for (const [k, set] of bdIndex) bd2.set(k, remapSet(set));
  return { sidIndex: sid2, bdIndex: bd2 };
}

/**
 * Append a value to a Set under a key in a Map<string, Set<string>>, creating the
 * Set on first insert.
 *
 * @param {Map<string, Set<string>>} map
 * @param {string} key
 * @param {string} value
 */
function addToSetIndex(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

/**
 * Parse every vault session note (flat + already-namespaced) into the
 * `{ id, frontmatter }` shape that buildBackfillIndex consumes. Reuses the same
 * recursive find pass that buildSessionRepoIndex uses, so session files are read
 * once per concern (this pass is only run under --with-backfill).
 *
 * @param {string} sessionsDir - absolute path to 50-sessions/
 * @returns {Promise<Array<{ id: string, frontmatter: object }>>}
 */
async function collectParsedVaultSessions(sessionsDir) {
  const out = [];
  if (!existsSync(sessionsDir)) return out;

  const result = spawnSync(
    'find',
    [sessionsDir, '-type', 'f', '-name', '*.md'],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    process.stderr.write(`${SCRIPT_NAME}: WARN: could not scan sessions for backfill: ${result.stderr || result.error?.message || 'unknown'}\n`);
    return out;
  }

  const files = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const filePath of files) {
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const frontmatter = parseRelocationFrontmatter(content);
    // Prefer the frontmatter id; fall back to the basename (the session id by convention).
    const id =
      (typeof frontmatter.id === 'string' && frontmatter.id.trim()) ||
      path.basename(filePath).replace(/\.md$/, '');
    if (id) out.push({ id, frontmatter });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Session→repo index builder
// ---------------------------------------------------------------------------

/**
 * Build a Map<sessionId, namespace> by scanning all session files — both flat
 * root AND existing <repo>/ subdirs (which carry frontmatter repo:).
 *
 * The index is passed to namespaceForLearning so it can resolve
 * source_session links to their owning namespace.
 *
 * When a backfillIndex is supplied (--with-backfill, Issue #700), it is forwarded
 * to namespaceForSession so backfilled sessions (no in-file repo signal) resolve
 * to a confident namespace and land in THIS index — which transitively lifts their
 * learnings via namespaceForLearning's source_session resolution.
 *
 * @param {string} sessionsDir - absolute path to 50-sessions/
 * @param {{ backfillIndex?: Map<string, { repo: string, confidence: string, source: string }> }} [opts]
 * @returns {Map<string, string>} sessionId → namespace
 */
async function buildSessionRepoIndex(sessionsDir, opts = {}) {
  const { backfillIndex } = opts;
  const index = new Map();
  if (!existsSync(sessionsDir)) return index;

  // All session .md files: flat + in subdirs (already-namespaced)
  const result = spawnSync(
    'find',
    [sessionsDir, '-type', 'f', '-name', '*.md'],
    { encoding: 'utf8' },
  );

  if (result.error || result.status !== 0) {
    // Non-fatal: return empty index, but warn so the operator knows source_session resolution is disabled
    process.stderr.write(`${SCRIPT_NAME}: WARN: could not scan sessions for index — transitive source_session resolution disabled: ${result.stderr || result.error?.message || 'unknown'}\n`);
    return index;
  }

  const files = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const filePath of files) {
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      process.stderr.write(`${SCRIPT_NAME}: WARN: skipping session file for index (${path.basename(filePath)}): ${e.message}\n`);
      continue;
    }

    const frontmatter = parseRelocationFrontmatter(content);
    const basename = path.basename(filePath);
    // namespaceForSession returns { namespace, source }. Forwarding backfillIndex
    // (undefined when --with-backfill is absent → inert) lets backfilled sessions
    // resolve to a confident namespace and land in this index, which transitively
    // lifts their learnings via namespaceForLearning's source_session resolution.
    const { namespace } = namespaceForSession(frontmatter, { backfillIndex });
    if (namespace && namespace !== '_unsorted' && namespace !== 'redacted-repo' && namespace !== 'unknown-repo') {
      // Derive sessionId from basename (strip .md)
      const sessionId = basename.replace(/\.md$/, '');
      index.set(sessionId, namespace);
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * Classify a single file, returning the plan entry.
 *
 * @param {object} opts
 * @param {string} opts.filePath - absolute path
 * @param {string} opts.corpusRoot - absolute path to 40-learnings/ or 50-sessions/
 * @param {Map<string, string>} opts.sessionRepoIndex
 * @param {Map<string, { repo: string, confidence: string, source: string }>} [opts.backfillIndex]
 * @returns {{ from: string, to: string, namespace: string, source: string, confident: boolean }}
 */
async function classifyFile({ filePath, corpusRoot, sessionRepoIndex, backfillIndex }) {
  const basename = path.basename(filePath);

  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    return {
      from: filePath,
      to: null,
      namespace: '_unsorted',
      source: 'error',
      confident: false,
      error: err.message,
    };
  }

  const frontmatter = parseRelocationFrontmatter(content);

  // classifyOwner dispatches on frontmatter.type — handles both sessions and learnings.
  // backfillIndex is undefined unless --with-backfill is set → inert in the default path.
  const classifyResult = classifyOwner({ frontmatter, sessionRepoIndex, backfillIndex });

  const { namespace, source, confident } = classifyResult;

  const dest = computeDest({ basename, root: corpusRoot, namespace });

  return {
    from: filePath,
    to: dest,
    namespace,
    source,
    confident,
  };
}

// ---------------------------------------------------------------------------
// Emit (stdout record per file)
// ---------------------------------------------------------------------------

/**
 * Emit a single JSONL record or human-readable line per file.
 *
 * @param {boolean} jsonMode
 * @param {object} rec
 */
function emit(jsonMode, rec) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(rec) + '\n');
    return;
  }
  // Human-readable: action from → to [namespace] (source)
  const fromRel = rec.from ? path.basename(rec.from) : '?';
  const toRel = rec.to ? path.relative(path.dirname(rec.from), rec.to) : '?';
  const reasonStr = rec.reason ? ` [${rec.reason}]` : '';
  process.stdout.write(
    `${SCRIPT_NAME}: ${rec.action}: ${fromRel} → ${toRel} (${rec.namespace ?? rec.reason ?? '?'})${reasonStr}\n`,
  );
}

// ---------------------------------------------------------------------------
// git mv wrapper
// ---------------------------------------------------------------------------

/**
 * Ensure a directory exists inside the vault (creates via mkdir -p, not git).
 * Vault directories can be created outside git since they'll be picked up when
 * files are moved in.
 *
 * @param {string} dir - absolute path
 */
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Move a file using `git mv` (stages the rename, does NOT commit).
 *
 * @param {string} vaultDir - absolute path to vault git root
 * @param {string} from - absolute path (source)
 * @param {string} to - absolute path (destination)
 * @returns {{ ok: boolean, error?: string }}
 */
function gitMv(vaultDir, from, to) {
  // git mv wants relative paths from the repo root
  const fromRel = path.relative(vaultDir, from);
  const toRel = path.relative(vaultDir, to);

  const result = spawnSync(
    'git',
    ['-C', vaultDir, 'mv', fromRel, toRel],
    { encoding: 'utf8' },
  );

  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || 'git mv failed').trim() };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Manifest writer (atomic tmp + rename)
// ---------------------------------------------------------------------------

/**
 * Write the reverse-manifest atomically under <vaultDir>/.orchestrator/.
 *
 * @param {object} opts
 * @param {string} opts.vaultDir
 * @param {boolean} opts.derivableOnly
 * @param {object} opts.summary
 * @param {Array<{from:string,to:string,namespace:string,source:string}>} opts.moves
 * @returns {string} absolute path to the written manifest
 */
async function writeManifest({ vaultDir, derivableOnly, summary, moves }) {
  const manifestDir = path.join(vaultDir, MANIFEST_DIR);
  await ensureDir(manifestDir);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(manifestDir, `relocation-manifest-${ts}.json`);
  const tmpPath = `${manifestPath}.tmp-${process.pid}`;

  // Store vault-relative paths in the manifest
  const movesRel = moves.map((m) => ({
    from: path.relative(vaultDir, m.from),
    to: path.relative(vaultDir, m.to),
    namespace: m.namespace,
    source: m.source,
  }));

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    tool: SCRIPT_NAME,
    createdAt: new Date().toISOString(),
    vaultDir,
    mode: derivableOnly ? 'derivable-only' : 'full',
    mechanism: 'git-mv',
    summary,
    moves: movesRel,
  };

  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fs.rename(tmpPath, manifestPath);

  return manifestPath;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Reverse a previous --apply run by reversing each move in the manifest.
 *
 * @param {string} manifestPath
 * @param {boolean} jsonMode
 */
async function runRollback(manifestPath, jsonMode) {
  let manifestContent;
  try {
    manifestContent = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    process.stderr.write(`${SCRIPT_NAME}: failed to read manifest: ${err.message}\n`);
    process.exit(2);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch (err) {
    process.stderr.write(`${SCRIPT_NAME}: failed to parse manifest: ${err.message}\n`);
    process.exit(2);
  }

  const { vaultDir, moves } = manifest;
  if (!vaultDir || !Array.isArray(moves)) {
    process.stderr.write(`${SCRIPT_NAME}: invalid manifest schema\n`);
    process.exit(1);
  }

  let reversed = 0;
  let skipped = 0;
  let errors = 0;

  // Reverse in reverse order (mirrors file-by-file; order matters if subdirs)
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i];
    const absTo = path.join(vaultDir, m.to);     // current location
    const absFrom = path.join(vaultDir, m.from); // destination (original)

    // Assert: to exists, from absent
    if (!existsSync(absTo)) {
      emit(jsonMode, {
        action: 'skipped',
        from: absTo,
        to: absFrom,
        namespace: m.namespace,
        source: m.source,
        confident: null,
        reason: 'source-missing-for-rollback',
      });
      skipped++;
      continue;
    }
    if (existsSync(absFrom)) {
      emit(jsonMode, {
        action: 'skipped',
        from: absTo,
        to: absFrom,
        namespace: m.namespace,
        source: m.source,
        confident: null,
        reason: 'dest-exists-for-rollback',
      });
      skipped++;
      continue;
    }

    const mvResult = gitMv(vaultDir, absTo, absFrom);
    if (!mvResult.ok) {
      process.stderr.write(`${SCRIPT_NAME}: ERROR git mv failed: ${mvResult.error}\n`);
      errors++;
      emit(jsonMode, {
        action: 'error',
        from: absTo,
        to: absFrom,
        namespace: m.namespace,
        source: m.source,
        confident: null,
        reason: mvResult.error,
      });
    } else {
      emit(jsonMode, {
        action: 'rolled-back',
        from: absTo,
        to: absFrom,
        namespace: m.namespace,
        source: m.source,
        confident: null,
      });
      reversed++;
    }
  }

  process.stderr.write(
    `${SCRIPT_NAME}: rollback complete — ${reversed} reversed, ${skipped} skipped, ${errors} errors\n`,
  );

  process.exit(errors > 0 ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Handle --rollback before requiring --vault-dir (manifest carries vaultDir)
  if (opts.rollback !== null) {
    await runRollback(opts.rollback, opts.json);
    return; // runRollback calls process.exit
  }

  // --vault-dir is required for all other modes
  if (!opts.vaultDir) {
    process.stderr.write(
      `${SCRIPT_NAME}: --vault-dir is required (no default to prevent accidental writes)\n`,
    );
    process.exit(1);
  }

  const vaultDir = path.resolve(opts.vaultDir);
  if (!existsSync(vaultDir)) {
    process.stderr.write(`${SCRIPT_NAME}: vault-dir not found: ${vaultDir}\n`);
    process.exit(1);
  }

  // Load relocation rules (errors are warnings, not fatal)
  const ruleset = loadVaultRelocationRules();
  for (const e of ruleset.errors ?? []) {
    process.stderr.write(`${SCRIPT_NAME}: config: ${e}\n`);
  }

  // ── Corpus paths ─────────────────────────────────────────────────────────
  const learningsDir = path.join(vaultDir, LEARNINGS_SUBDIR);
  const sessionsDir = path.join(vaultDir, SESSIONS_SUBDIR);

  // ── Step 0: Build the cross-repo backfill index (--with-backfill only) ─────
  // When --with-backfill is ABSENT, NO sessions.jsonl is read and backfillIndex
  // stays undefined → every downstream consumer is inert → byte-identical default.
  let backfillIndex; // undefined unless --with-backfill
  if (opts.withBackfill) {
    const reposRoot = opts.reposRoot
      ? path.resolve(opts.reposRoot)
      : path.dirname(vaultDir);
    const rawIndices = await buildCrossRepoIndices(reposRoot);
    const parsedVaultSessions = await collectParsedVaultSessions(sessionsDir);
    // Canonicalise repo identities against the vault's own repo:-ground-truth so a
    // remote-less dir (CamelCase basename) shares the folder with its repo: notes.
    const learned = learnCanonicalMap({ sidIndex: rawIndices.sidIndex, parsedVaultSessions });
    const { sidIndex, bdIndex } = remapIndices(rawIndices, learned);
    backfillIndex = buildBackfillIndex(parsedVaultSessions, { sidIndex, bdIndex });
    process.stderr.write(
      `${SCRIPT_NAME}: backfill: scanned ${rawIndices.reposScanned} repos under ${reposRoot} ` +
      `(${sidIndex.size} sids, ${bdIndex.size} branch|date keys, ${learned.size} canonical-learned) → ` +
      `${backfillIndex.size} sessions attributed from ${parsedVaultSessions.length} vault sessions\n`,
    );
  }

  // ── Step 1: Build session→repo index (single pass over ALL session files) ──
  // Forwarding backfillIndex lets backfilled sessions land in this index, which
  // transitively lifts their learnings via source_session resolution.
  const sessionRepoIndex = await buildSessionRepoIndex(sessionsDir, { backfillIndex });

  // ── Step 2: Enumerate flat files (maxdepth 1 only) ───────────────────────
  const scopeSessions = !opts.learningsOnly;
  const scopeLearnings = !opts.sessionsOnly;

  const sessionFiles = scopeSessions ? enumerateFlatFiles(sessionsDir) : [];
  const learningFiles = scopeLearnings ? enumerateFlatFiles(learningsDir) : [];

  // ── Step 3: Classify each flat file ──────────────────────────────────────
  /** @type {Array<{from:string,to:string,namespace:string,source:string,confident:boolean,corpusRoot:string}>} */
  const plan = [];

  for (const filePath of sessionFiles) {
    const entry = await classifyFile({
      filePath,
      corpusRoot: sessionsDir,
      sessionRepoIndex,
      backfillIndex,
    });
    plan.push({ ...entry, corpusRoot: sessionsDir });
  }

  for (const filePath of learningFiles) {
    const entry = await classifyFile({
      filePath,
      corpusRoot: learningsDir,
      sessionRepoIndex,
      backfillIndex,
    });
    plan.push({ ...entry, corpusRoot: learningsDir });
  }

  // ── Step 3.5: Pre-flight intra-batch dest-uniqueness detection ────────────
  // W1-D3 safety gap: computeDest is purely structural, so two distinct source
  // files with the same basename + namespace map to the SAME `to`. The runtime
  // existsSync guard only catches collisions against files that ALREADY exist —
  // it cannot see same-batch collisions in --dry-run (nothing has moved yet), so
  // dry-run under-counts. Group move-ELIGIBLE entries by `to`; any `to` reached
  // by ≥2 distinct `from` is an intra-batch collision. This surfaces them up-front.
  const destGroups = new Map(); // to → Set<from>
  for (const entry of plan) {
    if (entry.error || !entry.to) continue;
    const relToCorpus = path.relative(entry.corpusRoot, entry.from);
    if (isAlreadyNamespaced(relToCorpus)) continue;
    // Mirror the --derivable-only skip: non-confident entries don't reach the move
    // stage in that mode, so they cannot collide there either.
    if (opts.derivableOnly && !isConfident(entry.namespace)) continue;
    let set = destGroups.get(entry.to);
    if (!set) {
      set = new Set();
      destGroups.set(entry.to, set);
    }
    set.add(entry.from);
  }
  /** @type {Set<string>} colliding `to` paths (≥2 distinct sources) */
  const collidingDests = new Set();
  for (const [to, froms] of destGroups) {
    if (froms.size >= 2) collidingDests.add(to);
  }

  // ── Step 4: Apply mode decision, emit records ─────────────────────────────
  const summary = {
    moved: 0,
    skippedAlreadyNamespaced: 0,
    fallbackBucket: 0,
    skippedNonConfident: 0,
    destCollisions: 0,
    intraBatchCollisions: collidingDests.size,
    ioErrors: 0,
  };

  // Surface each intra-batch-colliding dest as an emit record (one per colliding
  // `to`, listing the count of competing sources) so --dry-run is honest about them.
  for (const to of collidingDests) {
    emit(opts.json, {
      action: 'intra-batch-collision',
      from: null,
      to,
      namespace: null,
      source: 'pre-flight',
      confident: null,
      reason: `intra-batch-collision: ${destGroups.get(to).size} sources map to this dest`,
      collidingSources: [...destGroups.get(to)],
    });
  }

  /** @type {Array<{from:string,to:string,namespace:string,source:string}>} */
  const appliedMoves = [];

  for (const entry of plan) {
    // isAlreadyNamespaced is a structural guard — should never be hit (we enumerate maxdepth 1)
    // but defensive check in case find returned a deeper path
    const relToCorpus = path.relative(entry.corpusRoot, entry.from);
    if (isAlreadyNamespaced(relToCorpus)) {
      summary.skippedAlreadyNamespaced++;
      emit(opts.json, {
        action: 'skipped',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
        reason: 'already-namespaced',
      });
      continue;
    }

    if (entry.error) {
      summary.ioErrors++;
      emit(opts.json, {
        action: 'skipped',
        from: entry.from,
        to: null,
        namespace: '_unsorted',
        source: 'error',
        confident: false,
        reason: `read-error: ${entry.error}`,
      });
      continue;
    }

    // --derivable-only: skip non-confident entries
    if (opts.derivableOnly && !isConfident(entry.namespace)) {
      summary.skippedNonConfident++;
      emit(opts.json, {
        action: 'skipped',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
        reason: 'non-confident',
      });
      continue;
    }

    // Track fallback bucket
    if (!isConfident(entry.namespace)) {
      summary.fallbackBucket++;
    }

    // Dest-collision guard
    if (existsSync(entry.to)) {
      summary.destCollisions++;
      emit(opts.json, {
        action: 'skipped',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
        reason: 'dest-exists',
      });
      continue;
    }

    if (!opts.apply) {
      // Dry-run: report what would happen
      emit(opts.json, {
        action: 'would-move',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
      });
      summary.moved++;
    } else {
      // Apply: mkdir, git mv, record
      try {
        await ensureDir(path.dirname(entry.to));
      } catch (err) {
        summary.ioErrors++;
        process.stderr.write(
          `${SCRIPT_NAME}: ERROR creating dir ${path.dirname(entry.to)}: ${err.message}\n`,
        );
        emit(opts.json, {
          action: 'skipped',
          from: entry.from,
          to: entry.to,
          namespace: entry.namespace,
          source: entry.source,
          confident: entry.confident,
          reason: `mkdir-error: ${err.message}`,
        });
        continue;
      }

      const mvResult = gitMv(vaultDir, entry.from, entry.to);
      if (!mvResult.ok) {
        summary.ioErrors++;
        process.stderr.write(`${SCRIPT_NAME}: ERROR git mv failed: ${mvResult.error}\n`);
        emit(opts.json, {
          action: 'skipped',
          from: entry.from,
          to: entry.to,
          namespace: entry.namespace,
          source: entry.source,
          confident: entry.confident,
          reason: `git-mv-error: ${mvResult.error}`,
        });
        continue;
      }

      emit(opts.json, {
        action: 'moved',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
      });
      summary.moved++;
      appliedMoves.push({
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
      });
    }
  }

  // ── Step 5: Write manifest on --apply ─────────────────────────────────────
  if (opts.apply && appliedMoves.length > 0) {
    try {
      const writtenPath = await writeManifest({
        vaultDir,
        derivableOnly: opts.derivableOnly,
        summary,
        moves: appliedMoves,
      });
      process.stderr.write(`${SCRIPT_NAME}: manifest written: ${writtenPath}\n`);
    } catch (err) {
      summary.ioErrors++;
      process.stderr.write(`${SCRIPT_NAME}: WARN: manifest write failed — moves were staged via git mv but --rollback via manifest is unavailable; reverse manually via 'git -C <vault> reset' or 'git mv' back. Error: ${err.message}\n`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const modeLabel = opts.apply ? 'applied' : 'dry-run';
  const derivableLabel = opts.derivableOnly ? ' [derivable-only]' : '';
  // The intra-batch segment is appended only when collisions exist OR backfill is
  // active. This preserves byte-identical summary output for the legacy default
  // path (no --with-backfill, no intra-batch collisions), while making the new
  // signal visible exactly when it carries information.
  const intraBatchSegment =
    collidingDests.size > 0 || opts.withBackfill
      ? `${summary.intraBatchCollisions} intra-batch-collisions, `
      : '';
  process.stderr.write(
    `${SCRIPT_NAME}: ${summary.moved} ${opts.apply ? 'moved' : 'would-move'}, ` +
    `${summary.skippedAlreadyNamespaced} already-namespaced, ` +
    `${summary.skippedNonConfident} non-confident skipped, ` +
    `${summary.destCollisions} dest-collisions, ` +
    intraBatchSegment +
    `${summary.ioErrors} I/O errors` +
    ` [${modeLabel}${derivableLabel}]\n`,
  );

  process.exit(summary.ioErrors > 0 ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Entry guard (run only when invoked directly)
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${SCRIPT_NAME}: FATAL: ${err.message}\n`);
    process.exit(2);
  });
}

export {
  enumerateFlatFiles,
  buildSessionRepoIndex,
  classifyFile,
  writeManifest,
  runRollback,
  _setResolverForTest,
};
