/**
 * Fix script: Research READY companies that have no contacts.
 *
 * ROOT CAUSE: 32 companies were marked READY status but never went through
 * the research pipeline, so they have zero contacts in the contacts table.
 *
 * This script finds READY companies with no contacts and runs them through
 * the research workflow to extract emails, phones, and calculate scores.
 */

const db = require('./src/db/database');
const exclusionService = require('./src/services/exclusionService');
const companyWebsite = require('./src/providers/companyWebsite');
const linkedInProvider = require('./src/providers/linkedInProvider');
const searchProvider = require('./src/providers/searchProvider');
const employeeVerifier = require('./src/services/employeeVerifier');
const validator = require('./src/services/validator');
const scoring = require('./src/services/scoring');
const normalizer = require('./src/services/normalizer');
const logger = require('./src/services/logger');

async function researchReadyCompany(company) {
  try {
    logger.info(`[${company.id}] Researching READY company: ${company.name} (domain: ${company.domain || 'none'})`);

    // Check if already contacted
    if (db.hasBeenContacted(null, company.id)) {
      logger.info(`  -> Already contacted, skipping`);
      return { companyId: company.id, status: "CONTACTED" };
    }

    // Check exclusions
    if (company.domain || company.name) {
      const exclusionCheck = exclusionService.isCompanyExcluded(company.name, company.domain);
      if (exclusionCheck.excluded) {
        db.upsertCompany({ id: company.id, status: "EXCLUDED", notes: exclusionCheck.reason });
        logger.info(`  -> Excluded: ${exclusionCheck.reason}`);
        return { companyId: company.id, status: "EXCLUDED" };
      }
    }

    let domain = company.domain;
    let officialWebsite = company.official_website;

    // Website research
    let webResearch = { contacts: [], careersUrl: null, linkedInUrl: null, publicApps: [], employeeInfo: null, employeeEvidence: null, sources: [], primaryPhone: null };

    if (domain || officialWebsite) {
      try {
        webResearch = await companyWebsite.researchWebsite(domain, officialWebsite);
        logger.info(`  -> Found ${webResearch.contacts.length} contacts, ${webResearch.sources.length} sources`);
      } catch (e) {
        logger.warn(`  -> Website research failed: ${e.message}`);
      }
    }

    // LinkedIn employee verification
    let linkedInEvidence = null;
    const linkedinUrl = company.linkedin_url || webResearch.linkedInUrl;
    if (linkedinUrl) {
      try {
        linkedInEvidence = await linkedInProvider.getCompanyHeadcount(linkedinUrl);
        if (linkedInEvidence) {
          logger.info(`  -> LinkedIn headcount: ${linkedInEvidence.employee_count || linkedInEvidence.employee_size_range || 'unknown'}`);
        }
      } catch (e) {
        logger.warn(`  -> LinkedIn failed: ${e.message}`);
      }
    }

    // Evaluate employee count
    const secondaryEvidence = webResearch.employeeEvidence || webResearch.employeeInfo;
    const evalResult = employeeVerifier.evaluateMultiSource(linkedInEvidence, secondaryEvidence);
    logger.info(`  -> Employee eval: ${evalResult.isQualified ? 'QUALIFIED' : evalResult.employee_count_status} (${evalResult.reason})`);

    // Employee threshold is OFF by default (MIN_EMPLOYEE_COUNT not set)
    // Override: treat as qualified if threshold is disabled
    const isQualified = evalResult.isQualified || true; // Employee verification OFF
    const employeeQualified = evalResult.isQualified;

    // Extract contacts
    const primaryPhone = webResearch.primaryPhone || null;
    let bestContact = null;

    for (const rawContact of webResearch.contacts) {
      const mxValid = await validator.checkMxRecords(rawContact.email);
      const contact = db.upsertContact({
        company_id: company.id,
        email: rawContact.email,
        email_type: rawContact.email_type,
        confidence: rawContact.confidence,
        source_url: rawContact.source_url,
        phone: rawContact.phone || (primaryPhone ? primaryPhone.phone : null),
        normalized_phone: rawContact.normalized_phone || (primaryPhone ? primaryPhone.normalized_phone : null),
        phone_type: rawContact.phone_type || (primaryPhone ? primaryPhone.phone_type : null),
        phone_source: "Website Crawling",
        phone_source_url: rawContact.source_url || (primaryPhone ? primaryPhone.source_url : null),
        whatsapp_available: rawContact.whatsapp_available || (primaryPhone ? primaryPhone.whatsapp_available : "unknown"),
        whatsapp_status: "READY",
        verified: 1,
        mx_valid: mxValid ? 1 : 0,
        notes: "Discovered during research fix"
      });
      if (!bestContact || rawContact.confidence === "HIGH") {
        bestContact = contact;
      }
    }

    // Search for additional contacts if no HR contact found
    if (!bestContact || bestContact.email_type !== "HR / Recruitment") {
      try {
        const searchRes = await searchProvider.searchHiringContacts(company.name, domain);
        for (const sc of searchRes.contacts) {
          const mxValid = await validator.checkMxRecords(sc.email);
          const contact = db.upsertContact({
            company_id: company.id,
            email: sc.email,
            email_type: sc.email_type,
            confidence: sc.confidence,
            source_url: sc.source_url,
            phone: primaryPhone ? primaryPhone.phone : null,
            normalized_phone: primaryPhone ? primaryPhone.normalized_phone : null,
            phone_type: primaryPhone ? primaryPhone.phone_type : null,
            phone_source: "Web Search",
            phone_source_url: null,
            whatsapp_available: primaryPhone ? primaryPhone.whatsapp_available : "unknown",
            whatsapp_status: "READY",
            verified: 1,
            mx_valid: mxValid ? 1 : 0,
            notes: "Discovered via search"
          });
          if (!bestContact) bestContact = contact;
        }
      } catch (e) {
        logger.warn(`  -> Search failed: ${e.message}`);
      }
    }

    // Calculate scores
    const servicesText = company.shopify_services || "";
    const appRelevanceScore = scoring.calculateAppRelevance(servicesText, "", company.partner_tier, []);
    const allContacts = db.getContactsByCompanyId(company.id);
    const actualBest = allContacts[0] || bestContact;
    const leadScore = scoring.calculateLeadScore(
      { app_relevance_score: appRelevanceScore, partner_tier: company.partner_tier, rating: company.rating, reviews: company.reviews, public_apps: company.public_apps, shopify_services: company.shopify_services },
      actualBest
    );

    // Determine final status
    let finalStatus = "NO_CONTACT";
    if (actualBest && ["HIGH", "MEDIUM"].includes(actualBest.confidence)) {
      finalStatus = "READY";
    } else if (appRelevanceScore < 50) {
      finalStatus = "LOW_RELEVANCE";
    }

    // Update company
    db.upsertCompany({
      id: company.id,
      employee_count: evalResult.employee_count || null,
      employee_count_min: evalResult.employee_count_min || null,
      employee_count_max: evalResult.employee_count_max || null,
      employee_size_range: evalResult.employee_size_range || null,
      employee_count_source: evalResult.employee_count_source || null,
      employee_count_source_url: evalResult.employee_count_source_url || null,
      employee_count_verified: evalResult.employee_count_status === "QUALIFIED" ? 1 : 0,
      employee_count_verified_at: evalResult.employee_count_verified_at || null,
      employee_count_status: evalResult.employee_count_status || null,
      app_relevance_score: appRelevanceScore,
      lead_score: leadScore,
      careers_url: webResearch.careersUrl || null,
      linkedin_url: linkedinUrl || null,
      phone: primaryPhone ? primaryPhone.phone : null,
      normalized_phone: primaryPhone ? primaryPhone.normalized_phone : null,
      phone_type: primaryPhone ? primaryPhone.phone_type : null,
      whatsapp_available: primaryPhone ? primaryPhone.whatsapp_available : "unknown",
      status: finalStatus,
      notes: evalResult.reason || null
    });

    logger.info(`  -> Result: ${finalStatus} | Score: ${leadScore} | Contacts: ${allContacts.length} | Email: ${actualBest ? actualBest.email : 'none'}`);

    return {
      companyId: company.id,
      name: company.name,
      status: finalStatus,
      contacts: allContacts.length,
      leadScore,
      bestEmail: actualBest ? actualBest.email : null
    };
  } catch (error) {
    logger.error(`[${company.id}] Error researching ${company.name}:`, error);
    return { companyId: company.id, name: company.name, status: "ERROR", error: error.message };
  }
}

async function main() {
  await exclusionService.init();

  const rawDb = db.getRawDb();

  // Find READY companies with no contacts
  const readyWithoutContacts = rawDb.prepare(`
    SELECT c.* FROM companies c
    WHERE c.status = 'READY'
    AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id)
  `).all();

  logger.section(`Fixing READY Companies Without Contacts`);
  logger.info(`Found ${readyWithoutContacts.length} READY companies with no contacts`);

  if (readyWithoutContacts.length === 0) {
    logger.success(`No READY companies without contacts found. Ready Queue is healthy.`);
    const stats = db.getStatistics();
    logger.info(`Ready Queue Count: ${stats.readyToSend}`);
    return;
  }

  let researchSuccess = 0;
  let researchFailed = 0;

  for (const company of readyWithoutContacts) {
    logger.progress(readyWithoutContacts.indexOf(company) + 1, readyWithoutContacts.length, company.name);
    const result = await researchReadyCompany(company);
    if (result.status === "READY" || result.status === "NO_CONTACT" || result.status === "LOW_RELEVANCE") {
      researchSuccess++;
    } else {
      researchFailed++;
    }
    // Polite delay
    await new Promise(r => setTimeout(r, 1000));
  }

  logger.section(`Research Fix Complete`);
  logger.info(`Successfully researched: ${researchSuccess}`);
  logger.info(`Failed: ${researchFailed}`);

  const finalQueueCount = db.getReadyQueueCount();
  logger.success(`Ready Queue Count: ${finalQueueCount}`);

  const stats = db.getStatistics();
  console.table({
    "Total Companies": stats.totalDiscovered,
    "Ready to Send": stats.readyToSend,
    "Total Contacts": stats.totalContacts,
    "Emails Sent": stats.sent,
    "Emails Failed": stats.failed
  });
}

main().catch(console.error);
