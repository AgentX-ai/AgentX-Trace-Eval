import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time string comparison via hashing (length-safe): secrets must not leak through
 *  early-exit comparison timing, however marginal the network signal. */
export function secretEquals(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
