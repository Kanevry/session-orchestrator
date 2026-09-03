// sync-vault-schema.mjs — the canonical .ts may carry a BARE `//` line inside a
// comment run (projects-baseline vault-frontmatter.ts does, inside
// vaultNoteStatusSchema). Measured 2026-09-03: `stripCommentLine` only dropped
// `// <text>` lines, so the generated block carried a stray `//` and every
// --check afterwards reported drift that no enum value explained (#531/#1175).
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/sync-vault-schema.mjs');

const CANONICAL = `import { z } from 'zod';
export const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const tagPathRegex = /^[a-z0-9]+$/;
export const isoDateRegex = /^\\d{4}-\\d{2}-\\d{2}$/;
/** Note category */
export const vaultNoteTypeSchema = z.enum([
  'note',
  'peer-card',
]);
export type VaultNoteType = z.infer<typeof vaultNoteTypeSchema>;
export const vaultNoteStatusSchema = z.enum([
  'draft',
  // A comment run with a blank comment line in the middle:
  //
  // continues here.
  'archived',
]);
export const vaultFrontmatterSchema = z
  .object({
    id: z.string().regex(slugRegex),
    type: vaultNoteTypeSchema,
    status: vaultNoteStatusSchema.optional(),
  })
  .passthrough();
export type VaultFrontmatter = z.infer<typeof vaultFrontmatterSchema>;
`;

const VALIDATOR = `import { z } from 'zod';
// ── BEGIN GENERATED SCHEMA (sync-vault-schema.mjs) — do not edit between sentinels ──
const placeholder = 1;
// ── END GENERATED SCHEMA ──
export { placeholder };
`;

function generatedBlock(text) {
  const lines = text.split('\n');
  const a = lines.findIndex((l) => l.includes('── BEGIN GENERATED SCHEMA'));
  const b = lines.findIndex((l) => l.includes('── END GENERATED SCHEMA ──'));
  return lines.slice(a + 1, b);
}

describe('sync-vault-schema.mjs — bare `//` comment lines in the canonical source', () => {
  it('--write drops a bare `//` (it is a comment, not content) and --check is then clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-sync-vault-schema-'));
    try {
      const canonical = join(dir, 'vault-frontmatter.ts');
      const validator = join(dir, 'validator.mjs');
      writeFileSync(canonical, CANONICAL);
      writeFileSync(validator, VALIDATOR);

      execFileSync('node', [SCRIPT, '--write', '--canonical', canonical, '--validator', validator], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const block = generatedBlock(readFileSync(validator, 'utf8'));
      // The enum values survive; the comment run — including its bare `//` — does not.
      expect(block.some((l) => l.includes("'archived'"))).toBe(true);
      expect(block.filter((l) => l.trim() === '//')).toEqual([]);
      expect(block.some((l) => l.includes('continues here'))).toBe(false);

      const check = spawnSync('node', [SCRIPT, '--check', '--canonical', canonical, '--validator', validator], {
        encoding: 'utf8',
      });
      expect(check.status, check.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
