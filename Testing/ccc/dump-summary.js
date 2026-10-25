const { DatabaseSync } = require("node:sqlite");
const path = require("path");

// Use absolute path to database
const databasePath = path.join(__dirname, "data", "leads.sqlite");
const db = new DatabaseSync(databasePath);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();

console.log("=== DATABASE SUMMARY ===");
console.log(`Database: ${config.databasePath}`);
console.log(`Total tables: ${tables.length}`);
console.log("");

for (const table of tables) {
  const tableName = table.name;
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get().count;

  // Get table schema info
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();

  console.log(`📊 ${tableName}: ${count} rows (${columns.length} columns)`);
}

// Detailed stats for companies
console.log("\n=== COMPANIES STATUS BREAKDOWN ===");
const statuses = db.prepare("SELECT status, COUNT(*) as count FROM companies GROUP BY status ORDER BY count DESC").all();
statuses.forEach(s => console.log(`  ${s.status}: ${s.count}`));

console.log("\n=== COMPANIES SOURCE BREAKDOWN ===");
const sources = db.prepare("SELECT source, COUNT(*) as count FROM companies GROUP BY source ORDER BY count DESC").all();
sources.forEach(s => console.log(`  ${s.source}: ${s.count}`));

console.log("\n=== COMPANIES APP_RELEVANCE_SCORE DISTRIBUTION ===");
const scores = db.prepare("SELECT CASE WHEN app_relevance_score >= 70 THEN '70+' WHEN app_relevance_score >= 50 THEN '50-69' WHEN app_relevance_score >= 30 THEN '30-49' ELSE '<30' END as range, COUNT(*) as count FROM companies GROUP BY range ORDER BY range").all();
scores.forEach(s => console.log(`  ${s.range}: ${s.count}`));

console.log("\n=== COMPANIES LEAD_SCORE DISTRIBUTION ===");
const leadScores = db.prepare("SELECT CASE WHEN lead_score >= 70 THEN '70+' WHEN lead_score >= 50 THEN '50-69' WHEN lead_score >= 30 THEN '30-49' ELSE '<30' END as range, COUNT(*) as count FROM companies GROUP BY range ORDER BY range").all();
leadScores.forEach(s => console.log(`  ${s.range}: ${s.count}`));

// Top companies by lead_score
console.log("\n=== TOP 10 COMPANIES BY LEAD_SCORE ===");
const topCompanies = db.prepare("SELECT id, name, domain, lead_score, app_relevance_score, employee_count, status FROM companies ORDER BY lead_score DESC LIMIT 10").all();
topCompanies.forEach(c => console.log(`  #${c.id}: ${c.name} (${c.domain}) | lead:${c.lead_score} | relevance:${c.app_relevance_score} | emp:${c.employee_count} | ${c.status}`));

// Contacts summary
console.log("\n=== CONTACTS SUMMARY ===");
const totalContacts = db.prepare("SELECT COUNT(*) as count FROM contacts").get().count;
const highConf = db.prepare("SELECT COUNT(*) as count FROM contacts WHERE confidence = 'HIGH'").get().count;
const medConf = db.prepare("SELECT COUNT(*) as count FROM contacts WHERE confidence = 'MEDIUM'").get().count;
const lowConf = db.prepare("SELECT COUNT(*) as count FROM contacts WHERE confidence = 'LOW'").get().count;
console.log(`  Total contacts: ${totalContacts}`);
console.log(`  High confidence: ${highConf}`);
console.log(`  Medium confidence: ${medConf}`);
console.log(`  Low confidence: ${lowConf}`);

// Email logs
console.log("\n=== EMAIL LOGS SUMMARY ===");
const totalEmailLogs = db.prepare("SELECT COUNT(*) as count FROM email_logs").get().count;
const sentEmails = db.prepare("SELECT COUNT(*) as count FROM email_logs WHERE status = 'SENT'").get().count;
const failedEmails = db.prepare("SELECT COUNT(*) as count FROM email_logs WHERE status = 'FAILED'").get().count;
console.log(`  Total email logs: ${totalEmailLogs}`);
console.log(`  Sent: ${sentEmails}`);
console.log(`  Failed: ${failedEmails}`);

// WhatsApp logs
console.log("\n=== WHATSAPP LOGS SUMMARY ===");
const totalWAMessages = db.prepare("SELECT COUNT(*) as count FROM whatsapp_logs").get().count;
const sentWA = db.prepare("SELECT COUNT(*) as count FROM whatsapp_logs WHERE status = 'SENT'").get().count;
console.log(`  Total WhatsApp messages: ${totalWAMessages}`);
console.log(`  Sent: ${sentWA}`);

// Exclusions
console.log("\n=== EXCLUSIONS ===");
const totalExclusions = db.prepare("SELECT COUNT(*) as count FROM exclusions").get().count;
console.log(`  Total exclusions: ${totalExclusions}`);

// Settings
console.log("\n=== SETTINGS ===");
const allSettings = db.prepare("SELECT key, value FROM settings").all();
console.log(`  Total settings: ${allSettings.length}`);
allSettings.forEach(s => console.log(`  ${s.key}: ${s.value}`));

// Job runs
console.log("\n=== JOB RUNS ===");
const jobRuns = db.prepare("SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 10").all();
jobRuns.forEach(jr => console.log(`  ${jr.id} | type:${jr.type} | status:${jr.status} | processed:${jr.processed_count} | started:${jr.started_at}`));

// Email batches
console.log("\n=== EMAIL BATCHES ===");
const batches = db.prepare("SELECT id, mode, status, total, sent, failed, pending, processing FROM email_batches ORDER BY updated_at DESC").all();
batches.forEach(b => console.log(`  ${b.id} | mode:${b.mode} | status:${b.status} | total:${b.total} sent:${b.sent} failed:${b.failed} pending:${b.pending} processing:${b.processing}`));

// Applications count
console.log("\n=== APPLICATIONS ===");
const totalApps = db.prepare("SELECT COUNT(*) as count FROM applications").get().count;
const readyApps = db.prepare("SELECT COUNT(*) as count FROM applications WHERE status = 'ready'").get().count;
console.log(`  Total applications: ${totalApps} (ready: ${readyApps})`);

// Jobs
console.log("\n=== JOBS ===");
const totalJobs = db.prepare("SELECT COUNT(*) as count FROM jobs").get().count;
console.log(`  Total jobs: ${totalJobs}`);

db.close();
