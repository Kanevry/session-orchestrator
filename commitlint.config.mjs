// Commitlint configuration — Conventional Commits
// See https://commitlint.js.org/reference/configuration.html
//
// Allowed types match Conventional Commits + the type vocabulary
// in `.claude/rules/development.md` § Git Conventions:
//   feat / fix / docs / style / refactor / test / chore / ci / perf / security
//
// Subject: imperative mood, sentence-case, no period, max 120 chars
// (matches the rule in .claude/rules/development.md).

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'ci', 'perf', 'security'],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
