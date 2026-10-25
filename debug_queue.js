const db = require('./src/db/database');
const rawDb = db.getRawDb();

// READY companies
const readyCompanies = rawDb.prepare("SELECT id, name FROM companies WHERE status = 'READY'").all();
console.log('=== READY COMPANIES (' + readyCompanies.length + ') ===');
for (const c of readyCompanies) {
  console.log('id=' + c.id + ' | ' + c.name);
}

console.log('\n=== CONTACTS FOR READY COMPANIES ===');
for (const c of readyCompanies) {
  const contacts = db.getContactsByCompanyId(c.id);
  console.log('id=' + c.id + ' ' + c.name + ' -> contacts: ' + contacts.length);
  for (const ct of contacts) {
    console.log('   email=' + ct.email + ' conf=' + ct.confidence + ' type=' + ct.email_type);
  }
}

console.log('\n=== EMAIL LOGS (SENT/DRY_RUN_SENT) ===');
const sentLogs = rawDb.prepare("SELECT company_id, email, status FROM email_logs WHERE status IN ('SENT', 'DRY_RUN_SENT')").all();
console.log('Total sent logs:', sentLogs.length);
const sentCompanyIds = new Set(sentLogs.map(l => l.company_id));
console.log('Distinct company_ids sent:', sentCompanyIds.size);

// Which READY companies have been emailed?
console.log('\n=== READY COMPANIES THAT WERE EMAILED ===');
for (const c of readyCompanies) {
  if (sentCompanyIds.has(c.id)) {
    console.log('Emailed: id=' + c.id + ' ' + c.name);
  }
}

// Check the actual ready queue query result
console.log('\n=== ACTUAL READY QUEUE QUERY ===');
const { whereSql, params } = db._buildReadyQueueWhere();
console.log('Where:', whereSql);
console.log('Params:', params);
const leads = db.getFinalQualifiedLeads(10);
console.log('Leads returned:', leads.length);
for (const l of leads) {
  console.log('  id=' + l.id + ' ' + l.name + ' status=' + l.status + ' app_relevance_score=' + l.app_relevance_score);
}
