/**
 * ux-grill/pencil-coverage.mjs — S6 Pencil frame coverage (optional, gated).
 *
 * Spec: docs/prd/2026-09-12-ux-grill.md § 2 S6 and § 3 "Pencil-Abdeckung
 * (optional)" — two acceptance criteria: (a) the run-record reports per route
 * `frame: desktop|mobile|both|none` derived from the `.pen` file's top-level
 * frames, (b) Pen.app unreachable → the step is recorded as
 * `skipped: pencil-unavailable` and the run ends WITHOUT error.
 *
 * **Why this module is a pure classifier.** The Pencil MCP tools
 * ({@link PENCIL_TOOL_NAMES}) are callable only from the coordinator's tool
 * surface, never from a Node process — there is no client for them here. So the
 * division of labour is: the COORDINATOR reads the top-level frames (an
 * `execute` Get visitor at depth 1) and hands them in; this module does the
 * matching and the classification, deterministically and without I/O.
 *
 * Leaf module: imports only `./schema.mjs` (no I/O, no side effects, no node
 * builtins).
 *
 * Exports:
 *   PENCIL_TOOL_NAMES, MOBILE_WIDTH_CEILING_PX, FRAME_COVERAGE,
 *   classifyFrameCoverage(), pencilSkipped(), describePencilStep()
 */

import { SKIP_REASONS } from './schema.mjs';

/**
 * The LIVE Pencil MCP tool names — the one place they are spelled in code, so
 * prose (skills, probes, references) can cite this constant instead of keeping
 * a private copy that rots.
 *
 * Measured 2026-09-12 from this session's MCP tool listing, which exposes
 * exactly: `mcp__pencil__browser`, `mcp__pencil__execute`,
 * `mcp__pencil__get_app_state`, `mcp__pencil__get_style`,
 * `mcp__pencil__read_skill`. The pre-2026 surface (`get_editor_state`,
 * `open_document`, `batch_get`, `get_screenshot`) no longer exists — any prose
 * still naming it is dead and was swept in the same change (PRD § 2 S6).
 *
 * Only the three tools this feature needs are named here; `get_style` and
 * `read_skill` exist but have no call site in ux-grill (BV-001.1).
 * @type {Readonly<{appState: string, execute: string, browser: string}>}
 */
export const PENCIL_TOOL_NAMES = Object.freeze({
  appState: 'mcp__pencil__get_app_state',
  execute: 'mcp__pencil__execute',
  browser: 'mcp__pencil__browser',
});

/**
 * A top-level frame narrower than this is classified `mobile`, otherwise
 * `desktop`.
 *
 * Named ceiling (BV-004): 600 px sits above every phone frame in common design
 * kits (iPhone 15 = 393, Pixel 8 = 412, iPhone 15 Pro Max = 430) and below every
 * tablet/desktop canvas (768, 1024, 1440). Revisit trigger: the first manifest
 * whose design file carries a deliberate tablet frame — a 768-px frame lands in
 * `desktop` here, which is a coverage answer, not a device taxonomy.
 * @type {number}
 */
export const MOBILE_WIDTH_CEILING_PX = 600;

/**
 * The four coverage values a route can carry in the run-record (PRD § 3).
 * @type {Readonly<Record<string, string>>}
 */
export const FRAME_COVERAGE = Object.freeze({
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
  BOTH: 'both',
  NONE: 'none',
});

const COVERAGE_VALUES = Object.freeze(Object.values(FRAME_COVERAGE));

/** `Dashboard (mobile)` / `Dashboard — desktop` → captures the device word. */
const DEVICE_SUFFIX = /[([\s—-]\s*(mobile|desktop)\s*\)?\s*$/i;

/** Regex metacharacters that make a `title-pattern` something other than a literal. */
const REGEX_METACHAR = /[.*+?^${}()|[\]\\]/;

/**
 * Normalise a frame or route key for case-insensitive comparison: lowercased,
 * trimmed, inner whitespace collapsed. Deliberately NOT slug-folding `-`/`_` —
 * `new-document` and `new document` are different frame names, and silently
 * equating them would report design coverage that does not exist.
 * @param {unknown} value
 * @returns {string} `''` for anything that is not a non-empty string.
 */
function normalise(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The frame name with a trailing `(mobile)` / `(desktop)` marker removed, so
 * `Dashboard (mobile)` matches the route key `dashboard`.
 * @param {unknown} name
 * @returns {string}
 */
function baseName(name) {
  return normalise(typeof name === 'string' ? name.replace(DEVICE_SUFFIX, '') : '');
}

/**
 * Classify ONE frame as `desktop` or `mobile`.
 *
 * Precedence — stated, because the two signals can disagree and a design file
 * is allowed to lie about its width:
 *   1. an explicit `(mobile)` / `(desktop)` suffix in the frame name;
 *   2. otherwise `width < MOBILE_WIDTH_CEILING_PX` → mobile, else desktop;
 *   3. no suffix and no usable width → `desktop`, because a `.pen` top-level
 *      frame defaults to the desktop canvas, and a mobile frame is in practice
 *      either narrower than the ceiling or suffix-labelled.
 * @param {{name?: unknown, width?: unknown}} frame
 * @returns {'desktop'|'mobile'}
 */
function deviceOfFrame(frame) {
  const suffix = typeof frame?.name === 'string' ? DEVICE_SUFFIX.exec(frame.name) : null;
  if (suffix) return suffix[1].toLowerCase() === 'mobile' ? FRAME_COVERAGE.MOBILE : FRAME_COVERAGE.DESKTOP;
  const width = frame?.width;
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
    return width < MOBILE_WIDTH_CEILING_PX ? FRAME_COVERAGE.MOBILE : FRAME_COVERAGE.DESKTOP;
  }
  return FRAME_COVERAGE.DESKTOP;
}

/**
 * Fold a set of matched frames into one coverage value.
 * @param {Array<object>} matched
 * @returns {string} a value of {@link FRAME_COVERAGE}.
 */
function coverageOf(matched) {
  if (matched.length === 0) return FRAME_COVERAGE.NONE;
  let hasDesktop = false;
  let hasMobile = false;
  for (const frame of matched) {
    if (deviceOfFrame(frame) === FRAME_COVERAGE.MOBILE) hasMobile = true;
    else hasDesktop = true;
  }
  if (hasDesktop && hasMobile) return FRAME_COVERAGE.BOTH;
  return hasMobile ? FRAME_COVERAGE.MOBILE : FRAME_COVERAGE.DESKTOP;
}

/**
 * The comparison keys a route offers for name matching: the last segment of
 * `path`, plus `title-pattern` when it is a plain literal.
 *
 * A `title-pattern` is a REGEX in the manifest (PRD § 2 S1). Only an
 * anchor-only pattern (`^Dashboard`, `Dashboard$`) is usable as a literal name;
 * anything carrying further metacharacters is skipped rather than matched
 * approximately — a wrong match reports design coverage that does not exist.
 * @param {{path?: unknown, ['title-pattern']?: unknown}} route
 * @returns {string[]} normalised, de-duplicated, never containing `''`.
 */
function routeKeys(route) {
  const keys = [];
  if (typeof route?.path === 'string') {
    const segments = route.path.split('/').filter((s) => s.length > 0);
    keys.push(normalise(segments.length > 0 ? segments[segments.length - 1] : route.path));
  }
  const pattern = route?.['title-pattern'];
  if (typeof pattern === 'string') {
    const stripped = pattern.replace(/^\^/, '').replace(/\$$/, '');
    if (stripped.length > 0 && !REGEX_METACHAR.test(stripped)) keys.push(normalise(stripped));
  }
  return [...new Set(keys.filter((k) => k.length > 0))];
}

/**
 * Classify per-route design-frame coverage (PRD § 2 S6, AC "Pencil-Abdeckung").
 *
 * Matching precedence, highest first:
 *   1. **`routes[].frame` as a coverage literal** — `desktop|mobile|both|none`
 *      written straight into the manifest (the shape
 *      `templates/_shared/ux-manifest.template.md` ships) is taken as the
 *      answer; `matchedBy: 'routes[].frame'`.
 *   2. **`routes[].frame` as a reference** — any other value is a frame `id`
 *      (exact) or frame `name` (case-insensitive, `(mobile)`/`(desktop)` suffix
 *      ignored). Resolving to nothing yields `none` with
 *      `matchedBy: 'routes[].frame'`: the declaration WAS honoured, the frame is
 *      absent — distinguishable from a route that declared nothing.
 *   3. **Name equality** — case-insensitive equality between a
 *      {@link routeKeys} key and a frame's base name; `matchedBy: 'name'`.
 *   4. Otherwise `none` with `matchedBy: null`.
 *
 * Pure: no I/O, no mutation of the inputs.
 *
 * @param {object} opts
 * @param {Array<{path: string, frame?: string, ['title-pattern']?: string}>} opts.routes
 *   the manifest's `routes[]`.
 * @param {Array<{id?: string, name?: string, width?: number, height?: number}>} [opts.frames]
 *   the `.pen` file's TOP-LEVEL frames, as obtained by the coordinator via
 *   `PENCIL_TOOL_NAMES.execute` with a depth-1 Get visitor. Defaults to `[]`,
 *   which classifies every route as `none` — the honest answer for "the design
 *   file has no top-level frames", NOT the same thing as a skipped step (see
 *   {@link pencilSkipped}).
 * @returns {Array<{route: string, frame: string, matchedBy: string|null}>} one
 *   entry per route, input order preserved. `{route, frame}` is exactly the
 *   `pencilCoverage` shape `makeRunRecord()` accepts; `matchedBy` is extra
 *   provenance for the report and is ignored by the run-record.
 * @throws {TypeError} on any invalid input — no silent defaults.
 */
export function classifyFrameCoverage({ routes, frames = [] } = {}) {
  if (!Array.isArray(routes)) {
    throw new TypeError('classifyFrameCoverage: routes must be an array');
  }
  if (!Array.isArray(frames)) {
    throw new TypeError('classifyFrameCoverage: frames must be an array when provided');
  }

  return routes.map((route, index) => {
    if (route === null || typeof route !== 'object' || Array.isArray(route)) {
      throw new TypeError(`classifyFrameCoverage: routes[${index}] must be a plain object`);
    }
    if (typeof route.path !== 'string' || route.path.length === 0) {
      throw new TypeError(`classifyFrameCoverage: routes[${index}].path must be a non-empty string`);
    }

    const declared = typeof route.frame === 'string' ? route.frame.trim() : '';

    if (declared.length > 0) {
      if (COVERAGE_VALUES.includes(declared.toLowerCase())) {
        return { route: route.path, frame: declared.toLowerCase(), matchedBy: 'routes[].frame' };
      }
      const wanted = normalise(declared);
      const matched = frames.filter(
        (frame) => frame?.id === declared || baseName(frame?.name) === wanted || normalise(frame?.name) === wanted,
      );
      return { route: route.path, frame: coverageOf(matched), matchedBy: 'routes[].frame' };
    }

    const keys = routeKeys(route);
    const matched = frames.filter((frame) => {
      const name = baseName(frame?.name);
      return name.length > 0 && keys.includes(name);
    });
    if (matched.length === 0) return { route: route.path, frame: FRAME_COVERAGE.NONE, matchedBy: null };
    return { route: route.path, frame: coverageOf(matched), matchedBy: 'name' };
  });
}

/**
 * The `skipped[]` record for an unavailable Pencil step (PRD § 3 AC 2).
 *
 * Returned rather than thrown on purpose: the run must end without error when
 * Pen.app or its MCP surface is unreachable, and a skip that is RECORDED is
 * what keeps "no coverage measured" from reading as "no design frames".
 *
 * @param {string} [reason] - a value of `SKIP_REASONS`; defaults to
 *   `SKIP_REASONS.PENCIL_UNAVAILABLE`.
 * @returns {{what: string, reason: string}} accepted by `makeRunRecord({skipped})`.
 * @throws {TypeError} if `reason` is not a known skip reason.
 */
export function pencilSkipped(reason = SKIP_REASONS.PENCIL_UNAVAILABLE) {
  if (!Object.values(SKIP_REASONS).includes(reason)) {
    throw new TypeError(`pencilSkipped: unknown skip reason ${String(reason)}`);
  }
  return { what: 'pencil', reason };
}

/**
 * Whether the optional Pencil step runs at all, per the manifest (PRD § 2 S6:
 * "if `pencil.file` is set and Pen.app is reachable"). This answers only the
 * first half — reachability is the coordinator's to determine, by calling
 * `PENCIL_TOOL_NAMES.appState`.
 *
 * @param {object} opts
 * @param {{frontmatter?: object}|object} opts.manifest - a `loadManifest()` /
 *   `parseManifest()` result, or a bare frontmatter object (both accepted: a
 *   bare frontmatter would otherwise silently answer `enabled: false`).
 * @returns {{enabled: boolean, file: string|null}} `file` is the manifest value
 *   verbatim — a repo-relative path that the caller resolves; this module never
 *   touches the filesystem.
 */
export function describePencilStep({ manifest } = {}) {
  const source = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {};
  const frontmatter =
    source.frontmatter && typeof source.frontmatter === 'object' && !Array.isArray(source.frontmatter)
      ? source.frontmatter
      : source;
  const file = frontmatter?.pencil?.file;
  if (typeof file !== 'string' || file.trim().length === 0) return { enabled: false, file: null };
  return { enabled: true, file: file.trim() };
}
