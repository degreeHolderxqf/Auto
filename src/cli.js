const { runDiscovery } = require("./workflows/discoverWorkflow");
const { runResearch } = require("./workflows/researchWorkflow");
const { runLeadGeneration } = require("./workflows/leadWorkflow");
const { showPreview, runSend } = require("./workflows/sendWorkflow");
const exportService = require("./services/exportService");
const exclusionService = require("./services/exclusionService");
const db = require("./db/database");
const logger = require("./services/logger");
const config = require("./config");

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      flags[key] = value !== undefined ? value : true;
    } else if (!flags._) {
      flags._ = arg;
    }
  }

  return { command, flags };
}

async function main() {
  const { command, flags } = parseArgs();

  try {
    switch (command.toLowerCase()) {
      case "discover": {
        const candidates = flags.candidates ? parseInt(flags.candidates, 10) : 150;
        await runDiscovery({ candidates });
        break;
      }

      case "research": {
        await runResearch(flags);
        break;
      }

      case "leads": {
        const target = flags.target ? parseInt(flags.target, 10) : 100;
        const minAppRelevanceScore = flags.minScore ? parseInt(flags.minScore, 10) : 70;
        await runLeadGeneration({ target, minAppRelevanceScore });
        break;
      }

      case "export": {
        await exportService.exportAll();
        break;
      }

      case "preview": {
        const limit = flags.limit ? parseInt(flags.limit, 10) : 25;
        await showPreview({ limit });
        break;
      }

      case "send": {
        const limit = flags.limit !== undefined 
          ? (flags.limit === "all" ? null : parseInt(flags.limit, 10)) 
          : (config.sendLimit || null);
        let dryRun = undefined;
        if (flags["dry-run"] !== undefined) {
          dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
        } else if (flags["no-dry-run"] === true || flags.live === true) {
          dryRun = false;
        }
        const yes = flags.yes === true || flags.y === true;
        await runSend({ limit, dryRun, yes });
        break;
      }

      case "status": {
        logger.section("Shopify Partner Campaign Status");
        const stats = db.getStatistics();
        console.table({
          "Total Discovered": stats.totalDiscovered,
          "Active Candidates": stats.candidates,
          "Excluded (History/Blacklist)": stats.excluded,
          "Duplicates": stats.duplicates,
          "Qualified Leads (App Score >= 70)": stats.qualified,
          "Total Public Contacts": stats.totalContacts,
          "HIGH Confidence Contacts": stats.highConfidence,
          "MEDIUM Confidence Contacts": stats.mediumConfidence,
          "Companies with No Public Contact": stats.noContact,
          "Ready for Outreach": stats.readyToSend,
          "Emails Sent": stats.sent,
          "Emails Failed": stats.failed
        });
        break;
      }

      case "exclude": {
        const companyName = flags._ || flags.name;
        const domain = flags.domain || null;
        if (!companyName) {
          logger.error("Please specify a company name to exclude: npm run exclude -- \"Company Name\"");
          process.exit(1);
        }
        await exclusionService.addExclusion(companyName, domain, "Manual CLI Exclusion");
        logger.success(`Added "${companyName}" to exclusions database & data/excluded_companies.csv`);
        break;
      }

      case "help":
      default: {
        console.log(`
Shopify Partner -> HR Lead Generation System
============================================
Available Commands:

  npm run discover                   Discover raw candidate partners from Shopify Directory
  npm run research                   Crawl official websites, careers pages, and find public contacts
  npm run leads [-- --target=100]    End-to-end: Discover, Filter, Research, Validate, Score & Export
  npm run export                     Export leads to CSV, Excel (XLSX), JSON, Queue, and History
  npm run preview                    Display formatted lead list ready for outreach
  npm run send [-- --limit=10]       Send personalized emails with resume attachment (supports --dry-run)
  npm run status                     Show database statistics and campaign progress
  npm run exclude -- "Company Name"  Add a company to dynamic exclusions list
        `);
        break;
      }
    }
  } catch (err) {
    logger.error("Command execution failed", err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
