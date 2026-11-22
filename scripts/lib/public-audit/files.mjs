import { readHtml } from './readers.mjs';

const HTML_CONTENT_TYPE = /^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i;

export async function measureFiles({
  manifest,
  pageResults,
  fetcher,
  clock = () => new Date().toISOString(),
}) {
  const results = [];
  const now = () => new Date(clock()).toISOString();
  const emit = (checkId, state, response, value, reason) => {
    const url = response.finalUrl || response.url;
    const timestamp = response.timestamp || now();
    results.push({
      checkId,
      state,
      url,
      timestamp,
      ...(value !== undefined ? { value, sources: [{ url, timestamp }] } : {}),
      ...(reason ? { reason } : {}),
      ...(state === 'finding' ? { category: 'opportunity' } : {}),
    });
  };
  const availability = (r) =>
    r.state !== 'ok' ? r.state : r.status === 429 || r.status >= 500 ? 'unavailable' : null;
  for (const { response, html: provided } of pageResults) {
    const state = availability(response);
    if (state || response.status < 200 || response.status >= 300) {
      for (const id of ['page.bytes', 'page.hydration'])
        emit(
          id,
          state || 'not-measurable',
          response,
          undefined,
          response.reason || 'Page body unavailable',
        );
      continue;
    }
    const contentType =
      response.headers?.['content-type'] || response.headers?.get?.('content-type');
    if (contentType && !HTML_CONTENT_TYPE.test(contentType)) {
      for (const id of ['page.bytes', 'page.hydration'])
        emit(id, 'not-measurable', response, undefined, 'Response is not HTML');
      continue;
    }
    const body = response.body || '';
    const bytes = response.receivedBytes ?? Buffer.byteLength(body, 'utf8');
    emit(
      'page.bytes',
      'ok',
      response,
      { bytes },
      'Received entity bytes, not compressed wire bytes',
    );
    const html = provided || readHtml(body);
    if (!html.measurable) {
      emit(
        'page.hydration',
        'not-measurable',
        response,
        undefined,
        html.reason || 'Unsupported HTML',
      );
      continue;
    }
    // BV-004: measure inert JSON only, not JavaScript assignments. Revisit with a maintained
    // embedded-data reader when configured pages require a representation named below.
    const unsupportedRepresentations = [];
    for (const script of html.scripts || []) {
      if (
        script.type &&
        !/^(?:text|application)\/(?:java|ecma)script$/i.test(script.type) &&
        script.type !== 'module'
      )
        continue;
      if (/\bself\s*\.\s*__next_f\s*(?:\.\s*push\s*\(|=)/.test(script.body))
        unsupportedRepresentations.push('next-flight');
      if (/\bwindow\s*\.\s*__INITIAL_STATE__\s*=/.test(script.body))
        unsupportedRepresentations.push('initial-state');
      if (/\b__NUXT__\s*=/.test(script.body)) unsupportedRepresentations.push('nuxt-state');
    }
    const unsupported = [...new Set(unsupportedRepresentations)];
    const hydration = (html.scripts || []).filter(
      (script) =>
        /^(application\/json|application\/.*\+json)$/i.test((script.type || '').trim()) &&
        !/^application\/ld\+json$/i.test((script.type || '').trim()),
    );
    const hydrationBytes = hydration.reduce(
      (total, script) => total + Buffer.byteLength(script.body || '', 'utf8'),
      0,
    );
    emit(
      'page.hydration',
      unsupported.length ? 'not-measurable' : 'ok',
      response,
      {
        bytes: hydrationBytes,
        scripts: hydration.length,
        percentOfHtml: bytes ? (hydrationBytes / bytes) * 100 : 0,
        scope: 'inert-json-only',
        complete: unsupported.length === 0,
        unsupportedRepresentations: unsupported,
      },
      unsupported.length
        ? 'Observed inert JSON subset only; unsupported embedded-data representation: ' +
            unsupported.join(', ')
        : 'Inert JSON script data only; executable scripts and JSON-LD excluded',
    );
  }
  const llms = manifest.llmsPaths ?? [
    '/llms.txt',
    ...(manifest.languages || []).map((lang) => `/${encodeURIComponent(lang)}/llms.txt`),
  ];
  const security = manifest.securityPaths ?? ['/.well-known/security.txt'];
  const indexnow = manifest.indexnowPaths || [];
  for (const [checkId, paths] of [
    ['public.llms', llms],
    ['public.security', security],
    ['public.indexnow', indexnow],
  ]) {
    if (checkId === 'public.indexnow' && paths.length === 0) {
      emit(
        checkId,
        'not-measurable',
        { url: manifest.baseUrl, timestamp: now() },
        undefined,
        'No IndexNow public candidate path configured; key location unknown',
      );
    }
    for (const path of [...new Set(paths)]) {
      let url;
      try {
        url = new URL(path, manifest.baseUrl).href;
      } catch {
        emit(
          checkId,
          'not-measurable',
          { url: manifest.baseUrl, timestamp: now() },
          undefined,
          'Invalid configured public path',
        );
        continue;
      }
      let response;
      try {
        response = await fetcher.fetch(url);
      } catch {
        response = {
          state: 'unavailable',
          url,
          timestamp: now(),
          reason: 'Public file request failed',
        };
      }
      // Configured IndexNow filenames may themselves contain key material. Never serialize them or bodies.
      const safeResponse =
        checkId === 'public.indexnow'
          ? {
              ...response,
              url: new URL('/[configured-indexnow-path]', manifest.baseUrl).href,
              finalUrl: undefined,
            }
          : response;
      const state = availability(response);
      if (state) {
        emit(
          checkId,
          state,
          safeResponse,
          undefined,
          checkId === 'public.indexnow' ? 'Configured IndexNow path unavailable' : response.reason,
        );
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        emit(
          checkId,
          'ok',
          safeResponse,
          { present: false },
          'Optional file absent; neutral observation',
        );
      } else if (response.status >= 200 && response.status < 300) {
        const contentType =
          response.headers?.['content-type'] || response.headers?.get?.('content-type');
        if (HTML_CONTENT_TYPE.test(contentType)) {
          emit(checkId, 'not-measurable', safeResponse, undefined, 'Expected a public file, received HTML');
        } else {
          emit(
            checkId,
            'ok',
            safeResponse,
            { present: true },
            'Public file responds successfully; content validity not assessed',
          );
        }
      } else
        emit(
          checkId,
          'not-measurable',
          safeResponse,
          undefined,
          `Optional file HTTP ${response.status}`,
        );
    }
  }
  return results;
}
