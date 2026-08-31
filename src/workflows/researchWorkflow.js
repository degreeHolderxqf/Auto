const shopifyDirectory = require("../providers/shopifyDirectory");
const companyWebsite = require("../providers/companyWebsite");
const linkedInProvider = require("../providers/linkedInProvider");
const searchProvider = require("../providers/searchProvider");
const exclusionService = require("../services/exclusionService");
const employeeVerifier = require("../services/employeeVerifier");
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

    // 1. Check if company is already contacted or excluded
    if (db.hasBeenContacted(null, company.id)) {
      db.updateCompanyStatus(company.id, "CONTACTED", "Previously Contacted Lead");
      return { companyId: company.id, status: "CONTACTED", reason: "Previously Contacted Lead" };
    }

    if (domain || company.name) {
      const exclusionCheck = exclusionService.isCompanyExcluded(company.name, domain);
      if (exclusionCheck.excluded) {
        db.upsertCompany({
          ...company,
          domain,
          status: "EXCLUDED",
          notes: exclusionCheck.reason
        });
        return { companyId: company.id, status: "EXCLUDED", reason: exclusionCheck.reason };
      }
    }

    // 2. Fetch Partner Profile Page if available
    let partnerProfileEvidence = null;
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

        if (company.shopify_services || (services && services.length > 0)) {
          const serviceText = [
            typeof company.shopify_services === "string" ? company.shopify_services : "",
            Array.isArray(services) ? services.join(" ") : ""
          ].join(" ");
          partnerProfileEvidence = employeeVerifier.parseHeadcountEvidence(serviceText, "Shopify Partner Profile", company.shopify_partner_url);
        }
      }
    }

    // Check exclusion again with newly discovered domain
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

    // 3. Employee-Size Verification Step (BEFORE expensive email discovery)
    // Source Priority: PRIMARY = LinkedIn -> SECONDARY = Official Website / About / Careers / Directory

    // Primary: LinkedIn
    let linkedInEvidence = null;
    if (linkedinUrl) {
      linkedInEvidence = await linkedInProvider.getCompanyHeadcount(linkedinUrl);
    }

    // Secondary: Official Company Website (Homepage, About, Careers, Team)
    let webResearch = { contacts: [], careersUrl: null, linkedInUrl: null, publicApps: [], employeeInfo: null, employeeEvidence: null, sources: [] };
    if (domain || officialWebsite) {
      webResearch = await companyWebsite.researchWebsite(domain, officialWebsite);
    }

    linkedinUrl = linkedinUrl || webResearch.linkedInUrl;
    if (!linkedInEvidence && linkedinUrl) {
      linkedInEvidence = await linkedInProvider.getCompanyHeadcount(linkedinUrl);
    }

    let secondaryEvidence = webResearch.employeeEvidence || webResearch.employeeInfo || partnerProfileEvidence;
    if ((!secondaryEvidence || secondaryEvidence.status === "UNKNOWN") && partnerProfileEvidence && partnerProfileEvidence.status !== "UNKNOWN") {
      secondaryEvidence = partnerProfileEvidence;
    }

    // Evaluate Multi-Source Decision Logic
    const evalResult = employeeVerifier.evaluateMultiSource(linkedInEvidence, secondaryEvidence);

    // Save Discovered Evidence Sources
    if (webResearch.sources && webResearch.sources.length > 0) {
      webResearch.sources.forEach((s) => {
        db.addSource({
          company_id: company.id,
          source_type: s.source_type,
          url: s.url,
          title: s.title,
          evidence: s.evidence
        });
      });
    }

    if (evalResult.employee_count_source_url) {
      db.addSource({
        company_id: company.id,
        source_type: "Employee Verification Evidence",
        url: evalResult.employee_count_source_url,
        title: evalResult.employee_count_source || "Headcount Evidence",
        evidence: evalResult.reason
      });
    }

    // 4. If NOT Qualified (employee_count < 30, uncertain, conflicting, unknown):
    // DO NOT discover contacts, DO NOT query search provider, DO NOT qualify as active lead!
    if (!evalResult.isQualified) {
      const finalStatus = evalResult.employee_count_status === "REJECTED" ? "REJECTED_HEADCOUNT" : "NOT_ELIGIBLE";
      
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
        employee_count: evalResult.employee_count,
        employee_count_min: evalResult.employee_count_min,
        employee_count_max: evalResult.employee_count_max,
        employee_size_range: evalResult.employee_size_range,
        employee_count_source: evalResult.employee_count_source,
        employee_count_source_url: evalResult.employee_count_source_url,
        employee_count_verified: 0,
        employee_count_verified_at: evalResult.employee_count_verified_at,
        employee_count_status: evalResult.employee_count_status,
        status: finalStatus,
        notes: evalResult.reason
      });

      logger.warn(`   Excluded ${company.name}: ${evalResult.reason} [Status: ${evalResult.employee_count_status}]`);
      return {
        companyId: company.id,
        name: company.name,
        status: finalStatus,
        employee_count: evalResult.employee_count,
        employee_count_status: evalResult.employee_count_status,
        reason: evalResult.reason
      };
    }

    // 5. Company IS QUALIFIED (>= 30 verified) -> Proceed with Email Discovery & Validation
    const primaryPhone = webResearch.primaryPhone || null;

    for (const rawContact of webResearch.contacts) {
      const mxValid = await validator.checkMxRecords(rawContact.email);
      db.upsertContact({
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
        notes: "Discovered on official company website"
      });
    }

    // If no HR contact yet, query Search Provider for hiring contacts
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
          phone: primaryPhone ? primaryPhone.phone : null,
          normalized_phone: primaryPhone ? primaryPhone.normalized_phone : null,
          phone_type: primaryPhone ? primaryPhone.phone_type : null,
          phone_source: "Website Crawling",
          phone_source_url: primaryPhone ? primaryPhone.source_url : null,
          whatsapp_available: primaryPhone ? primaryPhone.whatsapp_available : "unknown",
          whatsapp_status: "READY",
          verified: 1,
          mx_valid: mxValid ? 1 : 0,
          notes: "Discovered via public search snippet"
        });
      }
    }

    // 6. Calculate Scores
    const servicesStr = services.join(", ");
    const appRelevanceScore = scoring.calculateAppRelevance(servicesStr, "", partnerTier, webResearch.publicApps);
    
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

    // 7. Save Verified Company in Database
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
      employee_count: evalResult.employee_count,
      employee_count_min: evalResult.employee_count_min,
      employee_count_max: evalResult.employee_count_max,
      employee_size_range: evalResult.employee_size_range,
      employee_count_source: evalResult.employee_count_source,
      employee_count_source_url: evalResult.employee_count_source_url,
      employee_count_verified: 1,
      employee_count_verified_at: evalResult.employee_count_verified_at,
      employee_count_status: "QUALIFIED",
      app_relevance_score: appRelevanceScore,
      lead_score: leadScore,
      shopify_services: servicesStr,
      public_apps: webResearch.publicApps.join(", "),
      careers_url: webResearch.careersUrl,
      linkedin_url: linkedinUrl,
      phone: primaryPhone ? primaryPhone.phone : null,
      normalized_phone: primaryPhone ? primaryPhone.normalized_phone : null,
      phone_type: primaryPhone ? primaryPhone.phone_type : null,
      phone_source: primaryPhone ? "Website Crawling" : null,
      phone_source_url: primaryPhone ? primaryPhone.source_url : null,
      whatsapp_available: primaryPhone ? primaryPhone.whatsapp_available : "unknown",
      whatsapp_status: "READY",
      status: finalStatus,
      notes: evalResult.reason
    });

    const contactLog = bestContact ? `${bestContact.email} (${bestContact.confidence}, ${bestContact.email_type})` : "None found (Strict No-Guess)";
    const phoneLog = primaryPhone ? ` | Phone: ${primaryPhone.phone} (${primaryPhone.phone_type})` : "";
    logger.info(`   Employees: ${evalResult.employee_count || evalResult.employee_size_range} [${evalResult.employee_count_source}] | Lead Score: ${leadScore} | Contact: ${contactLog}${phoneLog} | Status: ${finalStatus}`);

    return {
      companyId: company.id,
      name: company.name,
      status: finalStatus,
      employee_count: evalResult.employee_count,
      employee_size_range: evalResult.employee_size_range,
      employee_count_source: evalResult.employee_count_source,
      appRelevanceScore,
      leadScore,
      bestContact
    };
  } catch (error) {
    logger.error(`Error researching company ${company.name}:`, error);
    db.updateCompanyStatus(company.id, "ERROR", error.message);
    return { companyId: company.id, status: "ERROR", error: error.message };
  }
}

async function runResearch(options = {}) {
  const limit = options.limit || 50;
  logger.section(`Starting Deep Research on Candidate Companies (Batch Limit: ${limit})`);

  await exclusionService.init();

  let companies = db.getAllCompanies({ status: "DISCOVERED", limit });
  if (companies.length === 0) {
    logger.info("No newly DISCOVERED companies found. Checking unresearched or candidate companies...");
    companies = db.getAllCompanies({ limit });
  }

  logger.info(`Found ${companies.length} candidate companies for research.`);

  const results = [];
  for (let i = 0; i < companies.length; i++) {
    const comp = companies[i];
    logger.progress(i + 1, companies.length, comp.name, comp.domain || "");
    const res = await researchCompany(comp);
    results.push(res);

    // Brief polite delay
    await new Promise((r) => setTimeout(r, 600));
  }

  logger.success(`Completed research on ${results.length} companies.`);
  return results;
}

module.exports = { researchCompany, runResearch };
