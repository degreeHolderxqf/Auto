/**
 * Test: New user (no DB overrides) gets empty personal fields.
 * Personal data must NOT be used as defaults.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const testDataDir = path.join(__dirname, "data", "test_default");
if (!fs.existsSync(testDataDir)) fs.mkdirSync(testDataDir, { recursive: true });
process.env.DATABASE_PATH = path.join(testDataDir, "test_default.sqlite");
process.env.RESUME_PATH = "";
// Use empty .env-like values to simulate a new user with no overrides.
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.EMAIL_FROM;
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.SMTP_SECURE;
delete process.env.CANDIDATE_NAME;
delete process.env.CANDIDATE_ROLE;
delete process.env.CANDIDATE_EXPERIENCE;
delete process.env.CANDIDATE_EMAIL;
delete process.env.CANDIDATE_PHONE;
delete process.env.EVOLUTION_API_URL;
delete process.env.EVOLUTION_INSTANCE_NAME;

const settingsService = require("./src/services/settingsService");

const defaults = settingsService.getDefaults();

console.log("Default user-specific fields (should be empty):");
console.log({
  candidateName: defaults.candidateName,
  candidateEmail: defaults.candidateEmail,
  candidateRole: defaults.candidateRole,
  candidatePhone: defaults.candidatePhone,
  candidateSkills: defaults.candidateSkills,
  resumeFilename: defaults.resumeFilename,
  smtpHost: defaults.smtpHost,
  smtpUser: defaults.smtpUser,
  smtpPass: defaults.smtpPass,
  emailFrom: defaults.emailFrom,
  evolutionApiUrl: defaults.evolutionApiUrl,
  evolutionApiKey: defaults.evolutionApiKey,
  evolutionInstanceName: defaults.evolutionInstanceName
});

assert.strictEqual(defaults.candidateName, "", "candidateName should be empty for new user");
assert.strictEqual(defaults.candidateEmail, "", "candidateEmail should be empty for new user");
assert.strictEqual(defaults.candidateRole, "", "candidateRole should be empty for new user");
assert.strictEqual(defaults.smtpHost, "", "smtpHost should be empty for new user");
assert.strictEqual(defaults.smtpUser, "", "smtpUser should be empty for new user");
assert.strictEqual(defaults.smtpPass, "", "smtpPass should be empty for new user");
assert.strictEqual(defaults.emailFrom, "", "emailFrom should be empty for new user");
assert.strictEqual(defaults.evolutionApiUrl, "", "evolutionApiUrl should be empty for new user");
assert.strictEqual(defaults.evolutionApiKey, "", "evolutionApiKey should be empty for new user");
assert.strictEqual(defaults.evolutionInstanceName, "", "evolutionInstanceName should be empty for new user");
assert.deepStrictEqual(defaults.candidateSkills, [], "candidateSkills should be empty array");

// Public/global defaults ARE still pre-filled (these are application-level)
assert.strictEqual(defaults.targetCountry, "India", "Global default country should be India");
assert.ok(defaults.minAppRelevanceScore > 0, "Global default minAppRelevanceScore should be set");
assert.ok(defaults.emailDelayMs > 0, "Global default emailDelayMs should be set");

// Employee verification must remain OFF by default
assert.strictEqual(defaults.minEmployeeCount, null, "Employee verification must be OFF by default");

console.log("\n✅ All default-value tests passed. New users get empty personal fields.");
console.log("✅ Public/global defaults remain pre-filled.");
console.log("✅ Employee verification remains OFF by default.");
process.exit(0);
