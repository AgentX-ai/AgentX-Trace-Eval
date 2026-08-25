import pino from "pino";

// The engine's one logger: structured JSON lines on stdout, level from AGENTX_LOG_LEVEL
// (default info). Deliberately no pino transport (pino-pretty etc.) - transports spawn worker
// threads, which the bun-compiled single binary must not depend on; pipe through `pino-pretty`
// manually in dev if you want colors: `yarn dev | npx pino-pretty`.
//
// Conventions:
// - logger.error({ err }, "what failed") - the error goes in the `err` key (pino serializes
//   message/stack), the message says what operation failed, not what the error said.
// - Request-scoped fields (reqId, projectId) come from the request middleware in index.ts;
//   core modules just use this module-level logger - their callers' request log line carries
//   the correlation id for the same time window.
export const logger = pino({
  level: process.env.AGENTX_LOG_LEVEL ?? "info",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
