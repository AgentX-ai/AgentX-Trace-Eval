import { defineConfig } from "vitest/config";

// Timeout floors, not per-test opinions. Almost every suite under src/test/ boots the REAL engine
// (src/test/server.ts spawns `node --import tsx src/index.ts`, which runs migrations and seeds a
// fresh database before the first request), so the work in a single `it` is seconds, not
// milliseconds. Vitest's stock 5s testTimeout / 10s hookTimeout are sized for pure unit tests and
// cannot cover that: the suite compensated by hand-writing `}, 90_000)` on ~110 individual cases,
// which works right up until one is forgotten. One was - metricPackV3's first case booted an
// engine under the 5s default and failed as a timeout, not an assertion. Under the coverage job
// the margin is thinner still, since V8 instrumentation slows the spawned engine's boot (see
// server.ts's own note about a harness artifact first seen exactly that way).
//
// Setting the defaults here makes the boot budget structural. Explicit per-test timeouts still
// win, so the longer suites (multi-boot restart/upgrade cases at 120s-240s) keep their own
// values; what changes is that omitting one now yields a sane budget instead of a flake.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
