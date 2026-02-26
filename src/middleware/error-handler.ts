import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * API Error class for controlled error responses.
 *
 * Throw this in route handlers to return a specific HTTP status and error code:
 *   throw new ApiError(404, "Task not found", "TASK_NOT_FOUND");
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: string = "INTERNAL_ERROR"
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Global error handler.
 *
 * ENTERPRISE REQUIREMENTS:
 * - Consistent error shape across ALL endpoints
 * - Never leak stack traces or internal details to clients
 * - Log errors server-side (console.error goes to Vercel Logs)
 * - Map known errors to proper HTTP status codes
 * - Catch-all for unexpected errors → 500
 *
 * FLUID COMPUTE NOTE:
 * Unhandled errors in one request won't crash other concurrent requests
 * on the same instance. Fluid Compute provides error isolation automatically.
 * But we still catch errors here for consistent API responses.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  // Log the full error for debugging (visible in Vercel Logs dashboard)
  console.error(`[ERROR] ${err.message}`, {
    path: c.req.path,
    method: c.req.method,
    ...(err instanceof ApiError ? { code: err.code } : { stack: err.stack })
  });

  // Known API errors — return the specified status and code
  if (err instanceof ApiError) {
    return c.json(
      {
        success: false,
        error: {
          message: err.message,
          code: err.code
        }
      },
      err.statusCode as ContentfulStatusCode
    );
  }

  // Unknown errors — return 500 with generic message
  return c.json(
    {
      success: false,
      error: {
        message: "Internal Server Error",
        code: "INTERNAL_ERROR"
      }
    },
    500
  );
};
