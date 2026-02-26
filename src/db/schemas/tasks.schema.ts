import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  pgEnum,
  index
} from "drizzle-orm/pg-core";

/**
 * Task status enum — stored as a PostgreSQL enum type for:
 * - Type safety at the database level (rejects invalid values)
 * - Storage efficiency (1-2 bytes vs variable-length string)
 * - Query performance (enum comparison is faster than string comparison)
 */
export const taskStatusEnum = pgEnum("task_status", [
  "todo",
  "in_progress",
  "done"
]);

/**
 * Task priority enum
 */
export const taskPriorityEnum = pgEnum("task_priority", [
  "low",
  "medium",
  "high"
]);

/**
 * Tasks table definition.
 *
 * PERFORMANCE DECISIONS:
 * - UUID v4 primary key: No sequential bottleneck (unlike auto-increment),
 *   generated server-side via `gen_random_uuid()` (no client round-trip needed)
 * - Indexes on `status` and `priority`: Common filter/sort columns need indexes
 *   to avoid full table scans as data grows
 * - `varchar(256)` for title: Bounded length prevents abuse and allows DB optimization
 * - `timestamp` for audit fields: Essential for enterprise (debugging, compliance)
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 256 }).notNull(),
    description: text("description"),
    status: taskStatusEnum("status").default("todo").notNull(),
    priority: taskPriorityEnum("priority").default("medium").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => [
    index("tasks_status_idx").on(table.status),
    index("tasks_priority_idx").on(table.priority),
    index("tasks_created_at_idx").on(table.createdAt)
  ]
);

/** TypeScript type inferred from the schema — use for SELECT results */
export type Task = typeof tasks.$inferSelect;

/** TypeScript type for INSERT operations — makes optional fields clear */
export type NewTask = typeof tasks.$inferInsert;
