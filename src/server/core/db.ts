import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Db = PGlite;
/** Anything that can run a query: the database itself or an open transaction. */
export type Q = Pick<PGlite, "query"> | Transaction;

const schemaPath = join(process.cwd(), "src/server/schema.sql");

/** Opens a PGlite database and applies the schema. `memory://` for tests. */
export async function openDb(dataDir = "memory://"): Promise<Db> {
  const db = await PGlite.create(dataDir);
  await db.exec(readFileSync(schemaPath, "utf8"));
  return db;
}

export async function one<T>(q: Q, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await q.query<T>(sql, params);
  return res.rows[0];
}

export async function many<T>(q: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await q.query<T>(sql, params);
  return res.rows;
}
