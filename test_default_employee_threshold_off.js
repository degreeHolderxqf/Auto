const assert = require('assert');
const config = require('./src/config');
const settingsService = require('./src/services/settingsService');

assert.strictEqual(config.minEmployeeCount, null, 'config.minEmployeeCount should default to null/off');
assert.strictEqual(settingsService.getDefaults().minEmployeeCount, null, 'settings defaults should keep employee verification off by default');

console.log('default employee threshold tests passed');
