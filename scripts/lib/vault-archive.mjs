/**
 * vault-archive.mjs — reusable helper to archive a repo file into the Meta-Vault.
 *
 * Epic #774 (docs Public-Split): process records (PRDs, retros, session notes)
 * move OUT of the public repo and INTO the Meta-Vault. This helper is the single
 * shared mechanism for that move, consumed by TWO callers:
 *
 *   1. scripts/archive-closed-prds.mjs — the durable Epic-close routine (S8/#782)
 *      that runs as a `custom-phases:` entry, archiving PRDs whose Epic is closed.
 *   2. The Wave-3 corpus mover (S3) — bulk-moves ~66 process records into the
 *      vault, passing the returned manifest back to the coordinator.
 *
 * The helper NEVER deletes the source (the caller decides: the CLI uses `git rm`
 * under --apply; the W3 mover hands a manifest to the coordinator). It only
 * COPIES the source into the vault with a generated, schema-valid frontmatter.
 *
 * ── Frontmatter schema (mirror, not import) ─────────────────────────────────
 * The canonical vault frontmatter schema is the GENERATED Zod block in
 * skills/vault-sync/validator.mjs (Z.104-134). That schema is NOT exported, and
 * `zod` is not a dependency of scripts/ (it lives only as a skill-local shim in
 * skills/vault-sync/node_modules/). So the field constraints below are a
 * hand-rolled MIRROR of that schema. If the canonical schema changes, update the
 * constants here to match. The mirror is proven equivalent by an integration
 * test that runs the REAL validator subprocess over generated output
 * (tests/lib/vault-archive.test.mjs § "REAL validator").
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import YAML from 'js-yaml';

import { expandTilde } from './common.mjs';

// ── Schema mirror (SSOT: skills/vault-sync/validator.mjs Z.104-134) ──────────
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
export const VAULT_TYPE_ENUM = Object.freeze([
  'note',
  'daily',
  'project',
  'person',
  'reference',
  'idea',
  'learning',
  'session',
  'peer-card',
  'board',
]);
export const VAULT_STATUS_ENUM = Object.freeze([
  'draft',
  'active',
  'verified',
  'archived',
  'production',
  'mvp',
  'idea',
]);

const SOURCE_REPO = 'session-orchestrator';
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Return today's date as an ISO YYYY-MM-DD string.
 * @param {Date} [now] — injectable clock for deterministic tests.
 * @returns {string}
 */
export function todayIso(now) {
  const d = now instanceof Date ? now : new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Derive a collision-safe kebab-case vault `id` from a filename.
 *
 * Strips the `.md` extension, lowercases, collapses every non-alphanumeric run
 * to a single hyphen, trims leading/trailing hyphens, and enforces the schema's
 * min-2 / max-128 length. When a `takenIds` Set is provided, the returned slug
 * is guaranteed unique against it (a numeric `-2`, `-3`, … suffix is appended on
 * collision) and the chosen slug is registered into the Set.
 *
 * @param {string} filename
 * @param {Set<string>} [takenIds] — mutated: the returned slug is added.
 * @returns {string} a valid slug matching SLUG_RE (length 2..128).
 */
export function slugFromFilename(filename, takenIds) {
  const stem = String(filename).replace(/\.md$/i, '');
  let slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) slug = 'note';
  if (slug.length < 2) slug = `${slug}-note`;
  if (slug.length > 128) slug = slug.slice(0, 128).replace(/-+$/, '');

  if (takenIds instanceof Set) {
    let candidate = slug;
    let n = 2;
    while (takenIds.has(candidate)) {
      const suffix = `-${n}`;
      candidate = slug.slice(0, 128 - suffix.length).replace(/-+$/, '') + suffix;
      n++;
    }
    slug = candidate;
    takenIds.add(slug);
  }

  return slug;
}

/**
 * Validate a frontmatter field object against the mirrored schema.
 * Returns { ok, errors[] } — never throws. Mirrors the REQUIRED fields plus the
 * optional fields this helper emits; unknown keys are ignored (schema is
 * `.passthrough()`).
 *
 * @param {Record<string, unknown>} f
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateFrontmatterFields(f) {
  const errors = [];
  if (
    typeof f.id !== 'string' ||
    !SLUG_RE.test(f.id) ||
    f.id.length < 2 ||
    f.id.length > 128
  ) {
    errors.push(`invalid id: ${JSON.stringify(f.id)}`);
  }
  if (!VAULT_TYPE_ENUM.includes(f.type)) {
    errors.push(`invalid type: ${JSON.stringify(f.type)}`);
  }
  if (typeof f.created !== 'string' || !ISO_DATE_RE.test(f.created)) {
    errors.push(`invalid created: ${JSON.stringify(f.created)}`);
  }
  if (typeof f.updated !== 'string' || !ISO_DATE_RE.test(f.updated)) {
    errors.push(`invalid updated: ${JSON.stringify(f.updated)}`);
  }
  if (
    f.title !== undefined &&
    (typeof f.title !== 'string' || f.title.length < 1 || f.title.length > 200)
  ) {
    errors.push(`invalid title: ${JSON.stringify(f.title)}`);
  }
  if (f.status !== undefined && !VAULT_STATUS_ENUM.includes(f.status)) {
    errors.push(`invalid status: ${JSON.stringify(f.status)}`);
  }
  if (f.tags !== undefined && !Array.isArray(f.tags)) {
    errors.push('invalid tags (must be an array)');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Split a raw markdown document into its (optional) YAML frontmatter object and
 * body. A file without a leading `---` fence returns { frontmatter: null }.
 *
 * @param {string} raw
 * @returns {{ frontmatter: Record<string, unknown>|null, body: string, hadFrontmatter: boolean, parseError: boolean }}
 */
export function splitFrontmatter(raw) {
  const m = String(raw).match(FRONTMATTER_RE);
  if (!m) return { frontmatter: null, body: String(raw), hadFrontmatter: false, parseError: false };

  let fm;
  let parseError = false;
  try {
    fm = YAML.load(m[1]);
  } catch {
    fm = null;
    parseError = true;
  }
  const frontmatter = fm && typeof fm === 'object' && !Array.isArray(fm) ? fm : {};
  return { frontmatter, body: String(raw).slice(m[0].length), hadFrontmatter: true, parseError };
}

/**
 * Extract the first markdown H1 (`# Title`) from a document as a title candidate.
 * @param {string} raw
 * @returns {string|undefined}
 */
export function titleFromMarkdown(raw) {
  const m = String(raw).match(/^#\s+(.+?)\s*$/m);
  if (!m) return undefined;
  return m[1].trim().slice(0, 200) || undefined;
}

/**
 * Build the validated archive frontmatter field object for a source file.
 *
 * Merges (when present) the source's existing frontmatter — the mandatory vault
 * fields are filled/normalised WITHOUT producing a second frontmatter block.
 * Field precedence: `overrides` > archival-mandated values (updated/status/
 * source/source-repo) > valid existing values (id/type/created/title) > derived
 * defaults. Throws when the resulting object fails the schema mirror.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath — absolute path of the file being archived.
 * @param {string} [opts.title] — explicit title (else existing.title, else derived).
 * @param {string|number} [opts.issueRef] — Epic/issue iid, recorded as `epic-ref`.
 * @param {string} [opts.type='reference']
 * @param {string} [opts.status='archived']
 * @param {Date} [opts.now] — injectable clock.
 * @param {string} [opts.repoRoot] — for computing the repo-relative `source`.
 * @param {Record<string, unknown>|null} [opts.existing] — source's parsed frontmatter.
 * @param {Set<string>} [opts.takenIds] — collision-safety registry for ids.
 * @param {Record<string, unknown>} [opts.overrides] — final field overrides.
 * @returns {Record<string, unknown>} validated, ordered field object.
 */
export function buildArchiveFields({
  sourcePath,
  title,
  issueRef,
  type = 'reference',
  status = 'archived',
  now,
  repoRoot,
  existing = null,
  takenIds,
  overrides = {},
} = {}) {
  if (!sourcePath) throw new Error('vault-archive: sourcePath is required');

  const filename = basename(sourcePath);
  const dateStr = todayIso(now);
  const base = existing && typeof existing === 'object' ? { ...existing } : {};

  // id: keep a valid existing id, else derive a collision-safe slug.
  let id;
  if (typeof base.id === 'string' && SLUG_RE.test(base.id) && base.id.length >= 2 && base.id.length <= 128) {
    id = base.id;
    if (takenIds instanceof Set) takenIds.add(id);
  } else {
    id = slugFromFilename(filename, takenIds);
  }

  // type: keep a valid existing enum value, else the archival default.
  const finalType = VAULT_TYPE_ENUM.includes(base.type) ? base.type : type;

  // created: keep a valid existing date (original creation), else today.
  const created =
    typeof base.created === 'string' && ISO_DATE_RE.test(base.created) ? base.created : dateStr;

  // title: explicit arg wins, else existing, else undefined (caller may derive).
  let finalTitle = title;
  if ((finalTitle === undefined || finalTitle === null || finalTitle === '') && typeof base.title === 'string') {
    finalTitle = base.title;
  }

  const merged = {
    ...base,
    id,
    type: finalType,
    created,
    updated: dateStr,
    status,
    source: repoRoot ? relative(repoRoot, sourcePath) : filename,
    'source-repo': SOURCE_REPO,
  };
  if (finalTitle !== undefined && finalTitle !== null && String(finalTitle).length > 0) {
    merged.title = String(finalTitle).slice(0, 200);
  }
  if (issueRef !== undefined && issueRef !== null && String(issueRef).length > 0) {
    merged['epic-ref'] = String(issueRef);
  }
  Object.assign(merged, overrides);

  const { ok, errors } = validateFrontmatterFields(merged);
  if (!ok) {
    throw new Error(`vault-archive: generated frontmatter invalid: ${errors.join('; ')}`);
  }

  // Deterministic, readable field order; preserve passthrough keys at the tail.
  const ordered = {};
  ordered.id = merged.id;
  ordered.type = merged.type;
  ordered.created = merged.created;
  ordered.updated = merged.updated;
  if (merged.title !== undefined) ordered.title = merged.title;
  if (merged.status !== undefined) ordered.status = merged.status;
  if (merged.tags !== undefined) ordered.tags = merged.tags;
  ordered.source = merged.source;
  ordered['source-repo'] = merged['source-repo'];
  for (const [k, v] of Object.entries(merged)) {
    if (!(k in ordered)) ordered[k] = v;
  }
  return ordered;
}

/**
 * Render a frontmatter field object into a `---\n…\n---\n` YAML block string.
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function renderFrontmatter(fields) {
  const yaml = YAML.dump(fields, { lineWidth: -1, sortKeys: false, noRefs: true });
  return `---\n${yaml}---\n`;
}

/**
 * Generate the archive frontmatter STRING for a source file. Thin wrapper over
 * buildArchiveFields + renderFrontmatter — validates and throws on invalid.
 *
 * @param {Parameters<typeof buildArchiveFields>[0]} opts — see buildArchiveFields.
 * @returns {string} a `---\n…\n---\n` block.
 */
export function generateArchiveFrontmatter(opts = {}) {
  return renderFrontmatter(buildArchiveFields(opts));
}

/**
 * Archive a repo file into the vault by copying it with a generated, schema-valid
 * frontmatter. Does NOT delete the source. Under `dryRun` (default true) NOTHING
 * is written — the returned manifest entry describes the planned move only.
 *
 * If the source already carries YAML frontmatter, its mandatory vault fields are
 * merged in place (no double `---` block).
 *
 * @param {object} opts
 * @param {string} [opts.repoRoot] — repo root for the repo-relative `source`/manifest.
 * @param {string} opts.vaultDir — absolute or `~`-prefixed vault root (REQUIRED);
 *   a leading `~` is expanded via {@link expandTilde} before use.
 * @param {string} opts.sourcePath — absolute path of the file to archive (REQUIRED).
 * @param {string} opts.targetSubdir — vault-relative destination directory.
 * @param {Record<string, unknown>} [opts.frontmatterOverrides] — final field overrides.
 * @param {boolean} [opts.dryRun=true]
 * @param {Date} [opts.now]
 * @param {Set<string>} [opts.takenIds]
 * @param {string} [opts.title]
 * @param {string|number} [opts.issueRef]
 * @param {string} [opts.type]
 * @param {string} [opts.status]
 * @returns {{ source: string, target: string, action: 'archived'|'would-archive', id: string }}
 */
export function archiveFileToVault({
  repoRoot,
  vaultDir,
  sourcePath,
  targetSubdir = '',
  frontmatterOverrides = {},
  dryRun = true,
  now,
  takenIds,
  title,
  issueRef,
  type,
  status,
} = {}) {
  if (!vaultDir) throw new Error('vault-archive: vaultDir is required');
  if (!sourcePath) throw new Error('vault-archive: sourcePath is required');

  const filename = basename(sourcePath);
  const targetRel = join(targetSubdir, filename);
  // Expand a `~`-prefixed vaultDir (e.g. the committed Session Config default
  // `~/Projects/vault`) before joining — without this, a host lacking
  // owner.yaml/SO_VAULT_DIR writes into a literal `./~` directory instead of
  // the real home-relative vault (single seam covers both the
  // archive-closed-prds CLI and the docs-Public-Split corpus mover).
  const vaultRoot = expandTilde(vaultDir);
  const targetAbs = join(vaultRoot, targetSubdir, filename);

  // #793 GAP-3: containment guard — a caller-supplied targetSubdir (e.g.
  // `../../etc`) must not resolve outside the vault root. relative()-based,
  // not a bare startsWith(vaultRoot) prefix check — a sibling directory that
  // merely shares a string prefix (`/vault-evil` vs `/vault`) would otherwise
  // slip past a naive check. Runs before any write AND before the dry-run
  // report, so a planned escape is refused rather than silently manifested.
  const relToVault = relative(vaultRoot, targetAbs);
  if (relToVault.startsWith('..') || isAbsolute(relToVault)) {
    throw new Error(`vault-archive: targetSubdir '${targetSubdir}' escapes vault root`);
  }

  const raw = readFileSync(sourcePath, 'utf8');
  const { frontmatter: existing, body } = splitFrontmatter(raw);

  const fields = buildArchiveFields({
    sourcePath,
    title: title ?? titleFromMarkdown(body),
    issueRef,
    type,
    status,
    now,
    repoRoot,
    existing,
    takenIds,
    overrides: frontmatterOverrides,
  });

  const content = renderFrontmatter(fields) + body;

  if (!dryRun) {
    mkdirSync(dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, content, 'utf8');
  }

  return {
    source: repoRoot ? relative(repoRoot, sourcePath) : sourcePath,
    target: targetRel,
    action: dryRun ? 'would-archive' : 'archived',
    id: fields.id,
  };
}
