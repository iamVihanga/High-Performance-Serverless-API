import { Hono } from "hono";
import { cors } from "hono/cors";
import { timing } from "./middleware/timing";
import { errorHandler } from "./middleware/error-handler";
import { requestId } from "./middleware/request-id";
import { tasksRoutes } from "./routes/tasks.routes";

/**
 * Main Hono application.
 *
 * ARCHITECTURE:
 * - Single Hono app handles ALL routes under /api/*
 * - Middleware is applied globally (runs on every request)
 * - Routes are modular — each resource is a separate Hono router
 * - The base path `/api` is set here, routes define their own sub-paths
 *
 * VERCEL INTEGRATION:
 * - `export default app` is all Vercel needs — it auto-detects Hono
 * - Routes become Vercel Functions with Fluid Compute automatically
 * - No adapter (`handle()`), no runtime config, no rewrites required
 */
const app = new Hono().basePath("/api");

// ─── Global Middleware ──────────────────────────────────────
// Order matters: timing wraps everything, CORS runs early, errors catch everything

app.use("*", timing());
app.use("*", requestId());
app.use(
  "*",
  cors({
    origin: "*", // Lock this down in production
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["X-Request-Id", "Server-Timing", "X-Response-Time"],
    maxAge: 86400, // Cache preflight for 24 hours
    credentials: true // Required for Better Auth cookies (Phase 10)
  })
);

// ─── Health Check ───────────────────────────────────────────
app.get("/health", (c) => {
  return c.json({
    success: true,
    data: {
      status: "healthy",
      timestamp: new Date().toISOString(),
      runtime: "nodejs-fluid"
    }
  });
});

// ─── Route Mounting ─────────────────────────────────────────
app.route("/tasks", tasksRoutes);

// ─── Global Error Handler ───────────────────────────────────
app.onError(errorHandler);

// ─── 404 Handler ────────────────────────────────────────────
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: {
        message: "Not Found",
        code: "NOT_FOUND"
      }
    },
    404
  );
});

// ─── Vercel Export ──────────────────────────────────────────
// Vercel auto-detects this default export and creates a Fluid Compute function.
// No adapter, no handle(), no runtime config needed.
export default app;
