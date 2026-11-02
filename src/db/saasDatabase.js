const fs = require("node:fs/promises");
const path = require("node:path");

let pool;

function getSaasPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    const error = new Error("DATABASE_URL must point to a durable PostgreSQL database before SaaS endpoints are enabled");
    error.statusCode = 503;
    throw error;
  }

  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number.parseInt(process.env.SAAS_DB_POOL_MAX || "10", 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
  pool.on("error", (error) => {
    console.error("[SAAS_DB] Unexpected PostgreSQL pool error:", error.message);
  });
  return pool;
}

async function runSaasMigration() {
  const database = getSaasPool();
  const client = await database.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [82741021]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS saas_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);

    const version = "001_initial";
    const alreadyApplied = await client.query(
      "SELECT 1 FROM saas_schema_migrations WHERE version = $1",
      [version]
    );
    if (alreadyApplied.rowCount > 0) {
      await client.query("COMMIT");
      return { applied: false, version };
    }

    const migrationPath = path.join(__dirname, "saas", `${version}.sql`);
    const sql = await fs.readFile(migrationPath, "utf8");
    await client.query(sql);
    await client.query(
      "INSERT INTO saas_schema_migrations (version) VALUES ($1)",
      [version]
    );
    await client.query("COMMIT");
    return { applied: true, version };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getSaasPool, runSaasMigration };
