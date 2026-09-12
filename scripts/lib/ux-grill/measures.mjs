/**
 * ux-grill/measures.mjs — Browser-side measurement scripts + pure classifiers.
 *
 * Leaf module: no imports at all (not even `./schema.mjs`) and no I/O. It ships
 * two kinds of thing:
 *
 *  1. `*_EVAL` constants — JavaScript SOURCE STRINGS handed verbatim to
 *     `agent-browser eval` (0.37.1). They run in the PAGE, so they cannot
 *     import anything; every threshold they need is inlined and pinned against
 *     the exported constants by the measures test suite.
 *  2. Pure functions — `classifyTargetSize`, `hasHorizontalOverflow`,
 *     `titleMatches`, `parseEvalOutput` — used by `collect.mjs` in node.
 *
 * This module NEVER builds findings. `collect.mjs` turns a measurement plus a
 * classifier verdict into a finding via `makeFinding()` from `./schema.mjs`.
 *
 * ## `agent-browser eval` output contract (measured 2026-09-12, v0.37.1)
 *
 * The tool evaluates the script and prints the completion value **already
 * JSON-serialised** (pretty-printed, multi-line):
 *
 * ```
 * $ printf '(() => ({n: window.innerWidth}))()' | agent-browser eval --stdin
 * {
 *   "n": 1280
 * }
 * $ agent-browser eval "document.title"
 * ""
 * ```
 *
 * Two consequences, both load-bearing for the shapes below:
 *  - The evals return plain values/objects, NOT `JSON.stringify(...)`. Returning
 *    a JSON string would print a *quoted, escaped* string (measured:
 *    `(() => JSON.stringify({n:1}))()` printed `"{\"n\":1}"`), forcing a double
 *    parse on every read.
 *  - Multi-line output is normal, so {@link parseEvalOutput} parses the WHOLE
 *    trimmed stdout, never the last line. It still tolerates the
 *    double-encoded shape, because a page that itself returns a JSON string is
 *    indistinguishable from the quoted form at the stdout boundary.
 *
 * Pass these strings via `eval --stdin` (heredoc) or `eval -b <base64>` — the
 * tool's own guidance ("Inline `agent-browser eval "..."` works only for simple
 * expressions"); {@link TARGET_SIZE_EVAL} contains quotes and brackets.
 *
 * Spec: docs/prd/2026-09-12-ux-grill.md § 2 S2/S3, § 3 AC "Stufe 1".
 *
 * Exports:
 *   TARGET_SIZE_FLOOR_PX, TARGET_SIZE_TARGET_PX, INTERACTIVE_TARGET_SELECTOR,
 *   TARGET_SIZE_MAX_ENTRIES, SELECTOR_MAX_DEPTH, SELECTOR_MAX_LENGTH,
 *   OVERFLOW_TOLERANCE_PX,
 *   TARGET_SIZE_EVAL, OVERFLOW_EVAL, VIEWPORT_WIDTH_EVAL,
 *   classifyTargetSize(), hasHorizontalOverflow(), titleMatches(),
 *   parseEvalOutput()
 */

/**
 * WCAG 2.2 SC 2.5.8 **Target Size (Minimum)**, AA: pointer targets must be at
 * least 24 × 24 CSS px. Below this is `target-size-floor` → severity `high`
 * (PRD § 2 S3).
 * @type {number}
 */
export const TARGET_SIZE_FLOOR_PX = 24;

/**
 * WCAG 2.1 SC 2.5.5 **Target Size (Enhanced)**, AAA: 44 × 44 CSS px. A target
 * at or above {@link TARGET_SIZE_FLOOR_PX} but below this is
 * `target-size-target` → severity `medium` (PRD § 2 S3 row "24–43 px").
 * @type {number}
 */
export const TARGET_SIZE_TARGET_PX = 44;

/**
 * THE population of interactive targets the size check runs over. Anything not
 * matched here is not measured and therefore cannot produce a finding — state
 * this list whenever a `target-size-*` count is reported (the count is
 * meaningless without its denominator).
 *
 * Deliberately syntactic (tags + explicit ARIA roles), not "everything with a
 * click handler": a listener attached in JS is invisible to a static query, so
 * a handler-based population would be unreproducible run to run — and
 * reproducibility is the AC ("Fingerprint-Mengen beider findings.jsonl
 * identisch"). `input[type=hidden]` is excluded at the selector level because
 * it has no box at all.
 * @type {string}
 */
export const INTERACTIVE_TARGET_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  '[role=button]',
  '[role=link]',
  '[role=menuitem]',
  '[role=tab]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=switch]',
  'summary',
  'label[for]',
].join(', ');

/**
 * Ceiling on entries returned by {@link TARGET_SIZE_EVAL}. A page with more
 * undersized targets than this has a systemic layout problem, not 200 separate
 * ones, and every entry becomes a fingerprinted finding + an issue candidate.
 * Revisit if a real route legitimately exceeds it — the eval reports
 * `truncated: true` so the condition is observable rather than silent.
 * @type {number}
 */
export const TARGET_SIZE_MAX_ENTRIES = 200;

/**
 * Maximum ancestor levels walked when building a target's CSS path.
 *
 * BV-004 — deliberate simplification. CEILING: 5 `:nth-of-type()` steps
 * uniquely identify a target on a normally-nested page and keep the generated
 * selector inside {@link SELECTOR_MAX_LENGTH}; the walk also stops early at the
 * first stable `id`. It does NOT guarantee uniqueness — two sibling subtrees
 * that differ only ABOVE level 5 produce the same path, hence the same
 * fingerprint, and collapse into one finding.
 * REVISIT TRIGGER: a real run reporting fewer `target-size-*` findings than the
 * eval's own `targets[]` length (the collapse becoming observable), or a target
 * app whose interactive elements routinely sit deeper than 5 levels below their
 * nearest `id`.
 * @type {number}
 */
export const SELECTOR_MAX_DEPTH = 5;

/**
 * Hard cap on a generated selector. The selector is the third segment of a
 * finding locator (`route|viewport|selector`) which `schema.mjs` truncates at
 * `LOCATOR_MAX_LENGTH` (256) BEFORE fingerprinting; keeping the selector well
 * under that leaves the route and viewport segments intact, so two findings on
 * different routes cannot collapse onto one fingerprint.
 *
 * BV-004 — deliberate simplification. CEILING: 160 leaves ≥ 96 chars of the
 * 256-char locator for `route|viewport|`, which covers every route/viewport
 * label the manifest schema admits. Over-long paths are TRUNCATED FROM THE LEFT
 * (the eval keeps the tail, i.e. the element and its nearest ancestors), so a
 * selector longer than this loses its outermost context and two deeply-nested
 * targets sharing a tail can fingerprint alike.
 * REVISIT TRIGGER: a route or viewport label pushing the assembled locator past
 * `LOCATOR_MAX_LENGTH` (256) in `schema.mjs`, which would start truncating the
 * SELECTOR segment a second time — raise 256 there rather than lowering 160 here.
 * @type {number}
 */
export const SELECTOR_MAX_LENGTH = 160;

/**
 * Subpixel tolerance for the horizontal-overflow comparison, see
 * {@link hasHorizontalOverflow}.
 *
 * BV-004 — deliberate simplification, stated AT the constant rather than only
 * in `skills/ux-grill/rubric-v2.md` § horizontal-overflow (which now points
 * here). CEILING: 1 CSS px absorbs fractional layout rounding (a 1439.5 px
 * container in a 1440 px viewport rounds up into `scrollWidth` and shows no
 * scrollbar) and nothing more — a real horizontal scrollbar is always several
 * px wide, so no genuine overflow hides under this tolerance. It is a FIXED
 * tolerance, not a ratio: on a hypothetical viewport measured in device pixels
 * at a high DPR, 1 CSS px would no longer be the rounding unit.
 * REVISIT TRIGGER: a run reporting `horizontal-overflow` on a page with no
 * scrollbar (tolerance too small) or missing a visible scrollbar (too large) —
 * both are observable from the recorded `scrollWidth`/`innerWidth` evidence.
 * @type {number}
 */
export const OVERFLOW_TOLERANCE_PX = 1;

/**
 * Classify a measured target box against the WCAG thresholds.
 *
 * BOTH axes are checked (PRD § 2 S3: "beide Achsen geprüft") — the smaller axis
 * decides, because a 147 × 20 px button is as hard to hit as a 20 × 20 one.
 *
 * Population note: this classifies a box that the caller has ALREADY decided is
 * a rendered, visible, interactive target. It knows nothing about visibility —
 * feeding it a hidden element's rect yields a verdict for an element that must
 * never produce a finding.
 *
 * @param {{width?: number, height?: number}} box - CSS-pixel box dimensions.
 * @returns {'floor'|'target'|null} `'floor'` when either axis is below
 *   {@link TARGET_SIZE_FLOOR_PX}; `'target'` when either axis is below
 *   {@link TARGET_SIZE_TARGET_PX}; otherwise `null` (compliant). Non-finite or
 *   missing input returns `null`: an unmeasurable box is not evidence of a
 *   violation, and a NaN comparison would otherwise silently read as "not
 *   below" anyway.
 */
export function classifyTargetSize({ width, height } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < TARGET_SIZE_FLOOR_PX || height < TARGET_SIZE_FLOOR_PX) return 'floor';
  if (width < TARGET_SIZE_TARGET_PX || height < TARGET_SIZE_TARGET_PX) return 'target';
  return null;
}

/**
 * Page-side target-size measurement.
 *
 * Returns `{ targets: Array<{selector, tag, width, height, class, verdict}>,
 * scanned: number, truncated: boolean }`, where `targets` holds ONLY the
 * non-compliant ones (verdict `'floor'` or `'target'`) and `scanned` is the size
 * of the population actually inspected — `collect.mjs` needs the denominator.
 * When `truncated` is `true` the scan stopped at the cap, so `scanned` is a
 * partial denominator and must be reported as such.
 *
 * Exclusions (an excluded element can never produce a finding):
 *  - zero-area rect, `display: none`, `visibility: hidden`
 *  - computed `opacity: 0` on the element or any ancestor (opacity does not
 *    inherit as a computed value, so the ancestor walk is required)
 *  - `aria-hidden="true"` or `inert` on the element or any ancestor
 *  - the custom-select pattern (PRD § 3 AC): a `select`/`input` that is ≤ 1 × 1
 *    px, sits off-screen, or is covered by another element at its centre point.
 *
 * The covered/off-screen/1×1 trio is scoped to `select`/`input` on purpose: it
 * is the native-control-behind-a-custom-trigger idiom, and applying a
 * hit-testing exclusion to every target would silently drop real violations
 * that merely sit under a decorative overlay.
 *
 * `off-screen` deliberately means left/above/right-of the viewport, NOT below
 * it: on any page taller than the viewport, "fully outside the viewport" would
 * exclude every below-the-fold target — normal scroll content, not a hiding
 * pattern.
 *
 * The thresholds 24/44, the depth 5, the length 160 and the cap 200 are inlined
 * because a page script cannot import; they MUST equal
 * {@link TARGET_SIZE_FLOOR_PX}, {@link TARGET_SIZE_TARGET_PX},
 * {@link SELECTOR_MAX_DEPTH}, {@link SELECTOR_MAX_LENGTH} and
 * {@link TARGET_SIZE_MAX_ENTRIES} (pinned by the measures test suite).
 * @type {string}
 */
export const TARGET_SIZE_EVAL = `(() => {
  const FLOOR = 24;            // must equal TARGET_SIZE_FLOOR_PX
  const TARGET = 44;           // must equal TARGET_SIZE_TARGET_PX
  const MAX_ENTRIES = 200;     // must equal TARGET_SIZE_MAX_ENTRIES
  const MAX_DEPTH = 5;         // must equal SELECTOR_MAX_DEPTH
  const MAX_SELECTOR = 160;    // must equal SELECTOR_MAX_LENGTH
  const SELECTOR = ${JSON.stringify(INTERACTIVE_TARGET_SELECTOR)};

  const classify = (w, h) => {
    if (!isFinite(w) || !isFinite(h)) return null;
    if (w < FLOOR || h < FLOOR) return 'floor';
    if (w < TARGET || h < TARGET) return 'target';
    return null;
  };

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < MAX_DEPTH; depth++) {
      const tag = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;
      }
      let index = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) index++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    const path = parts.join(' > ');
    return path.length > MAX_SELECTOR ? path.slice(-MAX_SELECTOR) : path;
  };

  const hiddenByAncestor = (el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute('aria-hidden') === 'true') return true;
      if (node.hasAttribute('inert')) return true;
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (parseFloat(cs.opacity) === 0) return true;
      node = node.parentElement;
    }
    return false;
  };

  const isCovered = (el, rect) => {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return true;
    return !(hit === el || el.contains(hit));
  };

  const els = Array.from(document.querySelectorAll(SELECTOR));
  const targets = [];
  let scanned = 0;
  let truncated = false;

  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (hiddenByAncestor(el)) continue;

    const tag = el.tagName.toLowerCase();
    if (tag === 'select' || tag === 'input') {
      if (rect.width <= 1 || rect.height <= 1) continue;
      const offscreen = rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth;
      if (offscreen) continue;
      if (isCovered(el, rect)) continue;
    }

    scanned++;
    // Classify on the RAW float and round only for reporting: rounding first
    // promotes a 23.6 x 23.6 px box to 24 x 24 and reclassifies a 'floor'
    // violation as 'target' (or as compliant at 43.6).
    const verdict = classify(rect.width, rect.height);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (verdict === null) continue;
    if (targets.length >= MAX_ENTRIES) { truncated = true; break; }
    targets.push({
      selector: cssPath(el),
      tag: tag,
      width: width,
      height: height,
      class: typeof el.className === 'string' ? el.className : '',
      verdict: verdict,
    });
  }

  return { targets: targets, scanned: scanned, truncated: truncated };
})()`;

/**
 * Page-side horizontal-overflow measurement. Feed the result to
 * {@link hasHorizontalOverflow}.
 *
 * `bodyScrollWidth` is reported alongside the documentElement value purely as
 * diagnostic context for the operator (it localises the overflow to the body
 * subtree); the verdict is computed from `scrollWidth`/`innerWidth` only.
 * @type {string}
 */
export const OVERFLOW_EVAL = `(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  bodyScrollWidth: document.body ? document.body.scrollWidth : null,
}))()`;

/**
 * Page-side viewport width — the device/viewport verification probe (PRD § 2
 * S2: "`window.innerWidth` muss zur Vorgabe passen, sonst
 * `skipped: device-mismatch`").
 * @type {string}
 */
export const VIEWPORT_WIDTH_EVAL = 'window.innerWidth';

/**
 * Decide whether a page overflows horizontally.
 *
 * The `+ 1` is a subpixel tolerance: fractional layout widths (a 1439.5 px
 * container in a 1440 px viewport) round up into `scrollWidth`, so a strict
 * `>` reports overflow on pages that show no scrollbar. One CSS pixel is the
 * smallest tolerance that absorbs that rounding without hiding a real
 * horizontal scrollbar, which is always ≥ several px wide.
 *
 * @param {{scrollWidth?: number, innerWidth?: number}} m - {@link OVERFLOW_EVAL} result.
 * @returns {boolean} `false` when either value is non-finite — an unmeasured
 *   page is not a violating page.
 */
export function hasHorizontalOverflow({ scrollWidth, innerWidth } = {}) {
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(innerWidth)) return false;
  return scrollWidth > innerWidth + OVERFLOW_TOLERANCE_PX;
}

/**
 * Test a page title against a manifest `title-pattern`.
 *
 * @param {string} title - the measured `document.title`, read by
 *   `collect.mjs` via `agent-browser get title --json`.
 * @param {string} [pattern] - a regex SOURCE string from the manifest (no
 *   delimiters, no flags), compiled with `new RegExp(pattern)`.
 * @returns {{ok: true, matched: boolean} | {ok: false, reason: 'invalid-pattern'}}
 *   An absent or empty pattern yields `{ok: true, matched: true}`: a route
 *   without `title-pattern` declares no expectation, so it can never produce a
 *   `title-mismatch` finding. An uncompilable pattern yields
 *   `{ok: false, reason: 'invalid-pattern'}` — a manifest defect the caller
 *   must surface as such, never as a title violation of the page.
 */
export function titleMatches(title, pattern) {
  if (pattern === undefined || pattern === null || pattern === '') {
    return { ok: true, matched: true };
  }
  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    return { ok: false, reason: 'invalid-pattern' };
  }
  return { ok: true, matched: re.test(typeof title === 'string' ? title : '') };
}

/**
 * Parse the stdout of `agent-browser eval`.
 *
 * Tolerant by design: the value is JSON, but it arrives pretty-printed over
 * several lines and may be double-encoded when the page itself returned a JSON
 * string. Both are handled; anything else returns the raw text so the caller can
 * record the failure instead of crashing a whole route.
 *
 * @param {string} stdout - raw process stdout.
 * @returns {{ok: true, value: unknown} | {ok: false, raw: string}}
 */
export function parseEvalOutput(stdout) {
  const raw = typeof stdout === 'string' ? stdout : '';
  const text = raw.trim();
  if (text === '') return { ok: false, raw };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, raw };
  }
  // Double-encoded case: the page returned a JSON *string*, so one parse yields
  // a string that is itself JSON. Only retry when it plausibly is.
  if (typeof value === 'string') {
    const inner = value.trim();
    if (inner.startsWith('{') || inner.startsWith('[')) {
      try {
        return { ok: true, value: JSON.parse(inner) };
      } catch {
        return { ok: true, value };
      }
    }
  }
  return { ok: true, value };
}
