import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractCandidates } from '../../scripts/lib/validate/check-doc-cli-commands.mjs';

const REPO_ROOT = process.cwd();
const OWNER_FILES = ['skills/gitlab-ops/SKILL.md', 'skills/plan/mode-new.md'];
const documents = OWNER_FILES.map((file) => ({
  file,
  body: readFileSync(join(REPO_ROOT, file), 'utf8'),
}));
const shellCommands = documents.flatMap(({ file, body }) =>
  extractCandidates(body).map(({ text }) => ({ file, text: text.replaceAll(/\s+/g, ' ').trim() })),
);
const glabApiCommands = shellCommands.filter(({ text }) => /\bglab api\b\s+\S/.test(text));
const projectApiCommands = glabApiCommands.filter(({ text }) => text.includes('projects/'));
const groupProjectApiEndpoints = glabApiCommands
  .map(({ text }) => text.match(/groups\/[^/\s"']+\/projects\?[^\s"']*/)?.[0])
  .filter((endpoint) => endpoint !== undefined);
const groupProjectEndpointsWithoutSimple = groupProjectApiEndpoints.filter((endpoint) => {
  const query = endpoint.slice(endpoint.indexOf('?') + 1);
  return new URLSearchParams(query).get('simple') !== 'true';
});
const mutatingProjectCommands = projectApiCommands.filter(({ text }) =>
  /(?:-X|--method)\s+(?:POST|PUT|PATCH|DELETE)\b/.test(text),
);
const requiredProjectOperationPatterns = [
  /projects\/\$\{ENCODED_PROJECT_PATH\}\/issues(?:[/?"]|$)/,
  /projects\/\$\{ENCODED_PROJECT_PATH\}\/milestones(?:[/?"]|$)/,
  /projects\/\$\{ENCODED_PROJECT_PATH\}\/issues\/[^\s]+\/links(?:[/?"]|$)/,
  /projects\/\$\{ENCODED_PROJECT_PATH\}\/protected_branches(?:[/?"]|$)/,
];
const legacyProjectIdentityCommands = shellCommands.filter(({ text }) =>
  /glab repo view\b.*--output json|projects\/:id\b|target_project_id=:id|projects\?search=|projects\/\d+(?:\b|\/)/.test(text),
);
const unpinnedGlabApiCommands = glabApiCommands.filter(
  ({ text }) => !/--hostname(?:=|\s+)"?\$GITLAB_HOST"?\b/.test(text),
);
function isFullProjectRestGet(text) {
  return (
    !/(?:-X|--method)\s+(?:POST|PUT|PATCH|DELETE)\b/.test(text) &&
    /projects\/\$\{ENCODED_PROJECT_PATH\}(?=["'\s?;|&)]|$)/.test(text)
  );
}

const fullProjectRestGets = projectApiCommands.filter(({ text }) => isFullProjectRestGet(text));
const visibilityQueries = glabApiCommands.filter(({ text }) =>
  /\bgraphql\b/.test(text) && /project\s*\(/.test(text) && /\{\s*visibility\s*\}/.test(text),
);
const ownerFilesWithCanonicalIdentity = documents
  .filter(
    ({ body }) =>
      /^GITLAB_HOST=/m.test(body) &&
      /^PROJECT_PATH="\$GROUP_PATH\/\$PROJECT_NAME"$/m.test(body) &&
      /^ENCODED_PROJECT_PATH=.*encodeURIComponent\(process\.argv\[1\]\).*"\$PROJECT_PATH"/m.test(body) &&
      !/encodeURIComponent\(encodeURIComponent\(/.test(body),
  )
  .map(({ file }) => file);
const requiredProjectOperationsPresent = requiredProjectOperationPatterns.map((pattern) =>
  projectApiCommands.some(({ text }) => pattern.test(text)),
);
const unsilencedProjectMutations = mutatingProjectCommands.filter(({ text }) => !/--silent\b/.test(text));
const unencodedLinkTargets = projectApiCommands.filter(({ text }) =>
  text.includes('/links') && !/target_project_id(?:=|\s+)"?\$\{?\w*ENCODED_PROJECT_PATH\}?"?/.test(text),
);

/**
 * #1065 regression: an API recipe that derives a numeric project ID or uses
 * `:id` is resolved from the ambient repository after project creation. That
 * can silently mutate a different project. These static checks parse only
 * executable shell candidates in the two recipe owners, not prose sentences.
 */
describe('#1065 GitLab project identity contract', () => {
  it('rejects implicit or numeric project recipes and requires host-pinned encoded endpoints', () => {
    expect(legacyProjectIdentityCommands).toEqual([]);
    expect(ownerFilesWithCanonicalIdentity).toEqual(OWNER_FILES);
    expect(unpinnedGlabApiCommands).toEqual([]);
    expect(groupProjectApiEndpoints).not.toEqual([]);
    expect(groupProjectEndpointsWithoutSimple).toEqual([]);
    expect(requiredProjectOperationsPresent).toEqual([true, true, true, true]);
    expect(unsilencedProjectMutations).toEqual([]);
    expect(unencodedLinkTargets).toEqual([]);
    expect(fullProjectRestGets).toEqual([]);
    expect(visibilityQueries).toHaveLength(1);
  });

  it('detects a full project REST read even when a formatter flag follows its endpoint', () => {
    const detailRead =
      'glab api --hostname "$GITLAB_HOST" "projects/${ENCODED_PROJECT_PATH}" --jq .visibility';

    expect(isFullProjectRestGet(detailRead)).toBe(true);
  });
});
