/**
 * label-scope.mjs — scope-tolerant label comparison.
 *
 * The canonical priority-label spelling is the GitLab SCOPED form
 * `priority::<level>`. Producers were migrated to it because the instance had
 * drifted to 416 scoped / 249 unscoped / 7 bare labels, and a data migration
 * that is not preceded by a producer migration is undone within a day.
 *
 * The DATA migration is a separate, later step, so for now both spellings
 * coexist on real issues. Every consumer that MATCHES a label therefore
 * compares through `normalizeLabel()`, which collapses the scope separator:
 * `priority::high` and `priority:high` are the same label for matching
 * purposes, while the emitted/default spelling stays canonical.
 *
 * Deliberately NOT applied to label WRITES — those always emit the canonical
 * scoped form.
 *
 * Stdlib-free leaf module.
 */

/**
 * Collapse a scoped label's double colon to a single colon and lowercase it,
 * yielding a comparison key that is identical for `key::value` and `key:value`.
 *
 * @param {unknown} label
 * @returns {string} normalized comparison key ('' for non-strings)
 */
export function normalizeLabel(label) {
  if (typeof label !== 'string') return '';
  return label.trim().toLowerCase().replace(/::/g, ':');
}

/**
 * Build a Set of normalized comparison keys from a label list.
 *
 * @param {unknown} labels
 * @returns {Set<string>}
 */
export function normalizedLabelSet(labels) {
  const set = new Set();
  if (!Array.isArray(labels)) return set;
  for (const l of labels) {
    const key = normalizeLabel(l);
    if (key) set.add(key);
  }
  return set;
}
