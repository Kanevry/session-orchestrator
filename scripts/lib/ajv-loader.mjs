/**
 * ajv-loader.mjs — shared lazy AJV 2020 instantiation (W3-Q2 fold-in, MED-004).
 *
 * Two call-sites previously duplicated the default-export shape negotiation
 * for `ajv/dist/2020.js`:
 *   - scripts/lib/agent-output-schema.mjs
 *   - scripts/lib/validate/check-agents.mjs (Check 7)
 *
 * This helper centralises the import + constructor lookup so a future AJV
 * migration only touches one file.
 *
 * Architect-review reference: .orchestrator/audits/wave-reviewer-3-architect.md (MED-004).
 */

let Ajv2020Ctor = null;

async function loadCtor() {
  if (Ajv2020Ctor === null) {
    const mod = await import('ajv/dist/2020.js');
    Ajv2020Ctor = mod.default ?? mod.Ajv2020 ?? mod;
  }
  return Ajv2020Ctor;
}

/**
 * Lazily import AJV 2020 and return a configured instance.
 *
 * @param {object} [opts] - Ajv constructor options (forwarded as-is).
 * @returns {Promise<object>} New Ajv2020 instance.
 */
export async function getAjv2020(opts = { allErrors: true, strict: false }) {
  const Ctor = await loadCtor();
  return new Ctor(opts);
}
