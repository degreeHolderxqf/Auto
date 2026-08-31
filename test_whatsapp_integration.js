/**
 * Comprehensive Automated Test Suite for WhatsApp Outreach & Evolution Go Integration
 */

const assert = require("assert");
const validator = require("./src/services/validator");
const whatsappGenerator = require("./src/services/whatsappGenerator");
const evolutionGoClient = require("./src/services/evolutionGoClient");
const whatsappWorkflow = require("./src/workflows/whatsappWorkflow");
const db = require("./src/db/database");
const settingsService = require("./src/services/settingsService");

async function runWhatsAppTests() {
  console.log("\n=======================================================");
  console.log("🧪 RUNNING WHATSAPP OUTREACH & EVOLUTION GO TEST SUITE");
  console.log("=======================================================\n");

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  async function asyncTest(name, fn) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  // 1. Phone Normalization (E.164)
  test("Test 1: Normalizing Indian mobile and landline numbers", () => {
    const norm1 = validator.normalizePhone("9876543210", "IN");
    assert.ok(norm1, "Should normalize valid 10-digit Indian mobile");
    assert.strictEqual(norm1.e164, "+919876543210");
    assert.strictEqual(norm1.country, "IN");

    const norm2 = validator.normalizePhone("+91 98765 43210", "IN");
    assert.ok(norm2);
    assert.strictEqual(norm2.e164, "+919876543210");

    const invalid = validator.normalizePhone("12345", "IN");
    assert.strictEqual(invalid, null, "Invalid length must return null");
  });

  // 2. Extracting Phones from wa.me and tel: links
  test("Test 2: Extracting WhatsApp direct links (wa.me & api.whatsapp.com)", () => {
    const html = `
      <div>
        <a href="https://wa.me/919876543210">Chat on WhatsApp</a>
        <a href="tel:+918012345678">Call Us</a>
      </div>
    `;
    const phones = validator.extractPhones(html, "IN", "https://example.com");
    assert.strictEqual(phones.length, 2, "Should extract both WhatsApp and tel link");
    
    const waPhone = phones.find((p) => p.whatsapp_available === "yes");
    assert.ok(waPhone, "Should identify WhatsApp link");
    assert.strictEqual(waPhone.normalized_phone, "+919876543210");
  });

  // 3. Strict Filtering: Customer Support, Sales Inquiry, Toll-Free 1800 Numbers
  test("Test 3: Strict filtering of sales, customer support, and toll-free helpline numbers", () => {
    const htmlWithSupport = `
      <div>
        <p>Customer Care & Support Helpline: 1800-111-2222</p>
        <p>Sales Inquiry Hotline: +91 91234 56789 (Call for pricing)</p>
        <p>For Careers & Recruitment: +91 99887 76655</p>
      </div>
    `;
    const phones = validator.extractPhones(htmlWithSupport, "IN", "https://example.com");
    
    // 1800 must be ignored
    assert.ok(!phones.some((p) => p.normalized_phone.includes("1800")), "Toll-free 1800 must be ignored");
    
    // Sales hotline must be ignored
    assert.ok(!phones.some((p) => p.normalized_phone === "+919123456789"), "Sales hotline must be ignored");
    
    // Careers / HR number must be kept
    const hrPhone = phones.find((p) => p.normalized_phone === "+919988776655");
    assert.ok(hrPhone, "Careers/Recruitment phone must be accepted");
    assert.strictEqual(hrPhone.phone_type, "HR / RECRUITMENT");
  });

  // 4. Personalized WhatsApp Message Generator
  test("Test 4: WhatsApp message generation with dynamic candidate details", () => {
    const mockCompany = {
      name: "Apex Shopify Studio",
      phone: "+919876543210"
    };
    const mockContact = {
      name: "Ananya Sharma",
      phone: "+919876543210"
    };

    const msg = whatsappGenerator.generateMessage(mockCompany, mockContact);
    assert.ok(msg.text.includes("Hi Ananya Sharma,"), "Should greet contact by name if available");
    assert.ok(msg.text.includes("Shopify Developer"), "Should include candidate role");
    assert.ok(msg.text.includes("Himanshu Soni"), "Should include candidate signature");

    // Without named contact
    const genericMsg = whatsappGenerator.generateMessage(mockCompany, null);
    assert.ok(genericMsg.text.includes("Hi Apex Shopify Studio Team,"), "Should fallback to company team greeting");
  });

  // 5. Duplicate Protection & Opt-Out Checks in DB
  await asyncTest("Test 5: Duplicate and opt-out guardrails in SQLite database", async () => {
    const uniqueSuffix = Math.floor(100000 + Math.random() * 900000);
    const testPhone = `+9198${uniqueSuffix}11`;

    const testCompany = db.upsertCompany({
      name: `Test WA Corp ${uniqueSuffix}`,
      normalized_name: `test-wa-corp-${uniqueSuffix}`,
      domain: `testwacorp${uniqueSuffix}.com`,
      phone: testPhone,
      normalized_phone: testPhone,
      status: "READY"
    });

    // Check not contacted initially
    assert.strictEqual(db.isWhatsAppContacted(testCompany.id, testPhone), false);
    assert.strictEqual(db.isWhatsAppOptedOut(testPhone), false);

    // Simulate opt-out webhook trigger
    db.logWhatsAppMessage({
      company_id: testCompany.id,
      phone: testPhone,
      message: "STOP",
      status: "OPTED_OUT"
    });

    assert.strictEqual(db.isWhatsAppOptedOut(testPhone), true, "Phone must be recognized as opted-out");
  });

  // 6. WhatsApp Dry Run Workflow Simulation
  await asyncTest("Test 6: WhatsApp Dry Run execution (no real network request)", async () => {
    // Ensure DRY RUN is true
    settingsService.updateSettings({ whatsAppDryRun: true });

    const uniqueSuffix = Math.floor(100000 + Math.random() * 900000);
    const testPhone = `+9199${uniqueSuffix}22`;

    const company = db.upsertCompany({
      name: `Dry Run Digital ${uniqueSuffix}`,
      normalized_name: `dry-run-digital-${uniqueSuffix}`,
      domain: `dryrundigital${uniqueSuffix}.com`,
      phone: testPhone,
      normalized_phone: testPhone,
      status: "READY"
    });

    const res = await whatsappWorkflow.sendSingleMessage(company.id);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.dryRun, true);
    assert.ok(res.messageId.startsWith("dry_run_"));

    // Verify logged in whatsapp_logs
    const logs = db.getWhatsAppLogsByCompany(company.id);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].status, "DRY_RUN_SENT");

    // Second send should be blocked by duplicate protection
    const dupRes = await whatsappWorkflow.sendSingleMessage(company.id);
    assert.strictEqual(dupRes.success, false);
    assert.ok(dupRes.error.includes("already been contacted"), "Duplicate send must be prevented");
  });

  // 7. WhatsApp Send Number Normalization (for Evolution API payload)
  test("Test 7: Evolution API WhatsApp recipient number normalization", () => {
    assert.strictEqual(evolutionGoClient.normalizeSendNumber("+91 98765 43210"), "919876543210");
    assert.strictEqual(evolutionGoClient.normalizeSendNumber("9876543210"), "919876543210", "10-digit Indian mobile should auto-prefix 91");
    assert.strictEqual(evolutionGoClient.normalizeSendNumber("09876543210"), "919876543210", "Leading 0 should be stripped and prefixed with 91");
    assert.strictEqual(evolutionGoClient.normalizeSendNumber("+1 (555) 123-4567"), "15551234567");
    assert.strictEqual(evolutionGoClient.normalizeSendNumber("123"), null, "Too short must return null");
  });

  // 8. Evolution API Health Check & Simulated Connection
  await asyncTest("Test 8: Evolution API health check and simulated session toggle", async () => {
    const health = await evolutionGoClient.checkHealth();
    assert.ok(typeof health.online === "boolean", "Health check must return online status");

    // Simulated connection toggle
    evolutionGoClient.setSimulatedConnected(true);
    const connState = await evolutionGoClient.getConnectionState();
    assert.strictEqual(connState.connected, true);
    assert.strictEqual(connState.state, "CONNECTED");

    evolutionGoClient.setSimulatedConnected(false);
  });

  console.log("\n=======================================================");
  console.log(`🏁 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runWhatsAppTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
