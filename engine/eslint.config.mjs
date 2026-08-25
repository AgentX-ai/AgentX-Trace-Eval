import tseslint from "typescript-eslint";

// Deliberately narrow: tsc --strict already covers types/unused symbols, so this config only
// enforces what the compiler cannot - async discipline. The engine leans on fire-and-forget
// monitoring calls (ingest kicks off runMonitorCheck/runOnlineEvaluators/runClassification
// without awaiting); no-floating-promises turns the "callers MUST try/catch or void this"
// code-comment convention into a build failure: intentional fire-and-forget must say `void`,
// and a forgotten await on anything else fails CI instead of silently racing.
export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // checksVoidReturn.arguments off: Express takes async handlers as void-returning callbacks
      // by design (router.get(path, async ...) everywhere); the other checks stay on.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      // require-await deliberately absent: interface-conforming async stubs (better-auth email
      // callbacks, express handlers) make it pure noise, and forgotten awaits are already caught
      // by no-floating-promises.
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
    },
  },
  {
    ignores: ["dist/**", "web/**", "drizzle/**"],
  }
);
