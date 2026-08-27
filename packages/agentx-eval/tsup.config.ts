import { defineConfig } from "tsup";

// Dual CJS+ESM build, same pattern as packages/judge-core: one package serves both
// CommonJS and ESM consumers without either needing a build-tooling change of its own.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  sourcemap: true,
  clean: true,
});
