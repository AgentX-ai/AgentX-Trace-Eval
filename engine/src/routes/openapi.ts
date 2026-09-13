import { Router, type Request, type Response } from "express";
import { zodToJsonSchema } from "zod-to-json-schema";
import { WIRE_CONTRACT } from "../contract/wire.js";

// GET /api/v1/openapi.json - the published half of the wire contract (src/contract/wire.ts).
// Consumers: AgentX-web-front can generate its response types from this instead of hand-copying
// engine shapes, and the Python SDK's CI can diff its models against it. Built lazily once per
// process; the schemas are static.
let cached: object | null = null;

type RequestSurface = {
  parameters?: Array<Record<string, unknown>>;
  requestBody?: Record<string, unknown>;
};

const jsonBody = (schema: Record<string, unknown>, required = true) => ({
  required,
  content: { "application/json": { schema } },
});
const q = (name: string, description: string, schema: Record<string, unknown> = { type: "string" }) => ({
  name,
  in: "query",
  required: false,
  description,
  schema,
});

// Hand-maintained request-side surfaces for the endpoints a generated client reaches first.
// The zod registry drives RESPONSES; these fill the request half where its absence turned
// into a guaranteed 400 on the client's first call.
const REQUEST_SURFACES: Record<string, RequestSurface> = {
  "post /insights/probe": {
    requestBody: jsonBody({
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        window: { type: "string", enum: ["24h", "7d", "30d"] },
        datasetIds: { type: "array", items: { type: "string" } },
        datasetId: { type: "string" },
      },
    }),
  },
  "post /insights/probe/batch": {
    requestBody: jsonBody({
      type: "object",
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string" } },
        window: { type: "string", enum: ["24h", "7d", "30d"] },
        datasetIds: { type: "array", items: { type: "string" } },
      },
    }),
  },
  "post /insights/topics/curate": {
    requestBody: jsonBody({
      type: "object",
      required: ["topic"],
      properties: {
        topic: { type: "string" },
        datasetId: { type: "string" },
        window: { type: "string", enum: ["24h", "7d", "30d"] },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
    }),
  },
  "post /agent-monitoring/session-sweep/run": {
    requestBody: jsonBody({ type: "object", properties: {} }, false),
  },
  "get /ingest/traces": {
    parameters: [
      q("limit", "Page size (max 200)", { type: "integer" }),
      q("cursor", "Opaque cursor from the previous page"),
      q("search", "Database-side LIKE across name/input/output/model/error/ids"),
      q("framework", "Comma-separated framework keys"),
      q("source", "production | eval | all"),
    ],
  },
  "get /agent-monitoring/metrics": {
    parameters: [
      q("window", "24h | 7d | 30d", { type: "string", enum: ["24h", "7d", "30d"] }),
      q("from", "Custom range start, epoch ms (with to)"),
      q("to", "Custom range end, epoch ms"),
      q("agentId", "Filter to one agent"),
      q("model", "Filter to one model"),
      q("framework", "Filter to one framework"),
    ],
  },
};

function buildDocument(): object {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  for (const entry of WIRE_CONTRACT) {
    schemas[entry.name] = zodToJsonSchema(entry.response, { target: "openApi3" });
    // OpenAPI templating, not Express syntax: ":id" is a literal path segment to every
    // generator, which turns the stated consumers' clients into guaranteed 404s.
    const oasPath = entry.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const params = [...entry.path.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    paths[`/api/v1${oasPath}`] = {
      ...(paths[`/api/v1${oasPath}`] ?? {}),
      [entry.method]: {
        summary: entry.summary,
        ...(params.length > 0 ? { parameters: params } : {}),
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: `#/components/schemas/${entry.name}` } } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "AgentX self-host engine",
      description:
        "The dashboard wire surfaces under contract so far - coverage grows with src/contract/wire.ts.",
      version: process.env.npm_package_version ?? "0.0.0",
    },
    paths,
    // Every published path sits behind the project API key (apiV1.ts) - without the scheme, a
    // generated client sends no x-api-key and every call 401s on its first run.
    components: { schemas, securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } } },
    security: [{ apiKey: [] }],
  };
}

export const openapiRouter = Router();
openapiRouter.get("/openapi.json", (_req: Request, res: Response) => {
  cached ??= buildDocument();
  res.status(200).json(cached);
});
