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
