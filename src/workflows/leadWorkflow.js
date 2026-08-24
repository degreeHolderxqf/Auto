const { runDiscovery } = require("./discoverWorkflow");
const { researchCompany } = require("./researchWorkflow");
const exportService = require("../services/exportService");
const exclusionService = require("../services/exclusionService");
const db = require("../db/database");
const logger = require("../services/logger");
const config = require("../config");

async function runLeadGeneration(options = {}) {
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

    // Check if we have gathered enough qualified leads with ready contacts
    const readyLeads = db.getAllCompanies({ status: "READY", minAppRelevanceScore: minRelevance });
    if (readyLeads.length >= targetLeads && processedCount >= 50) {
      logger.success(`Reached target of ${targetLeads} qualified leads with verified contacts!`);
      break;
    }

    // Polite delay
    await new Promise((r) => setTimeout(r, 600));
  }

  // 2. Export all final files
  logger.section("Generating Output Files");
  await exportService.exportAll();

  // 3. Print Final Report
  const stats = db.getStatistics();
  const finalLeads = db.getFinalQualifiedLeads(targetLeads);

  logger.section("Final Lead Generation Report");
  console.log(`📊 Partners Discovered     : ${stats.totalDiscovered}`);
  console.log(`🏢 Candidates Evaluated    : ${stats.candidates}`);
  console.log(`🚫 Excluded / Past History  : ${stats.excluded}`);
  console.log(`🔄 Existing Duplicates     : ${stats.duplicates}`);
  console.log(`⭐ Qualified (Score >= ${minRelevance}) : ${stats.qualified}`);
  console.log(`📧 Total Real Contacts     : ${stats.totalContacts}`);
  console.log(`🔒 HIGH Confidence         : ${stats.highConfidence}`);
  console.log(`🛡️  MEDIUM Confidence       : ${stats.mediumConfidence}`);
  console.log(`❓ No Public Contact       : ${stats.noContact}`);
  console.log(`🎯 Final Selected Leads    : ${finalLeads.length}`);
  console.log(`📤 Ready for Outreach      : ${stats.readyToSend}`);
  console.log(`✉️  Previously Sent Emails  : ${stats.sent}`);
  console.log(`❌ Errors Encountered      : ${errorsCount}`);
  console.log("=".repeat(60));

  return {
    targetLeads,
    finalLeadsCount: finalLeads.length,
    statistics: stats
  };
}

module.exports = { runLeadGeneration };
