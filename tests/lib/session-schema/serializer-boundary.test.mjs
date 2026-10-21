/**
 * Boundary coverage for the session-schema serializer split (#1009).
 *
 * TV-001 bug: a library importing the CLI entry point creates an inverted
 * dependency with CLI side effects/cycle risk; duplicate serializer exports
 * can also diverge in behavior or ValidationError identity.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeSessionLineChecked as leafSerializer } from '../../../scripts/lib/session-schema/serializer.mjs';
import {
  serializeSessionLineChecked as barrelSerializer,
  ValidationError as barrelValidationError,
} from '../../../scripts/lib/session-schema.mjs';
import { serializeSessionLineChecked as legacySerializer } from '../../../scripts/emit-session.mjs';
import { ValidationError as validatorValidationError } from '../../../scripts/lib/session-schema/validator.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LIB_ROOT = path.join(REPO_ROOT, 'scripts', 'lib');
const SERIALIZER_PATH = path.join(LIB_ROOT, 'session-schema', 'serializer.mjs');

function listMjsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? listMjsFiles(entryPath)
      : entry.name.endsWith('.mjs')
        ? [entryPath]
        : [];
  });
}

function importedSpecifiers(source) {
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? match[2]
  );
}

describe('session-schema serializer module boundary (#1009)', () => {
  it('keeps the serializer leaf independent from the parent barrel and CLI', () => {
    const serializerImports = importedSpecifiers(readFileSync(SERIALIZER_PATH, 'utf8'));
    const cliImporters = listMjsFiles(LIB_ROOT).filter((filePath) =>
      importedSpecifiers(readFileSync(filePath, 'utf8')).some((specifier) =>
        specifier.endsWith('emit-session.mjs')
      )
    );

    expect(serializerImports).toContain('./validator.mjs');
    expect(serializerImports).not.toContain('../session-schema.mjs');
    expect(serializerImports).not.toContain('./session-schema.mjs');
    expect(cliImporters).toEqual([]);
  });

  it('keeps direct, barrel, and legacy serializer exports identity-equal', () => {
    expect(leafSerializer).toBe(barrelSerializer);
    expect(leafSerializer).toBe(legacySerializer);
  });

  it('round-trips mixed cross-repo issues through every public serializer (#1603)', () => {
    const record = {
      session_id: 'sess-2026-10-14-cross-repo',
      session_type: 'deep',
      started_at: '2026-10-14T08:00:00Z',
      completed_at: '2026-10-14T09:00:00Z',
      total_waves: 0,
      waves: [],
      agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
      total_agents: 0,
      total_files_changed: 0,
      issues_created: [4, 'products/apple-mail-kit#92', 'Group/sub_group/repo.name#1603', 9],
    };
    const lines = [leafSerializer, barrelSerializer, legacySerializer].map((serialize) => {
      const line = serialize(record);
      const parsed = JSON.parse(line);
      expect(parsed.issues_created).toEqual([
        4, 'products/apple-mail-kit#92', 'Group/sub_group/repo.name#1603', 9,
      ]);
      expect(parsed).not.toHaveProperty('schema_version');
      expect(line.endsWith('\n')).toBe(true);
      return line;
    });
    expect(lines[1]).toBe(lines[0]);
    expect(lines[2]).toBe(lines[0]);
  });

  it('keeps the shared ValidationError class identity across the library boundary', () => {
    expect(barrelValidationError).toBe(validatorValidationError);
    expect(() => legacySerializer(undefined)).toThrow(validatorValidationError);
  });

  it('wraps non-Error toJSON throws in the shared ValidationError class', () => {
    expect(() =>
      leafSerializer({
        toJSON() {
          throw null;
        },
      })
    ).toThrow(validatorValidationError);
  });
});
