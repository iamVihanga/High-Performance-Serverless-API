# High-Performance Serverless API Tutorial

> Build an enterprise-grade serverless CRUD API targeting **sub-100ms responses** using **Vercel Edge Runtime**, **Neon PostgreSQL**, **Drizzle ORM**, and **Hono**.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Why This Stack?](#why-this-stack)
- [Phase 1: Project Foundation & Dependencies](#phase-1-project-foundation--dependencies)
- [Phase 2: Neon Database Setup](#phase-2-neon-database-setup)
- [Phase 3: Database Schema & Connection](#phase-3-database-schema--connection)
- [Phase 4: Vercel Edge Configuration](#phase-4-vercel-edge-configuration)
- [Phase 5: Middleware (Performance & Reliability)](#phase-5-middleware-performance--reliability)
- [Phase 6: Tasks CRUD Routes](#phase-6-tasks-crud-routes)
- [Phase 7: Performance Optimizations](#phase-7-performance-optimizations)
- [Phase 8: Local Development & Testing](#phase-8-local-development--testing)
- [Phase 9: Deployment](#phase-9-deployment)
- [Key Architectural Decisions](#key-architectural-decisions)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Client Request                          │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Vercel Edge Network (Global CDN)                │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │            Edge Function (V8 Isolate)                 │  │
│  │                                                       │  │
│  │  ┌─────────┐  ┌────────────┐  ┌──────────────────┐   │  │
│  │  │  Hono   │→ │ Middleware  │→ │  Route Handlers  │   │  │
│  │  │ Router  │  │  Pipeline   │  │  (Tasks CRUD)    │   │  │
│  │  └─────────┘  └────────────┘  └────────┬─────────┘   │  │
│  │                                         │             │  │
│  │                                         ▼             │  │
│  │                              ┌──────────────────┐     │  │
│  │                              │   Drizzle ORM    │     │  │
│  │                              │ (SQL Generation) │     │  │
│  │                              └────────┬─────────┘     │  │
│  └───────────────────────────────────────┼───────────────┘  │
│                                          │                  │
│                              HTTP Query (one-shot)          │
│                                          │                  │
└──────────────────────────────────────────┼──────────────────┘
                                           │
                                           ▼
                              ┌──────────────────────┐
                              │   Neon PostgreSQL    │
                              │  (Serverless HTTP)   │
                              │   Region: us-east-1  │
                              └──────────────────────┘
```

**Latency Budget Breakdown (Target: <100ms total):**

| Layer                  | Expected Latency | Notes                                   |
| ---------------------- | ---------------- | --------------------------------------- |
| Edge Function Startup  | ~0-1ms           | V8 isolate, near-zero cold start        |
| Hono Routing           | <1ms             | Trie-based router, ~14KB framework      |
| Middleware Pipeline    | <1ms             | Timing, CORS, error handler             |
| Zod Validation         | <1ms             | Schema validation on request body       |
| Drizzle SQL Generation | <1ms             | Compile-time SQL, zero runtime overhead |
| Neon HTTP Query        | ~5-30ms          | One-shot HTTP, co-located region        |
| JSON Serialization     | <1ms             | Small payload response                  |
| **Total**              | **~10-35ms**     | **Well under 100ms target**             |

---

## Why This Stack?

### Hono — The Fastest Edge-Native Framework

Hono is purpose-built for edge runtimes. At ~14KB, it's one of the smallest full-featured web frameworks available. It uses a trie-based router that resolves routes in O(1) time. Unlike Express (which was designed for long-running Node.js servers), Hono was designed from day one for short-lived serverless/edge functions.

**Performance comparison:**

- Express: ~2MB bundle, 250ms+ cold start on Node.js runtime
- Hono: ~14KB bundle, <1ms startup on Edge runtime

### Neon PostgreSQL — Serverless-Native Database

Neon is PostgreSQL re-architected for serverless. Its **HTTP driver** (`@neondatabase/serverless`) sends each query as a stateless HTTP request — no TCP handshake, no TLS negotiation, no connection pool warmup. This is critical because edge functions are stateless and short-lived; you can't maintain persistent database connections across invocations.

**Why HTTP over WebSocket?**

- Edge functions live for milliseconds. WebSocket connections can't be reused across invocations.
- HTTP queries are atomic: one request → one response → done.
- No connection setup overhead means every invocation is fast, not just warm ones.
- ~5-15ms per query vs ~50-100ms for WebSocket/TCP connection establishment.

### Drizzle ORM — Zero Runtime Overhead

Drizzle is the only TypeScript ORM that generates SQL at build time. There's no "query engine" running at runtime (unlike Prisma's Rust-based engine, which adds ~2-4MB to your bundle and 100ms+ to cold starts). Drizzle's output is raw SQL strings — the ORM essentially disappears at runtime.

**Why Drizzle over Prisma for Edge?**

- Prisma's runtime engine is incompatible with many edge environments
- Prisma adds 2-4MB to bundle size; Drizzle adds ~50KB
- Drizzle's `select()` is type-safe AND generates optimal SQL

### Vercel Edge Runtime — Near-Zero Cold Starts

Vercel Edge Runtime runs on V8 isolates (similar to Cloudflare Workers). Unlike Node.js serverless functions that spin up an entire Node.js process (~250ms cold start), V8 isolates start in <1ms. Your code is "always warm" from the user's perspective.

---

## Phase 1: Project Foundation & Dependencies

### Step 1: Install Dependencies

We need three categories of packages:

**Core dependencies** (used at runtime in the edge function):

```bash
bun add @neondatabase/serverless drizzle-orm hono @hono/zod-validator zod
```

| Package                    | Purpose                                        | Size Impact |
| -------------------------- | ---------------------------------------------- | ----------- |
| `@neondatabase/serverless` | Neon's HTTP/WebSocket driver for edge runtimes | ~20KB       |
| `drizzle-orm`              | Type-safe ORM, compiles to raw SQL             | ~50KB       |
| `hono`                     | Edge-native web framework (already installed)  | ~14KB       |
| `@hono/zod-validator`      | Hono middleware for Zod schema validation      | ~2KB        |
| `zod`                      | Runtime type validation for request bodies     | ~13KB       |

**Dev dependencies** (used during development/migrations, NOT deployed):

```bash
bun add -d drizzle-kit dotenv
```

| Package       | Purpose                              |
| ------------- | ------------------------------------ |
| `drizzle-kit` | Migration generation & DB management |
| `dotenv`      | Load `.env` file for local dev       |

> **Why is the bundle so small?** Total runtime dependencies are ~100KB. This is critical — Vercel Edge functions have a 1MB compressed size limit. Every KB of bundle size adds to cold start time. We're using ~10% of the limit.

### Step 2: Add npm Scripts

Update `package.json` to add these scripts:

```json
{
  "scripts": {
    "dev": "vercel dev",
    "build": "vercel build",
    "deploy": "vercel deploy",
    "deploy:prod": "vercel deploy --prod",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}
```

| Script        | What It Does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `dev`         | Starts local Vercel dev server, emulating the edge/serverless environment    |
| `build`       | Builds the project as Vercel would in CI                                     |
| `deploy`      | Deploys to Vercel preview environment                                        |
| `deploy:prod` | Deploys to Vercel production                                                 |
| `db:generate` | Reads your Drizzle schema and generates SQL migration files                  |
| `db:migrate`  | Applies pending migrations to your Neon database                             |
| `db:push`     | Pushes schema directly to DB (quick dev iteration, skips migration files)    |
| `db:studio`   | Opens Drizzle Studio — a visual DB browser at `https://local.drizzle.studio` |

> **Why `vercel dev` for local development?** It emulates Vercel's routing, environment variables, and runtime behavior. Your local environment matches production as closely as possible, avoiding "works on my machine" issues.

### Step 3: Create Project Folder Structure

```
src/
├── index.ts                # App entry: middleware composition, route mounting, Vercel export
├── db/
│   ├── index.ts            # Database connection (Neon HTTP client + Drizzle instance)
│   └── schema/
│       ├── index.ts         # Schema barrel export (re-exports all table schemas)
│       └── tasks.ts         # Tasks table definition
├── routes/
│   └── tasks.ts             # Tasks CRUD route handlers
├── middleware/
│   ├── timing.ts            # Server-Timing header middleware (performance monitoring)
│   └── error-handler.ts     # Global error handler (consistent error responses)
└── types/
    └── index.ts             # Shared TypeScript types & interfaces

drizzle.config.ts            # Drizzle Kit configuration (migrations, DB connection)
vercel.json                  # Vercel deployment configuration (runtime, regions, routes)
.env.example                 # Template showing required environment variables
.env                         # Local environment variables (git-ignored)
```

**Why this structure?**

- **`db/schema/` directory**: Schemas are separated by domain entity. As the project grows, you add `users.ts`, `projects.ts`, etc. The barrel `index.ts` re-exports everything — Drizzle Kit reads this single entry point.
- **`routes/` directory**: Each file is a self-contained Hono router for one resource. Easy to find, easy to test, easy to add new resources.
- **`middleware/` directory**: Reusable middleware separated from route logic. Enterprise apps accumulate middleware (auth, rate limiting, logging, etc.) — keeping them modular prevents `index.ts` from becoming a monolith.
- **`types/` directory**: Shared types prevent circular dependencies between routes and DB layers.

---

## Phase 2: Neon Database Setup

### Step 4: Create a Neon Project

1. **Sign up** at [neon.tech](https://neon.tech) (free tier includes 0.5GB storage, sufficient for development)

2. **Create a new project:**
   - Name: `high-performance-serverless-api` (or your preference)
   - **Region: `US East (Ohio) — us-east-2`** or **`US East (N. Virginia) — us-east-1`**

   > **⚠️ CRITICAL: Region selection determines your latency floor.** Vercel Edge functions in `iad1` (Washington D.C.) have ~1-3ms latency to Neon in `us-east-1`/`us-east-2`. Choosing `eu-west` would add ~80ms of cross-Atlantic latency to every single query. **Always co-locate compute and database.**

3. **Create database:** The default `neondb` database is fine, or create a custom one like `serverless_api`.

4. **Get your connection string:** After creating the project, Neon shows your connection string. It looks like:

   ```
   postgresql://username:password@ep-xxxxx-xxxxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

   You'll need this string in two forms:
   - **For the Edge function** (HTTP queries): The same connection string works — `@neondatabase/serverless` knows how to convert it to HTTP queries.
   - **For Drizzle Kit** (migrations, runs in Node.js): Use the same connection string directly.

### Step 5: Configure Environment Variables

Create `.env.example` in the project root (this gets committed to git as documentation):

```env
# Neon PostgreSQL connection string
# Get this from: https://console.neon.tech → Your Project → Connection Details
DATABASE_URL=postgresql://username:password@ep-xxxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Create `.env` in the project root (this is git-ignored, contains your real credentials):

```env
DATABASE_URL=postgresql://your-actual-username:your-actual-password@ep-xxxxx-xxxxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
```

> **Security note:** `.env` is already in `.gitignore` (the Hono template includes it). Never commit real database credentials. In production, Vercel environment variables are injected securely at runtime.

### Step 6: Set Vercel Environment Variables

1. Install the Vercel CLI if not already: `bun add -g vercel`
2. Link your project: `vercel link`
3. Add the environment variable:

```bash
vercel env add DATABASE_URL
```

Or via the Vercel Dashboard:

- Go to your project → **Settings** → **Environment Variables**
- Add `DATABASE_URL` with your Neon connection string
- Enable for **Production**, **Preview**, and **Development**

> **Why set it for all environments?** Preview deployments (from PRs) need database access too. In a real enterprise setup, you'd use separate Neon branches for preview vs production — Neon supports database branching natively.

---

## Phase 3: Database Schema & Connection

### Step 7: Create the Neon HTTP Connection

**File: `src/db/index.ts`**

```typescript
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Creates a Neon HTTP database client.
 *
 * WHY HTTP (not WebSocket or TCP Pool)?
 * - Edge functions are stateless — connections can't persist across invocations
 * - HTTP queries are atomic: one request → one response → done
 * - No connection setup overhead (no TCP handshake, no TLS negotiation)
 * - Each query is ~5-15ms vs ~50-100ms for WebSocket connection establishment
 *
 * HOW IT WORKS:
 * 1. `neon()` creates an HTTP SQL function (not a connection)
 * 2. `drizzle()` wraps it with type-safe query building
 * 3. Each `db.select()` / `db.insert()` call sends a single HTTP POST to Neon
 * 4. Neon executes the SQL and returns the result as JSON
 * 5. No connection to close, no pool to manage
 */
export function createDb() {
  const sql = neon(process.env.DATABASE_URL!);
  return drizzle(sql, { schema });
}

export type Database = ReturnType<typeof createDb>;
```

> **Why a factory function instead of a module-level singleton?**
>
> In Edge Runtime, module-level code runs once per isolate but isolates can be recycled unpredictably. A factory function ensures we always read the latest `DATABASE_URL` from the environment. The overhead is negligible — `neon()` just creates a function reference, it doesn't open a connection.

### Step 8: Define the Tasks Schema

**File: `src/db/schema/tasks.ts`**

```typescript
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
```

**File: `src/db/schema/index.ts`** (barrel export)

```typescript
export * from "./tasks";
```

> **Why barrel exports?** Drizzle Kit reads a single schema entry point. As you add more tables (`users.ts`, `projects.ts`, etc.), you just add `export * from "./users"` here. The Drizzle config points to this one file.

### Step 9: Create Drizzle Configuration

**File: `drizzle.config.ts`**

```typescript
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export default defineConfig({
  out: "./drizzle", // Migration files output directory
  schema: "./src/db/schema", // Schema files location
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL
  },
  verbose: true, // Log SQL during migrations
  strict: true // Fail on potentially destructive changes
});
```

> **`strict: true` is important.** It prevents accidental destructive migrations (like dropping a column with data) without explicit confirmation. In enterprise environments, this catches mistakes before they hit production.

### Step 10: Generate and Run Initial Migration

```bash
# Generate the migration SQL from your schema
bun run db:generate
```

This creates a file in `drizzle/` like `0000_create_tasks_table.sql` containing:

```sql
CREATE TYPE "task_status" AS ENUM ('todo', 'in_progress', 'done');
CREATE TYPE "task_priority" AS ENUM ('low', 'medium', 'high');

CREATE TABLE "tasks" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "title" varchar(256) NOT NULL,
  "description" text,
  "status" "task_status" DEFAULT 'todo' NOT NULL,
  "priority" "task_priority" DEFAULT 'medium' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "tasks_status_idx" ON "tasks" ("status");
CREATE INDEX "tasks_priority_idx" ON "tasks" ("priority");
CREATE INDEX "tasks_created_at_idx" ON "tasks" ("created_at");
```

Apply it to your Neon database:

```bash
# Run the migration against Neon
bun run db:migrate
```

> **Alternative for rapid development:** `bun run db:push` applies the schema directly without generating migration files. Useful during early development when the schema is changing frequently. **Always use proper migrations (`generate` + `migrate`) for production.**

Verify with Drizzle Studio:

```bash
bun run db:studio
```

This opens a browser-based database viewer at `https://local.drizzle.studio` where you can see your `tasks` table, run queries, and inspect data.

---

## Phase 4: Vercel Edge Configuration

### Step 11: Create `vercel.json`

**File: `vercel.json`**

```json
{
  "buildCommand": "exit 0",
  "outputDirectory": ".",
  "rewrites": [
    {
      "source": "/api/(.*)",
      "destination": "/api"
    }
  ],
  "functions": {
    "api/index.ts": {
      "runtime": "edge",
      "regions": ["iad1"]
    }
  },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, s-maxage=0, must-revalidate"
        }
      ]
    }
  ]
}
```

**Explanation of each setting:**

| Setting             | Value                | Why                                                                                                                                                                                                         |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildCommand`      | `"exit 0"`           | Hono for Vercel doesn't need a build step — Vercel's internal bundler handles TypeScript compilation. Running `exit 0` skips any default build.                                                             |
| `outputDirectory`   | `"."`                | Tells Vercel to use the project root (source files are in `src/`, Vercel bundles them directly).                                                                                                            |
| `rewrites`          | `/api/(.*)` → `/api` | Funnels all API paths (e.g., `/api/tasks/123`) to the single Hono entry point. Hono's internal router handles path matching. This is the **single-function pattern** — one edge function serves all routes. |
| `functions.runtime` | `"edge"`             | **Critical.** Forces Edge Runtime instead of default Node.js serverless. This is what gives us near-zero cold starts.                                                                                       |
| `functions.regions` | `["iad1"]`           | **Critical.** Pins the edge function to Vercel's Washington D.C. region, which is in the same AWS availability zone as Neon's `us-east-1`/`us-east-2`. This keeps DB query latency to ~1-5ms.               |

> **⚠️ Why `iad1` specifically?**
>
> By default, Vercel Edge functions run on their **global edge network** — the nearest point of presence to the user. This is great for static content and computation-only functions, but **terrible for database queries**. A user in Tokyo would hit a Tokyo edge node, which then queries your US East database — adding ~150ms of cross-Pacific latency.
>
> By pinning to `iad1`, we sacrifice global edge distribution for **consistent low-latency database access**. Every request routes to Washington D.C. regardless of user location. The slight increase in network latency for distant users (~50-100ms for cross-continent) is more than offset by the massive reduction in DB query latency.
>
> **For enterprise:** If you need global low-latency, consider Neon's read replicas in multiple regions, or a caching layer (Redis/Vercel KV) in front of the database.

### Step 12: Update the App Entry Point

**File: `src/index.ts`**

```typescript
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { cors } from "hono/cors";
import { timing } from "./middleware/timing";
import { errorHandler } from "./middleware/error-handler";
import { tasksRoutes } from "./routes/tasks";

// Edge Runtime declaration — tells Vercel to use V8 isolates
export const config = {
  runtime: "edge"
};

/**
 * Main Hono application.
 *
 * ARCHITECTURE:
 * - Single Hono app handles ALL routes under /api/*
 * - Middleware is applied globally (runs on every request)
 * - Routes are modular — each resource is a separate Hono router
 * - The base path `/api` is set here, routes define their own sub-paths
 */
const app = new Hono().basePath("/api");

// ─── Global Middleware ──────────────────────────────────────
// Order matters: timing wraps everything, CORS runs early, errors catch everything

app.use("*", timing());
app.use(
  "*",
  cors({
    origin: "*", // Lock this down in production
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400 // Cache preflight for 24 hours
  })
);

// ─── Health Check ───────────────────────────────────────────
app.get("/health", (c) => {
  return c.json({
    success: true,
    data: {
      status: "healthy",
      timestamp: new Date().toISOString(),
      runtime: "edge"
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

// ─── Vercel Edge Handler Export ─────────────────────────────
// This is the entry point Vercel uses to invoke the edge function
export default handle(app);
```

**Key points:**

- `export const config = { runtime: "edge" }` — This inline config reinforces the `vercel.json` setting. Belt and suspenders.
- `handle(app)` — Hono's Vercel adapter converts the Hono app into a Vercel-compatible edge function handler.
- `.basePath("/api")` — All routes are prefixed with `/api`. The tasks router at `/tasks` becomes `/api/tasks`.
- Middleware order: timing → CORS → route handler → error handler.

---

## Phase 5: Middleware (Performance & Reliability)

### Step 13: Create Timing Middleware

**File: `src/middleware/timing.ts`**

```typescript
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
```

> **Why `performance.now()` instead of `Date.now()`?** `performance.now()` provides sub-millisecond precision (microsecond-level). `Date.now()` only provides millisecond precision. When your target is <100ms, you need precise measurement.

### Step 14: Create Error Handler

**File: `src/middleware/error-handler.ts`**

```typescript
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
```

### Step 15: CORS Middleware

CORS is handled inline in `src/index.ts` using Hono's built-in `cors()` middleware (see Step 12). No separate file needed — Hono's implementation is battle-tested and handles preflight `OPTIONS` requests automatically.

**Production guidance:** Replace `origin: "*"` with your actual frontend domains:

```typescript
cors({
  origin: ["https://your-app.com", "https://staging.your-app.com"]
  // ...
});
```

### Step 16: Request ID Middleware

Add request ID tracking for distributed tracing (included inline in the timing middleware or as a separate middleware):

**File: `src/middleware/request-id.ts`**

```typescript
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
```

Then add it to the middleware chain in `src/index.ts`:

```typescript
import { requestId } from "./middleware/request-id";

// Add after timing, before CORS:
app.use("*", requestId());
```

---

## Phase 6: Tasks CRUD Routes

### Step 17: Create Tasks Route Handlers

**File: `src/routes/tasks.ts`**

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createDb } from "../db";
import { tasks } from "../db/schema";
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
    const db = createDb();

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

    // Chain conditions
    let filteredQuery =
      conditions.length > 0
        ? query.where(
            conditions.length === 1
              ? conditions[0]
              : (() => {
                  const { and } = require("drizzle-orm");
                  return and(...conditions);
                })()
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
    const db = createDb();

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
    const db = createDb();

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
    const db = createDb();

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
    const db = createDb();

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
```

**Performance patterns used throughout:**

| Pattern                                       | Impact                           | Explanation                                                 |
| --------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `.returning()` on all mutations               | -1 DB round-trip per mutation    | Returns the result in the same INSERT/UPDATE/DELETE query   |
| Explicit column selection in `.select({...})` | Less data serialized/transferred | Don't send unnecessary bytes over the wire                  |
| Zod validation before DB access               | Saves wasted DB queries          | Invalid requests are rejected at the middleware layer       |
| `.limit()` on all list queries                | Prevents unbounded result sets   | A table with 1M rows would crash without limits             |
| UUID validation regex                         | Prevents invalid DB queries      | PostgreSQL would error on invalid UUID; we catch it earlier |

### Step 18: Mount Routes

Routes are already mounted in `src/index.ts` (Step 12):

```typescript
app.route("/tasks", tasksRoutes);
```

This produces the following endpoint map:

| Method   | URL              | Handler        |
| -------- | ---------------- | -------------- |
| `GET`    | `/api/tasks`     | List tasks     |
| `GET`    | `/api/tasks/:id` | Get task by ID |
| `POST`   | `/api/tasks`     | Create task    |
| `PUT`    | `/api/tasks/:id` | Update task    |
| `DELETE` | `/api/tasks/:id` | Delete task    |
| `GET`    | `/api/health`    | Health check   |

---

## Phase 7: Performance Optimizations

### Step 19: Performance Best Practices Applied

Here's a summary of every performance decision in this project and its impact:

#### Edge Runtime (Near-Zero Cold Starts)

```
Node.js Serverless:  [████████████████████████░░░░░] 250ms cold start
Edge Runtime:        [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] <1ms cold start
```

V8 isolates (Edge) start ~250x faster than Node.js processes. This single decision eliminates the #1 source of serverless latency.

#### Neon HTTP Driver (Stateless Queries)

```
Traditional Pool:    Connect(50ms) → Query(5ms) → Close(1ms)  = 56ms
Neon HTTP:           Query(10ms)                                = 10ms
```

No connection lifecycle overhead. Each query is a self-contained HTTP request.

#### Region Co-Location

```
Edge(Tokyo) → DB(US East):    ████████████████ 150ms network
Edge(iad1)  → DB(US East):    ██ 1-5ms network
```

Pinning the edge function to `iad1` (same AWS region as Neon) keeps network hop to ~1-5ms.

#### Drizzle ORM (Zero Runtime Overhead)

```
Prisma:   Parse Query → Engine Processing → Generate SQL → Execute  (50ms overhead)
Drizzle:  Generated SQL Literal → Execute                           (<1ms overhead)
```

Drizzle's SQL is generated at compile time. At runtime, it's essentially a string literal.

#### Minimal Bundle Size

```
Express + Prisma:   ~5MB bundle (slow to load into isolate)
Hono + Drizzle:     ~100KB bundle (instant load)
```

Smaller bundles = faster isolate initialization = faster cold starts.

### Step 20: Response Caching

For read-heavy endpoints, add Vercel Edge Cache headers:

```typescript
// In the GET /tasks list handler, add before returning:
c.header("Cache-Control", "public, s-maxage=1, stale-while-revalidate=59");
```

**What this does:**

- `s-maxage=1` — Vercel's edge cache stores the response for 1 second
- `stale-while-revalidate=59` — For the next 59 seconds, serve the cached (stale) response immediately while revalidating in the background

**Result:** Repeated identical GET requests within 60 seconds are served from Vercel's edge cache at **~0ms** — no edge function invocation, no database query.

**When NOT to cache:**

- POST/PUT/DELETE (mutations) — never cache these
- User-specific data (after auth is added) — use `private` instead of `public`
- Real-time data that must always be fresh

---

## Phase 8: Local Development & Testing

### Step 21: Configure Local Development

Ensure your `.env` file has the `DATABASE_URL` set, then:

```bash
# Start the local Vercel development server
bun run dev
```

This starts a local server (typically at `http://localhost:3000`) that emulates Vercel's routing and edge runtime.

> **Note:** The local `vercel dev` server uses Node.js under the hood, so it won't perfectly replicate Edge Runtime behavior. For true edge testing, deploy to a Vercel preview environment.

### Step 22: Manual Testing

Test all endpoints with curl (or your preferred HTTP client):

#### Health Check

```bash
curl http://localhost:3000/api/health
```

Expected response:

```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2026-02-26T10:30:00.000Z",
    "runtime": "edge"
  }
}
```

#### Create a Task

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement user authentication",
    "description": "Add JWT-based auth middleware",
    "priority": "high"
  }'
```

Expected response (201 Created):

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Implement user authentication",
    "description": "Add JWT-based auth middleware",
    "status": "todo",
    "priority": "high",
    "createdAt": "2026-02-26T10:30:00.000Z",
    "updatedAt": "2026-02-26T10:30:00.000Z"
  }
}
```

#### List Tasks (with filters)

```bash
# All tasks
curl http://localhost:3000/api/tasks

# Filter by status
curl "http://localhost:3000/api/tasks?status=todo"

# Filter by priority with pagination
curl "http://localhost:3000/api/tasks?priority=high&limit=10&offset=0"
```

#### Get Single Task

```bash
curl http://localhost:3000/api/tasks/550e8400-e29b-41d4-a716-446655440000
```

#### Update a Task

```bash
curl -X PUT http://localhost:3000/api/tasks/550e8400-e29b-41d4-a716-446655440000 \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in_progress",
    "priority": "medium"
  }'
```

#### Delete a Task

```bash
curl -X DELETE http://localhost:3000/api/tasks/550e8400-e29b-41d4-a716-446655440000
```

#### Verify Performance

Check the `Server-Timing` header on any response:

```bash
curl -v http://localhost:3000/api/tasks 2>&1 | grep -i "server-timing"
# Output: Server-Timing: total;dur=12.50
```

The `dur=12.50` means 12.5 milliseconds total processing time. In production on Edge, expect similar or better numbers.

### Step 23: Verify Sub-100ms Performance

After deploying, check performance in three ways:

1. **`Server-Timing` header** — Every response includes the server-side processing time
2. **Vercel Analytics** — Dashboard shows p50/p95/p99 latency for all functions
3. **Vercel Functions tab** — Confirms "Edge" runtime is active (not "Serverless")

Expected production numbers:

| Endpoint                | Expected Latency | Notes                                   |
| ----------------------- | ---------------- | --------------------------------------- |
| `GET /api/health`       | 1-3ms            | No DB query, pure computation           |
| `GET /api/tasks`        | 10-25ms          | Single SELECT query to Neon             |
| `GET /api/tasks/:id`    | 8-15ms           | Primary key lookup (fastest query type) |
| `POST /api/tasks`       | 15-30ms          | INSERT + RETURNING                      |
| `PUT /api/tasks/:id`    | 15-30ms          | UPDATE + RETURNING                      |
| `DELETE /api/tasks/:id` | 10-20ms          | DELETE + RETURNING                      |

---

## Phase 9: Deployment

### Step 24: Deploy to Vercel

```bash
# Deploy to preview environment (creates a unique URL)
bun run deploy

# Check the preview deployment, then deploy to production
bun run deploy:prod
```

Before deploying, verify:

- [ ] `DATABASE_URL` is set in Vercel environment variables (Settings → Environment Variables)
- [ ] Neon database has been migrated (`bun run db:migrate`)
- [ ] `vercel.json` has `runtime: "edge"` and `regions: ["iad1"]`

### Step 25: Post-Deployment Verification

1. **Hit the health endpoint:**

   ```bash
   curl https://your-project.vercel.app/api/health
   ```

2. **Create a test task and verify CRUD works:**

   ```bash
   # Create
   curl -X POST https://your-project.vercel.app/api/tasks \
     -H "Content-Type: application/json" \
     -d '{"title": "Production test task"}'

   # List
   curl https://your-project.vercel.app/api/tasks

   # Check timing
   curl -v https://your-project.vercel.app/api/tasks 2>&1 | grep -i "server-timing"
   ```

3. **Verify Edge Runtime in Vercel Dashboard:**
   - Go to your project → **Functions** tab
   - Confirm it shows **"Edge"** (not "Serverless (Node.js)")
   - Check the region shows **"iad1"**

4. **Check Vercel Analytics:**
   - Go to **Analytics** → **Web Vitals** or **Functions**
   - Look at p50, p95, p99 latency
   - All should be well under 100ms

---

## Key Architectural Decisions

| Decision                        | Alternative              | Why We Chose This                                                                                             |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Edge Runtime**                | Node.js Serverless       | Near-zero cold starts (<1ms vs 250ms+). Critical for sub-100ms target.                                        |
| **Neon HTTP driver**            | WebSocket / TCP Pool     | Stateless one-shot queries are optimal for edge — no connection setup overhead (~10ms vs ~56ms).              |
| **Region co-location (`iad1`)** | Global edge distribution | Database queries dominate latency. Co-locating reduces DB round-trip from ~150ms to ~1-5ms.                   |
| **Drizzle ORM**                 | Prisma / TypeORM         | Zero runtime overhead, ~50KB vs ~4MB, native edge support. The only production-grade ORM that works on Edge.  |
| **Hono**                        | Express / Fastify        | Built for edge, ~14KB, fastest router benchmark, native Vercel adapter. Express can't run on Edge.            |
| **Zod validation**              | Manual validation        | Type-safe, composable, native Hono integration. Catches bad input before it hits the DB.                      |
| **`.returning()` pattern**      | INSERT then SELECT       | One DB round-trip instead of two. Halves mutation latency.                                                    |
| **UUID primary keys**           | Auto-increment integer   | No sequential bottleneck across distributed edge, generated server-side (`gen_random_uuid()`).                |
| **No auth (Phase 1)**           | JWT / API key            | Focused learning scope. Auth is added as middleware later without architectural changes.                      |
| **Single edge function**        | One function per route   | Hono's internal router is faster than Vercel's inter-function routing. One function = one cold start maximum. |

---

## What's Next?

This tutorial covers Phase 1 — a Tasks CRUD API demonstrating the core performance patterns. To build toward a production enterprise API, consider adding:

- **Authentication** — JWT validation middleware (e.g., `jose` library, edge-compatible)
- **Rate Limiting** — Use Vercel KV (Redis) for distributed rate limiting
- **Input Sanitization** — Prevent SQL injection (Drizzle's parameterized queries handle this, but validate at the edge too)
- **Structured Logging** — Ship logs to your observability platform
- **Database Branching** — Use Neon branches for preview deployments (each PR gets its own database)
- **Integration Tests** — Automated tests against a Neon branch
- **OpenAPI Documentation** — Generate from Zod schemas using `@hono/zod-openapi`
- **More Resources** — Users, Projects, Comments — following the same modular pattern

---

_Built with Hono + Neon + Drizzle on Vercel Edge Runtime. Every request under 100ms._
