import { it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

it('hook closure forbids fetch: forced exit crashes Windows async handles (#1612)', () => {
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(readFileSync(resolve(root, 'hooks/_lib/hook-import-set.json'), 'utf8'));
  const files = new Set([
    ...manifest.entries.map(entry => entry.file),
    ...readdirSync(resolve(root, 'hooks')).filter(file => file.endsWith('.mjs')).map(file => `hooks/${file}`),
  ]);
  const hits = [];
  function visit(node, file) {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
        node.callee?.type === 'Identifier' && node.callee.name === 'fetch') {
      hits.push(`${file}:${node.loc.start.line}`);
    }
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
        node.object?.name === 'globalThis' &&
        (node.computed ? node.property.value === 'fetch' : node.property.name === 'fetch')) {
      hits.push(`${file}:${node.loc.start.line}`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['comments', 'leadingComments', 'trailingComments', 'innerComments', 'loc', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, file));
      else if (value && typeof value === 'object') visit(value, file);
    }
  }
  for (const file of files) visit(parse(readFileSync(resolve(root, file), 'utf8'), { sourceType: 'module' }), file);
  expect(hits).toEqual([]);
});
