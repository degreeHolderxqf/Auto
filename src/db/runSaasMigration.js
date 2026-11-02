const { getSaasPool, runSaasMigration } = require("./saasDatabase");

async function main() {
  let pool;
  try {
    pool = getSaasPool();
    const result = await runSaasMigration();
    console.info(result.applied
      ? `Applied SaaS database migration ${result.version}`
      : `SaaS database migration ${result.version} is already applied`);
  } catch (error) {
    console.error("SaaS database migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

main();
