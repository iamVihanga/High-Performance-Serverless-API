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
