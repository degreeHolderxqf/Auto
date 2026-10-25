const shopifyDirectory = require("../providers/shopifyDirectory");
const exclusionService = require("../services/exclusionService");
const db = require("../db/database");
const normalizer = require("../services/normalizer");
const logger = require("../services/logger");

// Only treat TRULY TERMINAL statuses as duplicates — pipeline statuses
// (READY, APPROVED, EMAIL_FOUND, ACTIVE) should still be re-saved so the
// directory listing can refresh and the upsert will preserve the existing
// non-DISCOVERED status. Re-discovery of already-contacted leads would
// risk re-sending outreach, so SENT/CONTACTED/FAILED stay locked.
const TERMINAL_STATUSES = new Set([
  "SENT",
  "CONTACTED",
  "FAILED",
  "EXCLUDED",
  "SKIPPED_DUPLICATE"
]);

async function runDiscovery(options = {}) {
  const targetCandidates = options.candidates || 150;
  const fetchAllPages = options.fetchAllPages !== false;
  const source = options.source || "SHOPIFY_PARTNER_DIRECTORY";
  logger.section(`Starting Partner Discovery (Target: ${targetCandidates} candidates, source: ${source})`);

  await exclusionService.init();

  const rawPartners = await shopifyDirectory.discoverPartners(targetCandidates, { fetchAllPages });
  logger.info(`Discovered ${rawPartners.length} raw partner records from directory.`);

  let savedCount = 0;
  let excludedCount = 0;
  let duplicateCount = 0;
  let updatedCount = 0;

  for (const partner of rawPartners) {
    const normName = normalizer.normalizeCompanyName(partner.name);
    const existing = db.getCompanyByNormalizedName(normName) || db.getCompanyByShopifyUrl(partner.shopify_partner_url);

    // Check Exclusions
    const exclusionCheck = exclusionService.isCompanyExcluded(partner.name);
    if (exclusionCheck.excluded) {
      excludedCount++;
      db.upsertCompany({
        name: partner.name,
        normalized_name: normName,
        shopify_partner_url: partner.shopify_partner_url,
        city: partner.city,
        country: partner.country || "India",
        rating: partner.rating,
        reviews: partner.reviews,
        source,
        status: "EXCLUDED",
        notes: exclusionCheck.reason
      });
      continue;
    }

    // Only treat TRULY TERMINAL statuses as duplicates. Companies in pipeline
    // states (DISCOVERED, READY, APPROVED, EMAIL_FOUND, ACTIVE) get
    // re-upserted so the directory listing stays fresh; the upsert preserves
    // their existing non-DISCOVERED status automatically.
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      duplicateCount++;
      continue;
    }

    const wasNew = !existing;
    db.upsertCompany({
      name: partner.name,
      normalized_name: normName,
      shopify_partner_url: partner.shopify_partner_url,
      city: partner.city,
      country: partner.country || "India",
      rating: partner.rating,
      reviews: partner.reviews,
      source,
      status: "DISCOVERED"
    });

    if (wasNew) {
      savedCount++;
    } else {
      updatedCount++;
    }
  }

  logger.section("Discovery Summary");
  logger.info(`Total Raw Discovered : ${rawPartners.length}`);
  logger.info(`Saved as Candidates  : ${savedCount}`);
  logger.info(`Refreshed (Pipeline)  : ${updatedCount}`);
  logger.info(`Excluded (Filtered)  : ${excludedCount}`);
  logger.info(`Existing Duplicates  : ${duplicateCount}`);

  return {
    rawCount: rawPartners.length,
    savedCount,
    updatedCount,
    excludedCount,
    duplicateCount
  };
}

module.exports = { runDiscovery };
