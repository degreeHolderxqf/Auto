/**
 * Automated Test Suite for Dynamic Multi-User Settings System
 */

const assert = require("assert");
const settingsService = require("./src/services/settingsService");
const emailGenerator = require("./src/services/emailGenerator");
const db = require("./src/db/database");

async function runSettingsTests() {
  console.log("\n=======================================================");
  console.log("🧪 RUNNING DYNAMIC SETTINGS & MULTI-USER TEST SUITE");
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

  // 1. Get default settings
  test("Test 1: Default settings retrieval & structure", () => {
    const settings = settingsService.getSettings(true);
    assert.ok(settings.candidateName, "Candidate name should exist");
    assert.ok(settings.candidateRole, "Candidate role should exist");
    assert.ok(settings.smtpHost, "SMTP host should exist");
    assert.strictEqual(typeof settings.dryRun, "boolean", "dryRun should be boolean");
    assert.ok(Array.isArray(settings.candidateSkills), "candidateSkills should be an array");
  });

  // 2. Masking sensitive credentials
  test("Test 2: Password masking in public settings", () => {
    // Set a test password first
    settingsService.updateSettings({ smtpPass: "secret-app-password-123" });
    
    const publicSettings = settingsService.getSettings(true);
    assert.strictEqual(publicSettings.smtpPass, "••••••••", "Public password must be masked");

    const internalSettings = settingsService.getSettings(false);
    assert.strictEqual(internalSettings.smtpPass, "secret-app-password-123", "Internal password must be preserved");
  });

  // 3. Updating settings without changing password
  test("Test 3: Preserving password when sending masked placeholder", () => {
    settingsService.updateSettings({
      candidateName: "Alex Morgan",
      candidateRole: "Senior Shopify Plus Architect",
      candidateExperience: "5+ years",
      smtpPass: "••••••••" // Sent from UI
    });

    const internalSettings = settingsService.getSettings(false);
    assert.strictEqual(internalSettings.candidateName, "Alex Morgan");
    assert.strictEqual(internalSettings.candidateRole, "Senior Shopify Plus Architect");
    assert.strictEqual(internalSettings.candidateExperience, "5+ years");
    assert.strictEqual(internalSettings.smtpPass, "secret-app-password-123", "Password must remain unchanged");
  });

  // 4. Dynamic email generation with custom user profile
  test("Test 4: Email generator reflects dynamic profile immediately", () => {
    const mockCompany = {
      name: "Acme Commerce Co",
      app_relevance_score: 90,
      shopify_services: '["Custom Apps", "Theme Development"]'
    };

    const email = emailGenerator.generateEmail(mockCompany, { name: "Sarah Connor", email: "sarah@acme.com" });
    assert.ok(email.subject.includes("Senior Shopify Plus Architect"), "Subject must use dynamic role");
    assert.ok(email.text.includes("Alex Morgan"), "Body must use dynamic candidate name");
    assert.ok(email.text.includes("5+ years"), "Body must use dynamic experience");
    assert.ok(email.html.includes("Alex Morgan"), "HTML must use dynamic candidate name");
  });

  // 5. Configurable employee threshold update
  test("Test 5: Updating employee verification threshold dynamically", () => {
    settingsService.updateSettings({ minEmployeeCount: 50 });
    let current = settingsService.getSettings(false);
    assert.strictEqual(current.minEmployeeCount, 50, "Threshold should be updated to 50");

    settingsService.updateSettings({ minEmployeeCount: 0 }); // optional
    current = settingsService.getSettings(false);
    assert.strictEqual(current.minEmployeeCount, null, "Threshold 0 should normalize to null (optional)");
  });

  // 6. Restoring original settings
  test("Test 6: Restoring user settings", () => {
    settingsService.updateSettings({
      candidateName: "Himanshu Soni",
      candidateRole: "Shopify Developer",
      candidateExperience: "3 years",
      minEmployeeCount: 30
    });

    const restored = settingsService.getSettings(false);
    assert.strictEqual(restored.candidateName, "Himanshu Soni");
    assert.strictEqual(restored.candidateRole, "Shopify Developer");
    assert.strictEqual(restored.minEmployeeCount, 30);
  });

  console.log("\n=======================================================");
  console.log(`🏁 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runSettingsTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
