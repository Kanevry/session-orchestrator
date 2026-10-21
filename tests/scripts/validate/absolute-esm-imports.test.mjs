import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DIRS = ['scripts', 'hooks', 'skills', 'tests/setup'];
// Own sources only: skills/*/node_modules exists wherever a skill's deps are
// installed (it failed the gate on m5 with vitest/yaml internals).
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && entry.name === 'node_modules') return [];
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? files(target) : [target];
  });
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
}

// Structural regression gate: raw filesystem paths are invalid Windows ESM
// specifiers, including a variable whose initializer builds that path.
describe('absolute filesystem ESM imports', () => {
  it('never passes a path builder or a path-built variable directly to import()', () => {
    const violations = [];
    for (const file of DIRS.flatMap((dir) => files(path.join(ROOT, dir)))) {
      if (!/\.[cm]?js$/.test(file)) continue;
      const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'unambiguous' });
      const definitions = new Map();
      walk(ast, (node) => {
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
          definitions.set(node.id.name, node.init);
        }
      });
      const isRawPath = (node, seen = new Set()) => {
        if (!node) return false;
        if (node.type === 'Identifier') {
          if (node.name === '__dirname') return true;
          if (seen.has(node.name)) return false;
          return isRawPath(definitions.get(node.name), new Set([...seen, node.name]));
        }
        if (node.type === 'CallExpression') {
          const name = node.callee.name ?? node.callee.property?.name;
          if (name === 'pathToFileURL') return false;
          return ['join', 'resolve', 'dirname', 'fileURLToPath'].includes(name);
        }
        if (node.type === 'BinaryExpression') return isRawPath(node.left, seen) || isRawPath(node.right, seen);
        if (node.type === 'TemplateLiteral') return node.expressions.some((part) => isRawPath(part, seen));
        return false;
      };
      walk(ast, (node) => {
        const argument = node.type === 'ImportExpression' ? node.source
          : node.type === 'CallExpression' && node.callee.type === 'Import' ? node.arguments[0] : null;
        if (argument && isRawPath(argument)) violations.push(`${path.relative(ROOT, file)}:${node.loc.start.line}`);
      });
    }
    expect(violations, 'absolute file imports must use pathToFileURL(p).href').toEqual([]);
  });
});
