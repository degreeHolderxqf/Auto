/**
 * App Store Discovery Workflow
 *
 * Discovers leads from the Shopify App Store using shopifyAppStore.js provider,
 * applies exclusions, deduplicates against Partner Directory companies,
 * and upserts into the database.
 *
 * Key differences from Partner Directory workflow:
 * - Discovers apps, then maps developers to companies
 * - One developer can have multiple apps
 * - India filter is stricter (developer location, not app support)
 * - Source is marked as SHOPIFY_APP_STORE
 */

const shopifyAppStore = require("../providers/shopifyAppStore");
const exclusionService = require("../services/exclusionService");
const db = require("../db/database");
const normalizer = require("../services/normalizer");
const logger = require("../services/logger");
const config = require("../config");

// ─── Discovery Settings ────────────────────────────────────────────────────────

const DEFAULT_MAX_APPS = 200;
const DEFAULT_DETAIL_BATCH_SIZE = 50;
const DEFAULT_PAGE_DELAY = 2000; // 2s between directory pages
const DEFAULT_DETAIL_DELAY = 3000; // 3s between detail fetches

// ─── Discovery Runner ─────────────────────────────────────────────────────────

/**
 * Run App Store discovery workflow
 *
 * @param {Object} options
 * @param {number} options.maxApps - Target number of apps to discover (default: 200)
 * @param {boolean} options.indiaOnly - Filter for India-based developers (default: true)
 * @param {string} options.category - Optional category filter
 * @param {Object} options.checkpoint - Optional saved checkpoint for resumable discovery
 * @param {boolean} options.fetchAllPages - Scan all pages regardless of target (default: false)
 * @param {boolean} options.enrichWithDetails - Fetch detail pages for India evidence (default: true)
 * @returns {Object} Discovery results summary
 */
async function runAppStoreDiscovery(options = {}) {
  const maxApps = options.maxApps || DEFAULT_MAX_APPS;
  const indiaOnly = options.indiaOnly !== false;
  const category = options.category || null;
  const fetchAllPages = options.fetchAllPages === true;
  const enrichWithDetails = options.enrichWithDetails !== false;

  logger.section(`Starting App Store Discovery (Target: ${maxApps} apps, India: ${indiaOnly})`);

  // Initialize exclusion service
  await exclusionService.init();

  // ─── Step 1: Discover raw apps from directory pages ───────────────────────
  logger.info("Step 1: Fetching App Store directory pages...");

  const discoveryResult = await shopifyAppStore.discoverApps(maxApps, {
    category,
    indiaOnly: false, // We filter later with more evidence
    checkpoint: options.checkpoint,
    fetchAllPages
  });

  const { apps, checkpoint } = discoveryResult;
  logger.success(`Discovered ${apps.length} raw app records from App Store`);

  // ─── Step 2: Enrich with developer location evidence ─────────────────────
  let enrichedApps = [];
  if (enrichWithDetails) {
    logger.info("Step 2: Enriching apps with developer location evidence...");

    // Process in batches to avoid overwhelming the server
    const batchSize = options.detailBatchSize || DEFAULT_DETAIL_BATCH_SIZE;
    for (let i = 0; i < apps.length; i += batchSize) {
      const batch = apps.slice(i, i + batchSize);
      logger.info(`Processing detail batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(apps.length / batchSize)}...`);

      const enrichedBatch = await shopifyAppStore.enrichAppsWithLocation(batch, {
        indiaOnly,
        maxDetailFetches: batchSize,
        detailDelayMs: options.detailDelayMs || DEFAULT_DETAIL_DELAY
      });

      enrichedApps.push(...enrichedBatch);
    }

    logger.success(`Enriched ${enrichedApps.length} apps with location evidence`);
  } else {
    // Skip enrichment - use basic data only
    enrichedApps = apps.map(app => {
      const basicIndia = shopifyAppStore.isIndiaDeveloper(app);
      return {
        ...shopifyAppStore.buildCompanyFromApp(app),
        india_confidence: basicIndia.confidence || "LOW",
        india_evidence: JSON.stringify(basicIndia.evidence || [])
      };
    });

    if (indiaOnly) {
      enrichedApps = enrichedApps.filter(app => app.country === "India");
    }
  }

  // ─── Step 3: Apply exclusions and deduplicate ──────────────────────────────
  logger.info("Step 3: Applying exclusions and deduplication...");

  let savedCount = 0;
  let updatedCount = 0;
  let excludedCount = 0;
  let duplicateCount = 0;
  let indiaFilteredCount = 0;

  for (const companyData of enrichedApps) {
    // India filter (if enabled)
    if (indiaOnly && companyData.country !== "India") {
      indiaFilteredCount++;
      continue;
    }

    // Exclusion check - check name, domain, AND developer website
    const exclusionCheck = exclusionService.isCompanyExcluded(
      companyData.name,
      companyData.domain
    );

    if (exclusionCheck.excluded) {
      excludedCount++;
      logger.debug(`Excluded: ${companyData.name} - ${exclusionCheck.reason}`);
      continue;
    }

    // Check for existing company by normalized name or domain
    const existingByName = db.getCompanyByNormalizedName(companyData.normalized_name);
    const existingByDomain = companyData.domain ? db.getCompanyByDomain(companyData.domain) : null;
    const existing = existingByName || existingByDomain;

    // If company exists, update it (add app to public_apps if new)
    if (existing) {
      // Check if this app is already linked to this company
      const existingApps = existing.public_apps ? JSON.parse(existing.public_apps) : [];
      const appSlug = companyData.app_store_slug;

      const appAlreadyLinked = existingApps.some(a => a.app_slug === appSlug);

      if (!appAlreadyLinked) {
        // Add new app to existing company's app list
        existingApps.push({
          app_slug: companyData.app_store_slug,
          app_name: companyData.public_apps ? JSON.parse(companyData.public_apps)[0]?.app_name : companyData.app_name,
          app_url: companyData.app_store_url,
          category: companyData.category,
          rating: companyData.rating,
          reviews: companyData.reviews,
          pricing: companyData.pricing
        });

        // Update company with additional app data
        db.upsertCompany({
          id: existing.id,
          public_apps: existingApps,
          app_store_url: existing.app_store_url || companyData.app_store_url,
          rating: existing.rating || companyData.rating,
          reviews: Math.max(existing.reviews || 0, companyData.reviews || 0)
        });

        updatedCount++;
        logger.debug(`Updated company ${companyData.name}: added app ${appSlug}`);
      } else {
        duplicateCount++;
      }
      continue;
    }

    // New company - upsert it
    db.upsertCompany(companyData);
    savedCount++;
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  logger.section("App Store Discovery Summary");
  logger.info(`Total Raw Apps Discovered  : ${apps.length}`);
  logger.info(`India-Filtered            : ${indiaFilteredCount}`);
  logger.info(`Excluded (Parkhya etc.)   : ${excludedCount}`);
  logger.info(`Duplicates (Skipped)      : ${duplicateCount}`);
  logger.info(`Existing Companies Updated: ${updatedCount}`);
  logger.info(`Saved as Candidates       : ${savedCount}`);
  logger.info(`Checkpoint Page           : ${checkpoint.page}`);

  return {
    rawCount: apps.length,
    savedCount,
    updatedCount,
    excludedCount,
    duplicateCount,
    indiaFilteredCount,
    checkpoint
  };
}

/**
 * Resume App Store discovery from a saved checkpoint
 */
async function resumeAppStoreDiscovery(savedCheckpoint, options = {}) {
  logger.info(`Resuming App Store discovery from page ${savedCheckpoint.page}...`);

  return runAppStoreDiscovery({
    ...options,
    checkpoint: savedCheckpoint
  });
}

/**
 * Quick India-only discovery (optimized for speed)
 * Skips detail fetching, uses only basic India patterns
 */
async function quickIndiaDiscovery(options = {}) {
  const maxApps = options.maxApps || 100;

  logger.info("Starting quick India-focused discovery...");

  await exclusionService.init();

  // Discover apps without enrichment
  const { apps } = await shopifyAppStore.discoverApps(maxApps, {
    indiaOnly: false,
    fetchAllPages: false,
    maxPages: 20 // Limit pages for quick discovery
  });

  let savedCount = 0;
  let excludedCount = 0;
  let indiaFilteredCount = 0;

  for (const app of apps) {
    // Quick India check from basic data
    const indiaCheck = shopifyAppStore.isIndiaDeveloper(app);

    if (!indiaCheck.isIndia) {
      indiaFilteredCount++;
      continue;
    }

    // Exclusion check
    const exclusionCheck = exclusionService.isCompanyExcluded(
      app.developer_name || app.app_name
    );

    if (exclusionCheck.excluded) {
      excludedCount++;
      continue;
    }

    const companyData = shopifyAppStore.buildCompanyFromApp(app);
    companyData.india_confidence = indiaCheck.confidence || "LOW";
    companyData.india_evidence = JSON.stringify(indiaCheck.evidence || []);

    db.upsertCompany(companyData);
    savedCount++;
  }

  logger.success(`Quick India discovery: ${savedCount} companies saved`);

  return {
    rawCount: apps.length,
    savedCount,
    excludedCount,
    indiaFilteredCount
  };
}

module.exports = {
  runAppStoreDiscovery,
  resumeAppStoreDiscovery,
  quickIndiaDiscovery
};
