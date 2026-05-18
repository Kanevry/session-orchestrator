/**
 * language-mappers/typescript.mjs — Semantic slice extractor for TypeScript/JS.
 *
 * Uses @babel/parser (lazy import) to parse the file into an AST and walk
 * top-level declarations.  Emits SemanticSlice records for:
 *   function  — FunctionDeclaration
 *   class     — ClassDeclaration (+ nested method slices)
 *   interface — TSInterfaceDeclaration
 *   type      — TSTypeAliasDeclaration
 *   export    — ExportNamedDeclaration without an inner declaration
 *
 * Part of the Clawpatch Borrow Cluster (issue #416).
 */

// ---------------------------------------------------------------------------
// Types (JSDoc only — no runtime overhead)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   kind: 'function'|'class'|'interface'|'type'|'export'|'section';
 *   name: string;
 *   file: string;
 *   line: number;
 *   endLine: number;
 *   exported: boolean;
 *   isNested: boolean;
 *   params?: string[];
 *   doc?: string;
 *   source?: string;
 * }} SemanticSlice
 */

// ---------------------------------------------------------------------------
// Babel parser options
// ---------------------------------------------------------------------------

const BABEL_OPTIONS = {
  sourceType: 'module',
  strictMode: false,
  plugins: [
    'typescript',
    'jsx',
    'decorators-legacy',
    'classProperties',
    'classStaticBlock',
    'exportDefaultFrom',
    'importMeta',
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract parameter names from a Babel FunctionDeclaration / FunctionExpression
 * params array.  Returns an array of identifier name strings (skips patterns).
 *
 * @param {Array<object>} params
 * @returns {string[]}
 */
function extractParamNames(params) {
  return params.flatMap((p) => {
    if (p.type === 'Identifier') return [p.name];
    if (p.type === 'AssignmentPattern' && p.left?.type === 'Identifier') return [p.left.name];
    if (p.type === 'RestElement' && p.argument?.type === 'Identifier')
      return [`...${p.argument.name}`];
    if (p.type === 'TSParameterProperty' && p.parameter?.type === 'Identifier')
      return [p.parameter.name];
    return [];
  });
}

/**
 * Extract a leading comment string from the node's `leadingComments` if present.
 *
 * @param {object} node
 * @returns {string|undefined}
 */
function extractDoc(node) {
  const comments = node.leadingComments;
  if (!Array.isArray(comments) || comments.length === 0) return undefined;
  const last = comments[comments.length - 1];
  if (!last) return undefined;
  const raw = last.value ?? '';
  // Strip leading * characters (JSDoc style) and trim
  return raw
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim() || undefined;
}

/**
 * Safe node location accessor — returns {startLine, endLine} or {1, 1} on miss.
 *
 * @param {object} node
 * @returns {{ startLine: number; endLine: number }}
 */
function nodeLoc(node) {
  const start = node?.loc?.start?.line ?? 1;
  const end = node?.loc?.end?.line ?? start;
  return { startLine: start, endLine: end };
}

// ---------------------------------------------------------------------------
// AST walker
// ---------------------------------------------------------------------------

/**
 * Walk a single statement and emit SemanticSlice records into `out`.
 *
 * @param {object} stmt       AST statement node
 * @param {string} filePath   Source file path
 * @param {boolean} exported  Whether this stmt is inside an ExportDeclaration
 * @param {SemanticSlice[]} out
 */
function walkStatement(stmt, filePath, exported, out) {
  if (!stmt || typeof stmt !== 'object') return;

  switch (stmt.type) {
    case 'ExportNamedDeclaration': {
      const inner = stmt.declaration;
      if (inner) {
        // Has a nested declaration — delegate but mark as exported
        walkStatement(inner, filePath, true, out);
      } else {
        // Re-export or `export { foo }` without a declaration.
        // Note: `export * as ns from 'x'` lands here too (ExportNamespaceSpecifier).
        const { startLine, endLine } = nodeLoc(stmt);
        const source = stmt.source?.value;
        // Collect specifier names
        const names = (stmt.specifiers ?? []).map((s) => s.exported?.name ?? s.local?.name ?? '?');
        if (names.length > 0) {
          for (const name of names) {
            out.push({
              kind: 'export',
              name,
              file: filePath,
              line: startLine,
              endLine,
              exported: true,
              isNested: false,
              ...(source !== undefined ? { source } : {}),
            });
          }
        } else {
          // Empty specifiers with a source (rare: `export {} from 'x'`)
          out.push({
            kind: 'export',
            name: source ?? '<re-export>',
            file: filePath,
            line: startLine,
            endLine,
            exported: true,
            isNested: false,
            ...(source !== undefined ? { source } : {}),
          });
        }
      }
      break;
    }

    case 'ExportAllDeclaration': {
      // `export * from './x'`            → stmt.exported = null, name '*'
      // `export * as ns from './x'`      → stmt.exported = { name: 'ns' }
      const { startLine, endLine } = nodeLoc(stmt);
      out.push({
        kind: 'export',
        name: stmt.exported?.name ?? '*',
        file: filePath,
        line: startLine,
        endLine,
        exported: true,
        isNested: false,
        source: stmt.source?.value ?? '<unknown>',
      });
      break;
    }

    case 'ExportDefaultDeclaration': {
      const inner = stmt.declaration;
      const { startLine, endLine } = nodeLoc(stmt);
      if (inner && (inner.type === 'FunctionDeclaration' || inner.type === 'FunctionExpression')) {
        const name = inner.id?.name ?? '<default>';
        out.push({
          kind: 'function',
          name,
          file: filePath,
          line: startLine,
          endLine,
          exported: true,
          isNested: false,
          params: extractParamNames(inner.params ?? []),
          doc: extractDoc(stmt),
        });
      } else if (inner && (inner.type === 'ClassDeclaration' || inner.type === 'ClassExpression')) {
        const name = inner.id?.name ?? '<default>';
        out.push({
          kind: 'class',
          name,
          file: filePath,
          line: startLine,
          endLine,
          exported: true,
          isNested: false,
          params: extractClassMethods(inner),
          doc: extractDoc(stmt),
        });
        walkClassMethods(inner, filePath, out);
      } else {
        // Arrow function, expression, etc.
        const innerName =
          inner?.id?.name ?? (inner?.type === 'ArrowFunctionExpression' ? '<arrow>' : '<default>');
        out.push({
          kind: 'export',
          name: innerName,
          file: filePath,
          line: startLine,
          endLine,
          exported: true,
          isNested: false,
          doc: extractDoc(stmt),
        });
      }
      break;
    }

    case 'FunctionDeclaration': {
      if (!stmt.id) break; // anonymous
      const { startLine, endLine } = nodeLoc(stmt);
      out.push({
        kind: 'function',
        name: stmt.id.name,
        file: filePath,
        line: startLine,
        endLine,
        exported,
        isNested: false,
        params: extractParamNames(stmt.params ?? []),
        doc: extractDoc(stmt),
      });
      break;
    }

    case 'ClassDeclaration': {
      if (!stmt.id) break;
      const { startLine, endLine } = nodeLoc(stmt);
      out.push({
        kind: 'class',
        name: stmt.id.name,
        file: filePath,
        line: startLine,
        endLine,
        exported,
        isNested: false,
        params: extractClassMethods(stmt),
        doc: extractDoc(stmt),
      });
      walkClassMethods(stmt, filePath, out);
      break;
    }

    case 'TSInterfaceDeclaration': {
      const { startLine, endLine } = nodeLoc(stmt);
      const name = stmt.id?.name ?? '<interface>';
      out.push({
        kind: 'interface',
        name,
        file: filePath,
        line: startLine,
        endLine,
        exported,
        isNested: false,
        doc: extractDoc(stmt),
      });
      break;
    }

    case 'TSTypeAliasDeclaration': {
      const { startLine, endLine } = nodeLoc(stmt);
      const name = stmt.id?.name ?? '<type>';
      out.push({
        kind: 'type',
        name,
        file: filePath,
        line: startLine,
        endLine,
        exported,
        isNested: false,
        doc: extractDoc(stmt),
      });
      break;
    }

    // Variable declarations: const foo = () => {} or const foo = function() {}
    case 'VariableDeclaration': {
      for (const decl of stmt.declarations ?? []) {
        if (!decl.id || decl.id.type !== 'Identifier') continue;
        const init = decl.init;
        if (!init) continue;
        if (
          init.type === 'ArrowFunctionExpression' ||
          init.type === 'FunctionExpression'
        ) {
          const { startLine, endLine } = nodeLoc(stmt);
          out.push({
            kind: 'function',
            name: decl.id.name,
            file: filePath,
            line: startLine,
            endLine,
            exported,
            isNested: false,
            params: extractParamNames(init.params ?? []),
            doc: extractDoc(stmt),
          });
        }
      }
      break;
    }

    default:
      break;
  }
}

/**
 * Extract method names from a ClassDeclaration body.
 *
 * @param {object} classNode
 * @returns {string[]}
 */
function extractClassMethods(classNode) {
  const body = classNode?.body?.body ?? [];
  return body
    .filter((m) => m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod')
    .map((m) => {
      if (m.key?.type === 'Identifier') return m.key.name;
      if (m.key?.type === 'StringLiteral') return m.key.value;
      return '<method>';
    });
}

/**
 * Walk class body and emit nested method slices.
 *
 * @param {object} classNode
 * @param {string} filePath
 * @param {SemanticSlice[]} out
 */
function walkClassMethods(classNode, filePath, out) {
  const body = classNode?.body?.body ?? [];
  for (const member of body) {
    if (member.type !== 'ClassMethod' && member.type !== 'ClassPrivateMethod') continue;
    const { startLine, endLine } = nodeLoc(member);
    let name;
    if (member.key?.type === 'Identifier') {
      name = member.key.name;
    } else if (member.key?.type === 'StringLiteral') {
      name = member.key.value;
    } else {
      name = '<method>';
    }
    out.push({
      kind: 'function',
      name,
      file: filePath,
      line: startLine,
      endLine,
      exported: false,
      isNested: true,
      params: extractParamNames(member.params ?? []),
      doc: extractDoc(member),
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract semantic slices from TypeScript/JavaScript source.
 *
 * @param {string} filePath  Source file path (used only for the slice `file` field).
 * @param {string} content   Raw source text.
 * @returns {Promise<SemanticSlice[]>}
 */
export async function extractTypeScriptSlices(filePath, content) {
  if (!content.trim()) return [];

  const { parse } = await import('@babel/parser');

  let ast;
  try {
    ast = parse(content, BABEL_OPTIONS);
  } catch (err) {
    throw new Error(
      `extractTypeScriptSlices: parse error in '${filePath}': ${err.message}`,
      { cause: err },
    );
  }

  const body = ast?.program?.body ?? [];
  /** @type {SemanticSlice[]} */
  const slices = [];

  for (const stmt of body) {
    walkStatement(stmt, filePath, false, slices);
  }

  return slices;
}
