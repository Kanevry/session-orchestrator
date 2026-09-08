#!/usr/bin/env node
// Repository CI only: requires the checkout's Vitest config and dev dependencies.
// Test-result JSON does not prove coverage. Check the structured coverage summary
// against the same global percentage thresholds Vitest uses before writing a marker.
// The caller removes both reports and the marker before starting the current run.

import { readFileSync } from 'node:fs';
import config from '../../vitest.config.mjs';

const metrics = ['lines', 'functions', 'statements', 'branches'];
const [summaryPath = 'coverage/coverage-summary.json', xmlPath = 'coverage/cobertura-coverage.xml'] = process.argv.slice(2);

function requireValid(condition, reason) {
  if (!condition) throw new Error(reason);
}

// Check completeness of the XML emitted by the configured Istanbul reporter.
// This is an artifact check, not a DTD/schema evaluator; never fetch the DOCTYPE.
function checkCobertura(xml, total) {
  const stack = [];
  let root;
  let hasClassLine = false;
  const parts = xml.match(/<[^>]*>|[^<]+/g) ?? [];
  requireValid(parts.join('') === xml, 'malformed Cobertura artifact');
  for (const part of parts) {
    if (/^<\?xml\s[^<>]*\?>$|^<!DOCTYPE coverage SYSTEM "[^"<>]*">$/.test(part)) {
      requireValid(!root, 'unexpected Cobertura declaration');
      continue;
    }
    if (!part.startsWith('<')) {
      requireValid(!part.trim() || stack.at(-1) === 'source', 'unexpected Cobertura content');
      continue;
    }
    const tag = part.match(/^<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>$/);
    requireValid(tag, 'malformed Cobertura tag');
    const [, closing, name, attributes, selfClosing] = tag;
    if (closing) {
      requireValid(!attributes && !selfClosing && stack.pop() === name, 'unbalanced Cobertura tags');
    } else {
      const entries = [...attributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]);
      requireValid(new Set(entries.map(([key]) => key)).size === entries.length, 'duplicate Cobertura attributes');
      const values = Object.fromEntries(entries);
      if (stack.length === 0) {
        requireValid(!root && name === 'coverage' && !selfClosing, 'invalid Cobertura root');
        root = values;
      }
      const path = [...stack, name].join('/');
      if (path === 'coverage/packages/package/classes/class') {
        requireValid(typeof values.filename === 'string' && values.filename.trim(), 'Cobertura class is missing a filename');
      }
      if (path === 'coverage/packages/package/classes/class/lines/line') {
        requireValid(/^\d+$/.test(values.number) && Number(values.number) > 0
          && /^\d+$/.test(values.hits), 'invalid Cobertura line record');
        hasClassLine = true;
      }
      if (!selfClosing) stack.push(name);
    }
  }
  requireValid(root && stack.length === 0, 'empty or incomplete Cobertura artifact');
  requireValid(total.lines.total === 0 || hasClassLine, 'Cobertura artifact contains no class line records');
  for (const [attribute, expected] of Object.entries({
    'lines-valid': total.lines.total,
    'lines-covered': total.lines.covered,
    'line-rate': total.lines.pct / 100,
    'branches-valid': total.branches.total,
    'branches-covered': total.branches.covered,
    'branch-rate': total.branches.pct / 100,
  })) {
    requireValid(root[attribute] !== undefined && root[attribute] !== ''
      && Number(root[attribute]) === expected, `Cobertura ${attribute} disagrees with coverage summary`);
  }
}

try {
  const thresholds = config.test?.coverage?.thresholds;
  requireValid(thresholds && Object.keys(thresholds).every((key) => metrics.includes(key)),
    'unsupported coverage thresholds: expected global percentage thresholds');
  const { total } = JSON.parse(readFileSync(summaryPath, 'utf8'));
  requireValid(total && typeof total === 'object', 'missing coverage totals');
  for (const metric of metrics) {
    const threshold = thresholds[metric];
    requireValid(Number.isFinite(threshold) && threshold >= 0 && threshold <= 100,
      `missing or invalid configured ${metric} threshold`);
    const data = total[metric];
    requireValid(data && ['total', 'covered', 'skipped'].every((key) => Number.isSafeInteger(data[key]) && data[key] >= 0)
      && data.total > 0 && data.covered <= data.total && data.skipped <= data.total
      && Number.isFinite(data.pct) && data.pct >= 0 && data.pct <= 100,
    `missing or invalid ${metric} coverage data`);
    // Istanbul truncates percentages to two decimals; compare the reported
    // percentage (Vitest's threshold input) only after checking its counters.
    const percentage = Math.floor((100000 * data.covered / data.total) / 10) / 100;
    requireValid(data.pct === percentage, `inconsistent ${metric} coverage percentage`);
    requireValid(data.pct >= threshold, `${metric} coverage ${data.pct}% is below configured ${threshold}%`);
  }
  checkCobertura(readFileSync(xmlPath, 'utf8'), total);
  console.log(`[ci] coverage verified: ${metrics.map((metric) => `${metric}=${total[metric].pct}%`).join(' ')}`);
} catch (error) {
  console.error(`[ci] coverage NOT VERIFIED: ${error.message}`);
  process.exitCode = 1;
}
