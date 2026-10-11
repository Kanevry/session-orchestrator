/**
 * Offline role-profile evidence contract. Refs #1469.
 * Validation checks internal consistency, never source authenticity or runtime capability.
 */
export const ROLE_PROFILE_CONTRACT_VERSION = 1;

const BINDINGS = new Map([['openai', 'codex-cli'], ['anthropic', 'claude-code']]);
const DIALECTS = new Map([['openai-reasoning', 'openai'], ['anthropic-effort', 'anthropic']]);

/**
 * @param {unknown} value JSON data, without accessors or class instances.
 * @returns {{success: true, data: unknown, diagnostics: object[]} |
 * {success: false, error: {issues: {code: string, path: (string|number)[], message: string}[]}}}
 */
function safeParse(value) {
  const issues = [];
  const diagnostics = [];
  const fail = (code, path, message) => issues.push({ code, path, message });
  const object = (v, keys, path) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      fail('INVALID_TYPE', path, 'Expected a plain object');
      return {};
    }
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) {
      fail('INVALID_TYPE', path, 'Expected data properties');
      return {};
    }
    for (const key of Reflect.ownKeys(v)) {
      if (!keys.includes(key)) fail('UNKNOWN_FIELD', [...path, String(key)], 'Unknown field');
    }
    for (const key of keys) {
      if (!Object.hasOwn(v, key)) fail('MISSING_FIELD', [...path, key], 'Required field is missing');
    }
    return v;
  };
  const string = (v, path) => {
    if (typeof v !== 'string' || !v.trim()) fail('INVALID_TYPE', path, 'Expected a nonempty string');
  };
  const isNull = (v, path) => {
    if (v !== null) fail('INVALID_RELATION', path, 'Expected null in this evidence state');
  };
  const oneOf = (v, values, path) => {
    if (!values.includes(v)) fail('INVALID_VALUE', path, 'Unsupported discriminator');
  };
  const relation = (condition, path, message) => {
    if (!condition) fail('INVALID_RELATION', path, message);
  };
  const evidence = (v, field, path, statuses = ['known', 'unknown']) => {
    const e = object(v, ['status', field, 'sourceRef', 'reason'], path);
    oneOf(e.status, statuses, [...path, 'status']);
    if (e.status === 'unknown') {
      isNull(e[field], [...path, field]);
      isNull(e.sourceRef, [...path, 'sourceRef']);
      string(e.reason, [...path, 'reason']);
    } else if (statuses.includes(e.status)) {
      string(e[field], [...path, field]);
      string(e.sourceRef, [...path, 'sourceRef']);
      isNull(e.reason, [...path, 'reason']);
    }
    return e;
  };

  const root = object(value, ['contractVersion', 'role', 'taskClass', 'provider', 'transport',
    'binding', 'model', 'effort', 'harness', 'profile', 'registryVersion', 'selection',
    'authorization', 'evidence'], []);
  if (root.contractVersion !== ROLE_PROFILE_CONTRACT_VERSION) {
    fail('UNSUPPORTED_VERSION', ['contractVersion'], 'Expected contract version 1');
    return { success: false, error: { issues } };
  }
  for (const key of ['role', 'taskClass', 'provider', 'transport']) string(root[key], [key]);
  const binding = object(root.binding, ['status', 'sourceRef', 'reason'], ['binding']);
  oneOf(binding.status, ['known', 'unknown'], ['binding', 'status']);
  if (binding.status === 'known') {
    string(binding.sourceRef, ['binding', 'sourceRef']);
    isNull(binding.reason, ['binding', 'reason']);
    relation(BINDINGS.has(root.provider) && BINDINGS.get(root.provider) === root.transport,
      ['binding'], 'Known provider/transport binding must match the v1 contract');
  } else if (binding.status === 'unknown') {
    isNull(binding.sourceRef, ['binding', 'sourceRef']);
    string(binding.reason, ['binding', 'reason']);
  }

  const model = object(root.model, ['requested', 'observed', 'resolution'], ['model']);
  const requested = object(model.requested, ['kind', 'value'], ['model', 'requested']);
  oneOf(requested.kind, ['id', 'alias', 'inherit'], ['model', 'requested', 'kind']);
  if (requested.kind === 'inherit') isNull(requested.value, ['model', 'requested', 'value']);
  else string(requested.value, ['model', 'requested', 'value']);
  const observed = evidence(model.observed, 'id', ['model', 'observed']);
  const resolution = object(model.resolution,
    ['status', 'baselineId', 'parent', 'sourceRef', 'reason'], ['model', 'resolution']);
  oneOf(resolution.status, ['exact', 'alias-resolved', 'alias-drift', 'parent-inherit', 'unknown'],
    ['model', 'resolution', 'status']);
  if (observed.status === 'unknown') {
    relation(resolution.status === 'unknown', ['model', 'resolution', 'status'],
      'Unknown observation must retain unknown resolution');
  }
  if (resolution.status === 'unknown') {
    isNull(resolution.baselineId, ['model', 'resolution', 'baselineId']);
    isNull(resolution.parent, ['model', 'resolution', 'parent']);
    isNull(resolution.sourceRef, ['model', 'resolution', 'sourceRef']);
    string(resolution.reason, ['model', 'resolution', 'reason']);
  } else if (['exact', 'alias-resolved', 'alias-drift', 'parent-inherit'].includes(resolution.status)) {
    relation(observed.status === 'known', ['model', 'observed'], 'Resolution requires an observation');
    string(resolution.sourceRef, ['model', 'resolution', 'sourceRef']);
    isNull(resolution.reason, ['model', 'resolution', 'reason']);
    if (resolution.status !== 'alias-drift') isNull(resolution.baselineId, ['model', 'resolution', 'baselineId']);
    if (resolution.status !== 'parent-inherit') isNull(resolution.parent, ['model', 'resolution', 'parent']);
    if (resolution.status === 'exact') {
      relation(requested.kind === 'id' && requested.value === observed.id,
        ['model', 'resolution'], 'Exact resolution requires the requested ID');
    } else if (['alias-resolved', 'alias-drift'].includes(resolution.status)) {
      relation(requested.kind === 'alias', ['model', 'requested', 'kind'], 'Alias resolution requires an alias');
      if (resolution.status === 'alias-drift') {
        string(resolution.baselineId, ['model', 'resolution', 'baselineId']);
        relation(resolution.baselineId !== observed.id, ['model', 'resolution', 'baselineId'],
          'Alias drift requires a different documented baseline ID');
      }
    } else {
      const parent = object(resolution.parent, ['id', 'sourceRef'], ['model', 'resolution', 'parent']);
      string(parent.id, ['model', 'resolution', 'parent', 'id']);
      string(parent.sourceRef, ['model', 'resolution', 'parent', 'sourceRef']);
      relation(requested.kind === 'inherit' && parent.id === observed.id,
        ['model', 'resolution'], 'Parent inheritance requires matching parent evidence');
    }
  }

  const effort = object(root.effort, ['requested', 'effective', 'support'], ['effort']);
  const requestedEffort = object(effort.requested, ['provider', 'dialect', 'value'], ['effort', 'requested']);
  const effective = object(effort.effective,
    ['provider', 'dialect', 'status', 'value', 'sourceRef', 'reason'], ['effort', 'effective']);
  const support = object(effort.support, ['status', 'sourceRef', 'reason'], ['effort', 'support']);
  oneOf(support.status, ['supported', 'unsupported', 'unknown'], ['effort', 'support', 'status']);
  if (support.status === 'unknown') {
    isNull(support.sourceRef, ['effort', 'support', 'sourceRef']);
    string(support.reason, ['effort', 'support', 'reason']);
  } else if (['supported', 'unsupported'].includes(support.status)) {
    string(support.sourceRef, ['effort', 'support', 'sourceRef']);
    isNull(support.reason, ['effort', 'support', 'reason']);
  }
  oneOf(effective.status, ['known', 'unknown'], ['effort', 'effective', 'status']);
  for (const [key, entry] of [['requested', requestedEffort], ['effective', effective]]) {
    string(entry.provider, ['effort', key, 'provider']);
    string(entry.dialect, ['effort', key, 'dialect']);
    relation(entry.provider === root.provider, ['effort', key, 'provider'], 'Effort provider must match the record');
    if (DIALECTS.has(entry.dialect)) {
      relation(DIALECTS.get(entry.dialect) === entry.provider, ['effort', key, 'dialect'],
        'Effort dialect belongs to a different provider');
    } else {
      relation(support.status === 'unknown' && effective.status === 'unknown', ['effort', key, 'dialect'],
        'Unrecognized effort dialect requires unknown support and effective evidence');
    }
  }
  if (requestedEffort.value !== null) string(requestedEffort.value, ['effort', 'requested', 'value']);
  if (effective.status === 'unknown') {
    isNull(effective.value, ['effort', 'effective', 'value']);
    isNull(effective.sourceRef, ['effort', 'effective', 'sourceRef']);
    string(effective.reason, ['effort', 'effective', 'reason']);
  } else if (effective.status === 'known') {
    string(effective.value, ['effort', 'effective', 'value']);
    string(effective.sourceRef, ['effort', 'effective', 'sourceRef']);
    isNull(effective.reason, ['effort', 'effective', 'reason']);
  }
  if (support.status === 'unsupported') {
    diagnostics.push({ code: 'UNSUPPORTED_EFFORT', path: ['effort', 'requested', 'value'],
      message: 'Requested effort is documented as unsupported' });
    relation(!(effective.status === 'known' && effective.value === requestedEffort.value),
      ['effort', 'effective'], 'Unsupported requested effort cannot also be claimed effective');
  }

  const harness = object(root.harness, ['name', 'version'], ['harness']);
  string(harness.name, ['harness', 'name']);
  evidence(harness.version, 'value', ['harness', 'version']);
  const profile = object(root.profile, ['id', 'version'], ['profile']);
  string(profile.id, ['profile', 'id']);
  evidence(profile.version, 'value', ['profile', 'version']);
  evidence(root.registryVersion, 'value', ['registryVersion']);
  const selection = object(root.selection, ['mode', 'escalationReason'], ['selection']);
  oneOf(selection.mode, ['profile', 'owner-override', 'escalation'], ['selection', 'mode']);
  if (selection.mode === 'escalation') string(selection.escalationReason, ['selection', 'escalationReason']);
  else isNull(selection.escalationReason, ['selection', 'escalationReason']);
  const auth = object(root.authorization,
    ['status', 'authority', 'sourceRef', 'scope', 'reason'], ['authorization']);
  oneOf(auth.status, ['authorized', 'unknown', 'not-required'], ['authorization', 'status']);
  if (['owner-override', 'escalation'].includes(selection.mode)) {
    relation(auth.status === 'authorized', ['authorization', 'status'], 'Selection requires owner authorization evidence');
  }
  if (auth.status === 'authorized') {
    relation(auth.authority === 'owner', ['authorization', 'authority'], 'Authorization authority must be owner');
    string(auth.sourceRef, ['authorization', 'sourceRef']);
    isNull(auth.reason, ['authorization', 'reason']);
    const scope = object(auth.scope, ['role', 'provider', 'transport', 'model', 'effort'], ['authorization', 'scope']);
    for (const key of ['role', 'provider', 'transport']) {
      string(scope[key], ['authorization', 'scope', key]);
      relation(scope[key] === root[key], ['authorization', 'scope', key], 'Authorization scope must cover this record');
    }
    const scopedModel = object(scope.model, ['kind', 'value'], ['authorization', 'scope', 'model']);
    for (const key of ['kind', 'value']) relation(scopedModel[key] === requested[key],
      ['authorization', 'scope', 'model', key], 'Authorization must cover the model request');
    const scopedEffort = object(scope.effort, ['provider', 'dialect', 'value'], ['authorization', 'scope', 'effort']);
    for (const key of ['provider', 'dialect', 'value']) relation(scopedEffort[key] === requestedEffort[key],
      ['authorization', 'scope', 'effort', key], 'Authorization must cover the effort request');
  } else if (['unknown', 'not-required'].includes(auth.status)) {
    for (const key of ['authority', 'sourceRef', 'scope']) isNull(auth[key], ['authorization', key]);
    string(auth.reason, ['authorization', 'reason']);
  }
  const measured = evidence(root.evidence, 'timestamp', ['evidence']);
  if (measured.status === 'known') {
    const timestamp = measured.timestamp;
    const valid = typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) &&
      Number.isFinite(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp;
    relation(valid, ['evidence', 'timestamp'], 'Expected an actual UTC timestamp with millisecond precision');
  }
  return issues.length ? { success: false, error: { issues } } : { success: true, data: value, diagnostics };
}

/** Versioned schema facade; syntax success grants no runtime approval. */
export const roleProfileEvidenceSchema = Object.freeze({ safeParse });
