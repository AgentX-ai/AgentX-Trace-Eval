import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

// Route-level body validation: one zod schema per route instead of scattered `typeof` checks.
// The ad-hoc checks had a worse failure mode than rejection - a mistyped field was silently
// IGNORED (the same silent-no-op class as the removed placebo knobs: the caller believes a
// setting was applied while nothing changed). A schema failure is a 400 naming every bad field;
// unknown keys should be stripped by the schema (`.strip()`), not rejected, so legacy clients
// sending retired fields keep working. On success req.body is replaced with the parsed (typed,
// stripped, defaulted) value.
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`);
      res.status(400).json({ error: details[0], details });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
