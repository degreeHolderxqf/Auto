const db = require('./src/db/database');

// Test freelance company CRUD
console.log('=== Testing freelance company operations ===');

// Test getFreelanceCompanyByDomain
const byDomain = db.getFreelanceCompanyByDomain('test.myshopify.com');
console.log('Get by domain (no data):', byDomain);

// Test upsertFreelanceCompany - create
const result1 = db.upsertFreelanceCompany({
  name: 'Test Development Store',
  normalized_name: 'test development store',
  domain: 'test.myshopify.com',
  shopify_store_url: 'https://test.myshopify.com',
  city: 'Toronto',
  state: 'ON',
  country: 'Canada',
  store_name: 'Test Dev Store',
  store_description: 'Custom Shopify development agency',
  installed_apps: ['shopify-cli', 'theme-scout'],
  tech_stack: ['Node.js', 'React', 'GraphQL'],
  product_count: 15,
  estimated_revenue: 250000,
  employee_count: 8,
  employee_count_min: 5,
  employee_count_max: 15,
  employee_size_range: '5-10',
  employee_count_source: 'website',
  employee_count_verified: true,
  employee_count_verified_at: new Date().toISOString(),
  employee_count_status: 'QUALIFIED',
  service_clarity_score: 35,
  portfolio_score: 28,
  tech_depth_score: 22,
  geographic_reach_score: 18,
  contact_accessibility_score: 30,
  responsiveness_score: 25,
  freelance_lead_score: 65,
  source: 'BRAVE_SEARCH',
  discovery_keywords: 'shopify development agency',
  status: 'READY'
});
console.log('Upsert result:', result1 ? 'SUCCESS - ID: ' + result1.id : 'FAILED');

// Test getFreelanceCompanyById
const byId = db.getFreelanceCompanyById(result1.id);
console.log('Get by ID:', byId ? 'SUCCESS - name:' + byId.name : 'FAILED');

// Test getAllFreelanceCompanies
const all = db.getAllFreelanceCompanies({ limit: 5 });
console.log('Get all:', all.length, 'companies');

// Test status update
const updated = db.updateFreelanceCompanyStatus(result1.id, 'QUALIFIED', 'Lead qualified after review');
console.log('Status update:', updated ? 'SUCCESS' : 'FAILED');

// Test exclusion
const isExcluded = db.isFreelanceExcluded('test development store', 'test.myshopify.com');
console.log('Is excluded before adding:', isExcluded ? 'YES' : 'NO');

db.addFreelanceExclusion('Test Development Store', 'test development store', 'test.myshopify.com', 'Manual exclusion');
const isExcludedAfter = db.isFreelanceExcluded('test development store', 'test.myshopify.com');
console.log('Is excluded after adding:', isExcludedAfter ? 'YES' : 'NO');

// Test contact CRUD
const contactResult = db.upsertFreelanceContact({
  company_id: result1.id,
  name: 'Sarah Johnson',
  role: 'Founder',
  email: 'sarah@testdevstore.com',
  email_type: 'Founder',
  confidence: 'HIGH',
  phone: '+1-416-555-0123',
  normalized_phone: '+14165550123',
  phone_type: 'mobile',
  phone_source: 'website',
  phone_source_url: 'https://test.myshopify.com/pages/contact',
  whatsapp_available: true,
  whatsapp_status: 'READY',
  source_url: 'https://test.myshopify.com/pages/contact',
  verified: true,
  mx_valid: true,
  notes: 'Founder and decision maker'
});
console.log('Upsert contact:', contactResult ? 'SUCCESS - ID: ' + contactResult.id : 'FAILED');

const bestContact = db.getBestFreelanceContactForCompany(result1.id);
console.log('Best contact:', bestContact ? bestContact.name : 'FAILED');

// Test sources
db.addFreelanceSource({
  company_id: result1.id,
  source_type: 'BRAVE_SEARCH',
  url: 'https://search.brave.com/search?q=test+shopify+development',
  title: 'Brave Search Result',
  evidence: 'Found via Brave search'
});
const sources = db.getFreelanceSourcesByCompanyId(result1.id);
console.log('Sources count:', sources.length);

// Test lead details
db.upsertFreelanceLeadDetails({
  company_id: result1.id,
  service_offerings: ['Shopify theme development', 'Custom app development', 'Store migration'],
  portfolio_items: ['E-commerce store A', 'Subscription box B'],
  client_testimonials: ['Great work!', 'Professional and reliable'],
  service_gaps: ['No ongoing support package'],
  tech_stack_evidence: ['Node.js', 'React', 'GraphQL'],
  geographic_evidence: ['Toronto-based, serves North America'],
  qualification_evidence: { found_via_search: true, dev_services_advertised: true },
  outreach_personalization: { reference: 'saw your custom theme work on X', value_prop: 'we can rebuild for scalability and performance' }
});
const leadDetails = db.getFreelanceLeadDetails(result1.id);
console.log('Lead details retrieved:', leadDetails ? 'SUCCESS' : 'FAILED');
if (leadDetails) {
  console.log('  Service offerings:', leadDetails.service_offerings.length);
  console.log('  Portfolio items:', leadDetails.portfolio_items.length);
}

// Test batch operations
const batchId = 'test-batch-' + Date.now();
db.createFreelanceOutreachBatch(batchId, 'email', 5, false);
const batch = db.getFreelanceOutreachBatch(batchId);
console.log('Batch created:', batch ? 'SUCCESS - status:' + batch.status : 'FAILED');

// Test adding items to batch
const dbRaw = db.getRawDb();
const insertItem = dbRaw.prepare(`
  INSERT INTO freelance_outreach_items
    (batch_id, company_id, position, status)
  VALUES (?, ?, ?, 'PENDING')
`);
insertItem.run(batchId, result1.id, 0);

const batchItems = db.getFreelanceOutreachBatchItems(batchId);
console.log('Batch items count:', batchItems.length);

// Test statistics
const stats = db.getFreelanceStatistics();
console.log('Freelance statistics:');
console.log('  Total discovered:', stats.totalDiscovered);
console.log('  Verified:', stats.verified);
console.log('  Qualified:', stats.qualified);
console.log('  Contactable:', stats.contactable);
console.log('  Outreach ready:', stats.outreachReady);
console.log('  Emails sent:', stats.sent);
console.log('  Exclusions:', stats.excluded);
console.log('  WhatsApp sent:', stats.whatsappSent);

console.log('\n=== All tests completed successfully ===');