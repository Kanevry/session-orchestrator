import { readHtml } from './readers.mjs';
import { readFileSync } from 'node:fs';
const schemaRules = JSON.parse(
  readFileSync(new URL('./schema-rules.json', import.meta.url), 'utf8'),
);

/** Type requirements are observations, not rich-result or schema.org validation. */
export function measurePage({ page, response, manifest }) {
  const url = response.finalUrl || response.url || page.url;
  const timestamp = response.timestamp;
  const emit = (checkId, state, value, reason, category = 'error') => ({
    checkId,
    state,
    url,
    timestamp,
    pageType: page.type,
    ...(value !== undefined ? { value, sources: [{ url, timestamp }] } : {}),
    ...(reason ? { reason } : {}),
    ...(state === 'finding' ? { category } : {}),
  });
  if (response.state !== 'ok' || response.status === 429 || response.status >= 500) {
    return [
      emit(
        'page.http',
        response.state === 'ok' ? 'unavailable' : response.state,
        undefined,
        response.reason || `HTTP ${response.status}`,
      ),
    ];
  }
  if (response.status < 200 || response.status >= 300)
    return [emit('page.http', 'finding', { status: response.status }, 'Page GET did not succeed')];
  const contentType = response.headers?.['content-type'] || response.headers?.get?.('content-type');
  if (contentType && !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType))
    return [emit('page.metadata', 'not-measurable', undefined, 'Response is not HTML')];
  const html = readHtml(response.body || '');
  if (!html.measurable)
    return [
      emit(
        /JSON-LD/.test(html.reason || '') ? 'page.schema' : 'page.metadata',
        'not-measurable',
        undefined,
        html.reason || 'Unsupported HTML',
      ),
    ];
  const results = [
    emit('page.http', 'ok', {
      status: response.status,
      redirects: response.chain?.filter((h) => h.status >= 300 && h.status < 400).length || 0,
    }),
  ];
  const missing = [];
  if (!html.title?.trim()) missing.push('title');
  if (!html.description?.trim()) missing.push('description');
  if (!html.canonical) missing.push('canonical');
  if (html.h1Count !== 1) missing.push('one h1');
  for (const lang of manifest.languages || [])
    if (!html.hreflang.some((h) => h.lang.toLowerCase() === lang.toLowerCase()))
      missing.push(`hreflang:${lang}`);
  let canonical;
  const hreflang = [];
  const linkProblems = [];
  const resolve = (value, label) => {
    try {
      const resolved = new URL(value, url);
      if (
        !value.trim() ||
        !['http:', 'https:'].includes(resolved.protocol) ||
        resolved.username ||
        resolved.password
      )
        throw Error('Unsupported URL');
      return resolved.href;
    } catch {
      linkProblems.push(`Invalid ${label} URL`);
      return undefined;
    }
  };
  if (html.canonical) canonical = resolve(html.canonical, 'canonical');
  for (const alternate of html.hreflang) {
    const resolved = resolve(alternate.url, `hreflang:${alternate.lang}`);
    if (resolved) hreflang.push({ lang: alternate.lang, url: resolved });
  }
  const canonicalMismatch = canonical && canonical !== url;
  const entityDependent = /&(?:#\w+|\w+);/.test(`${html.title || ''}${html.description || ''}`);
  results.push(
    emit(
      'page.metadata',
      entityDependent ? 'not-measurable' : missing.length ? 'finding' : 'ok',
      entityDependent
        ? undefined
        : {
            titleLength: [...(html.title || '')].length,
            descriptionLength: [...(html.description || '')].length,
            h1Count: html.h1Count,
            missing: [...new Set(missing)],
            ...(canonical ? { canonical } : {}),
            hreflang,
          },
      entityDependent
        ? 'Entity-dependent metadata lengths are unsupported'
        : [...new Set(missing)].join(', '),
    ),
  );
  if (linkProblems.length || canonicalMismatch)
    results.push(
      emit(
        'page.links',
        'finding',
        { ...(canonical ? { canonical } : {}), hreflang },
        [
          ...linkProblems,
          ...(canonicalMismatch ? ['Canonical target differs from fetched page URL'] : []),
        ].join('; '),
        linkProblems.length ? 'error' : 'opportunity',
      ),
    );
  const filled = (value) =>
    value !== undefined &&
    value !== null &&
    value !== '' &&
    (!Array.isArray(value) || value.length > 0);
  const typeList = (value) =>
    (Array.isArray(value) ? value : [value]).filter(
      (type) => type !== undefined && type !== null && type !== '',
    );
  // Merge only by identical @id string on one page; a reference to an entity defined on another
  // page is not assessed. Revisit if cross-page entity graphs need requirement checks.
  const nodes = [];
  const byId = new Map();
  let invalid = false;
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const id = typeof node['@id'] === 'string' ? node['@id'] : undefined;
    if (node['@type'] || id !== undefined) {
      const merged = id !== undefined ? byId.get(id) : undefined;
      if (!merged) {
        const copy = new Map(Object.entries(node));
        if (id !== undefined) byId.set(id, copy);
        nodes.push(copy);
      } else {
        for (const [key, value] of Object.entries(node)) {
          if (key === '@type')
            merged.set('@type', [
              ...new Set([...typeList(merged.get('@type')), ...typeList(value)]),
            ]);
          else if (!filled(merged.get(key))) merged.set(key, value);
        }
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
  };
  for (const item of html.jsonLd) {
    try {
      visit(typeof item === 'string' ? JSON.parse(item) : item);
    } catch {
      invalid = true;
    }
  }
  const types = (node) =>
    typeList(node.get('@type')).map((type) => String(type).replace(/^https?:\/\/schema.org\//, ''));
  const typed = nodes.filter((node) => types(node).length);
  const present = [...new Set(typed.flatMap(types))];
  const requiredMissing = (page.expectedSchemaTypes || [])
    .filter((type) => !present.includes(type))
    .map((type) => `type:${type}`);
  const supportedTypes = present.filter((type) => Object.hasOwn(schemaRules, type));
  const unsupportedTypes = [...new Set([...present, ...(page.expectedSchemaTypes || [])])].filter(
    (type) => !Object.hasOwn(schemaRules, type),
  );
  const recommendedMissing = [];
  // A node that still carries only @id/@type/@context points at an entity defined elsewhere.
  const reference = (node) =>
    node.has('@id') && [...node.keys()].every((key) => ['@id', '@type', '@context'].includes(key));
  for (const node of typed) {
    if (reference(node)) continue;
    for (const type of types(node)) {
      if (!Object.hasOwn(schemaRules, type)) continue;
      const rule = schemaRules[type];
      for (const key of rule.required)
        if (!filled(node.get(key))) requiredMissing.push(`${type}.${key}`);
      for (const key of rule.recommended)
        if (!filled(node.get(key))) recommendedMissing.push(`${type}.${key}`);
    }
  }
  // ADR-004: a reference whose entity is not defined on this page was not assessed, so it can never read as ok.
  const unresolvedReferences = [
    ...new Set(typed.filter(reference).map((node) => String(node.get('@id')))),
  ];
  const uniqueRequired = [...new Set(requiredMissing)];
  const uniqueRecommended = [...new Set(recommendedMissing)];
  if (!typed.length && !(page.expectedSchemaTypes || []).length && !invalid) {
    results.push(
      emit(
        'page.schema',
        'not-measurable',
        undefined,
        'No JSON-LD types or configured expected types to assess',
      ),
    );
    return results;
  }
  const hasFinding = invalid || uniqueRequired.length || uniqueRecommended.length;
  const coverage = {
    types: present,
    supportedTypes,
    unsupportedTypes,
    unresolvedReferences,
    complete: unsupportedTypes.length === 0 && unresolvedReferences.length === 0,
  };
  const coverageReason = [
    ...(unsupportedTypes.length
      ? ['No requirement rules for types: ' + unsupportedTypes.join(', ')]
      : []),
    ...(unresolvedReferences.length
      ? ['Referenced entities not defined on this page: ' + unresolvedReferences.join(', ')]
      : []),
  ].join('; ');
  const incomplete = !coverage.complete;
  results.push(
    emit(
      'page.schema',
      hasFinding ? 'finding' : incomplete ? 'not-measurable' : 'ok',
      { ...coverage, missing: uniqueRequired, recommendedMissing: uniqueRecommended },
      invalid
        ? 'Invalid JSON-LD syntax'
        : incomplete
          ? coverageReason
          : 'Type-specific requirements only; not full semantic validation',
      uniqueRequired.length || invalid ? 'error' : 'opportunity',
    ),
  );
  // Preserve known findings and separately expose incomplete rule coverage to report/exit handling.
  if (hasFinding && incomplete)
    results.push(emit('page.schema.coverage', 'not-measurable', coverage, coverageReason));
  return results;
}
