const { URL } = require("node:url");
const searchProvider = require("../providers/searchProvider");
const companyWebsite = require("../providers/companyWebsite");
const merchantCsvLeadSource = require("../providers/merchantCsvLeadSource");
const merchantIngestion = require("../services/merchantIngestion");
const publicEmailExtractor = require("../services/publicEmailExtractor");
const logger = require("../services/logger");
const normalizer = require("../services/normalizer");
const validator = require("../services/validator");
const db = require("../db/database");
const config = require("../config");
const { estimateStoreRevenue } = require("../services/revenueEstimator");
const domainRankService = require("../services/domainRankService");

function shouldRefreshRevenueEstimate(existing, domain) {
  if (!existing) return true;
  const currentMethod = String(existing.method || "").trim().toLowerCase();
  const currentProvider = String(existing.traffic_provider || "").trim().toLowerCase();
  if (currentMethod !== "zero-cost proxy model" || currentProvider !== "local tranco rank proxy") return true;

  if (domain) {
    try {
      const currentRank = domainRankService.getDomainRank(domain);
      const currentRankAvailable = Boolean(currentRank && currentRank.available);
      const savedRankAvailable = String(existing.domain_rank_status || "").toUpperCase() === "AVAILABLE";
      const savedRank = Number(existing.domain_rank);
      if (currentRankAvailable !== savedRankAvailable ||
          (currentRankAvailable && (savedRank !== Number(currentRank.rank) ||
            existing.domain_rank_dataset_key !== currentRank.dataset_key))) return true;
    } catch {
      // Continue with the normal estimate refresh interval if local rank lookup fails.
    }
  }

  const updatedAt = Date.parse(existing.updated_at || "");
  if (!Number.isFinite(updatedAt)) return true;

  const successTtl = config.revenueEstimateRefreshDays * 24 * 60 * 60 * 1000;
  const retryTtl = config.revenueFailureRetryHours * 60 * 60 * 1000;
  const ttl = ["SUCCESS", "ESTIMATED"].includes(String(existing.status || "").toUpperCase()) ? successTtl : retryTtl;
  return Date.now() - updatedAt >= ttl;
}

async function enrichSavedStoreRevenue(companyId, domain) {
  try {
    const existing = db.getMerchantRevenueEstimate(companyId);
    if (!shouldRefreshRevenueEstimate(existing, domain)) return existing;

    const result = await estimateStoreRevenue(domain);
    return db.upsertMerchantRevenueEstimate({ ...result, company_id: companyId, domain });
  } catch (error) {
    logger.warn(`Revenue enrichment failed for ${domain}; store discovery will continue: ${error.message}`);
    return null;
  }
}

const BLOCKED_HOSTS = new Set([
  "shopify.com",
  "apps.shopify.com",
  "themes.shopify.com",
  "help.shopify.com",
  "partners.shopify.com"
]);

function getCandidateHost(candidateUrl) {
  try {
    const parsed = new URL(candidateUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (BLOCKED_HOSTS.has(hostname) || [...BLOCKED_HOSTS].some((blocked) => hostname.endsWith(`.${blocked}`))) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

function matchesCountry(candidateCountry, requestedCountry) {
  if (/^(worldwide|global|anywhere|all)$/i.test(requestedCountry)) return true;
  if (!candidateCountry) return true;

  const normalize = (value) => String(value).toLowerCase().replace(/[^a-z]/g, "");
  const requested = normalize(requestedCountry);
  const candidate = normalize(candidateCountry);
  const aliases = {
    us: ["us", "usa", "unitedstates"],
    usa: ["us", "usa", "unitedstates"],
    unitedstates: ["us", "usa", "unitedstates"],
    gb: ["gb", "uk", "unitedkingdom", "england", "scotland", "wales"],
    uk: ["gb", "uk", "unitedkingdom", "england", "scotland", "wales"],
    unitedkingdom: ["gb", "uk", "unitedkingdom", "england", "scotland", "wales"],
    ca: ["ca", "canada"],
    canada: ["ca", "canada"],
    in: ["in", "india"],
    india: ["in", "india"]
  };
  const requestedAliases = aliases[requested] || [requested];
  const candidateAliases = String(candidateCountry)
    .split(/[\/,;|]/)
    .flatMap((part) => aliases[normalize(part)] || [normalize(part)])
    .filter(Boolean);
  return candidateAliases.some((alias) => requestedAliases.includes(alias));
}

function candidateArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    // Fall back to comma-separated data from a curated lead file.
  }
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function mergePublicContactLinks(...values) {
  const result = {
    whatsappLinks: [],
    whatsappNumbers: [],
    instagramLinks: [],
    facebookLinks: [],
    scannedUrls: []
  };
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    for (const key of Object.keys(result)) {
      const items = Array.isArray(value[key]) ? value[key] : [];
      result[key] = [...new Set([...result[key], ...items.map((item) => String(item).trim()).filter(Boolean)])];
    }
  }
  return result;
}

async function runMerchantStoreDiscovery(options = {}) {
  const keywords = String(options.keywords || "").trim();
  const country = String(options.country || "India").trim();
  const maxStores = Math.max(1, Math.min(Number.parseInt(options.target, 10) || 30, 100));
  const concurrency = Math.max(1, Math.min(Number.parseInt(options.concurrency, 10) || 3, 5));
  if (!keywords) {
    throw new Error("Enter a store niche or product keyword before starting merchant discovery.");
  }
  if (!country) {
    throw new Error("Enter a country or choose Worldwide before starting merchant discovery.");
  }

  const existingLeads = merchantIngestion.getMerchantLeads({ limit: 10000 })
    .filter((lead) => matchesCountry(lead.country, country) && lead.website_url)
    .map((lead) => ({
      url: lead.website_url,
      title: lead.store_name,
      snippet: lead.store_description || "",
      contactEmail: lead.contact_email || "",
      contactEmailType: lead.email_type || "",
      contactEmailSourceUrl: lead.contact_email_source_url || "",
      contactPhone: lead.contact_phone || "",
      normalized_phone: lead.normalized_phone || "",
      country: lead.country,
      installedApps: lead.installed_apps || [],
      techStack: lead.tech_stack || [],
      storeDescription: lead.store_description || "",
      productCount: lead.product_count ?? null,
      estimatedRevenue: lead.estimated_revenue || null,
      whatsappAvailable: lead.whatsapp_available || "unknown",
      publicContactLinks: lead.public_contact_links || {},
      source: "imported merchant lead"
    }));
  const localPitchCandidates = (await merchantCsvLeadSource.getLocalCandidates())
    .filter((lead) => matchesCountry(lead.country, country));
  const searchCandidates = await searchProvider.searchShopifyStores(keywords, country, maxStores);
  const indexedStoreCandidates = searchCandidates.filter((candidate) =>
    String(candidate.searchQuery || "").startsWith("country:") ||
    String(candidate.searchQuery || "").startsWith("domain:")
  );
  const publicSearchCandidates = searchCandidates.filter((candidate) => !indexedStoreCandidates.includes(candidate));
  const candidates = [];
  const candidateHosts = new Set();
  for (const candidate of [...existingLeads, ...localPitchCandidates, ...indexedStoreCandidates, ...publicSearchCandidates]) {
    const host = getCandidateHost(candidate.url);
    if (!host || candidateHosts.has(host)) continue;
    candidateHosts.add(host);
    candidates.push(candidate);
    if (candidates.length >= maxStores) break;
  }
  let verifiedCount = 0;
  let contactBackedCount = 0;
  let importedCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;
  let robotsBlockedCount = 0;
  let unreachableCount = 0;
  let errorCount = 0;
  const stores = [];
  const seenHosts = new Set();

  logger.info(
    `Checking ${candidates.length} candidate(s) (${existingLeads.length} imported lead(s), ${localPitchCandidates.length} local pitch-list lead(s), ${indexedStoreCandidates.length} public store-index result(s), ${publicSearchCandidates.length} general search result(s)) for Shopify stores matching "${keywords}" in ${country} with concurrency ${concurrency}.`
  );

  let nextCandidateIndex = 0;
  let pendingImports = 0;
  const processCandidate = async (candidate, index) => {
    const domain = getCandidateHost(candidate.url);
    if (!domain || seenHosts.has(domain)) return;
    seenHosts.add(domain);
    let hasImportReservation = false;

    try {
      const research = await companyWebsite.researchWebsite(domain, candidate.url, {
        maxSubpages: 3,
        respectRobots: true,
        crawlDelayMs: 500,
        countryCode: normalizer.normalizeCountryCode(country, "IN")
      });
      const indexedShopifyStore = Boolean(candidate.storeEvidence?.verified);
      const existingPublicLinks = candidate.publicContactLinks || candidate.public_contact_links || {};
      let publicContactLinks = mergePublicContactLinks(existingPublicLinks);
      if (research.isShopifyStore || indexedShopifyStore) {
        if (research.crawlBlockedByRobots && !(research.contacts || []).some((entry) => entry.email)) {
          console.info(`[email-extractor] Website research was limited by robots.txt for ${domain}; trying the configured public-contact browser extractor.`);
        }
        const browserResult = await publicEmailExtractor.extractPublicContacts(candidate.url);
        publicContactLinks = mergePublicContactLinks(publicContactLinks, browserResult);
        if (browserResult.emails.length) {
          const knownEmails = new Set((research.contacts || []).map((entry) => entry.email));
          research.contacts = [
            ...(research.contacts || []),
            ...browserResult.emails.filter((entry) => !knownEmails.has(entry.email))
          ];
          logger.info(`Browser extraction found ${browserResult.emails.length} public email(s) for ${domain}.`);
        }
      }
      const usedIndexedEvidence = !research.websiteReachable &&
        research.crawlBlockedByRobots &&
        indexedShopifyStore;
      const candidateEmail = candidate.contactEmail || candidate.contact_email || candidate.email || "";
      const candidatePhone = candidate.contactPhone || candidate.contact_phone || candidate.phone || "";
      const hasKnownContact = Boolean(candidateEmail || candidatePhone);
      const shopifyStoreVerified = research.isShopifyStore || usedIndexedEvidence;
      if (!research.websiteReachable && research.crawlBlockedByRobots) robotsBlockedCount++;
      else if (!research.websiteReachable) unreachableCount++;

      if (!shopifyStoreVerified && !hasKnownContact) {
        if (research.websiteReachable) rejectedCount++;
        logger.debug(`Rejected merchant candidate ${domain}`, {
          source: candidate.source || candidate.searchQuery || "public search",
          reachable: research.websiteReachable,
          shopifyVerified: research.isShopifyStore,
          robotsBlocked: research.crawlBlockedByRobots
        });
        return;
      }
      if (usedIndexedEvidence) {
        logger.info(`Using recent urlscan.io Shopify evidence for ${domain}; robots.txt limited the initial HTTP research.`);
      }
      if (shopifyStoreVerified) {
        verifiedCount++;
      } else {
        contactBackedCount++;
        logger.info(`Retaining ${domain} from its supplied public contact; direct Shopify verification was unavailable.`);
      }

      const storeName = research.storeName || candidate.title || domain;
      const contacts = research.contacts || [];
      const contact = contacts.find((entry) => entry.email_type === "Owner / Founder") || contacts[0] || null;
      const phone = research.primaryPhone;
      const defaultCountryCode = normalizer.normalizeCountryCode(country, "IN");
      const whatsappPhone = publicContactLinks.whatsappNumbers
        .map((number) => validator.normalizePhone(number, defaultCountryCode))
        .find(Boolean) || null;
      const installedApps = research.installedApps?.length
        ? research.installedApps
        : candidateArray(candidate.installedApps || candidate.installed_apps);
      const techStack = research.techStack?.length
        ? research.techStack
        : candidateArray(candidate.techStack || candidate.tech_stack);
      const lead = {
        store_name: storeName,
        website_url: candidate.url,
        contact_email: contact?.email || candidateEmail,
        contact_email_type: contact?.email_type || candidate.contactEmailType || candidate.email_type || "Business Contact",
        contact_email_source_url: contact?.source_url || candidate.contactEmailSourceUrl || candidate.contact_email_source_url || candidate.url,
        contact_phone: phone?.normalized_phone || phone?.phone || whatsappPhone?.formatted || candidatePhone,
        normalized_phone: phone?.normalized_phone || whatsappPhone?.e164 || candidate.normalized_phone || null,
        whatsapp_available: publicContactLinks.whatsappLinks.length
          ? "yes"
          : phone?.whatsapp_available || candidate.whatsappAvailable || candidate.whatsapp_available || "unknown",
        public_contact_links: publicContactLinks,
        installed_apps: installedApps,
        tech_stack: techStack,
        store_description: research.storeDescription || candidate.storeDescription || candidate.store_description || candidate.snippet ||
          (candidate.storeEvidence
            ? `Shopify verified by recent public urlscan.io scan (${candidate.storeEvidence.scanTime}). ${candidate.storeEvidence.scanUrl || candidate.storeEvidence.evidence}`
            : hasKnownContact && !shopifyStoreVerified
              ? `Retained from ${candidate.source || "provided data"} because it includes a contact; Shopify status was not confirmed in this run.`
              : ""),
        product_count: research.productCount ?? candidate.productCount ?? candidate.product_count ?? null,
        country: research.country || candidate.country || "Unknown",
        city: candidate.city || "",
        state: candidate.state || "",
        estimated_revenue: candidate.estimatedRevenue || candidate.estimated_revenue || null
      };

      if (importedCount + pendingImports >= maxStores) return;
      pendingImports++;
      hasImportReservation = true;
      const imported = await merchantIngestion.importDiscoveredStore(lead, candidate.url);
      pendingImports--;
      hasImportReservation = false;
      if (imported.imported > 0 || imported.updated > 0) {
        importedCount += imported.imported;
        updatedCount += imported.updated || 0;
        const savedLead = imported.leads[0];
        const revenueEstimate = await enrichSavedStoreRevenue(
          savedLead.id,
          normalizer.normalizeDomain(candidate.url)
        );
        stores.push({
          id: savedLead.id,
          storeName,
          domain: normalizer.normalizeDomain(candidate.url),
          contactEmail: lead.contact_email || null,
          contactPhone: lead.contact_phone || null,
          whatsappAvailable: lead.whatsapp_available,
          whatsappLinks: publicContactLinks.whatsappLinks,
          whatsappNumbers: publicContactLinks.whatsappNumbers,
          instagramLinks: publicContactLinks.instagramLinks,
          facebookLinks: publicContactLinks.facebookLinks,
          installedApps: lead.installed_apps,
          techStack: lead.tech_stack,
          productCount: lead.product_count,
          estimatedRevenue: revenueEstimate && revenueEstimate.estimated_monthly_revenue != null
            ? revenueEstimate.estimated_monthly_revenue
            : lead.estimated_revenue || null,
          revenueEstimationStatus: revenueEstimate && revenueEstimate.status || null,
          revenueEstimationReason: revenueEstimate && revenueEstimate.reason || null
        });
      } else if (imported.skipped > 0) {
        duplicateCount += imported.skipped;
      } else {
        errorCount += imported.errors.length;
      }
    } catch (error) {
      if (hasImportReservation) pendingImports--;
      errorCount++;
      logger.warn(`Could not research merchant storefront ${domain}: ${error.message}`);
    } finally {
      if (index < candidates.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };

  const worker = async () => {
    while (importedCount + pendingImports < maxStores) {
      const index = nextCandidateIndex++;
      if (index >= candidates.length) return;
      await processCandidate(candidates[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker())
  );

  return {
    keywords,
    country,
    candidates: candidates.length,
    importedLeadCandidates: existingLeads.length,
    localPitchCandidates: localPitchCandidates.length,
    storeIndexCandidates: indexedStoreCandidates.length,
    publicSearchCandidates: publicSearchCandidates.length,
    verifiedShopifyStores: verifiedCount,
    contactBackedStores: contactBackedCount,
    importedStores: importedCount,
    updatedStores: updatedCount,
    duplicateStores: duplicateCount,
    rejectedNonShopifySites: rejectedCount,
    robotsBlockedSites: robotsBlockedCount,
    unreachableSites: unreachableCount,
    researchErrors: errorCount,
    stores,
    revenueNote: "Public catalog, currency, technology, review, and optional domain-rank signals are collected; revenue stays null without product prices, verified currency, and an explicitly enabled traffic source. Domain rank is never converted into visits."
  };
}

module.exports = { runMerchantStoreDiscovery, matchesCountry, shouldRefreshRevenueEstimate };
