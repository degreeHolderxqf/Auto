const { runDiscovery } = require("./discoverWorkflow");
const { researchCompany } = require("./researchWorkflow");
const exportService = require("../services/exportService");
const exclusionService = require("../services/exclusionService");
const db = require("../db/database");
const logger = require("../services/logger");
const config = require("../config");
const merchantIngestion = require("../services/merchantIngestion");
const appStoreDiscovery = require("./appStoreDiscovery");
const merchantStoreDiscovery = require("./merchantStoreDiscovery");

const SOURCE_MODES = new Set(["freelancing", "appstore", "partner"]);

async function runSourceLeadGeneration(options = {}) {
  const source = options.source;
  const targetLeads = Math.max(1, Number.parseInt(options.target, 10) || config.targetLeads || 100);

  if (!SOURCE_MODES.has(source)) {
    throw new Error(`Unsupported lead generation source "${source}". Use freelancing, appstore, or partner.`);
  }

  if (source === "freelancing") {
    const discovery = await merchantStoreDiscovery.runMerchantStoreDiscovery({
      keywords: options.keywords,
      country: options.country,
      target: targetLeads
    });
    const leads = merchantIngestion.getMerchantLeads({ status: "DISCOVERED", limit: targetLeads });
    const allMerchantLeads = merchantIngestion.getMerchantLeads({ limit: 10000 });
    const result = {
      mode: source,
      targetLeads,
      discovery,
      discovered: discovery.importedStores,
      storesWithEmail: discovery.stores.filter((store) => Boolean(store.contactEmail)).length,
      storesWithPhone: discovery.stores.filter((store) => Boolean(store.contactPhone)).length,
      readyForEmail: leads.filter((lead) => Boolean(lead.contact_email)).length,
      readyForWhatsApp: leads.filter((lead) => Boolean(lead.contact_phone)).length,
      totalImportedStores: new Set(allMerchantLeads.map((lead) => lead.id)).size,
      leads: leads.map((lead) => ({
        id: lead.id,
        storeName: lead.store_name,
        website: lead.website_url,
        installedApps: lead.installed_apps,
        contactEmail: lead.contact_email,
        contactPhone: lead.contact_phone,
        estimatedRevenue: lead.estimated_revenue
      }))
    };
    logger.info(`Freelancing mode selected ${result.discovered} imported Shopify store lead(s).`);
    await exportService.exportAll();
    return result;
  }

  await exclusionService.init();
  const discoveryTarget = Math.max(targetLeads * (source === "appstore" ? 4 : 2), 50);
  let discovery;
  let companySource;

  if (source === "appstore") {
    companySource = "SHOPIFY_APP_STORE";
    discovery = await appStoreDiscovery.runAppStoreDiscovery({
      maxApps: discoveryTarget,
      indiaOnly: true,
      fetchAllPages: false,
      enrichWithDetails: true
    });
  } else {
    companySource = "SHOPIFY_PARTNER_DIRECTORY";
    const { runDiscovery } = require("./discoverWorkflow");
    discovery = await runDiscovery({
      candidates: discoveryTarget,
      fetchAllPages: false,
      source: companySource
    });
  }

  const candidates = db.getAllCompanies({
    status: "DISCOVERED",
    source: companySource,
    limit: Math.max(targetLeads * 5, 100)
  });
  logger.info(`Researching ${candidates.length} ${source} candidate(s) for Shopify developer hiring contacts...`);

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const company = candidates[i];
    logger.progress(i + 1, candidates.length, company.name, company.domain || "");
    results.push(await researchCompany(company));
    const readyCount = db.getAllCompanies({
      source: companySource,
      status: "READY"
    }).length;
    if (readyCount >= targetLeads) break;
    if (i < candidates.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  await exportService.exportAll();
  const readyLeads = db.getAllCompanies({ source: companySource, status: "READY" });
  const sourceCompanies = db.getAllCompanies({ source: companySource });
  return {
    mode: source,
    targetLeads,
    source: companySource,
    discovery,
    evaluated: results.length,
    readyForOutreach: readyLeads.length,
    totalSourceCompanies: sourceCompanies.length,
    discoveredCandidatesRemaining: sourceCompanies.filter((company) => company.status === "DISCOVERED").length,
    results
  };
}

async function runLeadGeneration(options = {}) {
  if (options.source !== undefined) {
    return runSourceLeadGeneration(options);
  }

  const targetLeads = options.target || config.targetLeads || 100;
  const minRelevance = options.minAppRelevanceScore || config.minAppRelevanceScore || 70;

  logger.section(`100-Lead Generation Engine (Target: ${targetLeads} Qualified Leads)`);

  await exclusionService.init();

  // 1. Check existing database candidates or run discovery if candidate pool is small
  let candidates = db.getAllCompanies({ status: "DISCOVERED" });
  if (candidates.length < 50) {
    logger.info("Candidate pool is small. Running directory discovery...");
    await runDiscovery({ candidates: Math.max(150, targetLeads * 2) });
    candidates = db.getAllCompanies({ status: "DISCOVERED" });
  }

  logger.info(`Starting research on ${candidates.length} candidate companies...`);

  let processedCount = 0;
  let qualifiedCount = 0;
  let errorsCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const comp = candidates[i];
    logger.progress(i + 1, candidates.length, comp.name);

    const res = await researchCompany(comp);
    processedCount++;

    if (res.appRelevanceScore >= minRelevance) {
      qualifiedCount++;
    }

    if (res.status === "ERROR") {
      errorsCount++;
    }

    // Check if we have gathered enough qualified leads with ready contacts and headcount >= 30
    const readyLeads = db.getAllCompanies({
      status: "READY",
      minAppRelevanceScore: minRelevance,
      minEmployees: 30,
      verifiedOnly: true
    });

    if (readyLeads.length >= targetLeads && processedCount >= 50) {
      logger.success(`Reached target of ${targetLeads} qualified leads with verified contacts and employee_count >= 30!`);
      break;
    }

    // Polite delay
    await new Promise((r) => setTimeout(r, 600));
  }

  // 2. Export all final files
  logger.section("Generating Output Files");
  await exportService.exportAll();

  // 3. Print Final Report with actual verification breakdown metrics
  const stats = db.getStatistics();
  const finalLeads = db.getFinalQualifiedLeads(targetLeads);

  logger.section("Final Lead Generation Report");
  console.log(`📊 Partners Discovered       : ${stats.totalDiscovered}`);
  console.log(`🏢 Candidates Evaluated      : ${stats.candidates}`);
  console.log(`🚫 Excluded / Past History    : ${stats.excluded}`);
  console.log(`🔄 Existing Duplicates       : ${stats.duplicates}`);
  console.log(`👥 Employee Size Verified    : ${stats.employeeVerified} (>= 30 verified)`);
  console.log(`📉 Employee Size Too Low     : ${stats.employeeTooLow} (< 30 rejected)`);
  console.log(`❓ Employee Size Uncertain   : ${stats.employeeUncertain} (Needs verification)`);
  console.log(`⚠️  Employee Size Conflicting : ${stats.employeeConflicting}`);
  console.log(`⭐ Qualified (Score >= ${minRelevance}) : ${stats.qualified}`);
  console.log(`📧 Total Real Contacts       : ${stats.totalContacts}`);
  console.log(`🔒 HIGH Confidence           : ${stats.highConfidence}`);
  console.log(`🛡️  MEDIUM Confidence         : ${stats.mediumConfidence}`);
  console.log(`❓ No Public Contact         : ${stats.noContact}`);
  console.log(`🎯 Final Active Leads        : ${finalLeads.length}`);
  console.log(`📤 Ready for Outreach        : ${stats.readyToSend}`);
  console.log(`✉️  Previously Sent Emails    : ${stats.sent}`);
  console.log(`❌ Errors Encountered        : ${errorsCount}`);
  console.log("=".repeat(60));

  return {
    targetLeads,
    finalLeadsCount: finalLeads.length,
    statistics: stats
  };
}

module.exports = { runLeadGeneration, runSourceLeadGeneration };
