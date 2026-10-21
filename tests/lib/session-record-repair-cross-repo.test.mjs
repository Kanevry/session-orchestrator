/** #1603: synthetic records prove reference preservation at the repair boundary. */
import { describe, it, expect } from 'vitest';
import { repairLine } from '@lib/session-record-repair.mjs';
import { validateSession } from '@lib/session-schema/validator.mjs';

function validRecord() {
  return {
    session_id: 'sess-2026-10-14-cross-repo',
    session_type: 'deep',
    started_at: '2026-10-14T08:00:00Z',
    completed_at: '2026-10-14T09:00:00Z',
    total_waves: 0,
    waves: [],
    agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
    total_agents: 0,
    total_files_changed: 0,
    issues_created: ['products/apple-mail-kit#92', 4, 'Group/sub_group/repo.name#1603'],
  };
}

describe('repairLine cross-repo issues (#1603)', () => {
  it('returns valid with the exact original whitespace, key order and bytes', () => {
    const record = validRecord();
    const line = `  ${JSON.stringify(record, null, 2)}  `;
    const result = repairLine(line);
    expect(result.status).toBe('valid');
    expect(result.line).toBe(line);
    expect(result.error).toBeNull();
    expect(result.defects).toEqual([]);
  });

  it('repairs a missing file count without changing reference values, types or order', () => {
    const record = validRecord();
    delete record.total_files_changed;
    const result = repairLine(JSON.stringify(record));
    expect(result.status).toBe('repaired');
    expect(result.defects).toContain('total_files_changed_missing');
    const parsed = JSON.parse(result.line);
    expect(parsed.total_files_changed).toBe(0);
    expect(parsed.issues_created).toEqual([
      'products/apple-mail-kit#92', 4, 'Group/sub_group/repo.name#1603',
    ]);
    expect(parsed).not.toHaveProperty('schema_version');
    expect(() => validateSession(parsed)).not.toThrow();
  });

  it.each(['repo#92', ' products/apple-mail-kit#92', 'products/apple-mail-kit#92\n', null])(
    'preserves invalid reference %j as an error, even alongside a repairable defect', (value) => {
      for (const missingCount of [false, true]) {
        const record = { ...validRecord(), issues_created: [4, value] };
        if (missingCount) delete record.total_files_changed;
        const line = JSON.stringify(record);
        const result = repairLine(line);
        expect(result.status).toBe('error');
        expect(result.line).toBe(line);
        expect(result.error).toMatch(/issues_created\[1\].*number or qualified reference group\/repo#n/);
      }
    }
  );
});
