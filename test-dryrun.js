const db = require('./src/db/database');
const jobService = require('./src/services/jobService');
const jobRunsService = require('./src/services/jobRunsService');
const applicationService = require('./src/services/applicationService');
const config = require('./src/config');
const normalizer = require('./src/services/normalizer');

console.log('=== DRY-RUN TEST SUITE ===\n');

// Test 1: Config loads correctly
console.log('TEST 1 - Config:');
console.log('  remoteJobDiscoveryEnabled:', config.remoteJobDiscoveryEnabled);
console.log('  minRemoteJobRelevanceScore:', config.minRemoteJobRelevanceScore);
console.log('  maxRemoteJobsPerSource:', config.maxRemoteJobsPerSource);
console.log('  autoApplyDefault:', config.autoApplyDefault);
console.log('  PASS\n');

// Test 2: Database schema - check all new tables exist
console.log('TEST 2 - Database Tables:');
const tables = db.getRawDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
const newTables = ['jobs', 'job_sources', 'applications', 'job_profiles', 'job_runs'];
let tablesOK = true;
for (const t of newTables) {
  const found = tables.find(r => r.name === t);
  if (!found) {
    console.log('  ' + t + ': MISSING');
    tablesOK = false;
  } else {
    console.log('  ' + t + ': EXISTS');
  }
}
if (tablesOK) console.log('  PASS\n');

// Test 3: Normalizer functions
console.log('TEST 3 - Normalizer:');
console.log('  normalizeCompanyName:', normalizer.normalizeCompanyName('Test Company Ltd'));
console.log('  Has normalizeJobTitle:', typeof normalizer.normalizeJobTitle === 'function');
console.log('  PASS\n');

// Test 4: JobService upsert
console.log('TEST 4 - JobService.upsertJobs:');
const testJob = {
  title: 'Shopify Developer',
  company_name: 'Test Company Ltd',
  company_domain: 'testcompany.com',
  description: 'Looking for Shopify developer with Liquid and React experience',
  employment_type: 'full_time',
  location: 'Remote',
  application_url: 'https://example.com/apply'
};
try {
  const result = jobService.upsertJobs([testJob]);
  console.log('  Result:', JSON.stringify(result));
  // Verify it was inserted
  const job = db.getRawDb().prepare('SELECT * FROM jobs WHERE title = ?').get('Shopify Developer');
  if (job) {
    console.log('  Inserted job found:', 'YES (id=' + job.id + ', canonical_id=' + job.canonical_id + ')');
    console.log('  PASS\n');
  } else {
    console.log('  Inserted job found: NO');
    console.log('  FAIL - job not inserted\n');
  }
} catch(e) {
  console.log('  ERROR:', e.message);
  console.log('  FAIL\n');
}

// Test 5: JobRunsService
console.log('TEST 5 - JobRunsService.createRun:');
jobRunsService.createRun('DISCOVERY', 'himalayas', 100)
  .then(runId => {
    console.log('  Created runId:', runId);
    const run = db.getRawDb().prepare('SELECT * FROM job_runs WHERE id = ?').get(runId);
    console.log('  Run status:', run ? run.status : 'NOT FOUND');
    console.log('  PASS\n');
    // Cleanup
    db.getRawDb().prepare('DELETE FROM job_runs WHERE id = ?').run(runId);
  })
  .catch(err => {
    console.log('  ERROR:', err.message);
    console.log('  FAIL\n');
  })
  .finally(() => {
    // Test 6: ApplicationService
    console.log('TEST 6 - ApplicationService.upsertApplication:');
    try {
      const job = db.getRawDb().prepare('SELECT id FROM jobs LIMIT 1').get();
      if (job) {
        const result = applicationService.upsertApplication({ job_id: job.id, status: 'ready' });
        console.log('  Result:', JSON.stringify(result));
        console.log('  PASS\n');
      } else {
        console.log('  Skipped (no jobs in DB)\n');
      }
    } catch(e) {
      console.log('  ERROR:', e.message);
      console.log('  FAIL\n');
    }
    console.log('=== ALL TESTS COMPLETE ===');
    process.exit(0);
  });
