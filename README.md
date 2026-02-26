# High-Performance Serverless API Tutorial

> Build an enterprise-grade serverless CRUD API targeting **sub-100ms responses** using **Vercel Fluid Compute**, **Neon PostgreSQL**, **Drizzle ORM**, **Hono**, and **Better Auth**.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Why This Stack?](#why-this-stack)
- [Phase 1: Project Foundation & Dependencies](#phase-1-project-foundation--dependencies)
- [Phase 2: Neon Database Setup](#phase-2-neon-database-setup)
- [Phase 3: Database Schema & Connection](#phase-3-database-schema--connection)
- [Phase 4: Vercel Fluid Compute Configuration](#phase-4-vercel-fluid-compute-configuration)
- [Phase 5: Middleware (Performance & Reliability)](#phase-5-middleware-performance--reliability)
- [Phase 6: Tasks CRUD Routes](#phase-6-tasks-crud-routes)
- [Phase 7: Performance Optimizations](#phase-7-performance-optimizations)
- [Phase 8: Local Development & Testing](#phase-8-local-development--testing)
- [Phase 9: Deployment](#phase-9-deployment)
- [Phase 10: Better Auth Integration (Next Phase)](#phase-10-better-auth-integration-next-phase)
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
│              Vercel CDN + Fluid Compute (iad1)              │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         Node.js Function (Fluid Compute)              │  │
│  │     Concurrency: Multiple requests per instance       │  │
│  │     Bytecode Caching: Faster cold starts              │  │
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

| Layer                  | Expected Latency                                   | Notes                                                                       |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| Function Startup       | ~0ms (warm) / ~50-80ms (cold, with bytecode cache) | Fluid Compute reuses warm instances; bytecode caching mitigates cold starts |
| Hono Routing           | <1ms                                               | Trie-based router, ~14KB framework                                          |
| Middleware Pipeline    | <1ms                                               | Timing, CORS, error handler                                                 |
| Zod Validation         | <1ms                                               | Schema validation on request body                                           |
| Drizzle SQL Generation | <1ms                                               | Compile-time SQL, zero runtime overhead                                     |
| Neon HTTP Query        | ~5-30ms                                            | One-shot HTTP, co-located region (iad1)                                     |
| JSON Serialization     | <1ms                                               | Small payload response                                                      |
| **Total (warm)**       | **~10-35ms**                                       | **Well under 100ms target**                                                 |
| **Total (cold)**       | **~60-110ms**                                      | **At or near target; rare with Fluid Compute pre-warming**                  |

> **Why cold starts are not a concern with Fluid Compute:** Fluid Compute keeps instances alive across requests (concurrency), pre-warms production deployments, and uses V8 bytecode caching (Node.js 20+) to drastically reduce cold start frequency and duration. In practice, >95% of requests hit warm instances.

---

## Why This Stack?

### Hono — The Fastest Web-Standards Framework

Hono is built on Web Standards (Request/Response API) and runs on any JavaScript runtime — Node.js, Edge, Bun, Deno, Cloudflare Workers. At ~14KB, it's one of the smallest full-featured web frameworks available. It uses a trie-based router that resolves routes in O(1) time.

On Vercel, Hono has **first-class support**: just `export default app` and your routes automatically become Vercel Functions with Fluid Compute. No adapter, no configuration.

**Performance comparison:**

- Express: ~2MB bundle, no Web Standard support, manual Vercel adaptation required
- Hono: ~14KB bundle, native Vercel integration, zero-config deployment

### Neon PostgreSQL — Serverless-Native Database

Neon is PostgreSQL re-architected for serverless. Its **HTTP driver** (`@neondatabase/serverless`) sends each query as a stateless HTTP request — no TCP handshake, no TLS negotiation, no connection pool warmup.

**Why HTTP for Phase 1?**

- HTTP queries are atomic: one request → one response → done.
- No connection setup overhead means consistent latency (~10-20ms per query).
- Simplest possible setup — no pool management, no connection lifecycle.
- ~5-15ms per query vs ~50-100ms for initial WebSocket/TCP connection establishment.

> **Future upgrade path:** With Fluid Compute's concurrency model, instances stay alive handling multiple requests. This makes WebSocket connection pooling MORE effective than in traditional serverless — a single persistent connection can serve dozens of concurrent requests. We'll note this as an optimization for Phase 2+.

### Drizzle ORM — Zero Runtime Overhead

Drizzle is the only TypeScript ORM that generates SQL at build time. There's no "query engine" running at runtime (unlike Prisma's Rust-based engine, which adds ~2-4MB to your bundle and significant cold start overhead). Drizzle's output is raw SQL strings — the ORM essentially disappears at runtime.

**Why Drizzle over Prisma?**

- Prisma adds 2-4MB to bundle size; Drizzle adds ~50KB
- Drizzle's `select()` is type-safe AND generates optimal SQL
- Drizzle works identically across Node.js, Edge, and all runtimes
- Drizzle has native `neon-http` adapter — zero compatibility issues

### Vercel Fluid Compute — The Best of Both Worlds

Fluid Compute is Vercel's hybrid execution model (default since April 2025). It eliminates the traditional tradeoff between Edge Runtime (fast cold starts, limited APIs) and Node.js Serverless (full APIs, slow cold starts).

**What Fluid Compute gives us:**

| Feature                   | Benefit                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Optimized Concurrency** | A single function instance handles multiple requests simultaneously. Fewer cold starts, better resource utilization.                |
| **Bytecode Caching**      | Node.js 20+ stores compiled bytecode after first execution. Subsequent cold starts skip recompilation — ~50-80ms instead of ~250ms. |
| **Pre-warming**           | Production deployments pre-warm function instances. Most requests hit already-warm instances.                                       |
| **`waitUntil`**           | Run background tasks (logging, analytics) AFTER sending the response to the client — user sees faster response times.               |
| **Error Isolation**       | Unhandled errors in one request don't crash other concurrent requests on the same instance.                                         |
| **Full Node.js APIs**     | No restrictions on `crypto`, `fs`, `Buffer`, etc. Critical for Better Auth integration (Phase 10).                                  |
| **AZ Failover**           | Automatic failover across availability zones and regions for high availability.                                                     |

**Why Fluid Compute over Edge Runtime?**

```
                        Edge Runtime         Fluid Compute (Node.js)
Cold start:             ~0-1ms               ~50-80ms (bytecode cached) / ~0ms (warm)
Cold start frequency:   Every new isolate    Rare (concurrency + pre-warming)
Node.js API support:    Limited              Full
Better Auth support:    ❌ No                ✅ Yes
Concurrency:            1 req per isolate    Multiple reqs per instance
Connection pooling:     Not possible         Possible (future optimization)
Bundle size limit:      1MB compressed       250MB
waitUntil:              ❌ No                ✅ Yes
```

The key insight: **Edge Runtime has faster individual cold starts, but Fluid Compute has fewer cold starts overall.** With concurrency and pre-warming, most Fluid Compute requests hit warm instances (0ms startup). And when cold starts do occur, bytecode caching keeps them at ~50-80ms — well within our 100ms budget.

---

## Phase 1: Project Foundation & Dependencies

### Step 1: Install Dependencies

We need three categories of packages:

**Core dependencies** (used at runtime):

```bash
bun add @neondatabase/serverless drizzle-orm hono @hono/zod-validator zod
```

| Package                    | Purpose                                              | Size Impact |
| -------------------------- | ---------------------------------------------------- | ----------- |
| `@neondatabase/serverless` | Neon's HTTP/WebSocket driver for serverless runtimes | ~20KB       |
| `drizzle-orm`              | Type-safe ORM, compiles to raw SQL                   | ~50KB       |
| `hono`                     | Web-standards framework (already installed)          | ~14KB       |
| `@hono/zod-validator`      | Hono middleware for Zod schema validation            | ~2KB        |
| `zod`                      | Runtime type validation for request bodies           | ~13KB       |

**Dev dependencies** (used during development/migrations, NOT deployed):

```bash
bun add -d drizzle-kit dotenv
```

| Package       | Purpose                              |
| ------------- | ------------------------------------ |
| `drizzle-kit` | Migration generation & DB management |
| `dotenv`      | Load `.env` file for local dev       |

> **Why is the bundle small?** Total runtime dependencies are ~100KB. Smaller bundles mean faster bytecode caching and faster cold starts when they do occur. Every KB counts.

### Step 2: Add npm Scripts

Update `package.json` to add these scripts:

```json
{
  "scripts": {
    "dev:vercel": "vercel dev",
    "build:vercel": "vercel build",
    "deploy:vercel": "vercel deploy",
    "deploy:vercel:prod": "vercel deploy --prod",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}
```

| Script               | What It Does                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| `dev:vercel`         | Starts local Vercel dev server, emulating the Fluid Compute environment      |
| `build:vercel`       | Builds the project as Vercel would in CI                                     |
| `deploy:vercel`      | Deploys to Vercel preview environment                                        |
| `deploy:vercel:prod` | Deploys to Vercel production                                                 |
| `db:generate`        | Reads your Drizzle schema and generates SQL migration files                  |
| `db:migrate`         | Applies pending migrations to your Neon database                             |
| `db:push`            | Pushes schema directly to DB (quick dev iteration, skips migration files)    |
| `db:studio`          | Opens Drizzle Studio — a visual DB browser at `https://local.drizzle.studio` |

> **Why `vercel dev` for local development?** It emulates Vercel's routing, environment variables, and runtime behavior. Your local environment matches production as closely as possible, avoiding "works on my machine" issues.

> **Why use `*:vercel` for script commands?** Since commands like `vercel dev` and `vercel build` invokes the development and build commands, they cannot invoke same commands listed in package.json file itself.

### Step 3: Create Project Folder Structure

```
src/
├── index.ts                  # App entry: middleware composition, route mounting, default export
├── db/
│   ├── index.ts              # Database connection (Neon HTTP client + Drizzle instance)
│   └── schemas/
│       ├── index.ts          # Schema barrel export (re-exports all table schemas)
│       └── tasks.schema.ts   # Tasks table definition
├── routes/
│   └── tasks.routes.ts       # Tasks CRUD route handlers
├── middleware/
│   ├── timing.ts             # Server-Timing header middleware (performance monitoring)
│   └── error-handler.ts      # Global error handler (consistent error responses)
└── types/
    └── index.ts              # Shared TypeScript types & interfaces

drizzle.config.ts             # Drizzle Kit configuration (migrations, DB connection)
vercel.json                   # Vercel deployment configuration (Fluid Compute, region)
.env.example                  # Template showing required environment variables
.env                          # Local environment variables (git-ignored)
```

**Why this structure?**

- **`db/schemas/` directory**: Schemas are separated by domain entity. As the project grows, you add `users.schema.ts`, `projects.schema.ts`, etc. The barrel `index.ts` re-exports everything — Drizzle Kit reads this single entry point.
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

   > **⚠️ CRITICAL: Region selection determines your latency floor.** Vercel Functions default to `iad1` (Washington D.C., US East). Placing your Neon database in `us-east-1`/`us-east-2` keeps database round-trip latency to ~1-5ms. Choosing `eu-west` would add ~80ms of cross-Atlantic latency to every single query. **Always co-locate compute and database.**

3. **Create database:** The default `neondb` database is fine, or create a custom one like `serverless_api`.

4. **Get your connection string:** After creating the project, Neon shows your connection string. It looks like:

   ```
   postgresql://username:password@ep-xxxxx-xxxxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

   The same connection string works for both:
   - **Runtime** (HTTP queries): `@neondatabase/serverless` automatically converts it to HTTP queries.
   - **Drizzle Kit** (migrations, runs locally in Node.js): Uses it as a standard PostgreSQL connection string.

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
import * as schema from "./schemas";

/**
 * Module-level Neon HTTP database client (singleton).
 *
 * WHY A SINGLETON WITH FLUID COMPUTE:
 * With Fluid Compute, a single function instance handles MULTIPLE concurrent
 * requests. Module-level code runs once per instance and is shared across all
 * concurrent invocations. This means:
 *
 * 1. `neon()` creates the HTTP SQL function ONCE per instance
 * 2. All concurrent requests reuse the same `db` object
 * 3. Each `db.select()` / `db.insert()` still sends independent HTTP requests
 *    (Neon HTTP is stateless — no shared connection state to worry about)
 * 4. Zero overhead from recreating the Drizzle wrapper on every request
 *
 * WHY HTTP (not WebSocket or TCP Pool)?
 * - HTTP queries are atomic: one request → one response → done
 * - No connection setup overhead (no TCP handshake, no TLS negotiation)
 * - Each query is ~5-15ms vs ~50-100ms for WebSocket connection establishment
 * - Perfectly safe for concurrent access (each query is independent)
 *
 * UPGRADE PATH: With Fluid Compute's long-lived instances, WebSocket pooling
 * becomes viable in Phase 2+ for multi-query endpoints (e.g., transactions).
 */
const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

export type Database = typeof db;
```

> **Why a module-level singleton instead of a factory function?**
>
> In the previous Edge Runtime plan, we used a factory function (`createDb()`) because Edge isolates are short-lived and unpredictable. With Fluid Compute, instances persist across requests and handle concurrent invocations. A module-level singleton avoids recreating the Drizzle instance on every request. Since the Neon HTTP driver is stateless (each query is an independent HTTP call), sharing the `db` object across concurrent requests is completely safe.

### Step 8: Define the Tasks Schema

**File: `src/db/schemas/tasks.schema.ts`**

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

**File: `src/db/schemas/index.ts`** (barrel export)

```typescript
export * from "./tasks.schema";
```

> **Why barrel exports?** Drizzle Kit reads a single schema entry point. As you add more tables (`users.schema.ts`, `projects.schema.ts`, etc.), you just add `export * from "./users.schema"` here. The Drizzle config points to this one file.

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
  schema: "./src/db/schemas", // Schema files location
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

## Phase 4: Vercel Fluid Compute Configuration

### Step 11: Create `vercel.json`

**File: `vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "fluid": true,
  "regions": ["iad1"]
}
```

That's it. Three lines.

**Explanation of each setting:**

| Setting   | Value                  | Why                                                                                                                                                                                                                  |
| --------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema` | Vercel JSON schema URL | Enables IDE autocompletion and validation for `vercel.json` settings.                                                                                                                                                |
| `fluid`   | `true`                 | Explicitly enables Fluid Compute. While it's the default for new projects since April 2025, being explicit ensures it's always on regardless of project creation date.                                               |
| `regions` | `["iad1"]`             | **Critical.** Pins the function to Vercel's Washington D.C. region (`iad1`), which is the default Node.js function region and co-locates with Neon's `us-east-1`/`us-east-2`. This keeps DB query latency to ~1-5ms. |

> **⚠️ Why is `vercel.json` so simple now?**
>
> With the latest Vercel + Hono integration, **zero configuration is needed** for the basic setup:
>
> - **No `buildCommand`**: Vercel auto-detects Hono and handles bundling.
> - **No `outputDirectory`**: Vercel detects `src/index.ts` as the entry point automatically.
> - **No `rewrites`**: Vercel routes all requests to the Hono app; Hono's internal router handles path matching.
> - **No `functions.runtime`**: Fluid Compute with Node.js is the default. No need to specify `"edge"`.
> - **No `handle()` adapter**: Just `export default app` — Vercel understands Hono natively.
>
> We only need to set `regions` for database co-location and `fluid` for explicitness.

> **Region co-location explained:**
>
> By default, Vercel Node.js functions run in `iad1` (Washington D.C., US East). Our Neon database is also in US East. This means DB queries travel ~1-5ms within the same data center, not ~150ms across continents.
>
> If you need global low-latency in the future, consider Neon's read replicas in multiple regions combined with Vercel's multi-region functions (available on Pro/Enterprise plans).

### Step 12: Update the App Entry Point

**File: `src/index.ts`**

```typescript
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
```

**Key changes from the previous Edge Runtime plan:**

| Before (Edge Runtime)                             | Now (Fluid Compute)                       |
| ------------------------------------------------- | ----------------------------------------- |
| `import { handle } from "hono/vercel"`            | Not needed — Vercel detects Hono natively |
| `export const config = { runtime: "edge" }`       | Not needed — Fluid Compute is the default |
| `export default handle(app)`                      | `export default app`                      |
| Complex `vercel.json` with rewrites and functions | Minimal `vercel.json` with region + fluid |
| `credentials: false` (no cookies on Edge)         | `credentials: true` (Better Auth ready)   |

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
```

### Step 15: CORS Middleware

CORS is handled inline in `src/index.ts` using Hono's built-in `cors()` middleware (see Step 12). No separate file needed — Hono's implementation is battle-tested and handles preflight `OPTIONS` requests automatically.

**Important for Better Auth (Phase 10):** The CORS config already includes `credentials: true` and exposes relevant headers. This is required for Better Auth's cookie-based session management. When you add Better Auth, update `origin: "*"` to your specific frontend domain(s):

```typescript
cors({
  origin: ["https://your-app.com", "https://staging.your-app.com"],
  credentials: true
  // ...
});
```

### Step 16: Request ID Middleware

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

---

## Phase 6: Tasks CRUD Routes

### Step 17: Create Tasks Route Handlers

**File: `src/routes/tasks.routes.ts`**

```typescript
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
```

**Key changes from previous plan:**

- Uses `db` singleton import instead of `createDb()` factory per request
- Uses proper `and()` import from `drizzle-orm` instead of a runtime `require()`
- All route handlers are simpler — no DB creation overhead per request

**Performance patterns used throughout:**

| Pattern                                       | Impact                           | Explanation                                                 |
| --------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `.returning()` on all mutations               | -1 DB round-trip per mutation    | Returns the result in the same INSERT/UPDATE/DELETE query   |
| Explicit column selection in `.select({...})` | Less data serialized/transferred | Don't send unnecessary bytes over the wire                  |
| Zod validation before DB access               | Saves wasted DB queries          | Invalid requests are rejected at the middleware layer       |
| `.limit()` on all list queries                | Prevents unbounded result sets   | A table with 1M rows would crash without limits             |
| UUID validation regex                         | Prevents invalid DB queries      | PostgreSQL would error on invalid UUID; we catch it earlier |
| Module-level `db` singleton                   | Zero per-request overhead        | Shared across concurrent requests in Fluid Compute          |

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

#### Fluid Compute (Concurrency + Bytecode Caching)

```
Traditional Serverless:  [████████████████████████░░░░░] 250ms cold start, 1 req/instance
Fluid Compute (cold):   [████████████░░░░░░░░░░░░░░░░░] ~50-80ms (bytecode cached)
Fluid Compute (warm):   [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] ~0ms (instance reuse)
```

Fluid Compute eliminates most cold starts through concurrency (instances handle multiple requests) and pre-warming (production instances kept warm). When cold starts occur, bytecode caching reduces them from ~250ms to ~50-80ms.

#### Neon HTTP Driver (Stateless Queries)

```
Traditional Pool:    Connect(50ms) → Query(5ms) → Close(1ms)  = 56ms
Neon HTTP:           Query(10ms)                                = 10ms
```

No connection lifecycle overhead. Each query is a self-contained HTTP request. Safe for concurrent access across Fluid Compute invocations.

#### Region Co-Location (iad1)

```
Function(Tokyo) → DB(US East):    ████████████████ 150ms network
Function(iad1)  → DB(US East):    ██ 1-5ms network
```

Pinning the function to `iad1` (same AWS region as Neon) keeps network hop to ~1-5ms.

#### Drizzle ORM (Zero Runtime Overhead)

```
Prisma:   Parse Query → Engine Processing → Generate SQL → Execute  (50ms overhead)
Drizzle:  Generated SQL Literal → Execute                           (<1ms overhead)
```

Drizzle's SQL is generated at compile time. At runtime, it's essentially a string literal.

#### Minimal Bundle Size

```
Express + Prisma:   ~5MB bundle (slow to compile/cache bytecode)
Hono + Drizzle:     ~100KB bundle (instant bytecode caching)
```

Smaller bundles = faster bytecode compilation = faster cold starts when they occur.

#### Module-Level Singleton (Fluid Compute Advantage)

```
Factory pattern (old):  Per-request: neon() + drizzle() + query    = overhead per request
Singleton (new):        Per-instance: neon() + drizzle() once      = zero per-request overhead
                        Per-request: just the query                 = minimal overhead
```

With Fluid Compute's concurrency, the `db` singleton is created once and shared across all concurrent requests on the same instance.

### Step 20: Response Caching

For read-heavy endpoints, add Vercel Edge Cache headers:

```typescript
// In the GET /tasks list handler, add before returning:
c.header("Cache-Control", "public, s-maxage=1, stale-while-revalidate=59");
```

**What this does:**

- `s-maxage=1` — Vercel's CDN cache stores the response for 1 second
- `stale-while-revalidate=59` — For the next 59 seconds, serve the cached (stale) response immediately while revalidating in the background

**Result:** Repeated identical GET requests within 60 seconds are served from Vercel's CDN cache at **~0ms** — no function invocation, no database query.

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
bun run dev:vercel
```

This starts a local server (typically at `http://localhost:3000`) that emulates Vercel's routing and Fluid Compute behavior.

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
    "runtime": "nodejs-fluid"
  }
}
```

#### Create a Task

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement user authentication",
    "description": "Add Better Auth integration",
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
    "description": "Add Better Auth integration",
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

The `dur=12.50` means 12.5 milliseconds total processing time.

### Step 23: Verify Sub-100ms Performance

After deploying, check performance in three ways:

1. **`Server-Timing` header** — Every response includes the server-side processing time
2. **Vercel Observability** — Dashboard shows p50/p95/p99 latency, concurrency metrics, and cold start frequency
3. **Vercel Functions tab** — Shows Fluid Compute is active with concurrency and cost savings

Expected production numbers:

| Endpoint                | Expected Latency (warm) | Expected Latency (cold) | Notes                                   |
| ----------------------- | ----------------------- | ----------------------- | --------------------------------------- |
| `GET /api/health`       | 1-3ms                   | 50-80ms                 | No DB query, pure computation           |
| `GET /api/tasks`        | 10-25ms                 | 60-100ms                | Single SELECT query to Neon             |
| `GET /api/tasks/:id`    | 8-15ms                  | 55-90ms                 | Primary key lookup (fastest query type) |
| `POST /api/tasks`       | 15-30ms                 | 65-110ms                | INSERT + RETURNING                      |
| `PUT /api/tasks/:id`    | 15-30ms                 | 65-110ms                | UPDATE + RETURNING                      |
| `DELETE /api/tasks/:id` | 10-20ms                 | 60-100ms                | DELETE + RETURNING                      |

> **Cold starts are rare with Fluid Compute.** In production, >95% of requests hit warm instances due to concurrency (multiple requests per instance) and pre-warming. Cold start numbers above are worst-case scenarios for the first request to a brand-new deployment.

---

## Phase 9: Deployment

### Step 24: Deploy to Vercel

```bash
# Deploy to preview environment (creates a unique URL)
bun run deploy:vercel

# Check the preview deployment, then deploy to production
bun run deploy:vercel:prod
```

Before deploying, verify:

- [ ] `DATABASE_URL` is set in Vercel environment variables (Settings → Environment Variables)
- [ ] Neon database has been migrated (`bun run db:migrate`)
- [ ] `vercel.json` has `fluid: true` and `regions: ["iad1"]`

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

3. **Verify Fluid Compute in Vercel Dashboard:**
   - Go to your project → **Observability** tab → **Vercel Functions** section
   - Confirm Fluid Compute is active (you'll see concurrency and cost savings metrics)
   - Check the region shows **"iad1"**

4. **Check Performance Metrics:**
   - Look at p50, p95, p99 latency
   - Verify cold start frequency (should be very low)
   - Check saved GB-Hours from Fluid Compute's concurrency optimization
   - All warm request latencies should be well under 100ms

---

## Phase 10: Better Auth Integration (Next Phase)

> This phase will be implemented after the Tasks CRUD is stable. This section provides the architecture and integration guidance.

### Why Better Auth?

[Better Auth](https://www.better-auth.com/) is a modern, framework-agnostic authentication library designed for TypeScript. It provides:

- **Email/password, OAuth, magic links** — all built-in
- **Session management** — cookie-based, secure by default
- **Hono-native integration** — mounts directly on Hono routes
- **Database adapter for Drizzle** — uses your existing DB connection
- **Full Node.js API support** — uses `crypto`, cookies, sessions (this is why we chose Node.js + Fluid Compute over Edge Runtime)

### Why Fluid Compute Enables Better Auth

Better Auth requires full Node.js APIs that are **not available on Edge Runtime**:

| Feature           | Edge Runtime        | Node.js (Fluid Compute) |
| ----------------- | ------------------- | ----------------------- |
| `crypto.subtle`   | Partial             | ✅ Full                 |
| Cookie parsing    | Limited             | ✅ Full                 |
| Session storage   | Not possible        | ✅ Full                 |
| Database sessions | Complex workarounds | ✅ Native               |

This is the primary reason we chose **Node.js + Fluid Compute** over Edge Runtime. Better Auth works out of the box with zero compatibility issues.

### Architecture Preview

Better Auth will integrate into the existing project structure:

```
src/
├── index.ts                  # Mount Better Auth handler at /api/auth/*
├── lib/
│   └── auth.ts               # Better Auth configuration (Drizzle adapter, providers)
├── db/
│   └── schemas/
│       ├── index.ts           # Add auth schema exports
│       ├── tasks.schema.ts    # Existing
│       └── auth.schema.ts     # Better Auth tables (users, sessions, accounts)
├── middleware/
│   └── auth.middleware.ts     # Session validation middleware for protected routes
└── routes/
    └── tasks.routes.ts        # Add auth middleware to protect routes
```

### Integration Steps (High Level)

**Step 1: Install Better Auth**

```bash
bun add better-auth
```

**Step 2: Create auth configuration (`src/lib/auth.ts`)**

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg"
  }),
  emailAndPassword: {
    enabled: true
  }
  // Add OAuth providers, plugins, etc.
});
```

**Step 3: Mount auth handler in `src/index.ts`**

```typescript
import { auth } from "./lib/auth";

// Mount Better Auth — handles /api/auth/* routes automatically
app.on(["POST", "GET"], "/auth/*", (c) => {
  return auth.handler(c.req.raw);
});
```

**Step 4: Create session middleware (`src/middleware/auth.middleware.ts`)**

```typescript
app.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);
  await next();
});
```

**Step 5: Protect task routes**

```typescript
// In tasks.routes.ts — add auth check
.post("/", zValidator("json", createTaskSchema), async (c) => {
  const user = c.get("user");
  if (!user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
  // ... create task with user.id as owner
});
```

### Performance Impact of Better Auth

| Operation                    | Expected Additional Latency | Notes                                  |
| ---------------------------- | --------------------------- | -------------------------------------- |
| Session lookup (cookie → DB) | ~10-20ms                    | One DB query per authenticated request |
| Login/Register               | ~50-100ms                   | Password hashing + DB write            |
| OAuth callback               | ~100-200ms                  | External provider round-trip           |

Session lookups add ~10-20ms to authenticated requests. Combined with our existing ~10-30ms for CRUD operations, total authenticated request latency stays at **~20-50ms** — well under the 100ms target.

### CORS Considerations for Better Auth

The CORS middleware in Step 12 is already configured with `credentials: true`, which is required for Better Auth's cookie-based sessions. When you add Better Auth, you **must** change `origin: "*"` to specific domains:

```typescript
cors({
  origin: ["https://your-frontend.com"], // Wildcard "*" doesn't work with credentials
  credentials: true,
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["POST", "GET", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600
});
```

> **Note:** `credentials: true` with `origin: "*"` is rejected by browsers. You must specify exact origins when using cookies/credentials.

---

## Key Architectural Decisions

| Decision                        | Alternative                  | Why We Chose This                                                                                                                                                             |
| ------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js + Fluid Compute**     | Edge Runtime                 | Full Node.js API support (required for Better Auth). Concurrency + bytecode caching + pre-warming make cold starts rare and fast. Better enterprise compatibility.            |
| **Fluid Compute**               | Traditional Serverless       | Concurrency handles multiple requests per instance (fewer cold starts). Bytecode caching reduces cold start time. `waitUntil` enables background processing. Error isolation. |
| **Neon HTTP driver**            | WebSocket / TCP Pool         | Stateless one-shot queries — simplest, no connection management, safe for concurrent access. Consistent ~10-20ms per query. Upgrade to WebSocket pooling possible in Phase 2. |
| **Region co-location (`iad1`)** | Global distribution          | Database queries dominate latency. Co-locating reduces DB round-trip from ~150ms to ~1-5ms. `iad1` is Vercel's default Node.js region.                                        |
| **Drizzle ORM**                 | Prisma / TypeORM             | Zero runtime overhead, ~50KB vs ~4MB, works on all runtimes. Type-safe SQL generation. Native `neon-http` adapter.                                                            |
| **Hono**                        | Express / Fastify            | Web Standards-based, ~14KB, zero-config Vercel deployment (`export default app`). Native middleware ecosystem. Better Auth compatible.                                        |
| **`export default app`**        | `handle(app)` adapter        | Vercel natively detects Hono's default export. No adapter needed. Simpler code, fewer dependencies.                                                                           |
| **Module-level DB singleton**   | Factory function per request | Fluid Compute shares instances across concurrent requests. Singleton avoids per-request instantiation overhead.                                                               |
| **Zod validation**              | Manual validation            | Type-safe, composable, native Hono integration via `@hono/zod-validator`. Catches bad input before it hits the DB.                                                            |
| **`.returning()` pattern**      | INSERT then SELECT           | One DB round-trip instead of two. Halves mutation latency.                                                                                                                    |
| **UUID primary keys**           | Auto-increment integer       | No sequential bottleneck, generated server-side (`gen_random_uuid()`). Works well with distributed systems.                                                                   |
| **Better Auth (Phase 10)**      | JWT / custom auth            | Full-featured, Hono-native, Drizzle-adapter, session-based. Requires Node.js (enabled by Fluid Compute choice).                                                               |
| **Single function**             | One function per route       | Hono's internal router is faster than Vercel's inter-function routing. One function = maximum instance reuse with Fluid Compute concurrency.                                  |
| **Minimal `vercel.json`**       | Complex config               | Vercel auto-detects Hono. Only region and fluid settings are needed. Less config = fewer things to break.                                                                     |

---

## What's Next?

This tutorial covers **Phase 1-9** (Tasks CRUD) and **Phase 10** (Better Auth architecture). To build toward a full production enterprise API:

### Immediate Next Steps

- **Phase 10: Better Auth** — Implement the authentication layer described above
- **Phase 11: Protected Routes** — Add user ownership to tasks, role-based access control
- **Phase 12: WebSocket Connection Pooling** — Upgrade from HTTP to WebSocket driver for multi-query endpoints (transactions, batch operations). Fluid Compute's long-lived instances make connection pooling highly effective.

### Future Enhancements

- **Rate Limiting** — Use Vercel KV (Redis) or Neon-backed rate limiting
- **`waitUntil` for Background Tasks** — Offload logging, analytics, webhook notifications to run AFTER the response is sent
- **Database Branching** — Use Neon branches for preview deployments (each PR gets its own database)
- **OpenAPI Documentation** — Generate from Zod schemas using `@hono/zod-openapi`
- **Integration Tests** — Automated tests against a Neon branch
- **Multi-Region** — Add Neon read replicas + Vercel multi-region functions (Pro/Enterprise)
- **More Resources** — Users, Projects, Comments — following the same modular pattern

---

_Built with Hono + Neon + Drizzle on Vercel Fluid Compute. Every request under 100ms._
