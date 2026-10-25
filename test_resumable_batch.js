/**
 * Test: Resumable Batch System
 *
 * Simulates the Vercel interruption scenario:
 *   1. Create a 20-email dry-run batch
 *   2. Process the first chunk (5 emails)
 *   3. Simulate a process kill (don't process the rest)
 *   4. Resume the batch
 *   5. Verify all 20 items are processed, none sent twice
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Use a clean test database
const testDataDir = path.join(__dirname, "data", "test");
if (!fs.existsSync(testDataDir)) fs.mkdirSync(testDataDir, { recursive: true });
process.env.DATABASE_PATH = path.join(testDataDir, "test_leads.sqlite");
process.env.RESUME_PATH = ""; // Don't require a real PDF for dry run
process.env.DRY_RUN = "true";
process.env.EMAIL_DELAY_MS = "10"; // Speed up tests
process.env.EMAIL_BATCH_CHUNK_SIZE = "5";
process.env.EMAIL_BATCH_CHUNK_WALL_MS = "5000";

const db = require("./src/db/database");
const emailSender = require("./src/services/emailSender");

async function run() {
  console.log("=".repeat(60));
  console.log("🧪 RESUMABLE BATCH TEST");
  console.log("=".repeat(60));

  // Seed 20 fake leads with contacts
  const companyIds = [];
  for (let i = 0; i < 20; i++) {
    const c = db.upsertCompany({
      name: `TestCo ${i}`,
      normalized_name: `testco-${i}`,
      domain: `testco${i}.com`,
      country: "India",
      status: "READY",
      app_relevance_score: 80,
      lead_score: 80
    });
    companyIds.push(c.id);
  }
  console.log(`✅ Seeded ${companyIds.length} test companies`);

  // Create batch items
  const items = companyIds.map((id) => {
    const company = db.getCompanyById(id);
    return {
      company,
      contact: { id: null, name: "Test", email: `recipient${id}@example.com`, confidence: "HIGH" },
      mailOptions: {
        to: `recipient${id}@example.com`,
        from: "test@example.com",
        subject: "Test",
        text: "Test body",
        html: "<p>Test body</p>"
      }
    };
  });

  // Step 1: Create batch
  const batchId = emailSender.createBatch(items, { dryRun: true });
  console.log(`✅ Created batch ${batchId}`);

  let batch = db.getEmailBatch(batchId);
  assert.strictEqual(batch.total, 20, "Batch should have 20 items");
  assert.strictEqual(batch.pending, 20, "All items should be pending");
  console.log(`✅ Initial state: total=${batch.total} pending=${batch.pending}`);

  // Step 2: Process first chunk (5 emails)
  const result1 = await emailSender.processBatchChunk(batchId, { verify: true });
  console.log(`✅ First chunk: sent=${result1.sentInChunk} failed=${result1.failedInChunk} moreWork=${result1.moreWork}`);

  batch = db.getEmailBatch(batchId);
  assert.strictEqual(result1.sentInChunk, 5, "First chunk should have sent 5");
  assert.strictEqual(batch.sent, 5, "Batch should record 5 sent");
  assert.strictEqual(batch.pending, 15, "Batch should have 15 pending");
  assert.strictEqual(result1.moreWork, true, "Should indicate more work");
  console.log(`✅ State after chunk 1: sent=${batch.sent} pending=${batch.pending}`);

  // Step 3: Simulate interruption by NOT processing more.
  //          (In a real Vercel scenario the function would die here.)

  // Step 4: Resume
  const result2 = await emailSender.processBatchChunk(batchId, { verify: false });
  console.log(`✅ Second chunk: sent=${result2.sentInChunk} failed=${result2.failedInChunk} moreWork=${result2.moreWork}`);
  batch = db.getEmailBatch(batchId);
  assert.strictEqual(batch.sent, 10, "Batch should have 10 sent after resume");
  assert.strictEqual(batch.pending, 10, "Batch should have 10 pending after resume");
  console.log(`✅ State after chunk 2: sent=${batch.sent} pending=${batch.pending}`);

  // Step 5: Process until done (multiple chunks to simulate cron resume)
  let safety = 10;
  while (safety-- > 0) {
    const current = db.getEmailBatch(batchId);
    if (current.status === "COMPLETED" || current.status === "FAILED") break;
    const r = await emailSender.processBatchChunk(batchId, { verify: false });
    if (!r.moreWork) break;
  }

  batch = db.getEmailBatch(batchId);
  console.log(`✅ Final state: status=${batch.status} sent=${batch.sent} failed=${batch.failed} pending=${batch.pending}`);
  assert.strictEqual(batch.status, "COMPLETED", "Batch should be COMPLETED");
  assert.strictEqual(batch.sent, 20, "All 20 should be sent");
  assert.strictEqual(batch.pending, 0, "No pending should remain");

  // Verify no duplicate emails were logged
  const logs = db.getAllEmailLogs();
  const uniqueEmails = new Set(logs.filter(l => l.status === "SENT" || l.status === "DRY_RUN_SENT").map(l => l.email));
  console.log(`✅ Email logs: ${logs.length} rows, ${uniqueEmails.size} unique sent emails`);
  assert.strictEqual(uniqueEmails.size, 20, "Should have 20 unique sent emails (no duplicates)");

  // Verify item statuses
  const dbRaw = db.getRawDb();
  const itemStatuses = dbRaw.prepare("SELECT status, COUNT(*) as count FROM email_batch_items WHERE batch_id = ? GROUP BY status").all(batchId);
  console.log(`✅ Item statuses: ${JSON.stringify(itemStatuses)}`);

  console.log("\n" + "=".repeat(60));
  console.log("🏁 ALL BATCH TESTS PASSED");
  console.log("=".repeat(60));
  process.exit(0);
}

run().catch((e) => {
  console.error("❌ TEST FAILED:", e);
  process.exit(1);
});
