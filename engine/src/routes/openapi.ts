import { Router, type Request, type Response } from "express";
import { zodToJsonSchema } from "zod-to-json-schema";
import { WIRE_CONTRACT } from "../contract/wire.js";

// GET /api/v1/openapi.json - the published half of the wire contract (src/contract/wire.ts).
// Consumers: AgentX-web-front can generate its response types from this instead of hand-copying
// engine shapes, and the Python SDK's CI can diff its models against it. Built lazily once per
// process; the schemas are static.
let cached: object | null = null;

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
    components: { schemas },
  };
}

export const openapiRouter = Router();
openapiRouter.get("/openapi.json", (_req: Request, res: Response) => {
  cached ??= buildDocument();
  res.status(200).json(cached);
});
