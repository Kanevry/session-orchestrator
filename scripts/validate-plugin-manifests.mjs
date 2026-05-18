#!/usr/bin/env node
/**
 * validate-plugin-manifests.mjs
 *
 * Purpose: replace `npm install -g ajv-cli` CI step with the project's pinned
 * AJV (ajv/dist/2020.js via scripts/lib/ajv-loader.mjs); fetch schemas from
 * schemastore at runtime; exit 0 all-valid / 1 validation failure / 2 system
 * error; stdout PASS/FAIL or --json; stderr diagnostics only.
 *
 * Usage:
 *   node scripts/validate-plugin-manifests.mjs [--json] [<pluginRoot>]
 *
 * Exit codes:
 *   0 — all manifests valid
 *   1 — one or more validation failures
 *   2 — system error (network, file I/O, AJV compile)
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { getAjv2020 } from './lib/ajv-loader.mjs';

const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const pluginRoot =
  argv.find((a) => !a.startsWith('--')) ??
  join(fileURLToPath(import.meta.url), '..', '..');

const PAIRS = [
  {
    manifest: '.claude-plugin/plugin.json',
    schemaUrl: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
    label: 'plugin-manifest',
  },
  {
    manifest: '.claude-plugin/marketplace.json',
    schemaUrl: 'https://json.schemastore.org/claude-code-marketplace.json',
    label: 'marketplace',
  },
];

/**
 * Fetch and parse a remote JSON document, following up to 5 redirects.
 *
 * @param {string} url
 * @param {number} [redirects]
 * @returns {Promise<object>}
 */
// Host-pin: only follow redirects within schemastore.org (W4-Q2 LOW SSRF hardening).
// The initial URLs in PAIRS are hardcoded schemastore.org — this guard prevents a
// compromised CDN/DNS/upstream redirect from steering us to an attacker-controlled host.
function isAllowedRedirectHost(locationUrl) {
  try {
    const host = new URL(locationUrl).hostname;
    return host === 'json.schemastore.org' || host.endsWith('.schemastore.org');
  } catch {
    return false;
  }
}

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects >= 5) {
            return reject(new Error(`Too many redirects fetching ${url}`));
          }
          if (!isAllowedRedirectHost(res.headers.location)) {
            return reject(new Error(`Redirect off-host blocked: ${res.headers.location}`));
          }
          return resolve(fetchJson(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`JSON parse error from ${url}: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

// ONE shared AJV instance.
// validateSchema:false is REQUIRED — schemastore schemas are draft-07; Ajv2020
// would otherwise reject them. strict:false matches former ajv-cli --strict=false
// (format:uri keywords are silently ignored).
const ajv = await getAjv2020({ allErrors: true, strict: false, validateSchema: false });

const results = [];

for (const { manifest, schemaUrl, label } of PAIRS) {
  const manifestPath = join(pluginRoot, manifest);

  if (!existsSync(manifestPath)) {
    results.push({ label, manifest, ok: false, error: `File not found: ${manifestPath}` });
    continue;
  }

  let data;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    results.push({ label, manifest, ok: false, error: `Manifest parse error: ${err.message}` });
    continue;
  }

  let schema;
  try {
    schema = await fetchJson(schemaUrl);
  } catch (err) {
    process.stderr.write(`[validate-plugin-manifests] Network error fetching schema for ${label}: ${err.message}\n`);
    process.exit(2);
  }

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    process.stderr.write(`[validate-plugin-manifests] AJV compile error for ${label}: ${err.message}\n`);
    process.exit(2);
  }

  const valid = validate(data);
  results.push({
    label,
    manifest,
    ok: valid,
    errors: valid ? undefined : validate.errors,
  });
}

if (jsonMode) {
  process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
} else {
  for (const result of results) {
    if (result.ok) {
      process.stdout.write(`  PASS: ${result.manifest} validates against schemastore (${result.label})\n`);
    } else if (result.errors) {
      process.stdout.write(`  FAIL: ${result.manifest} — schema violations:\n`);
      for (const err of result.errors) {
        const path = err.instancePath || '(root)';
        process.stdout.write(`    ${path}: ${err.message}\n`);
      }
    } else {
      process.stdout.write(`  FAIL: ${result.manifest} — ${result.error}\n`);
    }
  }
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
