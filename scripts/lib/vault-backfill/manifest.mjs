/**
 * manifest.mjs — JSON manifest validation for vault-backfill headless mode.
 *
 * Validates the --yes <manifest.json> file format.
 * Part of scripts/vault-backfill.mjs (Issue #241).
 */

const VALID_TIERS = new Set(['top', 'active', 'archived']);
const VALID_VISIBILITIES = new Set(['public', 'internal', 'private']);
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate and normalise a manifest object.
 * Calls dieFn(1, ...) on any schema violation.
 *
 * @param {unknown} raw - parsed JSON from manifest file
 * @param {(code: number, msg: string) => never} dieFn
 * @returns {Array<{ id: number, path: string, slug: string, tier: string, visibility: string, skip: boolean }>}
 */
export function validateManifest(raw, dieFn) {
  if (typeof raw !== 'object' || raw === null) {
    dieFn(1, 'manifest must be a JSON object');
  }

  if (raw.version !== 1) {
    dieFn(1, `manifest.version must be 1, got: ${JSON.stringify(raw.version)}`);
  }

  if (!Array.isArray(raw.repos)) {
    dieFn(1, 'manifest.repos must be an array');
  }

  return raw.repos.map((entry, i) => {
    const prefix = `manifest.repos[${i}]`;

    if (typeof entry.id !== 'number') dieFn(1, `${prefix}.id must be a number`);
    if (typeof entry.path !== 'string' || !entry.path) {
      dieFn(1, `${prefix}.path must be a non-empty string`);
    }
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      dieFn(
        1,
        `${prefix}.path '${entry.path}' is invalid — must be a relative repo path (no leading '/' or '..' segments)`,
      );
    }
    if (typeof entry.slug !== 'string') dieFn(1, `${prefix}.slug must be a string`);
    if (!SLUG_RE.test(entry.slug)) {
      dieFn(
        1,
        `${prefix}.slug '${entry.slug}' is invalid — must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/`,
      );
    }
    if (!VALID_TIERS.has(entry.tier)) {
      dieFn(
        1,
        `${prefix}.tier '${entry.tier}' is invalid — must be one of: top|active|archived`,
      );
    }
    if (!VALID_VISIBILITIES.has(entry.visibility)) {
      dieFn(
        1,
        `${prefix}.visibility '${entry.visibility}' is invalid — must be one of: public|internal|private`,
      );
    }

    return {
      id: entry.id,
      path: entry.path,
      slug: entry.slug,
      tier: entry.tier,
      visibility: entry.visibility,
      skip: entry.skip === true,
    };
  });
}
