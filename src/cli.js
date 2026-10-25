const { runDiscovery } = require("./workflows/discoverWorkflow");
const { runResearch } = require("./workflows/researchWorkflow");
const { runLeadGeneration } = require("./workflows/leadWorkflow");
const { showPreview, runSend } = require("./workflows/sendWorkflow");
const { runAppStoreDiscovery, quickIndiaDiscovery } = require("./workflows/appStoreDiscovery");
const exportService = require("./services/exportService");
const exclusionService = require("./services/exclusionService");
const db = require("./db/database");
const logger = require("./services/logger");
const config = require("./config");
const freelanceScraper = require("./services/freelanceScraper");
const { runBulkLeadEnrichment } = require("./workflows/bulkLeadEnrichment");
const fs = require("node:fs/promises");

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const argument = arg.slice(2);
      const equalsAt = argument.indexOf("=");
      const key = equalsAt >= 0 ? argument.slice(0, equalsAt) : argument;
      const value = equalsAt >= 0 ? argument.slice(equalsAt + 1) : true;
      flags[key] = value;
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
        // Default to App Store discovery (primary source for app developers)
        // Use --partner or --source=partner to fall back to Partner Directory
        const source = flags.source || flags.partner ? "partner" : "appstore";
        const candidates = flags.candidates ? parseInt(flags.candidates, 10) : 200;
        const fetchAllPages = flags.all === true || flags.fetchAll === true;

        if (source === "appstore") {
          // App Store discovery — prioritizes app development companies
          const maxApps = flags.maxApps ? parseInt(flags.maxApps, 10) : candidates;
          const indiaOnly = flags.indiaOnly !== false && flags.world !== true;

          logger.section(`App Store Discovery (Target: ${maxApps} apps, India-Only: ${indiaOnly})`);

          const result = await runAppStoreDiscovery({
            maxApps,
            indiaOnly,
            fetchAllPages,
            enrichWithDetails: flags.fast !== true
          });

          await exportService.exportAll();
          logger.success(`App Store discovery complete: ${result.savedCount} saved, ${result.excludedCount} excluded, ${result.duplicateCount} duplicates`);
        } else {
          // Partner Directory discovery — the legacy/default for non-app-focused companies
          await runDiscovery({ candidates, fetchAllPages, source: "SHOPIFY_PARTNER_DIRECTORY" });
        }
        break;
      }

      case "research": {
        await runResearch(flags);
        break;
      }

      case "leads": {
        const target = flags.target ? parseInt(flags.target, 10) : 100;
        const minAppRelevanceScore = flags.minScore ? parseInt(flags.minScore, 10) : 70;
        const source = flags.source;
        if (source && !["freelancing", "appstore", "partner"].includes(source)) {
          throw new Error("--source must be freelancing, appstore, or partner");
        }
        await runLeadGeneration({ target, minAppRelevanceScore, ...(source ? { source } : {}) });
        break;
      }

      case "export": {
        await exportService.exportAll();
        break;
      }

      case "freelance-leads": {
        const feeds = flags.rss
          ? [{
              url: String(flags.rss),
              platform: flags.platform || "Authorized RSS",
              authorized: flags.authorized === true || flags.authorized === "true"
            }]
          : [];
        const boards = flags.boards
          ? JSON.parse(await fs.readFile(String(flags.boards), "utf8"))
          : [];
        const result = await freelanceScraper.runFreelanceLeadDiscovery({
          jobsFile: flags.input || flags.jobs || null,
          feeds,
          boards: Array.isArray(boards) ? boards : [],
          concurrency: flags.concurrency || process.env.FREELANCE_MAX_CONCURRENCY || 2,
          outputBase: flags.output || undefined
        });
        logger.success(`Freelance job enrichment complete: ${result.jobsProcessed} jobs, ${result.records.length} rows.`);
        break;
      }

      case "bulk-enrich": {
        const result = await runBulkLeadEnrichment({
          inputFile: flags.input,
          outputFile: flags.output,
          concurrency: flags.concurrency || 3
        });
        logger.success(`Bulk enrichment complete: ${result.rowsWritten} row(s) written to ${result.outputFile}.`);
        break;
      }

      case "import-tranco": {
        const { importTrancoFile } = require("./services/domainRankService");
        const result = await importTrancoFile({
          filePath: flags.input || flags.file,
          publicationDate: flags["publication-date"],
          listId: flags["list-id"],
          sourceUrl: flags["source-url"]
        });
        logger.success(`Imported ${result.rowCount} Tranco domains for ${result.publicationDate} (${result.datasetKey}).`);
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
          "Employee Size Verified (>= 30)": stats.employeeVerified,
          "Employee Size Too Low (< 30)": stats.employeeTooLow,
          "Employee Size Uncertain": stats.employeeUncertain,
          "Employee Size Conflicting": stats.employeeConflicting,
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

  npm run discover                        App Store (DEFAULT) - discover app developers from Shopify App Store
  npm run discover -- --partner           Partner Directory - discover agencies from Shopify Partners
  npm run discover -- --candidates=500    Set max candidates (default: 200 for App Store)
  npm run discover -- --all              Fetch all pages (no early stop)
  npm run discover -- --world            Include non-India developers (App Store only)
  npm run discover -- --fast             Skip detail enrichment (App Store only, faster)
  npm run research                        Crawl official websites, careers pages, and find public contacts
  npm run leads [-- --target=100]        End-to-end: Discover, Filter, Research, Validate, Score & Export
  npm run export                          Export leads to CSV, Excel (XLSX), JSON, Queue, and History
  npm run freelance-leads -- --input=data/freelance-jobs.json
                                          Enrich an authorized/manual job export; writes CSV and JSON
  npm run freelance-leads -- --rss=<url> --authorized --platform="Board name"
                                          Read a published RSS feed from an authorized source
  npm run freelance-leads -- --boards=data/authorized-boards.json
                                          Read configured boards that expressly permit automation
  npm run bulk-enrich -- --input=data/targets.csv [--output=output/enriched_leads.csv] [--concurrency=3]
                                          Enrich target domains/company names via API, then robots.txt-gated web fallback
  node src/cli.js import-tranco --input=tranco.csv --publication-date=YYYY-MM-DD [--list-id=ID]
                                          Import a previously downloaded Tranco rank CSV as a popularity signal
  npm run preview                         Display formatted lead list ready for outreach
  npm run send [-- --limit=10]            Send personalized emails with resume attachment (supports --dry-run)
  npm run status                          Show database statistics and campaign progress
  npm run exclude -- "Company Name"       Add a company to dynamic exclusions list
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
