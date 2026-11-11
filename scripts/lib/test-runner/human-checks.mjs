/**
 * test-runner/human-checks.mjs — deterministic floor for the rubric-v2 human checks.
 *
 * rubric-v2 (`skills/test-runner/rubric-v2.md`) runs six human checks per page
 * and viewport BEFORE the mechanical v1 checks. Three of them carry a part that
 * a machine can find without judgment; this module finds exactly that part, so
 * a page with a placeholder area, a dead link or three competing actions can
 * never be reported as "0 findings". The other three (five-second, density,
 * decoration) need a screenshot and a judgment — they come back as
 * `requires-judgment` coverage entries, and {@link checkReportComplete} refuses
 * a report that lacks a verdict for any of them.
 *
 * Input is the AX artifact the Playwright fixtures write to
 * `<run-dir>/ax-snapshots/*.yaml` (see `skills/playwright-driver/SKILL.md`).
 * Two real shapes exist and both are read:
 *   - aria snapshot (`locator.ariaSnapshot()`): a YAML list such as
 *     `- link "Docs":` with a child `- /url: "#"`. Carries link targets.
 *   - accessibility tree (`page.accessibility.snapshot()` dumped as YAML/JSON):
 *     an object `{role, name, disabled?, children?}`. Carries no link targets.
 * Anything else throws — an unreadable artifact must never look like a clean page.
 *
 * Pure: no I/O. The caller reads the file and passes its text.
 *
 * Exports:
 *   HUMAN_CHECKS                         → frozen check catalogue
 *   parseAxSnapshot(text)                → normalised node tree
 *   evaluateHumanChecks(opts)            → { findings, coverage }
 *   checkReportComplete({pages, coverage, judged}) → { complete, missing }
 */

import * as yaml from 'js-yaml';
import { fingerprintFinding } from './fingerprint.mjs';
import { yamlHasDocument } from '../yaml-has-document.mjs';

/** Rubric version stamped on every finding this module emits. */
const RUBRIC_VERSION = 'v2';

/** Fingerprint scope for every human check (v1 scopes stay untouched). */
const SCOPE = 'human';

/** rubric-v1 § Fingerprint formula: locators are cut to 256 chars before hashing. */
const LOCATOR_MAX = 256;

/**
 * The six rubric-v2 human checks. `mode` says who decides: `mechanical-floor`
 * checks get findings from this module (the agent may add more from the
 * screenshot), `requires-judgment` checks get none and must be judged.
 */
export const HUMAN_CHECKS = Object.freeze([
  Object.freeze({ check: 'five-second', mode: 'requires-judgment' }),
  Object.freeze({ check: 'primary-action', mode: 'mechanical-floor' }),
  Object.freeze({ check: 'dead-or-locked', mode: 'mechanical-floor' }),
  Object.freeze({ check: 'empty-state', mode: 'mechanical-floor' }),
  Object.freeze({ check: 'density', mode: 'requires-judgment' }),
  Object.freeze({ check: 'decoration', mode: 'requires-judgment' }),
]);

// Placeholder wording that never belongs on a shipped page. `TODO` is matched
// case-sensitively so a to-do app's "todo list" is not flagged.
const PLACEHOLDER_PATTERNS = [
  /\bnoch leer\b/i,
  /\bkommt bald\b/i,
  /\bcoming soon\b/i,
  /\blorem ipsum\b/i,
  /\bTODO\b/,
  /\bplatzhalter\b/i,
  /\bplaceholder\b/i,
  /\bunder construction\b/i,
  /\bin (?:arbeit|vorbereitung)\b/i,
];

// Lock and refusal wording shown to a visitor on the demo path.
// Ceiling (BV-004): the AX artifact carries no colour, so "red" cannot be
// tested here — every lock message is flagged, red or not. Revisit when the
// fixtures also write computed styles.
const LOCK_PATTERNS = [
  /\bgesperrt\b/i,
  /\blocked\b/i,
  /\bnicht verfügbar\b/i,
  /\bnot available\b/i,
  /\bkeine berechtigung\b/i,
  /\bpermission denied\b/i,
  /\baccess denied\b/i,
  /\bzugriff verweigert\b/i,
  /\bupgrade (?:to|zum) (?:unlock|freischalten)\b/i,
  /\bfreischalten\b/i,
  /\u{1F512}/u, // padlock emoji
];

// Containers whose whole purpose is a list of entries: no children = empty.
const LIST_ROLES = new Set(['list', 'listbox', 'table', 'grid', 'feed', 'tree']);

// Groups where several equal controls are the design, not a competition.
const ACTION_GROUP_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'toolbar',
  'menu',
  'menubar',
  'tablist',
  'radiogroup',
  'listbox',
  'tree',
  'grid',
  'table',
]);

// Link names that read as a call to action rather than navigation.
const CTA_LINK_PATTERN =
  /\b(?:jetzt|starten|loslegen|registrieren|anmelden|kaufen|buchen|testen|ausprobieren|get started|start|sign up|try|buy|book|subscribe|download|demo)\b/i;

/** Equal-rank actions in one container from which a finding is raised. */
const COMPETING_ACTIONS_MIN = 3;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AxNode
 * @property {string} role
 * @property {string} name
 * @property {boolean} disabled
 * @property {string|null} url  link target; null when the artifact carries none
 * @property {AxNode[]} children
 */

/**
 * Parse an aria-snapshot header such as `button "Save" [disabled]`.
 * @param {string} header
 * @returns {{role: string, name: string, disabled: boolean}}
 */
function parseAriaHeader(header) {
  const m = /^([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*$/.exec(header.trim());
  if (!m) return { role: 'text', name: header.trim(), disabled: false };
  let name = m[2] ?? '';
  try {
    name = JSON.parse(`"${name}"`);
  } catch {
    // keep the raw text — an odd escape must not drop the node
  }
  return { role: m[1], name, disabled: /\[disabled(?:=true)?\]/.test(m[3] ?? '') };
}

/**
 * Normalise one aria-snapshot list item.
 * @param {unknown} item
 * @returns {AxNode|null}
 */
function fromAriaItem(item) {
  if (typeof item === 'string') {
    return { ...parseAriaHeader(item), url: null, children: [] };
  }
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const [[key, value]] = Object.entries(item);
  const node = { ...parseAriaHeader(key), url: null, children: [] };
  if (key === 'text') {
    node.role = 'text';
    node.name = String(value ?? '');
    return node;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    node.children.push({
      role: 'text',
      name: String(value),
      disabled: false,
      url: null,
      children: [],
    });
  } else if (Array.isArray(value)) {
    for (const child of value) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const [[ck, cv]] = Object.entries(child);
        if (ck === '/url') {
          node.url = cv === null || cv === undefined ? '' : String(cv);
          continue;
        }
        if (ck.startsWith('/')) continue; // other props (/placeholder …)
      }
      const c = fromAriaItem(child);
      if (c) node.children.push(c);
    }
  }
  return node;
}

/**
 * Normalise one `page.accessibility.snapshot()` node.
 * @param {Record<string, unknown>} raw
 * @returns {AxNode}
 */
function fromAxTreeNode(raw) {
  const kids = Array.isArray(raw.children) ? raw.children : [];
  return {
    role: String(raw.role ?? ''),
    name: String(raw.name ?? ''),
    disabled: raw.disabled === true,
    url: null,
    children: kids.filter((k) => k && typeof k === 'object').map((k) => fromAxTreeNode(k)),
  };
}

/**
 * Parse an AX artifact (aria snapshot YAML or accessibility-tree YAML/JSON)
 * into one normalised tree rooted at a synthetic `document` node.
 * @param {string} text  file contents
 * @returns {AxNode}
 * @throws {TypeError} when the text is not one of the two known shapes
 */
export function parseAxSnapshot(text) {
  if (typeof text !== 'string') throw new TypeError('parseAxSnapshot: text must be a string');
  // js-yaml 5 (#2015): a source without a document throws; keep the v4 'unknown shape' path.
  const doc = yamlHasDocument(text) ? yaml.load(text) : undefined;
  if (Array.isArray(doc)) {
    const children = doc.map((i) => fromAriaItem(i)).filter(Boolean);
    return { role: 'document', name: '', disabled: false, url: null, children };
  }
  if (doc && typeof doc === 'object' && typeof doc.role === 'string') {
    return {
      role: 'document',
      name: '',
      disabled: false,
      url: null,
      children: [fromAxTreeNode(doc)],
    };
  }
  throw new TypeError(
    'parseAxSnapshot: unrecognised AX artifact — expected an aria-snapshot list or an accessibility-tree object with a role',
  );
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * @param {AxNode} node
 * @returns {string}
 */
function label(node) {
  return node.name ? `${node.role} "${node.name}"` : node.role;
}

/**
 * Depth-first walk yielding each node with its AX path (labels below `document`).
 * @param {AxNode} node
 * @param {string[]} trail
 * @returns {Generator<{node: AxNode, path: string[]}>}
 */
function* walk(node, trail = []) {
  for (const child of node.children) {
    const path = [...trail, label(child)];
    yield { node: child, path };
    yield* walk(child, path);
  }
}

/** @param {string} url */
function isDeadUrl(url) {
  const u = url.trim();
  return u === '' || u === '#' || /^javascript:/i.test(u);
}

/** @param {AxNode} node */
function isActionControl(node) {
  if (node.disabled) return false;
  if (node.role === 'button') return true;
  return node.role === 'link' && CTA_LINK_PATTERN.test(node.name);
}

/**
 * Push a primary-action hit when one container holds too many equal-rank actions.
 *
 * Ceiling (BV-004): the AX artifact has no visual weight and no geometry, so
 * "equal-rank" means "same container, same control kind" and "above the fold"
 * cannot be tested. Three sibling buttons (or call-to-action links) outside a
 * toolbar/menu/nav are the floor; whether ONE of them is visibly primary, and
 * whether a page has none at all, is the agent's screenshot judgment. Revisit
 * when the fixtures write bounding boxes and computed styles.
 *
 * @param {AxNode} node
 * @param {string[]} path
 * @param {object[]} hits
 */
function checkCompetingActions(node, path, hits) {
  const actions = node.children.filter((c) => isActionControl(c));
  if (actions.length < COMPETING_ACTIONS_MIN) return;
  hits.push({
    check: 'primary-action',
    checkId: 'primary-action-competing',
    severity: 'medium',
    path,
    title: `${actions.length} equal-rank actions compete: ${actions.map((a) => `"${a.name}"`).join(', ')}`,
    recommendation:
      'Pick the one action this page exists for and make it the only primary control; demote the rest to secondary links or move them below.',
  });
}

/**
 * Raw hits per check before they become findings.
 * @param {AxNode} root
 * @returns {Array<{check: string, checkId: string, severity: string, path: string[], title: string, recommendation: string}>}
 */
function collectHits(root) {
  const hits = [];
  const insideGroup = new WeakSet();
  checkCompetingActions(root, ['document'], hits);

  for (const { node, path } of walk(root)) {
    // Mark the subtree of action groups so primary-action ignores it.
    if (ACTION_GROUP_ROLES.has(node.role) || insideGroup.has(node)) {
      for (const c of node.children) insideGroup.add(c);
    }

    const text = node.name;
    if (text && PLACEHOLDER_PATTERNS.some((re) => re.test(text))) {
      hits.push({
        check: 'empty-state',
        checkId: 'empty-state-placeholder',
        severity: 'medium',
        path,
        title: `Placeholder text on the page: "${text.slice(0, 80)}"`,
        recommendation:
          'Remove the area until it has content, or replace the placeholder with what the visitor can do now (one sentence plus one action).',
      });
    }
    if (LIST_ROLES.has(node.role) && node.children.length === 0) {
      hits.push({
        check: 'empty-state',
        checkId: 'empty-state-empty-container',
        severity: 'medium',
        path,
        title: `Empty ${node.role} rendered without an empty-state message`,
        recommendation:
          'Hide the empty container, or show an empty state that says what will appear here and offers the action that fills it.',
      });
    }
    if (node.role === 'link' && node.url !== null && isDeadUrl(node.url)) {
      hits.push({
        check: 'dead-or-locked',
        checkId: 'dead-link',
        severity: 'high',
        path,
        title: `Control "${node.name || node.role}" leads nowhere (target "${node.url}")`,
        recommendation:
          'Give the control a real destination or action, or remove it; a link to "#" or javascript: is a dead button to the visitor.',
      });
    }
    if (text && LOCK_PATTERNS.some((re) => re.test(text))) {
      hits.push({
        check: 'dead-or-locked',
        checkId: node.disabled ? 'locked-control' : 'lock-message',
        severity: 'high',
        path,
        title: `Lock message in the visitor path: "${text.slice(0, 80)}"`,
        recommendation:
          'Keep locked features out of the demo path, or show what the feature does and how to get it instead of a refusal.',
      });
    }

    if (!insideGroup.has(node) && !ACTION_GROUP_ROLES.has(node.role)) {
      checkCompetingActions(node, path, hits);
    }
  }
  return hits;
}

/**
 * Run the mechanical floor of the rubric-v2 human checks on one page/viewport.
 *
 * @param {object} opts
 * @param {string} opts.text          AX artifact contents
 * @param {string} opts.page          route or screen name, e.g. '/start'
 * @param {number|string} opts.viewport  viewport width, e.g. 1440 or 390
 * @param {string} opts.evidencePath  artifact path relative to the run dir
 * @param {string} opts.runId
 * @returns {{findings: object[], coverage: Array<{check: string, page: string, viewport: string, status: 'evaluated'|'requires-judgment'}>}}
 * @throws {TypeError} on an unreadable artifact (see {@link parseAxSnapshot})
 */
export function evaluateHumanChecks({ text, page, viewport, evidencePath, runId }) {
  if (typeof page !== 'string' || page === '')
    throw new TypeError('evaluateHumanChecks: page must be a non-empty string');
  const vp = String(viewport);
  const root = parseAxSnapshot(text);
  const seen = new Set();
  const findings = [];

  for (const hit of collectHits(root)) {
    const locator = `${page}@${vp} :: ${hit.path.join(' > ')}`.slice(0, LOCATOR_MAX);
    const fingerprint = fingerprintFinding({ scope: SCOPE, checkId: hit.checkId, locator });
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    findings.push({
      run_id: runId,
      rubric_version: RUBRIC_VERSION,
      severity: hit.severity,
      check: hit.check,
      fingerprint,
      evidence_path: evidencePath,
      suggested_priority: hit.severity,
      scope: SCOPE,
      checkId: hit.checkId,
      locator,
      title: hit.title,
      description: `Mechanical floor of rubric-v2 check ${hit.check} on ${page} at ${vp}px: found at AX path "${hit.path.join(' > ')}" in ${evidencePath}.`,
      recommendation: hit.recommendation,
    });
  }

  const coverage = HUMAN_CHECKS.map(({ check, mode }) => ({
    check,
    page,
    viewport: vp,
    status: mode === 'requires-judgment' ? 'requires-judgment' : 'evaluated',
  }));
  return { findings, coverage };
}

/** rubric-v2 Hard rule 1: every page is judged at both of these widths. */
const REQUIRED_VIEWPORTS = Object.freeze(['1440', '390']);

/**
 * rubric-v2 Hard rule 3: a report is complete only when EVERY expected cell —
 * each page × viewport (1440, 390) × each of the six human checks — has a
 * verdict. A `mechanical-floor` check counts as decided when that
 * page/viewport's AX snapshot was parsed (an `evaluated` coverage entry from
 * {@link evaluateHumanChecks}) or when it was judged explicitly; a
 * `requires-judgment` check counts only with an explicit judged entry. A
 * missing viewport, a snapshot the parser rejected (it yields no coverage) and
 * an empty run are therefore all incomplete, and the report must open with
 * `REPORT INCOMPLETE — human checks missing: <check>@<page>@<viewport>[, …]`.
 *
 * The expected pages are `pages` plus every page named in `coverage` or
 * `judged`, so a page cannot drop out by being left off the list.
 *
 * @param {object} opts
 * @param {string[]} opts.pages — every page the run was meant to evaluate
 * @param {Array<{check: string, page: string, viewport: string|number, status: string}>} [opts.coverage]
 * @param {Array<{check: string, page: string, viewport: string|number}>} [opts.judged]
 * @returns {{complete: boolean, missing: Array<{check: string, page: string, viewport: string}>, reason?: 'no pages'}}
 */
export function checkReportComplete(opts) {
  // The old positional form (coverage, judged) must fail loudly, never answer.
  if (Array.isArray(opts) || opts === null || typeof opts !== 'object' || !Array.isArray(opts.pages)) {
    throw new TypeError('checkReportComplete: expected { pages: string[], coverage, judged }');
  }
  const coverage = opts.coverage ?? [];
  const judged = opts.judged ?? [];
  const key = (check, page, viewport) => `${check}\n${page}\n${String(viewport)}`;
  const done = new Set(judged.map((e) => key(e.check, e.page, e.viewport)));
  const floorDone = new Set(
    coverage.filter((e) => e.status === 'evaluated').map((e) => key(e.check, e.page, e.viewport)),
  );
  const pages = [
    ...new Set([...opts.pages, ...coverage.map((e) => e.page), ...judged.map((e) => e.page)]),
  ];
  if (pages.length === 0) return { complete: false, missing: [], reason: 'no pages' };

  const missing = [];
  for (const page of pages) {
    for (const viewport of REQUIRED_VIEWPORTS) {
      for (const { check, mode } of HUMAN_CHECKS) {
        const k = key(check, page, viewport);
        const decided = done.has(k) || (mode === 'mechanical-floor' && floorDone.has(k));
        if (!decided) missing.push({ check, page, viewport });
      }
    }
  }
  return { complete: missing.length === 0, missing };
}
