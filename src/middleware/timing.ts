// Performance Monitoring Middleware
import type { MiddlewareHandler } from "hono";

/**
 * Server-Timing middleware.
 *
 * Adds a `Server-Timing` header to every response with the total
 * processing time in milliseconds.
 *
 * WHY THIS MATTERS:
 * - Visible in browser DevTools → Network tab → Timing section
 * - Can be collected by monitoring tools (Datadog, New Relic, etc.)
 * - Helps identify slow endpoints without adding logging overhead
 * - Standard HTTP header (W3C Server-Timing specification)
 *
 * Example response header:
 *   Server-Timing: total;dur=12.5
 *
 * This means the entire request (routing + middleware + DB query + serialization)
 * took 12.5 milliseconds.
 */
export function timing(): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();

    await next();

    const duration = (performance.now() - start).toFixed(2);
    c.header("Server-Timing", `total;dur=${duration}`);
    c.header("X-Response-Time", `${duration}ms`);
  };
}
