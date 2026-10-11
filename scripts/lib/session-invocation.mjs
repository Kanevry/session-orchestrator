/**
 * Resolve the leading /session mode independently of the user's task context.
 * This is a text boundary, not a shell/option parser: quotes and command syntax
 * in the context remain data. `unknown` is a ledger value, never a live mode.
 *
 * A bare `/session` defaults to `deep`. In a repo without any session history
 * of its own that default is not silent: the result carries
 * `defaultReason: 'no-session-history'`, and the caller asks for task and mode
 * first (#1561). `hasHistory` left undefined means "not measured" and keeps
 * the plain default.
 *
 * @param {string} [argumentsText] Complete text following /session.
 * @param {{hasHistory?: boolean}} [options]
 * @returns {{sessionType: string, context: string, profile?: string, invalidMode?: string, defaultReason?: string}}
 */
export function resolveSessionInvocation(argumentsText = '', { hasHistory } = {}) {
  if (typeof argumentsText !== 'string') {
    throw new TypeError('session invocation arguments must be a string');
  }
  const [_, mode, context = ''] = argumentsText.trimStart().match(/^(\S+)(?:\s+([\s\S]*))?$/u) ?? [];
  if (mode === undefined) {
    return hasHistory === false
      ? { sessionType: 'deep', context: '', defaultReason: 'no-session-history' }
      : { sessionType: 'deep', context: '' };
  }
  if (mode === 'ultradeep') return { sessionType: 'deep', profile: 'ultradeep', context };
  if (['housekeeping', 'feature', 'deep'].includes(mode)) {
    return { sessionType: mode, context };
  }
  return { sessionType: 'deep', context, invalidMode: mode };
}
