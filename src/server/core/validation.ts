import type { z } from "zod";

/** First message per top-level field, for showing next to form inputs. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

/**
 * Only same-site relative paths are allowed as a post-login destination.
 * Rejects absolute URLs, protocol-relative `//evil.com`, and `/\evil.com`,
 * which browsers treat as protocol-relative.
 */
export function safeNext(next: unknown, fallback = "/workspaces"): string {
  if (typeof next !== "string" || next.length > 500) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
