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
export function parseSections(body) {
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
export function serializeSections(sections) {
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
