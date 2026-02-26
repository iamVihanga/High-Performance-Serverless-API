import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// @ts-ignore
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export default defineConfig({
  out: "./src/db/migrations", // Migration files output directory
  schema: "./src/db/schemas", // Schema files location
  dialect: "postgresql",
  dbCredentials: {
    // @ts-ignore
    url: process.env.DATABASE_URL
  },
  verbose: true, // Log SQL during migrations
  strict: true // Fail on potentially destructive changes
});
