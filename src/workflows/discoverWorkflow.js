const shopifyDirectory = require("../providers/shopifyDirectory");
const exclusionService = require("../services/exclusionService");
const db = require("../db/database");
const normalizer = require("../services/normalizer");
const logger = require("../services/logger");

async function runDiscovery(options = {}) {
  const targetCandidates = options.candidates || 150;
  logger.section(`Starting Partner Discovery (Target: ${targetCandidates} candidates)`);

  await exclusionService.init();

  const rawPartners = await shopifyDirectory.discoverPartners(targetCandidates);
  logger.info(`Discovered ${rawPartners.length} raw partner records from directory.`);

  let savedCount = 0;
  let excludedCount = 0;
  let duplicateCount = 0;

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
        status: "EXCLUDED",
        notes: exclusionCheck.reason
      });
      continue;
    }

    if (existing && existing.status !== "DISCOVERED") {
      duplicateCount++;
      continue;
    }

    db.upsertCompany({
      name: partner.name,
      normalized_name: normName,
      shopify_partner_url: partner.shopify_partner_url,
      city: partner.city,
      country: partner.country || "India",
      rating: partner.rating,
      reviews: partner.reviews,
      status: "DISCOVERED"
    });

    savedCount++;
  }

  logger.section("Discovery Summary");
  logger.info(`Total Raw Discovered : ${rawPartners.length}`);
  logger.info(`Saved as Candidates  : ${savedCount}`);
  logger.info(`Excluded (Filtered)  : ${excludedCount}`);
  logger.info(`Existing Duplicates  : ${duplicateCount}`);

  return {
    rawCount: rawPartners.length,
    savedCount,
    excludedCount,
    duplicateCount
  };
}

module.exports = { runDiscovery };
