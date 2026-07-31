import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AGENTX_HOME } from "../storage/db.js";

const CONFIG_PATH = path.join(AGENTX_HOME, "config.json");

type LocalConfig = { apiKey: string };

// Self-host has no workspace/user/ACL model (see plan's "Auth" decision): one instance, one
// implicit tenant, one API key. Generated once on first boot and reused after that, instead of
// the hosted SaaS's authenticateUser/authenticateApiKey session+workspace-membership machinery.
export function ensureLocalApiKey(): string {
  fs.mkdirSync(AGENTX_HOME, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as LocalConfig;
    if (existing.apiKey) {
      return existing.apiKey;
    }
  }
  const apiKey = `agtx_local_${randomBytes(24).toString("hex")}`;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ apiKey } satisfies LocalConfig, null, 2));
  return apiKey;
}

export function requireApiKey(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.header("x-api-key");
    if (provided !== apiKey) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }
    next();
  };
}
