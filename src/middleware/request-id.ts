import type { MiddlewareHandler } from "hono";

/**
 * Request ID middleware for distributed tracing.
 *
 * Forwards existing `X-Request-Id` header (from load balancers, API gateways)
 * or generates a new one. The ID is included in every response, making it
 * easy to trace a request through logs, error reports, and monitoring.
 *
 * ENTERPRISE USE CASE:
 * - User reports "I got an error" → ask for the X-Request-Id
 * - Search Vercel Logs for that ID → find the exact error + stack trace
 * - No guesswork, no timestamp-based log hunting
 */
export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const id = c.req.header("X-Request-Id") ?? crypto.randomUUID();

    c.set("requestId", id);
    c.header("X-Request-Id", id);

    await next();
  };
}
