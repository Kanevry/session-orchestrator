import { it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// TV-005: direct imports bypass the Windows process boundary configuration.
it('routes every product zx import through scripts/lib/zx.mjs', () => {
  const root = resolve(import.meta.dirname, '../..');
  const hits = [];
  function visit(node, file) {
    if (!node || typeof node !== 'object') return;
    const staticImport = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type);
    const dynamicImport = node.type === 'CallExpression' && node.callee?.type === 'Import';
    const source = staticImport ? node.source : dynamicImport ? node.arguments[0] : node.type === 'ImportExpression' ? node.source : null;
    if (source?.value === 'zx') hits.push(`${file}:${node.loc.start.line}`);
    for (const [key, value] of Object.entries(node)) {
      if (['comments', 'leadingComments', 'trailingComments', 'innerComments', 'loc', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, file));
      else if (value && typeof value === 'object') visit(value, file);
    }
  }
  function scan(dir) {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) scan(file);
      else if (/\.(?:[cm]?js|[cm]?ts)$/.test(entry.name) && file !== 'scripts/lib/zx.mjs') {
        const ast = parse(readFileSync(resolve(root, file), 'utf8'), {
          sourceType: 'unambiguous', plugins: /\.[cm]?ts$/.test(file) ? ['typescript'] : [],
        });
        visit(ast, file);
      }
    }
  }
  ['scripts', 'hooks', 'skills'].forEach(scan);
  expect(hits).toEqual([]);
});
