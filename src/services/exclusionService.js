const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { createObjectCsvWriter } = require("csv-writer");
const config = require("../config");
const db = require("../db/database");
const normalizer = require("./normalizer");
const logger = require("./logger");

class ExclusionService {
  constructor() {
    this.excludedNames = new Set();
    this.excludedDomains = new Set();
    this.isLoaded = false;
  }

  async init() {
    if (this.isLoaded) return;
    await this.loadFromCsv();
    this.syncToDb();
    this.isLoaded = true;
  }

  async loadFromCsv() {
    if (!fs.existsSync(config.exclusionsPath)) {
      logger.warn(`Exclusions file not found at ${config.exclusionsPath}. Creating a new one.`);
      return;
    }

    return new Promise((resolve) => {
      fs.createReadStream(config.exclusionsPath)
        .pipe(csv())
        .on("data", (row) => {
          const rawName = row["Company Name"] || row["company_name"] || row["Name"] || "";
          const normName = row["Normalized Name"] || row["normalized_name"] || normalizer.normalizeCompanyName(rawName);
          const rawDomain = row["Domain"] || row["domain"] || "";
          const normDomain = normalizer.normalizeDomain(rawDomain);
          const reason = row["Reason"] || row["reason"] || "Previous Outreach Exclusion";

          if (normName) {
            this.excludedNames.add(normName);
            db.addExclusion(rawName || normName, normName, normDomain, reason);
          }

          if (normDomain) {
            this.excludedDomains.add(normDomain);
          }
        })
        .on("end", () => {
          logger.info(`Loaded ${this.excludedNames.size} excluded company names and ${this.excludedDomains.size} domains.`);
          resolve();
        })
        .on("error", (err) => {
          logger.error("Error reading exclusions CSV", err);
          resolve();
        });
    });
  }

  syncToDb() {
    // 1. Load manual exclusions
    const dbExclusions = db.getAllExclusions();
    dbExclusions.forEach((ex) => {
      if (ex.normalized_name) this.excludedNames.add(ex.normalized_name);
      if (ex.domain) this.excludedDomains.add(ex.domain);
    });

    // 2. Load all contacted leads from database
    try {
      const contactedLeads = db.getContactedLeads();
      contactedLeads.forEach((l) => {
        const normName = normalizer.normalizeCompanyName(l.company_name);
        const normDomain = normalizer.normalizeDomain(l.domain);
        if (normName) this.excludedNames.add(normName);
        if (normDomain) this.excludedDomains.add(normDomain);
      });
    } catch (e) {
      // ignore if table syncing
    }
  }

  /**
   * Checks whether a company is excluded by name, domain, or past outreach
   */
  isCompanyExcluded(companyName, domain = null) {
    if (!this.isLoaded) {
      this.syncToDb();
    }

    const normName = normalizer.normalizeCompanyName(companyName);
    const normDomain = normalizer.normalizeDomain(domain);

    // Direct domain match
    if (normDomain && this.excludedDomains.has(normDomain)) {
      return { excluded: true, reason: `Excluded domain: ${normDomain}` };
    }

    // Direct normalized name match
    if (normName && this.excludedNames.has(normName)) {
      return { excluded: true, reason: `Excluded company name: ${normName}` };
    }

    // Fuzzy token & stem match against excluded list
    for (const exName of this.excludedNames) {
      if (!exName || exName.length < 3) continue;

      if (normName === exName) {
        return { excluded: true, reason: `Exact normalized match: ${exName}` };
      }

      // Check word token match
      const nameTokens = normName.split(" ");
      if (nameTokens.includes(exName) && exName.length >= 4) {
        return { excluded: true, reason: `Token match with excluded company: ${exName}` };
      }

      // Substring check for names >= 4 chars
      if (normName.length >= 4 && exName.length >= 4) {
        if (normName.startsWith(exName) || exName.startsWith(normName)) {
          return { excluded: true, reason: `Prefix match with excluded: ${exName}` };
        }
      }

      // Check if domain contains excluded company stem
      if (normDomain && normDomain.includes(exName) && exName.length >= 4) {
        return { excluded: true, reason: `Domain stem match with excluded: ${exName}` };
      }
    }

    // Check DB exclusions
    if (db.isExcluded(normName, normDomain)) {
      return { excluded: true, reason: "Found in exclusions database" };
    }

    return { excluded: false };
  }

  /**
   * Add a new company to exclusions and save to CSV
   */
  async addExclusion(companyName, domain = null, reason = "Manual Exclusion") {
    const normName = normalizer.normalizeCompanyName(companyName);
    const normDomain = normalizer.normalizeDomain(domain);

    if (normName) this.excludedNames.add(normName);
    if (normDomain) this.excludedDomains.add(normDomain);

    db.addExclusion(companyName, normName, normDomain, reason);

    // Append to CSV if not already present
    try {
      const csvWriter = createObjectCsvWriter({
        path: config.exclusionsPath,
        header: [
          { id: "companyName", title: "Company Name" },
          { id: "normalizedName", title: "Normalized Name" },
          { id: "domain", title: "Domain" },
          { id: "reason", title: "Reason" },
          { id: "addedAt", title: "Added At" }
        ],
        append: true
      });

      await csvWriter.writeRecords([
        {
          companyName,
          normalizedName: normName,
          domain: normDomain || "",
          reason,
          addedAt: new Date().toISOString()
        }
      ]);
    } catch (err) {
      logger.error("Failed to append exclusion to CSV", err);
    }
  }
}

module.exports = new ExclusionService();
