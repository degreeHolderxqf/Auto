const db = require('./src/db/database');
const rawDb = db.getRawDb();

// Check companies with contacts
const withContacts = rawDb.prepare(`
  SELECT c.id, c.name, c.status, c.app_relevance_score, c.source,
         ct.email, ct.confidence, ct.email_type
  FROM companies c
  LEFT JOIN (
    SELECT * FROM contacts
    GROUP BY company_id
    HAVING min(
      CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END * 10 +
      CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
    )
  ) ct ON ct.company_id = c.id
  WHERE ct.email IS NOT NULL
  ORDER BY c.status, c.app_relevance_score DESC
  LIMIT 20
`).all();

console.log('=== COMPANIES WITH CONTACTS (top 20) ===');
for (const c of withContacts) {
  console.log('id=' + c.id + ' | status=' + c.status + ' | score=' + c.app_relevance_score + ' | source=' + c.source + ' | email=' + c.email + ' | conf=' + c.confidence);
}

// Count companies by status with contacts
const byStatusWithContacts = rawDb.prepare(`
  SELECT c.status, COUNT(*) as count
  FROM companies c
  JOIN (
    SELECT * FROM contacts
    GROUP BY company_id
    HAVING min(
      CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END * 10 +
      CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
    )
  ) ct ON ct.company_id = c.id
  GROUP BY c.status
`).all();

console.log('\n=== BY STATUS (with contacts) ===');
for (const r of byStatusWithContacts) {
  console.log(r.status + ': ' + r.count);
}

// Count NOT emailed
const emailedCompanyIds = new Set(
  rawDb.prepare("SELECT DISTINCT company_id FROM email_logs WHERE status IN ('SENT', 'DRY_RUN_SENT')").all().map(r => r.company_id)
);
const emailedEmails = new Set(
  rawDb.prepare("SELECT DISTINCT email FROM email_logs WHERE status IN ('SENT', 'DRY_RUN_SENT')").all().map(r => r.email)
);

const readyWithContactsNotEmailed = withContacts.filter(c =>
  c.status === 'READY' &&
  !emailedCompanyIds.has(c.id) &&
  c.email && !emailedEmails.has(c.email)
);
console.log('\n=== READY + CONTACTS + NOT EMAILED ===');
console.log('Count:', readyWithContactsNotEmailed.length);

// Check DISCOVERED with contacts
const discoveredWithContacts = withContacts.filter(c => c.status === 'DISCOVERED');
console.log('\n=== DISCOVERED + CONTACTS (top 10) ===');
console.log('Count:', discoveredWithContacts.length);
for (const c of discoveredWithContacts.slice(0, 10)) {
  console.log('id=' + c.id + ' | score=' + c.app_relevance_score + ' | email=' + c.email + ' | conf=' + c.confidence);
}

// Check if app_relevance_score filter is blocking
const minScore = 70;
const allReadyWithContacts = withContacts.filter(c => c.status === 'READY');
const allReadyAboveThreshold = allReadyWithContacts.filter(c => c.app_relevance_score >= minScore);
console.log('\n=== READY + CONTACTS + score>=70 ===');
console.log('Total READY with contacts:', allReadyWithContacts.length);
console.log('Above threshold:', allReadyAboveThreshold.length);
for (const c of allReadyAboveThreshold) {
  console.log('id=' + c.id + ' | score=' + c.app_relevance_score + ' | email=' + c.email + ' | emailed=' + emailedCompanyIds.has(c.id));
}
