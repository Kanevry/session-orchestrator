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
      // #1234 — removed/deprecated import surfaces. Static imports only; the
      // shim's own test imports it dynamically in a child process on purpose.
      "no-restricted-imports": ["error", {
        patterns: [
          {
            regex: "(^|/)locks/index\\.mjs$",
            message:
              "locks/index.mjs is deprecated since 5.2.0 (removed in 6.0.0) — import from " +
              "scripts/lib/locks/state-md-lock.mjs / staging-fence-lock.mjs, or scripts/lib/session-lock.mjs.",
          },
          {
            regex: "(^|/)owner-yaml\\.mjs$",
            importNames: ["OWNER_YAML_PATH"],
            message: "OWNER_YAML_PATH was deleted — use resolveOwnerYamlPath().",
          },
        ],
      }],
    },
    files: ["**/*.mjs", "**/*.js"],
  },
  {
    // Browser-side site scripts: the page's own globals, not Node's. The
    // vendored three.js build is third-party minified code and is ignored below.
    files: ["site/assets/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly", document: "readonly", navigator: "readonly",
        getComputedStyle: "readonly", matchMedia: "readonly", devicePixelRatio: "readonly",
        requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly",
        ResizeObserver: "readonly", IntersectionObserver: "readonly", CustomEvent: "readonly",
        HTMLElement: "readonly", performance: "readonly",
      },
    },
  },
  {
    ignores: [
      "node_modules/**",
      "site/vendor/**",
      ".orchestrator/**",
      ".claude/**",
      ".codex/**",
      ".cursor/**",
      "docs/**",
      "templates/**",
      "tests/**/*.fixture.*",
    ],
  },
];
