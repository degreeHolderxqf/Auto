/**
 * Automated Shopify Partner -> HR Lead Generation & Outreach System
 * Upgraded entry point (preserved from legacy newest.js)
 */

const { runLeadGeneration } = require("./src/workflows/leadWorkflow");
const { showPreview, runSend } = require("./src/workflows/sendWorkflow");
const logger = require("./src/services/logger");
const config = require("./src/config");

(async () => {
  logger.section("Shopify Partner -> HR Lead Generation System");
  logger.info(`Mode: ${config.dryRun ? "🧪 DRY RUN" : "🚀 LIVE SEND"}`);
  logger.info(`Target Leads: ${config.targetLeads}`);
  logger.info(`Resume Path: ${config.resumePath}`);

  try {
    // 1. Run Lead Generation (Discovery + Research + Validation + Scoring + Checkpoint)
    await runLeadGeneration({
      target: config.targetLeads,
      minAppRelevanceScore: config.minAppRelevanceScore
    });

    // 2. Show Preview Table
    await showPreview({ limit: 15 });

    console.log("\n💡 Next steps:");
    console.log("  To send approved leads in controlled batch:");
    console.log("  npm run send -- --limit=10 --dry-run");
    console.log("  To review exported files, check the output/ folder.");
  } catch (error) {
    logger.error("Application run failed", error);
    process.exit(1);
  }
})();
