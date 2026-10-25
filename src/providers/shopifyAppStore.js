/**
 * Shopify App Store Provider
 *
 * Discovers apps from the Shopify App Store with pagination, India developer
 * location filtering, and checkpointing for resumable discovery.
 *
 * The App Store is a client-side React SPA, so we use Puppeteer to render
 * the page and extract app cards from the DOM. We then fetch each app's
 * detail page to get developer location evidence.
 *
 * Key differences from Partner Directory:
 * - Scrapes apps.shopify.com instead of shopify.com/partners/directory
 * - Finds DEVELOPER location (not app support for India)
 * - Returns app data (name, developer, URL, description, category, pricing)
 * - One developer can have multiple apps - dedup by developer name, not app
 * - Source field: SHOPIFY_APP_STORE (vs SHOPIFY_PARTNER_DIRECTORY)
 */

const puppeteer = require("puppeteer");
const normalizer = require("../services/normalizer");
const logger = require("../services/logger");
const config = require("../config");

// ─── Puppeteer Setup ───────────────────────────────────────────────────────────

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ─── App Store Provider ───────────────────────────────────────────────────────

class ShopifyAppStoreProvider {
  constructor() {
    this.baseUrl = "https://apps.shopify.com";
    this.searchUrl = "https://apps.shopify.com/search";

    // Pagination state (checkpointing)
    this._checkpoint = {
      queryIndex: 0,
      page: 1,
      seenAppSlugs: new Set()
    };

    // Search queries relevant to app developers (prioritizes app dev)
    this.searchQueries = [
      "shopify developer",
      "custom app",
      "theme development",
      "liquid developer",
      "shopify plus",
      "api integration",
      "checkout extensibility",
      "shopify functions"
    ];

    // India evidence patterns
    this.indiaCityPatterns = [
      "Bangalore", "Bengaluru", "Mumbai", "Delhi", "New Delhi", "Chennai",
      "Hyderabad", "Pune", "Kolkata", "Noida", "Gurgaon", "Gurugram",
      "Jaipur", "Ahmedabad", "Surat", "Lucknow", "Kanpur", "Nagpur",
      "Indore", "Bhopal", "Coimbatore", "Kochi", "Trivandrum", "Visakhapatnam"
    ];
  }

  /**
   * Reset checkpoint for fresh discovery
   */
  resetCheckpoint() {
    this._checkpoint = {
      queryIndex: 0,
      page: 1,
      seenAppSlugs: new Set()
    };
  }

  /**
   * Save checkpoint state for resumable discovery
   */
  saveCheckpoint() {
    return {
      queryIndex: this._checkpoint.queryIndex,
      page: this._checkpoint.page,
      seenAppSlugs: Array.from(this._checkpoint.seenAppSlugs)
    };
  }

  /**
   * Load checkpoint state for resumable discovery
   */
  loadCheckpoint(saved) {
    if (!saved) return;
    this._checkpoint.queryIndex = saved.queryIndex || 0;
    this._checkpoint.page = saved.page || 1;
    this._checkpoint.seenAppSlugs = new Set(saved.seenAppSlugs || []);
  }

  /**
   * Build search URL with query and pagination
   */
  buildSearchUrl(query, page) {
    const params = new URLSearchParams();
    params.set("q", query);
    params.set("type", "apps");
    params.set("page", String(page));
    return `${this.searchUrl}?${params.toString()}`;
  }

  /**
   * Build app detail URL
   */
  buildAppUrl(slug) {
    return `${this.baseUrl}/${slug}`;
  }

  /**
   * Discover apps from App Store using Puppeteer.
   * Searches across multiple developer-relevant queries and paginates.
   *
   * @param {number} maxApps - Target number of apps to discover
   * @param {Object} options - { query?, checkpoint?, fetchAllPages? }
   */
  async discoverApps(maxApps = 200, options = {}) {
    const fetchAllPages = options.fetchAllPages !== false;

    // Load checkpoint if provided
    if (options.checkpoint) {
      this.loadCheckpoint(options.checkpoint);
    }

    logger.info(
      `Starting Shopify App Store discovery (Target: >= ${maxApps} apps, ` +
      `fetchAllPages=${fetchAllPages}, ` +
      `startingQuery=${this._checkpoint.queryIndex}, startingPage=${this._checkpoint.page})...`
    );

    const apps = [];
    const browser = await getBrowser();

    try {
      let queryIdx = this._checkpoint.queryIndex;

      // Iterate through search queries until we have enough apps
      while (queryIdx < this.searchQueries.length) {
        const query = this.searchQueries[queryIdx];
        let page = queryIdx === this._checkpoint.queryIndex ? this._checkpoint.page : 1;
        let emptyPages = 0;
        const maxPagesPerQuery = 5;
        const pageDelay = 2000;

        logger.info(`Searching: "${query}" (starting page ${page})`);

        while (
          page <= maxPagesPerQuery &&
          emptyPages < 2 &&
          (fetchAllPages || apps.length < maxApps)
        ) {
          const searchUrl = this.buildSearchUrl(query, page);
          logger.info(`  Page ${page}: ${searchUrl}`);

          try {
            const appsOnPage = await this.scrapeSearchPage(browser, searchUrl);
            logger.info(`  Found ${appsOnPage.length} apps`);

            if (appsOnPage.length === 0) {
              emptyPages++;
            } else {
              emptyPages = 0;
              for (const app of appsOnPage) {
                if (!this._checkpoint.seenAppSlugs.has(app.app_slug)) {
                  this._checkpoint.seenAppSlugs.add(app.app_slug);
                  apps.push(app);
                }
                if (!fetchAllPages && apps.length >= maxApps) break;
              }
            }
          } catch (e) {
            logger.warn(`  Page ${page} failed: ${e.message}`);
            emptyPages++;
          }

          page++;
          this._checkpoint.page = page;
          await this._delay(pageDelay);
        }

        queryIdx++;
        this._checkpoint.queryIndex = queryIdx;
        this._checkpoint.page = 1;

        if (!fetchAllPages && apps.length >= maxApps) break;
      }
    } finally {
      // Don't close browser here - keep it for detail fetches
    }

    logger.success(`App Store discovery: collected ${apps.length} unique apps`);

    return {
      apps,
      checkpoint: this.saveCheckpoint()
    };
  }

  /**
   * Scrape a single search results page using Puppeteer
   */
  async scrapeSearchPage(browser, url) {
    const page = await browser.newPage();
    const apps = [];

    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 30000
      });

      // Wait for app cards to render
      try {
        await page.waitForSelector('a[href*="/apps/"]', { timeout: 10000 });
      } catch {
        // No apps on this page
      }

      // Extract app data from rendered DOM
      const scraped = await page.evaluate(() => {
        const results = [];
        // Find all links that look like app pages
        const links = document.querySelectorAll('a[href*="/apps/"]');

        links.forEach(link => {
          try {
            const href = link.getAttribute("href");
            if (!href) return;

            // Extract slug from URL
            const match = href.match(/\/apps\/([a-z0-9-]+)/i);
            if (!match) return;
            const slug = match[1].toLowerCase();

            // Skip non-app pages (e.g., /apps/category/...)
            if (slug === "category" || slug === "categories" || slug === "search") return;

            // Get app name from link text or nearby h-tag
            let appName = link.textContent?.trim();
            if (!appName || appName.length < 2 || appName.length > 100) {
              const heading = link.querySelector("h1, h2, h3, h4, h5, h6");
              appName = heading?.textContent?.trim() || slug.replace(/-/g, " ");
            }

            // Get developer name (look for "by XYZ" pattern)
            let developerName = null;
            const parent = link.closest("div, article, section, li");
            if (parent) {
              const byMatch = parent.textContent?.match(/by\s+([A-Z][A-Za-z0-9\s&.-]+?)(?:\.|,|\s+\d|\s*$)/);
              if (byMatch) {
                developerName = byMatch[1].trim();
              }
            }

            results.push({
              app_slug: slug,
              app_name: appName.slice(0, 100),
              developer_name: developerName,
              source: "SHOPIFY_APP_STORE"
            });
          } catch (e) {
            // Skip malformed entries
          }
        });

        return results;
      });

      apps.push(...scraped);
    } catch (e) {
      logger.warn(`scrapeSearchPage error: ${e.message}`);
    } finally {
      await page.close();
    }

    return apps;
  }

  /**
   * Fetch detailed app page to extract developer location evidence
   */
  async fetchAppDetail(appSlug) {
    const browser = await getBrowser();
    const url = this.buildAppUrl(appSlug);

    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      );

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 30000
      });

      // Wait for developer info to render
      try {
        await page.waitForSelector('[data-component-name*="developer"], a[href*="apps.shopify.com/partners/"]', {
          timeout: 5000
        });
      } catch {
        // No developer info found
      }

      const detail = await page.evaluate(() => {
        const result = {
          developer_name: null,
          developer_website: null,
          developer_location: null,
          india_evidence: [],
          app_description: null,
          support_email: null,
          developer_partner_url: null
        };

        // Find developer link (usually points to /partners/...)
        const devLink = document.querySelector('a[href*="/partners/"]');
        if (devLink) {
          result.developer_partner_url = devLink.getAttribute("href");
          result.developer_name = devLink.textContent?.trim();
        }

        // Find developer website link (external link in app detail)
        const allLinks = document.querySelectorAll("a[href^=\"http\"]");
        for (const link of allLinks) {
          const href = link.getAttribute("href");
          if (!href) continue;
          if (
            href.includes("apps.shopify.com") ||
            href.includes("shopify.com") ||
            href.includes("facebook.com") ||
            href.includes("twitter.com") ||
            href.includes("linkedin.com")
          ) continue;
          result.developer_website = href.split("?")[0];
          break;
        }

        // Find developer location text
        const locationRegex = /\b(Bangalore|Bengaluru|Mumbai|Delhi|New Delhi|Chennai|Hyderabad|Pune|Kolkata|Noida|Gurgaon|Gurugram|Jaipur|Ahmedabad|Surat|Lucknow|Kanpur|Nagpur|Indore|Bhopal|Coimbatore|Kochi|Trivandrum|Visakhapatnam|India)\b/i;
        const allText = document.body.innerText;
        const locMatch = allText.match(locationRegex);
        if (locMatch) {
          result.developer_location = locMatch[1];
          result.india_evidence.push({
            type: locMatch[1].toLowerCase() === "india" ? "country" : "city",
            value: locMatch[1]
          });
        }

        // Check developer website TLD
        if (result.developer_website) {
          const urlMatch = result.developer_website.match(/\.in(\/|$)/);
          if (urlMatch) {
            result.india_evidence.push({
              type: "tld",
              source: "developer_website",
              value: result.developer_website
            });
          }
        }

        // Check for Indian phone number in page
        const phoneMatch = allText.match(/\+91[\s\-]?[0-9]{10}/);
        if (phoneMatch) {
          result.india_evidence.push({
            type: "phone_prefix",
            value: phoneMatch[0]
          });
        }

        // App description (meta tag)
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
          result.app_description = metaDesc.getAttribute("content");
        }

        // Find support email
        const mailtoLink = document.querySelector('a[href^="mailto:"]');
        if (mailtoLink) {
          result.support_email = mailtoLink.getAttribute("href").replace("mailto:", "").toLowerCase();
        }

        return result;
      });

      return detail;
    } catch (e) {
      logger.warn(`fetchAppDetail(${appSlug}) error: ${e.message}`);
      return null;
    } finally {
      await page.close();
    }
  }

  /**
   * Check if app developer is likely based in India based on evidence
   */
  isIndiaDeveloper(appData, detailData = null) {
    // If we have strong location evidence from detail page
    if (detailData?.india_evidence?.length > 0) {
      const hasCountryOrCity = detailData.india_evidence.some(
        e => e.type === "country" || e.type === "city" || e.type === "phone_prefix"
      );
      if (hasCountryOrCity) {
        return { isIndia: true, confidence: "HIGH", evidence: detailData.india_evidence };
      }

      const hasTldMatch = detailData.india_evidence.some(e => e.type === "tld");
      if (hasTldMatch) {
        return { isIndia: true, confidence: "MEDIUM", evidence: detailData.india_evidence };
      }
    }

    // Fallback: check developer name patterns
    const nameToCheck = appData.developer_name || detailData?.developer_name;
    if (nameToCheck) {
      // City or country in name
      for (const city of this.indiaCityPatterns) {
        if (nameToCheck.toLowerCase().includes(city.toLowerCase())) {
          return {
            isIndia: true,
            confidence: "MEDIUM",
            evidence: [{ type: "developer_name_pattern", value: nameToCheck }]
          };
        }
      }
      if (/\b(India|IN\b)\b/.test(nameToCheck)) {
        return {
          isIndia: true,
          confidence: "MEDIUM",
          evidence: [{ type: "developer_name_pattern", value: nameToCheck }]
        };
      }

      // Common Indian company name suffixes
      const indianSuffixes = [
        /\bTechnologies?\s*(Pvt\.?\s*)?Ltd\.?\b/i,
        /\bSolutions?\s*(Pvt\.?\s*)?Ltd\.?\b/i,
        /\bInfotech\b/i,
        /\bSoftware\s*(Pvt\.?\s*)?(Ltd\.?|Private)\b/i,
        /\bDigital\s*(Pvt\.?\s*)?(Ltd\.?|Private)\b/i
      ];

      for (const pattern of indianSuffixes) {
        if (pattern.test(nameToCheck)) {
          return {
            isIndia: true,
            confidence: "LOW",
            evidence: [{ type: "company_suffix", value: nameToCheck }]
          };
        }
      }
    }

    return { isIndia: false, confidence: null, evidence: [] };
  }

  /**
   * Process a batch of apps to enrich with developer location
   * Returns enriched apps with company data ready for upsert
   */
  async enrichAppsWithLocation(apps, options = {}) {
    const indiaOnly = options.indiaOnly !== false;
    const delayMs = options.detailDelayMs || 3000;
    const maxDetails = options.maxDetailFetches || 50;

    const enrichedApps = [];
    let detailFetchCount = 0;

    for (const app of apps) {
      if (detailFetchCount >= maxDetails) {
        logger.info(`Reached max detail fetches (${maxDetails}). Skipping remaining.`);
        break;
      }

      // Basic India check from app data
      const basicIndiaCheck = this.isIndiaDeveloper(app);

      // If IndiaOnly and basic check says not India, skip without fetching detail
      if (indiaOnly && !basicIndiaCheck.isIndia) {
        continue;
      }

      // Fetch detail page
      const detail = await this.fetchAppDetail(app.app_slug);
      detailFetchCount++;

      if (detail) {
        app.developer_partner_url = detail.developer_partner_url;
        app.developer_website = detail.developer_website;
        app.developer_location = detail.developer_location;
        app.support_email = detail.support_email;
        app.app_description = detail.app_description;
        if (detail.developer_name && !app.developer_name) {
          app.developer_name = detail.developer_name;
        }

        const fullIndiaCheck = this.isIndiaDeveloper(app, detail);

        if (indiaOnly && !fullIndiaCheck.isIndia) {
          await this._delay(delayMs);
          continue;
        }

        app.india_evidence = fullIndiaCheck.evidence;
        app.india_confidence = fullIndiaCheck.confidence;
      } else {
        app.india_confidence = basicIndiaCheck.confidence || "LOW";
        app.india_evidence = basicIndiaCheck.evidence || [];
      }

      const companyData = this.buildCompanyFromApp(app);
      enrichedApps.push(companyData);

      await this._delay(delayMs);
    }

    return enrichedApps;
  }

  /**
   * Build company data structure from app data
   */
  buildCompanyFromApp(app) {
    const companyName = app.developer_name || app.app_name;
    const normalizedName = normalizer.normalizeCompanyName(companyName);

    let domain = null;
    if (app.developer_website) {
      domain = normalizer.normalizeDomain(app.developer_website);
    }

    const appsList = [{
      app_slug: app.app_slug,
      app_name: app.app_name,
      app_url: app.app_url || this.buildAppUrl(app.app_slug),
      category: app.category || null,
      rating: app.rating || null,
      reviews: app.reviews || 0,
      pricing: app.pricing || null
    }];

    return {
      name: companyName,
      normalized_name: normalizedName,
      domain,
      official_website: app.developer_website,
      city: this.extractCityFromLocation(app.developer_location),
      country: this.isIndiaDeveloper(app).isIndia ? "India" : null,
      source: "SHOPIFY_APP_STORE",
      app_store_url: app.app_url || this.buildAppUrl(app.app_slug),
      app_store_slug: app.app_slug,
      public_apps: JSON.stringify(appsList),
      developer_name: app.developer_name,
      developer_location: app.developer_location,
      developer_website: app.developer_website,
      support_email: app.support_email,
      india_confidence: app.india_confidence || "UNKNOWN",
      india_evidence: JSON.stringify(app.india_evidence || []),
      status: "DISCOVERED"
    };
  }

  /**
   * Extract city from location string
   */
  extractCityFromLocation(location) {
    if (!location) return null;
    for (const city of this.indiaCityPatterns) {
      if (location.toLowerCase().includes(city.toLowerCase())) {
        return city;
      }
    }
    return location.split(",")[0].trim();
  }

  /**
   * Utility delay function
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cleanup browser on shutdown
   */
  async cleanup() {
    await closeBrowser();
  }
}

module.exports = new ShopifyAppStoreProvider();
