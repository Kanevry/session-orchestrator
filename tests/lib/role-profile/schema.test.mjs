import { describe, expect, it } from 'vitest';
import { roleProfileEvidenceSchema } from '../../../scripts/lib/role-profile/schema.mjs';

// Inline contract records; source references are fictional, never live account data.
const known = value => ({ status: 'known', value, sourceRef: 'fixture:version', reason: null });
const unknown = field => ({ status: 'unknown', [field]: null, sourceRef: null, reason: 'Not measured' });
function record() {
  return {
    contractVersion: 1, role: 'worker', taskClass: 'implementation', provider: 'openai', transport: 'codex-cli',
    binding: { status: 'known', sourceRef: 'fixture:binding', reason: null },
    model: {
      requested: { kind: 'id', value: 'unlisted-model/2030' },
      observed: { status: 'known', id: 'unlisted-model/2030', sourceRef: 'fixture:observation', reason: null },
      resolution: { status: 'exact', baselineId: null, parent: null, sourceRef: 'fixture:resolution', reason: null },
    },
    effort: {
      requested: { provider: 'openai', dialect: 'openai-reasoning', value: 'medium' },
      effective: { provider: 'openai', dialect: 'openai-reasoning', ...known('medium') },
      support: { status: 'supported', sourceRef: 'fixture:capability', reason: null },
    },
    harness: { name: 'codex', version: known('fixture-build') },
    profile: { id: 'routine', version: known('fixture-profile') }, registryVersion: known('fixture-registry'),
    selection: { mode: 'profile', escalationReason: null },
    authorization: { status: 'not-required', authority: null, sourceRef: null, scope: null, reason: 'Record only' },
    evidence: { status: 'known', timestamp: '2026-10-10T16:00:00.000Z', sourceRef: 'fixture:receipt', reason: null },
  };
}
function unobserved() {
  const r = record();
  r.model.observed = unknown('id');
  r.model.resolution = { status: 'unknown', baselineId: null, parent: null, sourceRef: null, reason: 'Not resolved' };
  r.effort.effective = { provider: 'openai', dialect: 'openai-reasoning', ...unknown('value') };
  r.effort.support = { status: 'unknown', sourceRef: null, reason: 'No capability measurement' };
  return r;
}
function authorize(r) {
  r.authorization = {
    status: 'authorized', authority: 'owner', sourceRef: 'fixture:owner-decision', reason: null,
    scope: { role: r.role, provider: r.provider, transport: r.transport,
      model: { ...r.model.requested }, effort: { ...r.effort.requested } },
  };
}
function freeze(v) {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
function rejected(r, code, path) {
  const result = roleProfileEvidenceSchema.safeParse(r);
  expect(result.success).toBe(false);
  expect(result.error.issues).toContainEqual(expect.objectContaining({ code, path }));
}

describe('role-profile evidence contract v1', () => {
  it('accepts documented observations without catalog-normalizing unknown IDs', () => {
    const result = roleProfileEvidenceSchema.safeParse(record());
    expect(result.success).toBe(true);
    expect(result.data.model.observed.id).toBe('unlisted-model/2030');
    expect(result.diagnostics).toEqual([]);
    expect(result).not.toHaveProperty('approved');
  });
  it('preserves unknown evidence without manufacturing an observation', () => {
    const r = unobserved();
    const result = roleProfileEvidenceSchema.safeParse(r);
    expect(result.success).toBe(true);
    expect(result.data.model.observed).toEqual({ status: 'unknown', id: null, sourceRef: null, reason: 'Not measured' });
    expect(result.data.model.resolution.status).toBe('unknown');
    expect(result.data.effort.effective.status).toBe('unknown');
    expect(result.data.model.requested.value).toBe('unlisted-model/2030');
  });
  it('allows explicitly unknown versions, binding, provider and effort dialect', () => {
    const r = unobserved();
    r.provider = 'future-provider'; r.transport = 'future-transport';
    r.binding = { status: 'unknown', sourceRef: null, reason: 'New binding' };
    for (const e of [r.effort.requested, r.effort.effective]) {
      e.provider = 'future-provider'; e.dialect = 'future-dialect';
    }
    r.effort.requested.value = 'future-level';
    r.harness.version = unknown('value'); r.profile.version = unknown('value');
    r.registryVersion = unknown('value'); r.evidence = unknown('timestamp');
    const result = roleProfileEvidenceSchema.safeParse(r);
    expect(result.success).toBe(true);
    expect(result.data.effort.requested.value).toBe('future-level');
  });
  it.each(['owner-override', 'escalation'])('requires a scoped owner receipt for %s', mode => {
    const r = record(); r.selection.mode = mode;
    if (mode === 'escalation') r.selection.escalationReason = 'Contract complexity';
    rejected(r, 'INVALID_RELATION', ['authorization', 'status']);
    authorize(r);
    expect(roleProfileEvidenceSchema.safeParse(r).success).toBe(true);
    const receipt = r.authorization.sourceRef;
    for (const [code, change] of [
      ['INVALID_TYPE', a => { a.sourceRef = null; }],
      ['INVALID_TYPE', a => { a.sourceRef = ' '; }],
      ['MISSING_FIELD', a => { delete a.sourceRef; }],
    ]) {
      change(r.authorization);
      rejected(r, code, ['authorization', 'sourceRef']);
      r.authorization.sourceRef = receipt;
    }
    r.authorization.scope.effort.value = 'high';
    rejected(r, 'INVALID_RELATION', ['authorization', 'scope', 'effort', 'value']);
  });
  it('reports unsupported effort while allowing a documented different effective value', () => {
    const r = unobserved();
    r.effort.support = { status: 'unsupported', sourceRef: 'fixture:capability', reason: null };
    expect(roleProfileEvidenceSchema.safeParse(r).diagnostics).toEqual([
      { code: 'UNSUPPORTED_EFFORT', path: ['effort', 'requested', 'value'], message: 'Requested effort is documented as unsupported' },
    ]);
    r.effort.effective = { provider: 'openai', dialect: 'openai-reasoning', ...known('low') };
    expect(roleProfileEvidenceSchema.safeParse(r).success).toBe(true);
    r.effort.effective.value = 'medium';
    rejected(r, 'INVALID_RELATION', ['effort', 'effective']);
  });
  it('separates alias resolution, baseline drift and parent inheritance', () => {
    const r = record(); r.model.requested = { kind: 'alias', value: 'workhorse' };
    r.model.resolution.status = 'alias-resolved';
    expect(roleProfileEvidenceSchema.safeParse(r).success).toBe(true);
    r.model.resolution.status = 'alias-drift'; r.model.resolution.baselineId = 'previous-model';
    expect(roleProfileEvidenceSchema.safeParse(r).success).toBe(true);
    r.model.resolution.baselineId = r.model.observed.id;
    rejected(r, 'INVALID_RELATION', ['model', 'resolution', 'baselineId']);
    r.model.requested = { kind: 'inherit', value: null };
    r.model.resolution = { status: 'parent-inherit', baselineId: null,
      parent: { id: 'unlisted-model/2030', sourceRef: 'fixture:parent' }, sourceRef: 'fixture:inherit', reason: null };
    expect(roleProfileEvidenceSchema.safeParse(r).success).toBe(true);
    r.model.resolution.parent.id = 'another-parent';
    rejected(r, 'INVALID_RELATION', ['model', 'resolution']);
    const missing = unobserved(); missing.model.requested = { kind: 'inherit', value: null };
    expect(roleProfileEvidenceSchema.safeParse(missing).success).toBe(true);
  });
  it('accepts anthropic effort only in its own provider and transport dialect', () => {
    const r = record(); r.provider = 'anthropic'; r.transport = 'claude-code';
    for (const e of [r.effort.requested, r.effort.effective]) {
      e.provider = 'anthropic'; e.dialect = 'anthropic-effort'; e.value = 'high';
    }
    expect(roleProfileEvidenceSchema.safeParse(r).success).toBe(true);
    r.effort.requested.dialect = 'openai-reasoning';
    rejected(r, 'INVALID_RELATION', ['effort', 'requested', 'dialect']);
  });
  it.each([
    ['missing observation', r => { delete r.model.observed; }, 'INVALID_TYPE', ['model', 'observed']],
    ['fabricated resolution', r => { r.model.observed = unknown('id'); }, 'INVALID_RELATION', ['model', 'resolution', 'status']],
    ['exact ID mismatch', r => { r.model.observed.id = 'different'; }, 'INVALID_RELATION', ['model', 'resolution']],
    ['wrong transport', r => { r.transport = 'claude-code'; }, 'INVALID_RELATION', ['binding']],
    ['numeric effort', r => { r.effort.requested.value = 2; }, 'INVALID_TYPE', ['effort', 'requested', 'value']],
    ['provider mismatch', r => { r.effort.effective.provider = 'anthropic'; }, 'INVALID_RELATION', ['effort', 'effective', 'provider']],
    ['unknown dialect claimed supported', r => { r.effort.requested.dialect = 'mystery'; }, 'INVALID_RELATION', ['effort', 'requested', 'dialect']],
    ['unknown ID present', r => { r.model.observed = { ...unknown('id'), id: 'invented' }; }, 'INVALID_RELATION', ['model', 'observed', 'id']],
    ['empty observation source', r => { r.model.observed.sourceRef = ''; }, 'INVALID_TYPE', ['model', 'observed', 'sourceRef']],
    ['invalid calendar date', r => { r.evidence.timestamp = '2026-02-30T16:00:00.000Z'; }, 'INVALID_RELATION', ['evidence', 'timestamp']],
    ['unknown field', r => { r.approved = true; }, 'UNKNOWN_FIELD', ['approved']],
    ['missing task class', r => { delete r.taskClass; }, 'MISSING_FIELD', ['taskClass']],
    ['future version', r => { r.contractVersion = 2; }, 'UNSUPPORTED_VERSION', ['contractVersion']],
    ['string version', r => { r.contractVersion = '1'; }, 'UNSUPPORTED_VERSION', ['contractVersion']],
    ['wrong authority', r => { authorize(r); r.authorization.authority = 'agent'; }, 'INVALID_RELATION', ['authorization', 'authority']],
    ['missing escalation reason', r => { authorize(r); r.selection.mode = 'escalation'; }, 'INVALID_TYPE', ['selection', 'escalationReason']],
  ])('rejects %s with a field-addressed issue', (_name, edit, code, path) => {
    const r = record(); edit(r); rejected(r, code, path);
  });
  it.each([null, [], 'record', 42])('rejects non-object input %j without throwing', input => {
    rejected(input, 'INVALID_TYPE', []);
  });
  it('validates frozen success and failure inputs without mutation or nondeterminism', () => {
    for (const r of [unobserved(), { ...record(), taskClass: '' }]) {
      const snapshot = globalThis.structuredClone(r); freeze(r);
      expect(roleProfileEvidenceSchema.safeParse(r)).toEqual(roleProfileEvidenceSchema.safeParse(r));
      expect(r).toEqual(snapshot);
    }
  });
});
