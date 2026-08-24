const shopifyDirectory = require("../providers/shopifyDirectory");
const companyWebsite = require("../providers/companyWebsite");
const searchProvider = require("../providers/searchProvider");
const exclusionService = require("../services/exclusionService");
const validator = require("../services/validator");
const scoring = require("../services/scoring");
const normalizer = require("../services/normalizer");
const db = require("../db/database");
const logger = require("../services/logger");

async function researchCompany(company) {
  try {
    let officialWebsite = company.official_website;
    let domain = company.domain;
    let services = [];
    let partnerTier = company.partner_tier;
    let rating = company.rating;
    let reviews = company.reviews;
    let city = company.city;
    let linkedinUrl = company.linkedin_url;

    // 1. Fetch Partner Profile Page if not already populated
    if (company.shopify_partner_url) {
      const profile = await shopifyDirectory.fetchPartnerProfile(company.shopify_partner_url);
      if (profile) {
        officialWebsite = officialWebsite || profile.official_website;
        domain = domain || profile.domain;
        services = profile.shopify_services || [];
        partnerTier = profile.partner_tier || partnerTier;
        rating = profile.rating != null ? profile.rating : rating;
        reviews = profile.reviews || reviews;
        city = profile.city || city;
        linkedinUrl = profile.linkedin_url || linkedinUrl;

        // If profile listed an email, record it as a contact
        if (profile.listed_email && validator.isValidEmailFormat(profile.listed_email)) {
          const mxValid = await validator.checkMxRecords(profile.listed_email);
          db.upsertContact({
            company_id: company.id,
            email: profile.listed_email,
            email_type: validator.classifyEmailType(profile.listed_email),
            confidence: "HIGH",
            source_url: company.shopify_partner_url,
            verified: 1,
            mx_valid: mxValid ? 1 : 0,
            notes: "Found directly on official Shopify Partner Directory Profile"
          });
        }
      }
    }

    // 2. Check exclusions with newly discovered domain
    if (domain) {
      const exclusionCheck = exclusionService.isCompanyExcluded(company.name, domain);
      if (exclusionCheck.excluded) {
        db.upsertCompany({
          ...company,
          domain,
          official_website: officialWebsite,
          partner_tier: partnerTier,
          status: "EXCLUDED",
          notes: exclusionCheck.reason
        });
        return { companyId: company.id, status: "EXCLUDED", reason: exclusionCheck.reason };
      }
    }

    // 3. Crawl Official Company Website
    let webResearch = { contacts: [], careersUrl: null, linkedInUrl: null, publicApps: [], sources: [] };
    if (domain || officialWebsite) {
      webResearch = await companyWebsite.researchWebsite(domain, officialWebsite);
    }

    linkedinUrl = linkedinUrl || webResearch.linkedInUrl;

    // 4. Record Discovered Sources
    webResearch.sources.forEach((s) => {
      db.addSource({
        company_id: company.id,
        source_type: s.source_type,
        url: s.url,
        title: s.title,
        evidence: s.evidence
      });
    });

    // 5. Validate & Save Website Contacts
    for (const rawContact of webResearch.contacts) {
      const mxValid = await validator.checkMxRecords(rawContact.email);
      db.upsertContact({
        company_id: company.id,
        email: rawContact.email,
        email_type: rawContact.email_type,
        confidence: rawContact.confidence,
        source_url: rawContact.source_url,
        verified: 1,
        mx_valid: mxValid ? 1 : 0,
        notes: "Discovered on official company website"
      });
    }

    // 6. If no HR contact yet, query Search Provider (no synthetic guessing)
    const currentContacts = db.getContactsByCompanyId(company.id);
    const hasHrContact = currentContacts.some((c) => c.email_type === "HR / Recruitment" && c.confidence !== "LOW");

    if (!hasHrContact && (company.name || domain)) {
      const searchRes = await searchProvider.searchHiringContacts(company.name, domain);
      for (const sc of searchRes.contacts) {
        const mxValid = await validator.checkMxRecords(sc.email);
        db.upsertContact({
          company_id: company.id,
          email: sc.email,
          email_type: sc.email_type,
          confidence: sc.confidence,
          source_url: sc.source_url,
          verified: 1,
          mx_valid: mxValid ? 1 : 0,
          notes: "Discovered via public search snippet"
        });
      }
    }

    // 7. Calculate Scores
    const servicesStr = services.join(", ");
    const appRelevanceScore = scoring.calculateAppRelevance(servicesStr, "", partnerTier, webResearch.publicApps);
    
    // Retrieve best contact after all providers ran
    const allCompanyContacts = db.getContactsByCompanyId(company.id);
    const bestContact = allCompanyContacts[0] || null;

    const leadScore = scoring.calculateLeadScore(
      {
        app_relevance_score: appRelevanceScore,
        partner_tier: partnerTier,
        rating,
        reviews,
        public_apps: webResearch.publicApps.join(", "),
        shopify_services: servicesStr
      },
      bestContact
    );

    // Determine final status
    let finalStatus = "RESEARCHED";
    if (bestContact && ["HIGH", "MEDIUM"].includes(bestContact.confidence)) {
      finalStatus = "READY";
    } else if (appRelevanceScore < 50) {
      finalStatus = "LOW_RELEVANCE";
    } else {
      finalStatus = "NO_CONTACT";
    }

    // 8. Update Company in Database (Immediate Checkpoint)
    db.upsertCompany({
      id: company.id,
      name: company.name,
      normalized_name: company.normalized_name,
      domain,
      shopify_partner_url: company.shopify_partner_url,
      official_website: officialWebsite,
      city: city || company.city,
      country: company.country || "India",
      partner_tier: partnerTier,
      rating,
      reviews,
      app_relevance_score: appRelevanceScore,
      lead_score: leadScore,
      shopify_services: servicesStr,
      public_apps: webResearch.publicApps.join(", "),
      careers_url: webResearch.careersUrl,
      linkedin_url: linkedinUrl,
      status: finalStatus
    });

    const contactLog = bestContact ? `${bestContact.email} (${bestContact.confidence}, ${bestContact.email_type})` : "None found (Strict No-Guess)";
    logger.info(`   Relevance: ${appRelevanceScore} | Lead Score: ${leadScore} | Contact: ${contactLog} | Status: ${finalStatus}`);

    return {
      companyId: company.id,
      name: company.name,
      appRelevanceScore,
      leadScore,
      bestContact,
      status: finalStatus
    };
  } catch (err) {
    logger.error(`Error researching company ${company.name}`, err);
    try {
      db.updateCompanyStatus(company.id, "RESEARCH_ERROR", err.message);
    } catch (e) {
      // ignore secondary db error
    }
    return { companyId: company.id, status: "ERROR", error: err.message };
  }
}

async function runResearch(options = {}) {
  logger.section("Starting Company Research Pipeline");

  await exclusionService.init();

  const pendingCompanies = db.getAllCompanies({ status: "DISCOVERED" });
  logger.info(`Found ${pendingCompanies.length} pending candidate companies to research.`);

  let processed = 0;
  let readyCount = 0;
  let noContactCount = 0;
  let errorCount = 0;

  for (let i = 0; i < pendingCompanies.length; i++) {
    const comp = pendingCompanies[i];
    logger.progress(i + 1, pendingCompanies.length, comp.name);

    const res = await researchCompany(comp);
    processed++;

    if (res.status === "READY") readyCount++;
    else if (res.status === "NO_CONTACT") noContactCount++;
    else if (res.status === "ERROR") errorCount++;

    // Polite delay between company websites
    await new Promise((r) => setTimeout(r, 600));
  }

  logger.section("Research Pipeline Completed");
  logger.info(`Processed    : ${processed}`);
  logger.info(`Ready Leads  : ${readyCount}`);
  logger.info(`No Contact   : ${noContactCount}`);
  logger.info(`Errors       : ${errorCount}`);

  return { processed, readyCount, noContactCount, errorCount };
}

module.exports = { runResearch, researchCompany };
