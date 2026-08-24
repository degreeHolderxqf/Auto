/**
 * Automated Test Suite for Strict Employee-Size Verification (>= 30) & Email Eligibility
 * 
 * Verifies all 12 Required Test Cases + Edge Cases:
 * 1. LinkedIn: 51–200 -> ACCEPT
 * 2. LinkedIn: 201–500 -> ACCEPT
 * 3. LinkedIn: 11–50 (No other evidence) -> NOT ELIGIBLE
 * 4. LinkedIn: 11–50 + Official website confirms 42 employees -> ACCEPT
 * 5. Exact employee count: 30 -> ACCEPT
 * 6. Exact employee count: 29 -> REJECT
 * 7. Exact employee count: 100 -> ACCEPT
 * 8. Employee count unknown -> NOT ELIGIBLE
 * 9. LinkedIn: 11–50 + Secondary source: 25 -> REJECT
 * 10. LinkedIn: 11–50 + Secondary source: 35 -> ACCEPT
 * 11. Company already contacted -> EXCLUDE regardless of employee size
 * 12. Company already contacted but a new email is found -> EXCLUDE
 * 13. Range 1–10 employees -> REJECT
 * 14. Range 20–40 (no secondary proof) -> NOT ELIGIBLE (NEED MORE VERIFICATION)
 * 15. Single bound 10,000+ employees -> ACCEPT
 * 16. Conflicting evidence: LinkedIn 51–200 vs Website 18 -> CONFLICTING (Not eligible)
 */

const assert = require("assert");
const employeeVerifier = require("./src/services/employeeVerifier");
const db = require("./src/db/database");
const exclusionService = require("./src/services/exclusionService");

async function runTests() {
  console.log("\n=======================================================");
  console.log("🧪 RUNNING STRICT EMPLOYEE VERIFICATION TEST SUITE (16 CASES)");
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

  // 1. LinkedIn: 51–200 -> ACCEPT
  test("Test Case 1: LinkedIn 51–200 -> ACCEPT (min >= 30)", () => {
    const text = "Company size: 51-200 employees on LinkedIn";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "LinkedIn");
    const res = employeeVerifier.evaluateMultiSource(evidence, null);

    assert.strictEqual(res.isQualified, true, "Should be qualified");
    assert.strictEqual(res.employee_count_status, "QUALIFIED");
    assert.strictEqual(res.employee_count_min, 51);
    assert.strictEqual(res.employee_count_max, 200);
    assert.strictEqual(res.employee_size_range, "51-200");
    assert.strictEqual(res.employee_count_verified, 1);
  });

  // 2. LinkedIn: 201–500 -> ACCEPT
  test("Test Case 2: LinkedIn 201–500 -> ACCEPT (min >= 30)", () => {
    const text = "Headcount: 201-500 employees";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "LinkedIn");
    const res = employeeVerifier.evaluateMultiSource(evidence, null);

    assert.strictEqual(res.isQualified, true, "Should be qualified");
    assert.strictEqual(res.employee_count_status, "QUALIFIED");
    assert.strictEqual(res.employee_count_min, 201);
    assert.strictEqual(res.employee_count_max, 500);
  });

  // 3. LinkedIn: 11–50, No other evidence -> NOT ELIGIBLE
  test("Test Case 3: LinkedIn 11–50 (no other evidence) -> NOT ELIGIBLE (NEEDS VERIFICATION)", () => {
    const text = "Company size: 11-50 employees";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "LinkedIn");
    const res = employeeVerifier.evaluateMultiSource(evidence, null);

    assert.strictEqual(res.isQualified, false, "Must NOT be qualified automatically");
    assert.strictEqual(res.employee_count_status, "NEED_MORE_VERIFICATION");
    assert.strictEqual(res.employee_size_range, "11-50");
    assert.strictEqual(res.employee_count_verified, 0);
  });

  // 4. LinkedIn: 11–50 + Official website confirms 42 employees -> ACCEPT
  test("Test Case 4: LinkedIn 11–50 + Official website confirms 42 employees -> ACCEPT", () => {
    const linkedInText = "Company size: 11-50 employees";
    const websiteText = "Our in-house team has 42 employees globally building top stores";

    const prim = employeeVerifier.parseHeadcountEvidence(linkedInText, "LinkedIn");
    const sec = employeeVerifier.parseHeadcountEvidence(websiteText, "Official Website Homepage");
    const res = employeeVerifier.evaluateMultiSource(prim, sec);

    assert.strictEqual(res.isQualified, true, "Should be qualified via secondary verification");
    assert.strictEqual(res.employee_count_status, "QUALIFIED");
    assert.strictEqual(res.employee_count, 42);
    assert.strictEqual(res.employee_count_verified, 1);
    assert.ok(res.employee_count_source.includes("Official Website Homepage"));
  });

  // 5. Exact employee count: 30 -> ACCEPT
  test("Test Case 5: Exact employee count: 30 -> ACCEPT (>= 30 IS VALID)", () => {
    const text = "We have a strong workforce of 30 developers across our office";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "Website");
    const res = employeeVerifier.evaluateMultiSource(null, evidence);

    assert.strictEqual(res.isQualified, true, "30 is >= 30 and must be accepted");
    assert.strictEqual(res.employee_count_status, "QUALIFIED");
    assert.strictEqual(res.employee_count, 30);
    assert.strictEqual(res.employee_count_verified, 1);
  });

  // 6. Exact employee count: 29 -> REJECT
  test("Test Case 6: Exact employee count: 29 -> REJECT (< 30)", () => {
    const text = "Our full-time team of 29 employees builds custom apps";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "Website");
    const res = employeeVerifier.evaluateMultiSource(null, evidence);

    assert.strictEqual(res.isQualified, false, "29 is < 30 and must be rejected");
    assert.strictEqual(res.employee_count_status, "REJECTED");
    assert.strictEqual(res.employee_count, 29);
    assert.strictEqual(res.employee_count_verified, 0);
  });

  // 7. Exact employee count: 100 -> ACCEPT
  test("Test Case 7: Exact employee count: 100 -> ACCEPT", () => {
    const text = "Over 100 team members worldwide";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "Website");
    const res = employeeVerifier.evaluateMultiSource(null, evidence);

    assert.strictEqual(res.isQualified, true, "100 is >= 30");
    assert.strictEqual(res.employee_count_status, "QUALIFIED");
    assert.strictEqual(res.employee_count, 100);
    assert.strictEqual(res.employee_count_verified, 1);
  });

  // 8. Employee count unknown -> NOT ELIGIBLE
  test("Test Case 8: Employee count unknown -> NOT ELIGIBLE (UNKNOWN)", () => {
    const text = "We are an innovative Shopify agency with many great clients";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "Website");
    const res = employeeVerifier.evaluateMultiSource(null, evidence);

    assert.strictEqual(res.isQualified, false, "Unknown count must not qualify");
    assert.strictEqual(res.employee_count_status, "UNKNOWN");
    assert.strictEqual(res.employee_count_verified, 0);
  });

  // 9. LinkedIn: 11–50 + Secondary source: 25 -> REJECT
  test("Test Case 9: LinkedIn 11–50 + Secondary source: 25 -> REJECT (< 30)", () => {
    const linkedInText = "Company size: 11-50 employees";
    const websiteText = "Headcount of 25 specialists";

    const prim = employeeVerifier.parseHeadcountEvidence(linkedInText, "LinkedIn");
    const sec = employeeVerifier.parseHeadcountEvidence(websiteText, "Official Website");
    const res = employeeVerifier.evaluateMultiSource(prim, sec);

    assert.strictEqual(res.isQualified, false, "Secondary resolved count to 25 (< 30), must reject");
    assert.strictEqual(res.employee_count_status, "REJECTED");
    assert.strictEqual(res.employee_count, 25);
    assert.strictEqual(res.employee_count_verified, 0);
  });

  // 10. LinkedIn: 11–50 + Secondary source: 35 -> ACCEPT
  test("Test Case 10: LinkedIn 11–50 + Secondary source: 35 -> ACCEPT (>= 30)", () => {
    const linkedInText = "Company size: 11-50 employees";
    const websiteText = "A passionate staff of 35 engineers";

    const prim = employeeVerifier.parseHeadcountEvidence(linkedInText, "LinkedIn");
    const sec = employeeVerifier.parseHeadcountEvidence(websiteText, "Official Website");
    const res = employeeVerifier.evaluateMultiSource(prim, sec);

    assert.strictEqual(res.isQualified, true, "Secondary source 35 is >= 30, must accept");
    assert.strictEqual(res.employee_count_status, "QUALIFIED");
    assert.strictEqual(res.employee_count, 35);
    assert.strictEqual(res.employee_count_verified, 1);
  });

  // 11. Company already contacted -> EXCLUDE regardless of employee size
  test("Test Case 11: Company already contacted -> EXCLUDE regardless of employee size", () => {
    const testComp = db.upsertCompany({
      name: "Test Contacted Corp",
      normalized_name: "test contacted corp",
      domain: "testcontacted.com",
      employee_count: 150,
      employee_size_range: "51-200",
      employee_count_verified: 1,
      employee_count_status: "QUALIFIED",
      status: "CONTACTED"
    });

    const isContacted = db.hasBeenContacted(null, testComp.id);
    assert.strictEqual(isContacted, true, "Already contacted company must be excluded");

    const qualifiedLeads = db.getFinalQualifiedLeads(100);
    const inQualified = qualifiedLeads.some((l) => l.id === testComp.id);
    assert.strictEqual(inQualified, false, "Contacted company must NOT appear in final qualified leads");
  });

  // 12. Company already contacted but a new email is found -> EXCLUDE
  test("Test Case 12: Company already contacted but new email is found -> EXCLUDE", () => {
    const testComp = db.upsertCompany({
      name: "Test Contacted Again Corp",
      normalized_name: "test contacted again corp",
      domain: "testcontactedagain.com",
      employee_count: 85,
      employee_count_verified: 1,
      employee_count_status: "QUALIFIED",
      status: "DISCOVERED"
    });

    db.addEmailLog({
      company_id: testComp.id,
      email: "oldhr@testcontactedagain.com",
      subject: "Old Outreach",
      status: "SENT",
      attempts: 1
    });

    const checkOldEmail = db.hasBeenContacted("oldhr@testcontactedagain.com", testComp.id);
    const checkNewEmail = db.hasBeenContacted("newcareers@testcontactedagain.com", testComp.id);

    assert.strictEqual(checkOldEmail, true, "Old email must be flagged as contacted");
    assert.strictEqual(checkNewEmail, true, "Company ID check must exclude new email for previously contacted company");
  });

  // 13. Range 1–10 employees -> REJECT
  test("Test Case 13: Range 1–10 employees -> REJECT", () => {
    const text = "Company size: 1-10 employees";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "LinkedIn");
    const res = employeeVerifier.evaluateMultiSource(evidence, null);

    assert.strictEqual(res.isQualified, false, "1-10 employees must be rejected");
    assert.strictEqual(res.employee_count_status, "REJECTED");
    assert.strictEqual(res.employee_size_range, "1-10");
  });

  // 14. Range 20–40 (no secondary proof) -> NOT ELIGIBLE
  test("Test Case 14: Range 20–40 (no secondary proof) -> NOT ELIGIBLE", () => {
    const text = "Headcount 20-40 employees";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "Website");
    const res = employeeVerifier.evaluateMultiSource(null, evidence);

    assert.strictEqual(res.isQualified, false, "20-40 range is ambiguous and must not qualify alone");
    assert.strictEqual(res.employee_count_status, "NEED_MORE_VERIFICATION");
  });

  // 15. Single bound 10,000+ employees -> ACCEPT
  test("Test Case 15: Single bound 10,000+ employees -> ACCEPT", () => {
    const text = "10,000+ employees worldwide";
    const evidence = employeeVerifier.parseHeadcountEvidence(text, "LinkedIn");
    const res = employeeVerifier.evaluateMultiSource(evidence, null);

    assert.strictEqual(res.isQualified, true, "10000+ is >= 30 and must qualify");
    assert.strictEqual(res.employee_count_status, "QUALIFIED");
    assert.strictEqual(res.employee_count_min, 10000);
  });

  // 16. Conflicting evidence: LinkedIn 51–200 vs Website 18 -> CONFLICTING
  test("Test Case 16: Conflicting evidence (LinkedIn 51–200 vs Website 18) -> CONFLICTING", () => {
    const linkedInText = "Company size: 51-200 employees";
    const websiteText = "Our boutique team consists of 18 full-time designers";

    const prim = employeeVerifier.parseHeadcountEvidence(linkedInText, "LinkedIn");
    const sec = employeeVerifier.parseHeadcountEvidence(websiteText, "Official Website");
    const res = employeeVerifier.evaluateMultiSource(prim, sec);

    assert.strictEqual(res.isQualified, false, "Conflicting evidence must not qualify");
    assert.strictEqual(res.employee_count_status, "CONFLICTING");
  });

  console.log("\n=======================================================");
  console.log(`🏁 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
