process.env.DATABASE_PATH = ":memory:";
process.env.MIN_EMPLOYEE_COUNT = "";
process.env.MIN_EMPLOYEES = "";

const assert = require('assert');
const config = require('./src/config');
const db = require('./src/db/database');
const settingsService = require('./src/services/settingsService');

assert.strictEqual(config.minEmployeeCount, null, 'config.minEmployeeCount should default to null/off');
assert.strictEqual(settingsService.getDefaults().minEmployeeCount, null, 'settings defaults should keep employee verification off by default');

const database = db.getRawDb();
const companyResult = database.prepare(`
  INSERT INTO companies (name, normalized_name, status, app_relevance_score)
  VALUES ('Queue Test Store', 'queue test store', 'DISCOVERED', 70)
`).run();
database.prepare(`
  INSERT INTO contacts (company_id, email, confidence, email_type)
  VALUES (?, 'queue-test@example.com', 'MEDIUM', 'General')
`).run(Number(companyResult.lastInsertRowid));
db.saveSetting('minEmployeeCount', 30);

const settings = settingsService.getSettings(false);
assert.strictEqual(settings.minEmployeeCount, null, 'a stale saved 30+ default should be cleared when env threshold is blank');
assert.strictEqual(db.getAllSettings().minEmployeeCount, null, 'the stale saved threshold should be cleared persistently');
assert.strictEqual(settingsService.getSettings(false).minEmployeeCount, null, 'the disabled threshold should remain null after reloading settings');
assert.strictEqual(config.minEmployeeCount, null, 'reloading settings should keep the runtime filter disabled');
assert.strictEqual(db.getReadyQueueCount(), 1, 'a contactable lead without headcount should remain ready when filtering is disabled');

config.minEmployeeCount = 30;
assert.strictEqual(db.getReadyQueueCount(), 0, 'an explicitly enabled 30+ threshold should still filter unknown headcount');

db.saveSetting('minEmployeeCount', null);
assert.strictEqual(settingsService.getSettings(false).minEmployeeCount, null, 'an empty persisted setting should normalize to disabled');
assert.strictEqual(db.getReadyQueueCount(), 1, 'an empty persisted setting should not silently exclude leads');

console.log('default employee threshold tests passed');
