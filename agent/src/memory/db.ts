import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config().DATABASE_URL, max: 8, idleTimeoutMillis: 30_000 });
    pool.on("error", (err) => {
      // Une connexion idle qui meurt ne doit pas tuer le process.
      console.error("pg pool error", err);
    });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
