const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const config = require("./src/config");

const db = new DatabaseSync(config.databasePath);

// Get all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("=== DATABASE TABLES ===");
tables.forEach(t => console.log(t.name));

for (const table of tables) {
  const tableName = table.name;

  // Get column info
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const colNames = columns.map(c => c.name).join(", ");

  // Get row count
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get();

  console.log(`\n=== ${tableName.toUpperCase()} (${count.count} rows) ===`);
  console.log(`Columns: ${colNames}`);

  // Get all rows
  if (count.count > 0) {
    const rows = db.prepare(`SELECT * FROM ${tableName}`).all();
    console.log(JSON.stringify(rows, null, 2));
  }
}

// Close database
db.close();