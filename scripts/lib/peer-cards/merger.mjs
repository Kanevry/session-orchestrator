/**
 * merger.mjs — Sentinel-region three-way merge for peer cards (USER.md / AGENT.md)
 * for issue #503 (Wave 2 I8).
 *
 * Consumers:
 *   - /evolve --dialectic pass (future #506)
 *
 * Design notes
 * ────────────
 *  • SENTINEL-REGION MERGE (Strategy A per #503 D3). Managed regions are delimited by
 *    HTML comment sentinels:
 *        <!-- BEGIN MANAGED: <section-name> -->
 *        ...AI-replaceable content...
 *        <!-- END MANAGED: <section-name> -->
 *    Content outside sentinels is hand-owned and preserved verbatim. Content inside
 *    sentinels is AI-replaceable.
 *  • Pure functions — no fs imports, no IO, deterministic. Same input → same output.
 *  • Conflict-surfacing — duplicate section names and orphan BEGIN sentinels become
 *    `conflicts[]` entries. The caller decides UX (warn vs prompt vs reject).
 *  • Idempotent — `mergePeerCard(body, {})` returns body byte-equivalent (modulo the
 *    serialize round-trip; the sentinel comments are re-emitted in the same form).
 *
 * Section-name grammar: `[A-Za-z0-9_-]+` (word characters + hyphen).
 */

const SECTION_NAME = '[\\w-]+';
const SENTINEL_BEGIN_RE = new RegExp(`<!--\\s*BEGIN\\s+MANAGED:\\s*(${SECTION_NAME})\\s*-->`, 'g');

/**
 * @typedef {Object} HandSection
 * @property {'hand'} type
 * @property {string} content — verbatim text between/around sentinels (may be empty)
 * @property {number} startIdx — absolute char offset in original body
 * @property {number} endIdx — absolute char offset (exclusive)
 */

/**
 * @typedef {Object} ManagedSection
 * @property {'managed'} type
 * @property {string} name — section name from the BEGIN sentinel
 * @property {string} content — inner content (excludes the sentinel comments themselves)
 * @property {number} startIdx — offset of the BEGIN sentinel; -1 for sections appended via merge
 * @property {number} endIdx — offset just past the END sentinel; -1 for appended sections
 */

/**
 * @typedef {HandSection | ManagedSection} Section
 */

/**
 * @typedef {Object} Conflict
 * @property {'duplicate-section' | 'orphan-begin'} type
 * @property {string} [name] — section name (for duplicate-section and orphan-begin)
 */

/**
 * Parse a peer-card body into hand-owned and AI-managed sections.
 *
 * Behaviour
 * ─────────
 *  • Text before the first BEGIN sentinel becomes a `hand` section.
 *  • Each well-formed BEGIN..END pair becomes a `managed` section. The `content` field
 *    excludes the sentinel comments themselves (so re-serialising wraps them back on).
 *  • An orphan BEGIN (no matching END) collapses the BEGIN sentinel and all remaining
 *    text into a single `hand` section — defensive: we never silently drop user text.
 *    Caller should detect this via the absence of the expected managed section in the
 *    parse result, OR via the `mergePeerCard` `conflicts[]` (which checks structure).
 *  • Trailing text after the last END becomes a `hand` section.
 *
 * @param {string} body
 * @returns {{ sections: Section[] }}
 */
function parseSections(body) {
  if (typeof body !== 'string') {
    throw new Error(`parseSections: body must be string (got ${typeof body}).`);
  }

  const sections = [];
  const text = body;
  let cursor = 0;

  // Reset regex state (global regex carries lastIndex across calls)
  SENTINEL_BEGIN_RE.lastIndex = 0;
  const beginMatches = [...text.matchAll(SENTINEL_BEGIN_RE)];

  for (const beginMatch of beginMatches) {
    const sectionName = beginMatch[1];
    const beginStart = beginMatch.index;

    // If a previous orphan-BEGIN already consumed to EOF, skip remaining matches
    if (beginStart < cursor) continue;

    const beginEnd = beginStart + beginMatch[0].length;

    // Hand region BEFORE this BEGIN
    if (cursor < beginStart) {
      sections.push({
        type: 'hand',
        content: text.slice(cursor, beginStart),
        startIdx: cursor,
        endIdx: beginStart,
      });
    }

    // Find matching END (constructed per-section so names match exactly)
    const endRegex = new RegExp(`<!--\\s*END\\s+MANAGED:\\s*${escapeRegex(sectionName)}\\s*-->`);
    const endRest = text.slice(beginEnd);
    const endMatch = endRest.match(endRegex);

    if (!endMatch) {
      // Orphan BEGIN — defensive: treat the BEGIN sentinel + rest of file as hand
      sections.push({
        type: 'hand',
        content: text.slice(beginStart),
        startIdx: beginStart,
        endIdx: text.length,
      });
      cursor = text.length;
      break;
    }

    const endStart = beginEnd + endMatch.index;
    const endEnd = endStart + endMatch[0].length;

    sections.push({
      type: 'managed',
      name: sectionName,
      content: text.slice(beginEnd, endStart),
      startIdx: beginStart,
      endIdx: endEnd,
    });
    cursor = endEnd;
  }

  // Trailing hand region
  if (cursor < text.length) {
    sections.push({
      type: 'hand',
      content: text.slice(cursor),
      startIdx: cursor,
      endIdx: text.length,
    });
  }

  return { sections };
}

/**
 * Serialize sections back to a body string, wrapping managed regions in sentinels.
 *
 * @param {Section[]} sections
 * @returns {string}
 */
function serializeSections(sections) {
  if (!Array.isArray(sections)) {
    throw new Error(`serializeSections: sections must be array (got ${typeof sections}).`);
  }

  let out = '';
  for (const s of sections) {
    if (s.type === 'hand') {
      out += s.content;
    } else if (s.type === 'managed') {
      out += `<!-- BEGIN MANAGED: ${s.name} -->`;
      out += s.content;
      out += `<!-- END MANAGED: ${s.name} -->`;
    } else {
      throw new Error(`serializeSections: unknown section type: ${JSON.stringify(s)}`);
    }
  }
  return out;
}

/**
 * @typedef {Object} MergeResult
 * @property {string} body — the merged body
 * @property {Conflict[]} conflicts — duplicate-section / orphan-begin issues for caller review
 * @property {{ preserved: number, replaced: number, appended: number }} stats
 */

/**
 * Merge a dialectic-derived update into an existing peer-card body.
 *
 * Semantics
 * ─────────
 *  • Hand-owned sections (outside sentinels): PRESERVED verbatim.
 *  • Managed sections matching `managedUpdates` keys: REPLACED with new content.
 *  • Managed sections in `managedUpdates` not in existing: APPENDED at end.
 *  • Managed sections in existing not in `managedUpdates`: KEPT (no auto-delete).
 *  • Idempotency: `mergePeerCard(body, {})` returns a body byte-equivalent to `body`
 *    (round-trip through parse/serialize, which preserves sentinel form).
 *
 * Conflicts
 * ─────────
 *  • `duplicate-section` — same managed section name appears more than once in the
 *    existing body. We replace ALL occurrences with the update content (or keep all
 *    as-is if no update) but surface the conflict so the caller can resolve.
 *  • `orphan-begin` — BEGIN without matching END. Detected by re-parsing the merged
 *    body and comparing sentinel structure.
 *
 * @param {string} existingBody — the on-disk body (with sentinels)
 * @param {Record<string, string>} managedUpdates — `{ <section-name>: <new-content> }`
 * @returns {MergeResult}
 */
export function mergePeerCard(existingBody, managedUpdates) {
  if (typeof existingBody !== 'string') {
    throw new Error(`mergePeerCard: existingBody must be string (got ${typeof existingBody}).`);
  }
  if (!managedUpdates || typeof managedUpdates !== 'object' || Array.isArray(managedUpdates)) {
    throw new Error('mergePeerCard: managedUpdates must be a plain object.');
  }

  // Validate update keys against section-name grammar
  for (const name of Object.keys(managedUpdates)) {
    if (!/^[\w-]+$/.test(name)) {
      throw new Error(`mergePeerCard: invalid section name "${name}" (allowed: [A-Za-z0-9_-]+).`);
    }
    if (typeof managedUpdates[name] !== 'string') {
      throw new Error(`mergePeerCard: managedUpdates["${name}"] must be a string.`);
    }
  }

  const { sections } = parseSections(existingBody);
  const conflicts = [];
  const stats = { preserved: 0, replaced: 0, appended: 0 };

  // Detect orphan-begin: a BEGIN sentinel was found but no matching END (the parser
  // collapsed it into a hand section). We re-scan the original text for BEGIN names
  // whose presence in the parsed managed sections is missing — those are orphans.
  const parsedManagedNames = new Set();
  const seenForDuplicate = new Set();
  for (const s of sections) {
    if (s.type === 'managed') {
      parsedManagedNames.add(s.name);
      if (seenForDuplicate.has(s.name)) {
        conflicts.push({ type: 'duplicate-section', name: s.name });
      } else {
        seenForDuplicate.add(s.name);
      }
    }
  }

  SENTINEL_BEGIN_RE.lastIndex = 0;
  const allBeginNames = [...existingBody.matchAll(SENTINEL_BEGIN_RE)].map(m => m[1]);
  const reportedOrphans = new Set();
  for (const name of allBeginNames) {
    if (!parsedManagedNames.has(name) && !reportedOrphans.has(name)) {
      conflicts.push({ type: 'orphan-begin', name });
      reportedOrphans.add(name);
    }
  }

  // Apply updates: replace managed sections whose names match, preserve others
  const updatedSections = sections.map(s => {
    if (s.type === 'hand') {
      stats.preserved++;
      return s;
    }
    // s.type === 'managed'
    if (Object.prototype.hasOwnProperty.call(managedUpdates, s.name)) {
      stats.replaced++;
      return { ...s, content: wrapManagedContent(managedUpdates[s.name]) };
    }
    // Managed section not in updates — keep as-is
    return s;
  });

  // Append new managed sections from updates that didn't exist in original
  for (const name of Object.keys(managedUpdates)) {
    if (!parsedManagedNames.has(name)) {
      stats.appended++;
      updatedSections.push({
        type: 'managed',
        name,
        content: wrapManagedContent(managedUpdates[name]),
        startIdx: -1,
        endIdx: -1,
      });
    }
  }

  return {
    body: serializeSections(updatedSections),
    conflicts,
    stats,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise managed content so the serialised form always reads:
 *   <!-- BEGIN MANAGED: x -->\n<content>\n<!-- END MANAGED: x -->
 * Trimming + adding newlines keeps managed regions visually distinct from sentinels.
 * @param {string} raw
 * @returns {string}
 */
function wrapManagedContent(raw) {
  return '\n' + raw.trim() + '\n';
}

/**
 * Escape regex metacharacters in a section name. The grammar `[\w-]+` excludes most
 * metacharacters, but defence-in-depth is cheap here.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── body-string → section-map adapter (#1310) ────────────────────────────────
//
// The seam this closes: `dialectic-deriver` (agents/dialectic-deriver.md § Output
// format) emits ONE FULL PEER-CARD BODY STRING per target, while `mergePeerCard`
// above consumes a SECTION MAP keyed by sentinel name. Nothing translated between
// the two, so `/evolve dialectic --apply` could not complete (#1310, correcting
// #1303 point 3 — the signatures line up, the seam did not).
//
// The mapping is DERIVED, not invented: every managed region in the live cards
// wraps exactly one `## ` heading, so the heading IS the section unit. Existing
// names are read back out of the card rather than re-slugified, because the live
// names are NOT a pure function of their headings — measured 2026-09-11 in
// `.orchestrator/peers/AGENT.md`: "Guard and protocol-migration discipline" →
// `guard-and-protocol-migration` (drops "discipline") and "Review discipline — the
// refutation mandate" → `review-discipline-refutation-mandate` (drops "the").
// Re-slugifying either would APPEND a duplicate section instead of replacing it.

const H2_RE = /^##[ \t]+(.+?)[ \t]*$/gm;

/** Normalise a heading for matching: case- and whitespace-insensitive. */
function headingKey(heading) {
  return heading.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Slugify a heading into a section name matching the `[\w-]+` grammar.
 * Only used for headings with NO existing managed section (the append path).
 * @param {string} heading
 * @returns {string}
 */
function slugifyHeading(heading) {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'section';
}

/**
 * Split a proposed full-body string into `{ <section-name>: <content> }`, reusing
 * the existing card's section names wherever the heading already has a home.
 *
 * Behaviour for every input class (no case is silently dropped):
 *  • Heading whose text matches an existing managed section's own `## ` heading →
 *    mapped to that section's EXISTING name (`origin: 'existing'`) → REPLACE.
 *  • Heading with no existing section → slugified name (`origin: 'new'`) →
 *    APPEND. Collisions get a `-2`, `-3`, … suffix.
 *  • Text BEFORE the first `## ` heading → returned as `preamble`. It is NOT
 *    written into any section (it has no sentinel to own it); `mergeDerivedBody`
 *    surfaces it as an `unmapped-preamble` conflict so a caller cannot miss it.
 *  • Content under `###`+ headings stays inside its parent `##` section.
 *  • A proposed body that already carries BEGIN/END sentinels keeps them inside
 *    the section content — it is the deriver's job not to emit them (see
 *    `agents/dialectic-deriver.md` § Anti-patterns).
 *
 * Pure function — no IO, deterministic.
 *
 * @param {string} proposedBody — the deriver's full replacement body for one target
 * @param {string} [existingBody] — the on-disk body, for existing-name lookup
 * @returns {{ managedUpdates: Record<string,string>,
 *             mapping: Array<{heading: string, section: string, origin: 'existing'|'new'}>,
 *             preamble: string }}
 */
export function deriveManagedUpdates(proposedBody, existingBody = '') {
  if (typeof proposedBody !== 'string') {
    throw new Error(`deriveManagedUpdates: proposedBody must be string (got ${typeof proposedBody}).`);
  }
  if (typeof existingBody !== 'string') {
    throw new Error(`deriveManagedUpdates: existingBody must be string (got ${typeof existingBody}).`);
  }

  // heading-key → existing section name, read out of the live card
  const existingByHeading = new Map();
  const existingNames = new Set();
  if (existingBody.length > 0) {
    for (const s of parseSections(existingBody).sections) {
      if (s.type !== 'managed') continue;
      existingNames.add(s.name);
      const h = s.content.match(/^##[ \t]+(.+?)[ \t]*$/m);
      if (h && !existingByHeading.has(headingKey(h[1]))) {
        existingByHeading.set(headingKey(h[1]), s.name);
      }
    }
  }

  H2_RE.lastIndex = 0;
  const heads = [...proposedBody.matchAll(H2_RE)];
  const preamble = (heads.length > 0 ? proposedBody.slice(0, heads[0].index) : proposedBody).trim();

  /** @type {Record<string,string>} */
  const managedUpdates = {};
  const mapping = [];
  const used = new Set();

  for (let i = 0; i < heads.length; i++) {
    const heading = heads[i][1];
    const start = heads[i].index;
    const end = i + 1 < heads.length ? heads[i + 1].index : proposedBody.length;
    const content = proposedBody.slice(start, end).trim();

    const existing = existingByHeading.get(headingKey(heading));
    let section;
    let origin;
    if (existing !== undefined && !used.has(existing)) {
      section = existing;
      origin = 'existing';
    } else {
      const base = slugifyHeading(heading);
      let candidate = base;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${base}-${n++}`;
      }
      section = candidate;
      origin = existingNames.has(candidate) ? 'existing' : 'new';
    }

    used.add(section);
    managedUpdates[section] = content;
    mapping.push({ heading, section, origin });
  }

  return { managedUpdates, mapping, preamble };
}

/**
 * Merge a deriver-shaped FULL BODY STRING into an existing peer-card body.
 * This is the function `/evolve dialectic --apply` calls; `mergePeerCard` stays
 * the section-map primitive its existing callers already use.
 *
 * @param {string} existingBody
 * @param {string} proposedBody
 * @returns {MergeResult & { mapping: Array<{heading: string, section: string, origin: 'existing'|'new'}>, preamble: string }}
 */
export function mergeDerivedBody(existingBody, proposedBody) {
  const { managedUpdates, mapping, preamble } = deriveManagedUpdates(proposedBody, existingBody);
  const result = mergePeerCard(existingBody, managedUpdates);
  if (preamble.length > 0) {
    result.conflicts.push({ type: 'unmapped-preamble', content: preamble });
  }
  return { ...result, mapping, preamble };
}
