/** Format Claude JSON accounting without inventing a price or its provenance. */
import { isMainModule } from './is-main-module.mjs';
import { COST_BASIS } from './telemetry/pricing.mjs';

export const CONTEXT_OVERHEAD_HEADER =
  'LABEL\tCONTEXT_TOK\tcache_create\tcache_read\toutput\tUSD\tCOST_BASIS\n';

/**
 * @param {string} text JSON response text
 * @param {string} label measurement label
 * @returns {string} TSV row, or a recognizable parse-error row
 */
export function formatContextOverhead(text, label) {
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    return `${label}\tPARSE-ERROR\n`;
  }
  const usage = response?.usage || {};
  const context =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const cost = response?.total_cost_usd;
  const validCost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
  // Native numbers alone do not establish billing or API-list provenance.
  const basis = validCost && response.cost_basis === COST_BASIS
    ? response.cost_basis
    : 'unknown';
  return [
    label, context, usage.cache_creation_input_tokens || 0,
    usage.cache_read_input_tokens || 0, usage.output_tokens || 0,
    validCost ? cost.toFixed(4) : 'unknown', basis,
  ].join('\t') + '\n';
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--header') {
    process.stdout.write(CONTEXT_OVERHEAD_HEADER);
  } else if (args.length === 2 && args[0] === '--') {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => {
      process.stdout.write(formatContextOverhead(text, args[1]));
    });
  } else {
    process.stderr.write('Usage: context-overhead-format.mjs --header | -- <label> (JSON on stdin)\n');
    process.exitCode = 1;
  }
}
