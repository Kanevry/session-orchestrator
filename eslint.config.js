import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "prefer-const": "error",
      "no-var": "error",
      "eqeqeq": ["error", "always"],
      "no-console": "off",
    },
    files: ["**/*.mjs", "**/*.js"],
  },
  {
    ignores: [
      "node_modules/**",
      ".orchestrator/**",
      ".claude/**",
      ".codex/**",
      ".cursor/**",
      "docs/**",
      "tests/**/*.fixture.*",
    ],
  },
];
