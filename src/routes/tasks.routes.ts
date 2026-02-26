import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { db } from "../db";
import { tasks } from "../db/schemas";
import { ApiError } from "../middleware/error-handler";

// ─── Validation Schemas ─────────────────────────────────────

/**
 * Zod schemas validate request bodies BEFORE hitting the database.
 * This saves a wasted DB round-trip on invalid data and provides
 * clear, structured error messages to the client.
 */
const createTaskSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(256, "Title must be 256 characters or less"),
  description: z.string().nullable().optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional().default("todo"),
  priority: z.enum(["low", "medium", "high"]).optional().default("medium")
});

const updateTaskSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(256, "Title must be 256 characters or less")
    .optional(),
  description: z.string().nullable().optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional()
});

const querySchema = z.object({
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0)
});

// ─── Route Handlers ─────────────────────────────────────────

export const tasksRoutes = new Hono()

  // ── GET /api/tasks — List tasks with optional filters ──
  .get("/", zValidator("query", querySchema), async (c) => {
    const { status, priority, limit, offset } = c.req.valid("query");

    // Build query dynamically based on filters
    let query = db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        priority: tasks.priority,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt
      })
      .from(tasks);

    // Apply filters using Drizzle's type-safe where clauses
    const conditions = [];
    if (status) conditions.push(eq(tasks.status, status));
    if (priority) conditions.push(eq(tasks.priority, priority));

    const filteredQuery =
      conditions.length > 0
        ? query.where(
            conditions.length === 1 ? conditions[0] : and(...conditions)
          )
        : query;

    const result = await filteredQuery.limit(limit).offset(offset);

    return c.json({
      success: true,
      data: result,
      meta: {
        limit,
        offset,
        count: result.length
      }
    });
  })

  // ── GET /api/tasks/:id — Get a single task ──
  .get("/:id", async (c) => {
    const id = c.req.param("id");

    // UUID validation
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new ApiError(400, "Invalid task ID format", "INVALID_ID");
    }

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);

    if (!task) {
      throw new ApiError(404, "Task not found", "TASK_NOT_FOUND");
    }

    return c.json({
      success: true,
      data: task
    });
  })

  // ── POST /api/tasks — Create a new task ──
  .post("/", zValidator("json", createTaskSchema), async (c) => {
    const body = c.req.valid("json");

    /**
     * `.returning()` is a PERFORMANCE PATTERN:
     * It returns the inserted row in the same query — no need for
     * a second SELECT. One DB round-trip instead of two.
     *
     * SQL generated: INSERT INTO tasks (...) VALUES (...) RETURNING *
     */
    const [task] = await db.insert(tasks).values(body).returning();

    return c.json(
      {
        success: true,
        data: task
      },
      201
    );
  })

  // ── PUT /api/tasks/:id — Update a task ──
  .put("/:id", zValidator("json", updateTaskSchema), async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");

    // Check if there's anything to update
    if (Object.keys(body).length === 0) {
      throw new ApiError(400, "No fields to update", "EMPTY_UPDATE");
    }

    /**
     * `.where().returning()` — Update + return in one query.
     * Drizzle's `$onUpdate` on `updatedAt` automatically sets
     * the timestamp without us explicitly including it.
     */
    const [task] = await db
      .update(tasks)
      .set({
        ...body,
        updatedAt: new Date()
      })
      .where(eq(tasks.id, id))
      .returning();

    if (!task) {
      throw new ApiError(404, "Task not found", "TASK_NOT_FOUND");
    }

    return c.json({
      success: true,
      data: task
    });
  })

  // ── DELETE /api/tasks/:id — Delete a task ──
  .delete("/:id", async (c) => {
    const id = c.req.param("id");

    /**
     * `.returning()` confirms the deletion — if the array is empty,
     * the task didn't exist. One query, no extra SELECT needed.
     */
    const [task] = await db.delete(tasks).where(eq(tasks.id, id)).returning();

    if (!task) {
      throw new ApiError(404, "Task not found", "TASK_NOT_FOUND");
    }

    return c.json({
      success: true,
      data: task
    });
  });
