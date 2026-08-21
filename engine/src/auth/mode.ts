// Auth/tenancy mode flags, in their own dependency-free module so deep call sites (judge key
// resolution, app settings) can read them without importing better-auth's module graph.

export type AuthMode = "disabled" | "enabled";

export function authMode(): AuthMode {
  return process.env.AGENTX_AUTH === "enabled" ? "enabled" : "disabled";
}

// Cloud tenancy switch: with AGENTX_AUTH=enabled, AGENTX_MULTI_TENANT=true changes the tenancy
// model from "one shared org, first user claims the instance" (a self-host team) to "every
// signup gets its own organization + default project" (the eval.agentx.so SaaS posture).
// It also hard-isolates per-org state: LLM provider keys come only from the org's own settings
// (never the process env - one tenant's spend must not ride another's key), and the pricing
// catalog's global rows become read-only defaults next to per-org additions.
export function isMultiTenant(): boolean {
  return authMode() === "enabled" && process.env.AGENTX_MULTI_TENANT === "true";
}
