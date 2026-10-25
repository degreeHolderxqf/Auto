const path = require("node:path");
const fs = require("node:fs/promises");
const { createObjectCsvWriter } = require("csv-writer");
const pLimit = require("p-limit");
const config = require("../config");
const { parseInputFile, parseDomain } = require("../services/bulkInputProcessor");
const contactEnrichmentApi = require("../providers/contactEnrichmentApi");
const respectfulDomainCrawler = require("../providers/respectfulDomainCrawler");

function hasSocialLinks(socialLinks) {
  return Object.values(socialLinks || {}).some((items) => Array.isArray(items) ? items.length > 0 : Boolean(items));
}

function mergeSocialLinks(...values) {
  const result = { LinkedIn: [], Twitter: [], Instagram: [], Facebook: [] };
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    for (const key of Object.keys(result)) {
      const items = Array.isArray(value[key]) ? value[key] : value[key] ? [value[key]] : [];
      result[key] = [...new Set([...result[key], ...items.map((item) => String(item).trim()).filter(Boolean)])];
    }
  }
  return result;
}

function makeRows(domain, emails, source, socialLinks) {
  const serializedLinks = JSON.stringify(socialLinks || {});
  const values = Array.isArray(emails) ? [...new Set(emails.map((email) => String(email || "").trim()).filter(Boolean))] : [];
  if (!values.length && !hasSocialLinks(socialLinks)) return [];
  return (values.length ? values : [""]).map((email) => ({
    Domain: domain || "",
    Email: email,
    Source: source,
    Social_Links: serializedLinks
  }));
}

async function exportCsv(rows, outputFile) {
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const writer = createObjectCsvWriter({
    path: outputFile,
    header: [
      { id: "Domain", title: "Domain" },
      { id: "Email", title: "Email" },
      { id: "Source", title: "Source" },
      { id: "Social_Links", title: "Social_Links" }
    ]
  });
  await writer.writeRecords(rows);
}

async function enrichOneTarget(target) {
  try {
    const apiResult = await contactEnrichmentApi.enrichTarget(target);
    let domain = parseDomain(apiResult.domain) || target.domain || "";
    let emails = apiResult.emails || [];
    let socialLinks = mergeSocialLinks(apiResult.socialLinks);
    let source = "API";

    // If the API resolves an organization name to a domain but has no contact signals,
    // the compliant crawler can still perform a robots.txt-gated lookup.
    if (!emails.length && !hasSocialLinks(socialLinks) && domain) {
      const webResult = await respectfulDomainCrawler.crawlDomain(domain);
      domain = parseDomain(webResult.domain) || domain;
      emails = webResult.emails || [];
      socialLinks = mergeSocialLinks(socialLinks, webResult.socialLinks);
      source = "Web";
    } else if (!domain && !emails.length && !hasSocialLinks(socialLinks)) {
      console.info(`[bulk-enrich] No domain or contact data was resolved for ${target.companyName || "input row " + target.rowNumber}; skipping fallback.`);
    }

    return {
      target,
      rows: makeRows(domain, emails, source, socialLinks),
      source,
      error: null
    };
  } catch (error) {
    console.warn(`[bulk-enrich] Could not process ${target.domain || target.companyName}: ${error.message}`);
    return { target, rows: [], source: "", error: error.message };
  }
}

async function runBulkLeadEnrichment(options = {}) {
  const inputFile = options.inputFile || options.input;
  if (!inputFile) throw new Error("Provide an input CSV or JSON file with --input=<path>.");

  const outputFile = path.resolve(options.outputFile || options.output || path.join(config.outputDir, "enriched_leads.csv"));
  const concurrency = Math.max(1, Math.min(Number.parseInt(options.concurrency, 10) || 3, 5));
  const targets = await parseInputFile(inputFile);
  if (!targets.length) throw new Error("No usable company names or domains were found in the input file.");

  const limit = pLimit(concurrency);
  let completed = 0;
  const header = [
    { id: "Domain", title: "Domain" },
    { id: "Email", title: "Email" },
    { id: "Source", title: "Source" },
    { id: "Social_Links", title: "Social_Links" }
  ];
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  let hasWrittenHeader = false;
  let rowsWritten = 0;
  let apiRows = 0;
  let webRows = 0;
  let skipped = 0;
  let errors = 0;

  // Process bounded batches so the limiter does not retain one pending Promise per input row.
  const batchSize = Math.max(25, concurrency * 20);
  for (let offset = 0; offset < targets.length; offset += batchSize) {
    const batch = targets.slice(offset, offset + batchSize);
    const outcomes = await Promise.all(batch.map((target) => limit(async () => {
      const outcome = await enrichOneTarget(target);
      completed++;
      console.info(`[bulk-enrich] Completed ${completed}/${targets.length}: ${target.domain || target.companyName}`);
      return outcome;
    })));
    const batchRows = outcomes.flatMap((outcome) => outcome.rows);
    if (batchRows.length) {
      const writer = createObjectCsvWriter({ path: outputFile, header, append: hasWrittenHeader });
      await writer.writeRecords(batchRows);
      hasWrittenHeader = true;
      rowsWritten += batchRows.length;
    }
    apiRows += outcomes.filter((outcome) => outcome.source === "API").reduce((total, outcome) => total + outcome.rows.length, 0);
    webRows += outcomes.filter((outcome) => outcome.source === "Web").reduce((total, outcome) => total + outcome.rows.length, 0);
    errors += outcomes.filter((outcome) => outcome.error).length;
    skipped += outcomes.filter((outcome) => !outcome.error && outcome.rows.length === 0).length;
  }

  if (!hasWrittenHeader) {
    const emptyWriter = createObjectCsvWriter({ path: outputFile, header });
    await emptyWriter.writeRecords([]);
  }

  console.info(`[bulk-enrich] Wrote ${rowsWritten} row(s) to ${outputFile}; ${apiRows} API row(s), ${webRows} web row(s), ${skipped} empty/skipped target(s), ${errors} processing error(s).`);
  return {
    targetsProcessed: targets.length,
    rowsWritten,
    apiRows,
    webRows,
    skipped,
    errors,
    outputFile
  };
}

module.exports = { runBulkLeadEnrichment, enrichOneTarget, makeRows, exportCsv };
