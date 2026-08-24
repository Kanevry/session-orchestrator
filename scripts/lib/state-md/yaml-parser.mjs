/**
 * Minimal hand-rolled YAML-subset parser + serializer for the fields used by
 * the session-orchestrator STATE.md contract. Not a general-purpose YAML
 * implementation — handles:
 *   - Scalar strings, booleans, integers, nulls
 *   - Flow-style integer arrays (`[1, 2, 3]`)
 *   - Block-style sequences of mappings (issue #244), e.g. `docs-tasks:` with
 *     indented `- key: value` entries. Only one nesting level supported.
 *   - Single-line FLOW MAPPINGS as list items (`- { k: v, … }`) — hand-written
 *     but valid YAML, parsed into the same plain object a block item yields and
 *     re-emitted in block notation on the next serialize (#1111).
 *
 * That is the full grammar permitted by skills/_shared/state-ownership.md.
 * A list item this grammar cannot represent (a flow SEQUENCE `- [a, b]`, or a
 * flow mapping whose interior is malformed) is dropped from ITS OWN LIST and
 * reported on `parseStateMd(...).warnings` — never escalated to a null
 * document. See `parseBlockValue` for why that scoping is load-bearing.
 *
 * Never throws. Returns null for unparseable input rather than raising.
 *
 * Inverse property (#747 — root-fix for the 6.3-MB balloon incident #739):
 * `parseScalar` and `serializeScalar` are mutually inverse for scalars the
 * SERIALIZER produced. Concretely:
 *   - serialize∘parse is a BYTE-fixpoint for any file this serializer emitted:
 *     double-quoted scalars are JSON-escaped on emit and JSON.parse-unescaped
 *     on read, so a literal `"` / `\` / newline no longer accretes an extra
 *     backslash layer per round-trip (the compounding-growth mechanism).
 *   - parse∘serialize preserves the VALUE and its runtime type exactly:
 *     bool/null/number-SHAPED strings ('true', 'null', '42', '1.0') are
 *     force-quoted on emit so they survive as strings instead of coercing to a
 *     boolean/null/number on the next parse.
 *   - KNOWN non-byte-fixpoint: a SINGLE-quoted source line normalises to
 *     double-quoted on first serialize (content identical, bytes differ), then
 *     converges to a byte-fixpoint after one cycle. The serializer never emits
 *     single-quoted, so this only affects hand-authored input.
 *
 * Leaf module — no imports from peer state-md submodules (avoids circular deps).
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parses a STATE.md file into frontmatter + body.
 *
 * `warnings` is OMITTED (not `null`, not `[]`) when the parse was clean, so a
 * caller pinning the whole return with `toEqual({ frontmatter, body })` still
 * matches and no consumer has to learn about it to keep working. When present
 * it is a non-empty array of `{ key, index, reason }` records naming list items
 * that were dropped from `frontmatter[key]` — `index` addresses the RAW source
 * item position (dropped items included), so it stays quotable against the file
 * even though the surviving array is shorter.
 *
 * @param {string} contents
 * @returns {{frontmatter: object, body: string, warnings?: Array<{key: string, index: number, reason: string}>}|null}
 */
export function parseStateMd(contents) {
  if (typeof contents !== 'string') return null;
  const match = FRONTMATTER_RE.exec(contents);
  if (!match) return null;
  const [, fmText, body] = match;
  const warnings = [];
  const frontmatter = parseFrontmatter(fmText, warnings);
  if (frontmatter === null) return null;
  const parsed = { frontmatter, body: body.startsWith('\n') ? body.slice(1) : body };
  if (warnings.length > 0) parsed.warnings = warnings;
  return parsed;
}

/**
 * Serializes a frontmatter object + body back into STATE.md format.
 *
 * @param {{frontmatter: object, body: string}} input
 * @returns {string}
 */
export function serializeStateMd({ frontmatter, body }) {
  const fmLines = [];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (isBlockSeqOfMappings(v)) {
      fmLines.push(`${k}:`);
      for (const entry of v) {
        serializeBlockSeqEntry(entry, fmLines);
      }
    } else {
      fmLines.push(`${k}: ${serializeScalar(v)}`);
    }
  }
  const bodyOut = body.startsWith('\n') ? body : `\n${body}`;
  return `---\n${fmLines.join('\n')}\n---\n${bodyOut}`;
}

function parseFrontmatter(text, warnings) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const rstripped = lines[i].replace(/\s+$/, '');
    if (rstripped === '' || /^\s*#/.test(rstripped)) {
      i++;
      continue;
    }
    if (/^\s/.test(rstripped)) return null;
    const idx = rstripped.indexOf(':');
    if (idx === -1) return null;
    const key = rstripped.slice(0, idx).trim();
    if (key === '') return null;
    const valuePart = rstripped.slice(idx + 1).trim();
    if (valuePart === '') {
      const result = parseBlockValue(lines, i + 1, key, warnings);
      if (result === null) return null;
      out[key] = result.value;
      i = result.nextIndex;
    } else {
      out[key] = parseScalar(valuePart);
      i++;
    }
  }
  return out;
}

/**
 * Parses an optional block-sequence-of-mappings value following an empty
 * `key:` line. Returns `{ value, nextIndex }` where:
 *   - `value === null` means no block sequence was present (the `key:` has
 *     no body) and `nextIndex === start` so the caller resumes at `start`.
 *   - `value === [...]` means a block sequence was consumed.
 * Returns `null` on malformed block syntax.
 *
 * A list item that opens a YAML FLOW collection is resolved PER ITEM, never per
 * document:
 *   - `- { id: m-1, task: "x", wave: 1, status: b }` parses into exactly the
 *     object the equivalent block item yields (and serializes back as block
 *     notation). Splitting it at the first colon — the #1111 bug, measured
 *     2026-08-24 @ f0766e1 as `keys: ["{ id"] · status: undefined` — is what
 *     this must never do again.
 *   - Anything else flow-shaped (`- [a, b]`, or a `{ … }` whose interior is
 *     malformed) is dropped from THIS list with a `warnings` record. It cannot
 *     be kept: a non-mapping item makes `isBlockSeqOfMappings` false for the
 *     whole array, and the serializer would then emit the entire list through
 *     `serializeScalar` as `[object Object]`.
 *
 * Escalating either case to `null` for the WHOLE document — the first #1111 fix
 * — is the failure this scoping exists to prevent: every mutator in this family
 * opens with `parseStateMd(contents); if (parsed === null) return contents;`, so
 * one hand-written item silently turned every STATE.md write into a no-op that
 * reported success. Silent-wrong must not be traded for silent-absent.
 */
function parseBlockValue(lines, start, key, warnings) {
  let i = start;
  while (i < lines.length) {
    const rstripped = lines[i].replace(/\s+$/, '');
    if (rstripped === '' || /^\s*#/.test(rstripped)) {
      i++;
      continue;
    }
    break;
  }
  if (i >= lines.length) return { value: null, nextIndex: start };
  const peek = lines[i].replace(/\s+$/, '');
  const bulletMatch = peek.match(/^(\s+)- /);
  if (!bulletMatch) return { value: null, nextIndex: start };
  const indent = bulletMatch[1];
  const contIndent = indent + '  ';
  const entries = [];
  let itemIndex = 0;
  while (i < lines.length) {
    const rstripped = lines[i].replace(/\s+$/, '');
    if (rstripped === '' || /^\s*#/.test(rstripped)) {
      i++;
      continue;
    }
    if (!rstripped.startsWith(indent + '- ')) break;
    const firstBody = rstripped.slice(indent.length + 2);
    // `entry === null` marks an item this grammar cannot represent: its
    // continuation lines are still consumed below (so the walk stays aligned),
    // but nothing is pushed onto `entries`.
    let entry;
    if (firstBody.startsWith('{')) {
      entry = parseFlowMapping(firstBody);
      if (entry === null) {
        warnings.push({ key, index: itemIndex, reason: 'malformed-flow-mapping' });
      }
    } else if (firstBody.startsWith('[')) {
      entry = null;
      warnings.push({ key, index: itemIndex, reason: 'flow-sequence-item' });
    } else {
      const firstColon = firstBody.indexOf(':');
      if (firstColon === -1) return null;
      const firstKey = firstBody.slice(0, firstColon).trim();
      if (firstKey === '') return null;
      entry = {};
      entry[firstKey] = parseScalar(firstBody.slice(firstColon + 1).trim());
    }
    i++;
    while (i < lines.length) {
      const inner = lines[i].replace(/\s+$/, '');
      if (inner === '' || /^\s*#/.test(inner)) {
        i++;
        continue;
      }
      if (!inner.startsWith(contIndent) || inner.startsWith(indent + '- ')) break;
      const body = inner.slice(contIndent.length);
      if (/^\s/.test(body)) return null;
      const colon = body.indexOf(':');
      if (colon === -1) return null;
      const contKey = body.slice(0, colon).trim();
      if (contKey === '') return null;
      if (entry !== null) entry[contKey] = parseScalar(body.slice(colon + 1).trim());
      i++;
    }
    if (entry !== null) entries.push(entry);
    itemIndex++;
  }
  return { value: entries, nextIndex: i };
}

/**
 * Splits a flow-collection interior on its TOP-LEVEL commas — the ones outside
 * quotes and outside any nested `{}`/`[]`. A naive `split(',')` would cut
 * `task: "a, b"` in half, which is the same class of first-separator mistake
 * that produced the `{ id` key in the first place.
 *
 * @param {string} inner
 * @returns {string[]}
 */
function splitFlowSegments(inner) {
  const segments = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote !== null) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        current += inner[++i] ?? '';
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * Parses a SINGLE-LINE YAML flow mapping (`{ k: v, k2: "v, 2" }`) into a plain
 * object, reusing `parseScalar` for each value so a flow item and the equivalent
 * block item yield byte-identical results.
 *
 * Returns `null` when `raw` is not a well-formed single-line flow mapping —
 * unterminated, an empty segment, or a segment with no `:`. Callers report that
 * as a dropped item; nothing here throws.
 *
 * KNOWN CEILING: a NESTED flow mapping value (`{ id: m-1, meta: { a: 1 } }`)
 * keeps `{ a: 1 }` as a STRING rather than an object — this subset has no
 * nested-mapping representation and the serializer has no way to emit one. Flat
 * flow mappings are the whole observed population (hand-written `mission-status`
 * / `docs-tasks` items). Revisit if a nested flow value ever appears in a real
 * STATE.md.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function parseFlowMapping(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const inner = trimmed.slice(1, -1).trim();
  const out = {};
  if (inner === '') return out;
  for (const segment of splitFlowSegments(inner)) {
    const part = segment.trim();
    if (part === '') return null;
    const colon = part.indexOf(':');
    if (colon === -1) return null;
    const key = part.slice(0, colon).trim();
    if (key === '') return null;
    out[key] = parseScalar(part.slice(colon + 1).trim());
  }
  return out;
}

function parseScalar(raw) {
  if (raw === '' || raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => parseScalar(s.trim()));
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    // Double-quoted: the serializer emits these via JSON.stringify, so JSON.parse
    // is the exact inverse (unescapes `\"`, `\\`, `\n`, `\t`, `\uXXXX`, …). Fall
    // back to a naive quote-strip if the interior is not valid JSON (hand-authored
    // or already-corrupt content) — this module's never-throw contract holds.
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    // Single-quoted: the serializer never emits this form (it always uses
    // double-quotes via JSON.stringify), so a plain quote-strip is correct and
    // no unescaping is defined. Sources like this normalise to double-quoted on
    // the next serialize — a KNOWN non-byte-fixpoint (value preserved).
    return raw.slice(1, -1);
  }
  return raw;
}

function isBlockSeqOfMappings(v) {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))
  );
}

function serializeBlockSeqEntry(entry, fmLines) {
  const entries = Object.entries(entry);
  if (entries.length === 0) {
    fmLines.push('  - {}');
    return;
  }
  const [firstKey, firstValue] = entries[0];
  fmLines.push(`  - ${firstKey}: ${serializeScalar(firstValue)}`);
  for (let idx = 1; idx < entries.length; idx++) {
    const [key, value] = entries[idx];
    fmLines.push(`    ${key}: ${serializeScalar(value)}`);
  }
}

/** Characters permitted in an unquoted (bare) scalar emission. */
const BARE_SCALAR_RE = /^[\w\-./:+@]+$/;

function serializeScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(serializeScalar).join(', ')}]`;
  const s = String(v);
  // Emit bare ONLY when the value would round-trip back to the identical STRING.
  // `parseScalar(s) === s` force-quotes bool/null/number-shaped strings
  // ('true'/'false'/'null'/'42'/'1.0'), which would otherwise re-parse to a
  // boolean/null/number — the silent type-coercion asymmetry (#747). Otherwise
  // JSON.stringify, whose exact inverse is the JSON.parse branch in parseScalar.
  // (parseScalar is a hoisted function declaration — safe to reference here.)
  if (BARE_SCALAR_RE.test(s) && parseScalar(s) === s) return s;
  return JSON.stringify(s);
}
