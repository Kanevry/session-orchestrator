/**
 * Case-sensitive POSIX globs with dot:true. Input backslashes always become
 * slashes so the same scope matches Windows paths. Pattern backslashes
 * always escape the next character. Star and question-mark wildcards stay
 * line-bounded, and globstar can consume literal "." and ".." segments.
 * Separators and dot segments are otherwise preserved.
 *
 * BV-004 ceiling: 4096 pattern code units, 32 group levels and 256 values per
 * brace range. Out-of-budget syntax, regex special groups, stepped ranges and
 * unknown POSIX classes are literal. Named classes use ASCII and stay within
 * one segment. Signed ranges and unsigned ranges that form invalid character
 * classes keep bounded numeric expansion. Unclosed extglobs keep the literal
 * fallback because recovering them would require deciding their operator
 * semantics. Bare parentheses group glob alternatives. Raw regex operators
 * and separators in unclosed groups stay within the bounded glob grammar.
 * Revisit on a consumer glob that needs one of these forms or exceeds a limit.
 *
 * Deliberate differences from Picomatch 4.0.7 (dot:true), with BV-004 ceilings:
 * - An unclosed `{` becomes literal and glob wildcards stay active within the
 *   existing parser limits. Picomatch can fall back to a literal-only match.
 *   Revisit if a consumer relies on that literal-only behavior.
 * - An unclosed bare `(` becomes literal and its contents use the bounded glob
 *   grammar. Picomatch agrees in simple cases and can reject more complex ones.
 *   Revisit if a consumer relies on that rejection.
 * - A slashless glob ending in a non-globstar star or class can match `dir/`
 *   with one optional trailing slash. Picomatch can reject it, as with `docs*`.
 *   Revisit if a consumer needs that glob to distinguish `dir` from `dir/`.
 * - A top-level whole-segment `*` requires at least one character within the
 *   segment. Picomatch can accept empty segments such as the one in
 *   `src//index.ts`. Revisit if a consumer needs to match an empty segment.
 *
 * Opus review of d2e0b807: 238,886 random pairs yielded 285 patterns that had
 * previously agreed with Picomatch and now diverged. Across 183 shipped
 * patterns and 911,157 pairs, only the two intended directory matches changed.
 *
 * The cached RegExp fast path has at most two independent unbounded
 * repetitions of fixed-width atoms, and at most 64 branch combinations.
 * Other patterns use the same compiled atoms in a graph. Each traversal visits
 * a (state, path offset) pair once, and each negative assertion is memoized
 * per offset. With S states and edges and N path offsets, this bounds graph
 * matching to O(S²N²) work with negative assertions and O(SN) without them.
 */

const MAX_PATTERN_LENGTH = 4096;
const MAX_GROUP_DEPTH = 32;
const MAX_RANGE_VALUES = 256;
// BV-004: keep at most 1000 compiled patterns, evicting in insertion order.
// Revisit if a consumer repeatedly matches more distinct patterns per process.
const MAX_CACHED_PATTERNS = 1000;
const cache = new Map();

const POSIX_CLASSES = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7F',
  blank: ' \\t',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '\\x21-\\x7E',
  lower: 'a-z',
  print: '\\x20-\\x7E',
  punct: '\\x21-\\x2F\\x3A-\\x40\\x5B-\\x60\\x7B-\\x7E',
  space: ' \\t\\r\\n\\v\\f',
  upper: 'A-Z',
  word: 'A-Za-z0-9_',
  xdigit: 'A-Fa-f0-9',
};

const escapeRegex = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const literal = (value) => ({ source: escapeRegex(value) });
const slash = literal('/');
const pathChar = { source: '[^\\n\\r\\u2028\\u2029]' };
const segmentChar = { source: '[^/\\n\\r\\u2028\\u2029]' };
const end = '(?![\\s\\S])';

const choice = (branches) => ({ branches });
const optional = (sequence) => choice([sequence, []]);
const repeat = (branches, minimum = 0) => ({ repeat: branches, minimum });

function classAtom(source) {
  try {
    new RegExp(source);
    return { source };
  } catch {
    return null;
  }
}

function braceRange(value) {
  const numeric = /^(-?\d+)\.\.(-?\d+)$/.exec(value);
  const letters = /^([A-Za-z])\.\.([A-Za-z])$/.exec(value);
  if (!numeric && !letters) return null;

  if (numeric && !numeric[1].startsWith('-') && !numeric[2].startsWith('-')) {
    // Picomatch sorts the endpoints as strings, so {9..12} becomes [12-9].
    const [first, last] = numeric.slice(1).sort();
    const atom = classAtom(`[${first}-${last}]`);
    if (atom) return atom;
  }

  const first = numeric ? Number(numeric[1]) : letters[1].charCodeAt(0);
  const last = numeric ? Number(numeric[2]) : letters[2].charCodeAt(0);
  const count = Math.abs(last - first) + 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || count > MAX_RANGE_VALUES) return null;

  const step = first <= last ? 1 : -1;
  return choice(Array.from({ length: count }, (_, index) => {
    const item = first + step * index;
    return [literal(numeric ? String(item) : String.fromCharCode(item))];
  }));
}

function classBoundaries(pattern) {
  const ends = new Uint32Array(pattern.length + 1);
  const namedEnds = new Uint32Array(pattern.length);
  const nextNamedEnd = new Map();
  // An entry gives the exclusive end from a position inside a nonempty class.
  // Zero means no closing bracket is reachable by following the class tokens.
  for (let cursor = pattern.length - 1; cursor >= 0; cursor--) {
    // A named class at cursor opens with the delimiter at cursor + 1 and closes later.
    const delimiter = pattern[cursor + 2];
    if (pattern[cursor + 3] === ']' && ':.='.includes(delimiter)) {
      nextNamedEnd.set(delimiter, cursor + 4);
    }
    const char = pattern[cursor];
    if (char === ']') {
      ends[cursor] = cursor + 1;
      continue;
    }
    const namedEnd = char === '[' ? nextNamedEnd.get(pattern[cursor + 1]) : undefined;
    if (namedEnd) namedEnds[cursor] = namedEnd;
    const tokenEnd = namedEnd ?? (char === '\\' && cursor + 1 < pattern.length ? cursor + 2 : cursor + 1);
    ends[cursor] = ends[tokenEnd];
  }
  return { ends, namedEnds };
}

function parse(pattern) {
  let index = 0;
  let boundaries;

  function readClass() {
    const start = index++;
    const negate = pattern[index] === '^';
    if (negate) index++;
    const { ends, namedEnds } = boundaries ??= classBoundaries(pattern);
    // A leading ] counts as content, so only a later ] can close the class.
    const classEnd = ends[pattern[index] === ']' ? index + 1 : index];
    if (!classEnd) {
      index = start + 1;
      return literal('[');
    }

    // Successful classes consume disjoint spans of the pattern.
    let content = '';
    let named = false;
    let unsupportedClass = false;
    while (index < classEnd - 1) {
      const char = pattern[index++];
      const namedEnd = namedEnds[index - 1];
      if (namedEnd) {
        named = true;
        const name = pattern.slice(index + 1, namedEnd - 2);
        if (pattern[index] === ':' && Object.hasOwn(POSIX_CLASSES, name)) {
          content += POSIX_CLASSES[name];
        } else {
          unsupportedClass = true;
          content += pattern.slice(index - 1, namedEnd);
        }
        index = namedEnd;
      } else if (char === '\\' && index < pattern.length) {
        content += pattern[index++].replace(/[\\[\]^/-]/g, '\\$&');
      } else {
        content += char.replace(/[\\[\]^]/g, '\\$&');
      }
    }
    index = classEnd;
    const raw = pattern.slice(start, index);
    const source = '(?!/)[' + (negate ? '^' : '') + content + ']';
    const atom = unsupportedClass ? null : classAtom(source);
    if (!atom) return literal(raw);
    // Picomatch also recognizes the literal spelling of simple [abc] classes.
    const token = !named && !negate && !/[-\\[\]^$.*+?(){}|]/.test(content)
      ? choice([[atom], [literal(raw)]])
      : atom;
    return { ...token, isClass: true };
  }

  function readAlternatives(close, separator, depth) {
    if (depth > MAX_GROUP_DEPTH) throw new RangeError('glob group depth');
    const branches = [[]];
    while (index < pattern.length && pattern[index] !== close) {
      const start = index;
      const char = pattern[index++];
      const branch = branches.at(-1);

      if (char === separator) {
        branches.push([]);
      } else if (char === '\\') {
        const escaped = pattern[index++] ?? '\\';
        branch.push(escaped === '/' ? slash : literal(escaped));
      } else if (char === '[') {
        index--;
        branch.push(readClass());
      } else if (char === '(' || char === '{' || ('!@+*?'.includes(char) && pattern[index] === '(')) {
        const operator = char === '(' || char === '{' ? '' : char;
        if (operator) index++;
        const open = pattern[index - 1];
        const bodyStart = index;
        const delimiter = open === '{' ? ',' : '|';
        const groups = readAlternatives(open === '{' ? '}' : ')', delimiter, depth + 1);
        const rawBody = pattern.slice(bodyStart, index);
        if (index === pattern.length) {
          if (operator) throw new SyntaxError('unclosed extglob');
          branch.push(literal(open), ...groups[0]);
          for (const group of groups.slice(1)) branch.push(literal(delimiter), ...group);
          continue;
        }
        const raw = pattern.slice(start, ++index);

        if (open === '{' && groups.length === 1) {
          branch.push(braceRange(rawBody) ?? literal(raw));
        } else if (open === '(' && rawBody.startsWith('?') && /^(?:[!=<:]|[a-z-]+:)/.test(rawBody.slice(1))) {
          branch.push(literal(raw));
        } else {
          branch.push({ operator, groups, rawBody, rest: pattern.slice(index) });
        }
      } else if (char === '*') {
        while (pattern[index] === '*' && pattern[index + 1] !== '(') index++;
        branch.push({ stars: index - start });
      } else {
        branch.push(char === '?' ? segmentChar : char === '/' ? slash : literal(char));
      }
    }
    return branches;
  }

  return readAlternatives(undefined, undefined, 0)[0];
}

function normalize(sequence, { startsSegment = true, endsSegment = true, topLevel = false } = {}) {
  const result = [];
  const boundaryBefore = (index) => index === 0 ? startsSegment : sequence[index - 1] === slash;
  const boundaryAfter = (index) => index === sequence.length - 1 ? endsSegment : sequence[index + 1] === slash;
  const globstar = (index) => sequence[index]?.stars === 2 && boundaryBefore(index) && boundaryAfter(index);

  for (let index = 0; index < sequence.length; index++) {
    const token = sequence[index];
    if (globstar(index)) {
      while (sequence[index + 1] === slash && globstar(index + 2)) index += 2;
      const across = repeat([[pathChar]]);
      if (sequence[index + 1] === slash) {
        result.push(optional([across, slash]));
        index++;
      } else if (result.length > 1 && result.at(-1) === slash) {
        result.pop();
        result.push(optional([slash, across]));
      } else {
        result.push(across);
      }
    } else if (token.stars) {
      const wholeSegment = topLevel && boundaryBefore(index) && boundaryAfter(index);
      result.push(repeat([[segmentChar]], wholeSegment ? 1 : 0));
    } else if (token.groups) {
      const groups = token.groups.map((branch) =>
        normalize(branch, { startsSegment: boundaryBefore(index), endsSegment: boundaryAfter(index) }));
      if (token.operator === '!') {
        const across = token.rawBody.includes('/');
        const suffix = token.rawBody.includes('*') && /^\.[^\\/.]+$/.test(token.rest) ? token.rest : '';
        const atEnd = across || /^\)*$/.test(token.rest);
        const forbidden = suffix
          ? groups.map((branch) => [...branch, ...normalize(parse(suffix), { startsSegment: false })])
          : groups;
        result.push({ forbidden, atEnd }, repeat([[across ? pathChar : segmentChar]]));
      } else if (token.operator === '+' || token.operator === '*') {
        result.push(repeat(groups, token.operator === '+' ? 1 : 0));
      } else {
        result.push(choice(token.operator === '?' ? [...groups, []] : groups));
      }
    } else {
      result.push(token);
    }
  }
  // Wave scopes may carry a trailing slash on a directory name.
  const last = sequence.at(-1);
  if (topLevel && (last?.isClass || (last?.stars && !globstar(sequence.length - 1)))) {
    result.push(optional([slash]));
  }
  return result;
}

// Produce a whole-pattern RegExp only where its worst-case search is bounded
// by two independent repetitions and a fixed number of branch combinations.
function regexSource(sequence) {
  let source = '';
  let repetitions = 0;
  let routes = 1;
  for (const token of sequence) {
    if (token.source) {
      source += token.source;
    } else if (token.branches) {
      const branches = token.branches.map(regexSource);
      if (branches.some((branch) => !branch)) return null;
      source += '(?:' + branches.map((branch) => branch.source).join('|') + ')';
      repetitions += Math.max(...branches.map((branch) => branch.repetitions));
      routes *= branches.reduce((sum, branch) => sum + branch.routes, 0);
    } else if (token.repeat?.length === 1 && token.repeat[0].length === 1 && token.repeat[0][0].source) {
      source += '(?:' + token.repeat[0][0].source + ')' + (token.minimum ? '+' : '*');
      repetitions++;
    } else {
      return null;
    }
    if (repetitions > 2 || routes > 64) return null;
  }
  return { source, repetitions, routes };
}

// Compile the remaining patterns to a graph using a continuation per branch.
function compileGraph(sequence) {
  const states = [];
  const atoms = new Map();
  const add = (state) => states.push(state) - 1;

  function compile(tokens, next) {
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index];
      if (token.source) {
        if (!atoms.has(token.source)) atoms.set(token.source, new RegExp(token.source, 'y'));
        next = add({ regex: atoms.get(token.source), next });
      } else if (token.branches) {
        next = add({ choices: token.branches.map((branch) => compile(branch, next)) });
      } else if (token.repeat) {
        const loop = { choices: [next] };
        const loopId = add(loop);
        const branches = token.repeat.map((branch) => compile(branch, loopId));
        loop.choices.push(...branches);
        next = token.minimum ? add({ choices: branches }) : loopId;
      } else {
        const accept = add({ accept: true, atEnd: token.atEnd });
        const forbidden = add({ choices: token.forbidden.map((branch) => compile(branch, accept)) });
        next = add({ forbidden, next });
      }
    }
    return next;
  }

  const start = compile(sequence, add({ accept: true, atEnd: true }));
  return { states, start };
}

function matchGraph({ states, start }, path) {
  const stride = path.length + 1;
  const assertions = new Map();

  function visit(first, offset) {
    const pending = [first * stride + offset];
    const seen = new Set();
    while (pending.length) {
      const key = pending.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      const position = key % stride;
      const state = states[(key - position) / stride];

      if (state.accept) {
        if (!state.atEnd || position === path.length) return true;
      } else if (state.regex) {
        state.regex.lastIndex = position;
        if (state.regex.test(path)) pending.push(state.next * stride + state.regex.lastIndex);
      } else if (state.choices) {
        for (const choiceId of state.choices) pending.push(choiceId * stride + position);
      } else {
        if (!assertions.has(key)) assertions.set(key, visit(state.forbidden, position));
        if (!assertions.get(key)) pending.push(state.next * stride + position);
      }
    }
    return false;
  }

  return visit(start, 0);
}

function compile(pattern) {
  let glob = pattern.replace(/^\.\//, '');
  let negated = false;
  while (glob.startsWith('!') && !glob.startsWith('!(')) {
    glob = glob.slice(1);
    negated = !negated;
  }
  glob = glob.replace(/^\.\//, '');

  let sequence;
  try {
    sequence = normalize(parse(glob), { topLevel: true });
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof RangeError)) throw error;
    sequence = [literal(glob)];
  }

  const source = regexSource(sequence);
  return source
    ? { regex: new RegExp('^(?:' + source.source + ')' + end), negated }
    : { graph: compileGraph(sequence), negated };
}

/**
 * Match a nonempty path against a single glob.
 * @param {string} filePath
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchGlob(filePath, pattern) {
  if (typeof filePath !== 'string' || typeof pattern !== 'string' || !filePath || !pattern) return false;
  const path = filePath.replaceAll('\\', '/');
  if (path === pattern) return true;
  if (pattern.length > MAX_PATTERN_LENGTH) return false;

  let compiled = cache.get(pattern);
  if (!compiled) {
    compiled = compile(pattern);
    if (cache.size >= MAX_CACHED_PATTERNS) cache.delete(cache.keys().next().value);
    cache.set(pattern, compiled);
  }
  const matches = compiled.regex ? compiled.regex.test(path) : matchGraph(compiled.graph, path);
  return matches !== compiled.negated;
}
