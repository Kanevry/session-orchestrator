// lint-staged — runs on git-staged files via Husky pre-commit
// See https://github.com/lint-staged/lint-staged
//
// Patterns:
//   *.mjs         → ESLint --fix (and Prettier write — added once
//                   #353 ships .prettierrc; today no-op for prettier)
//   *.{md,json,yml,yaml} → Prettier write (added when #353 ships)

export default {
  '*.mjs': ['eslint --fix'],
};
