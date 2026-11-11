/**
 * yaml-has-document — js-yaml 5 guard (#2015).
 *
 * js-yaml 4 returned `undefined` for a source without a YAML document (empty,
 * whitespace-only, comments-only); js-yaml 5 throws "expected a document, but
 * the input is empty". Callers whose empty-file path means "not a mapping"
 * (not "parse error") test with this before `load()`.
 *
 * Leaf module, no imports: `owner-yaml.mjs` resolves js-yaml lazily so hooks
 * run without node_modules, and must not gain a static js-yaml edge.
 *
 * @param {string} text
 * @returns {boolean} true when every line is blank or a `#` comment
 */
export function yamlHasDocument(text) {
  return String(text)
    .split(/\r?\n/)
    .some((line) => !/^\s*(#.*)?$/.test(line));
}
