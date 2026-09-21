/**
 * Resolve the leading /session mode independently of the user's task context.
 * This is a text boundary, not a shell/option parser: quotes and command syntax
 * in the context remain data. `unknown` is a ledger value, never a live mode.
 *
 * @param {string} [argumentsText] Complete text following /session.
 * @returns {{sessionType: string, context: string, profile?: string, invalidMode?: string}}
 */
export function resolveSessionInvocation(argumentsText = '') {
  if (typeof argumentsText !== 'string') {
    throw new TypeError('session invocation arguments must be a string');
  }
  const [_, mode, context = ''] = argumentsText.trimStart().match(/^(\S+)(?:\s+([\s\S]*))?$/u) ?? [];
  if (mode === undefined) return { sessionType: 'deep', context: '' };
  if (mode === 'ultradeep') return { sessionType: 'deep', profile: 'ultradeep', context };
  if (['housekeeping', 'feature', 'deep'].includes(mode)) {
    return { sessionType: mode, context };
  }
  return { sessionType: 'deep', context, invalidMode: mode };
}
