import "server-only";
import { mkdirSync } from "node:fs";
import { openDb, type Db } from "./core/db";

// One PGlite instance per server process. Kept on globalThis so dev-mode hot
// reloads reuse it instead of opening the same data directory twice.
const g = globalThis as unknown as { __featureBoardDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!g.__featureBoardDb) {
    const dir = process.env.DATABASE_DIR ?? ".data/pglite";
    if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
    g.__featureBoardDb = openDb(dir);
  }
  return g.__featureBoardDb;
}
