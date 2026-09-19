/**
 * vault-yaml.test.mjs — Unit tests for scripts/lib/vault-yaml.mjs (#1131).
 *
 * The bugs each case names:
 *  - a declared `metadata.slug` is ignored, so every vault writer files the repo
 *    under a directory-derived name instead (the #1131 defect itself);
 *  - a malformed / absent / key-less `.vault.yaml` THROWS or returns a junk
 *    value, breaking a vault write that must degrade instead;
 *  - an unvalidated slug becomes a filesystem path segment, so `../evil`
 *    escapes the vault root (trust boundary).
 *
 * PORTABLE — every fixture lives under os.tmpdir(); nothing reads or writes a
 * real vault.
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { readVaultSlug, VAULT_YAML_FILE } from '@lib/vault-yaml.mjs';

let tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tmpDirs = [];
});

/** Create a tmp repo root, optionally carrying a `.vault.yaml` with `content`. */
function repoWith(content) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vault-yaml-'));
  tmpDirs.push(dir);
  if (typeof content === 'string') {
    fs.writeFileSync(path.join(dir, VAULT_YAML_FILE), content);
  }
  return dir;
}

/** The real `.vault.yaml` shape written by scripts/lib/vault-backfill/template.mjs. */
function vaultYaml(slugLiteral) {
  return [
    'apiVersion: vault.example/v1',
    'kind: Repository',
    '',
    'metadata:',
    '  name: Acme Tool',
    `  slug: ${slugLiteral}`,
    '  tier: active',
    '',
    'spec:',
    '  status: production',
    '',
  ].join('\n');
}

describe('readVaultSlug — happy path', () => {
  it('returns the declared metadata.slug from a real-shaped .vault.yaml', () => {
    expect(readVaultSlug(repoWith(vaultYaml('acme-tool')))).toBe('acme-tool');
  });

  it('returns the declared slug even when it differs from the directory name (the #1131 bug)', () => {
    // The directory is a mkdtemp name; the slug is something else entirely.
    // Pre-#1131 nothing read this key, so the directory name won by default.
    const dir = repoWith(vaultYaml('acme'));
    expect(readVaultSlug(dir)).toBe('acme');
    expect(readVaultSlug(dir)).not.toBe(path.basename(dir));
  });

  it('accepts a quoted scalar (the form renderTemplate writes)', () => {
    expect(readVaultSlug(repoWith(vaultYaml('"acme-tool"')))).toBe('acme-tool');
  });
});

describe('readVaultSlug — every degraded input returns null and never throws', () => {
  it.each([
    ['absent file', undefined],
    ['empty file', ''],
    ['malformed YAML (unclosed bracket)', 'metadata: [slug: acme\n  broken: : :\n'],
    ['YAML scalar, not a mapping', 'just-a-string\n'],
    ['missing metadata block', 'apiVersion: vault.example/v1\nspec:\n  status: production\n'],
    ['missing metadata.slug key', 'metadata:\n  name: Acme Tool\n  tier: active\n'],
    ['metadata is a string, not a mapping', 'metadata: acme-tool\n'],
    ['non-string slug (number)', vaultYaml('42')],
    ['non-string slug (mapping)', 'metadata:\n  slug:\n    nested: acme\n'],
    ['null slug', vaultYaml('~')],
    ['path traversal "../evil"', vaultYaml('"../evil"')],
    ['absolute path "/etc/passwd"', vaultYaml('"/etc/passwd"')],
    ['nested path "acme/tool"', vaultYaml('"acme/tool"')],
    ['leading dot ".hidden"', vaultYaml('".hidden"')],
    ['whitespace "Foo Bar"', vaultYaml('"Foo Bar"')],
    ['uppercase "FooBarApp"', vaultYaml('"FooBarApp"')],
    ['trailing hyphen "acme-"', vaultYaml('"acme-"')],
    ['empty string slug', vaultYaml('""')],
  ])('%s → null', (_name, content) => {
    expect(readVaultSlug(repoWith(content))).toBeNull();
  });

  it.each([
    ['empty repoRoot', ''],
    ['whitespace repoRoot', '   '],
    ['undefined repoRoot', undefined],
    ['null repoRoot', null],
    ['non-string repoRoot', 42],
  ])('%s → null', (_name, repoRoot) => {
    expect(readVaultSlug(repoRoot)).toBeNull();
  });

  it('a directory named .vault.yaml reads as null rather than throwing (EISDIR)', () => {
    const dir = repoWith(undefined);
    fs.mkdirSync(path.join(dir, VAULT_YAML_FILE));
    expect(readVaultSlug(dir)).toBeNull();
  });
});
