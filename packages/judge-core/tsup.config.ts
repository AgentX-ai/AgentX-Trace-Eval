import { defineConfig } from "tsup";

// Dual CJS+ESM build: AgentX-web-api is CommonJS (tsconfig.json: module: commonjs),
// AgentX-trace-eval/engine is ESM ("type": "module"): one package needs to serve both without
// either consumer needing a build-tooling change of its own.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
