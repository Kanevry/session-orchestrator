/**
 * Minimal hand-rolled YAML-subset parser + serializer for the fields used by
 * the session-orchestrator STATE.md contract. Not a general-purpose YAML
 * implementation — handles:
 *   - Scalar strings, booleans, integers, nulls
 *   - Flow-style integer arrays (`[1, 2, 3]`)
 *   - Block-style sequences of mappings (issue #244), e.g. `docs-tasks:` with
 *     indented `- key: value` entries. Only one nesting level supported.
 *
 * That is the full grammar permitted by skills/_shared/state-ownership.md.
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
 * @param {string} contents
 * @returns {{frontmatter: object, body: string}|null}
 */
export function parseStateMd(contents) {
  if (typeof contents !== 'string') return null;
  const match = FRONTMATTER_RE.exec(contents);
  if (!match) return null;
  const [, fmText, body] = match;
  const frontmatter = parseFrontmatter(fmText);
  if (frontmatter === null) return null;
  return { frontmatter, body: body.startsWith('\n') ? body.slice(1) : body };
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

function parseFrontmatter(text) {
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
      const result = parseBlockValue(lines, i + 1);
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
 */
function parseBlockValue(lines, start) {
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
  while (i < lines.length) {
    const rstripped = lines[i].replace(/\s+$/, '');
    if (rstripped === '' || /^\s*#/.test(rstripped)) {
      i++;
      continue;
    }
    if (!rstripped.startsWith(indent + '- ')) break;
    const firstBody = rstripped.slice(indent.length + 2);
    const firstColon = firstBody.indexOf(':');
    if (firstColon === -1) return null;
    const firstKey = firstBody.slice(0, firstColon).trim();
    if (firstKey === '') return null;
    const entry = {};
    entry[firstKey] = parseScalar(firstBody.slice(firstColon + 1).trim());
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
      const key = body.slice(0, colon).trim();
      if (key === '') return null;
      entry[key] = parseScalar(body.slice(colon + 1).trim());
      i++;
    }
    entries.push(entry);
  }
  return { value: entries, nextIndex: i };
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
