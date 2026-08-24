const https = require("https");
const http = require("http");
const { URL } = require("url");
const normalizer = require("../services/normalizer");
const scoring = require("../services/scoring");
const logger = require("../services/logger");
const config = require("../config");

function fetchUrl(targetUrl, timeout = 12000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const mod = parsed.protocol === "http:" ? http : https;
      const req = mod.get(
        targetUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"
          },
          timeout
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = new URL(res.headers.location, targetUrl).toString();
            return resolve(fetchUrl(nextUrl, timeout));
          }
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, html: data }));
        }
      );
      req.on("error", () => resolve({ status: 0, html: "" }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ status: 0, html: "" });
      });
    } catch (e) {
      resolve({ status: 0, html: "" });
    }
  });
}

class ShopifyDirectoryProvider {
  constructor() {
    this.baseUrl = config.shopifyDirectoryUrl;
  }

  /**
   * Discovers candidate Shopify Partner companies across directory pages
   * @param {number} maxCandidates Target number of raw candidate partners (e.g. 150)
   */
  async discoverPartners(maxCandidates = 150) {
    logger.info(`Starting Shopify Partner Directory discovery (Target: >= ${maxCandidates} candidates)...`);
    const candidates = [];
    const seenUrls = new Set();
    let page = 1;
    let emptyPages = 0;
    const maxPages = 40;

    while (candidates.length < maxCandidates && page <= maxPages && emptyPages < 3) {
      const pageUrl = this.buildPageUrl(page);
      logger.info(`Fetching Directory Page ${page}: ${pageUrl}`);

      const response = await fetchUrl(pageUrl);
      if (response.status !== 200 || !response.html) {
        logger.warn(`Directory page ${page} returned status ${response.status}`);
        emptyPages++;
        page++;
        continue;
      }

      const partnersOnPage = this.parseDirectoryPage(response.html);
      logger.info(`Found ${partnersOnPage.length} partners on page ${page}`);

      if (partnersOnPage.length === 0) {
        emptyPages++;
      } else {
        emptyPages = 0;
        for (const partner of partnersOnPage) {
          if (partner.shopify_partner_url && !seenUrls.has(partner.shopify_partner_url)) {
            seenUrls.add(partner.shopify_partner_url);
            candidates.push(partner);
          }
        }
      }

      page++;
      // Brief polite delay between directory page requests
      await new Promise((r) => setTimeout(r, 1000));
    }

    logger.success(`Discovery completed. Total raw partners collected: ${candidates.length}`);
    return candidates;
  }

  buildPageUrl(page) {
    const parsed = new URL(this.baseUrl);
    parsed.searchParams.set("page", page.toString());
    return parsed.toString();
  }

  /**
   * Parse listing cards from directory HTML
   */
  parseDirectoryPage(html) {
    const cardBlocks = html.split(/data-component-name=["']listing-profile-card["']/);
    const partners = [];

    for (let i = 1; i < cardBlocks.length; i++) {
      const block = cardBlocks[i];

      // Partner URL
      const hrefMatch = block.match(/href=["'](\/partners\/directory\/partner\/[^"']+)["']/);
      if (!hrefMatch) continue;

      const shopify_partner_url = "https://www.shopify.com" + hrefMatch[1].split("?")[0];

      // Company Name
      const h3Match = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      const name = h3Match
        ? h3Match[1].replace(/<[^>]+>/g, "").trim()
        : hrefMatch[1].split("/").pop().replace(/-/g, " ");

      // Rating & Reviews
      const ratingMatch = block.match(/Rating([0-9.]+)\(([0-9]+)\)/i) ||
        block.match(/([0-9]\.[0-9])\s*\(([0-9]+)\s*reviews?\)/i) ||
        block.match(/aria-label=["']([0-9.]+)\s*out of 5 stars.*?([0-9]+)\s*reviews/i);

      let rating = null;
      let reviews = 0;
      if (ratingMatch) {
        rating = parseFloat(ratingMatch[1]);
        reviews = parseInt(ratingMatch[2] || "0", 10);
      }

      // Location
      const locMatch = block.match(/([A-Za-z\s]+),\s*(India)/i);
      let city = null;
      let country = "India";
      if (locMatch) {
        city = locMatch[1].trim();
        country = "India";
      }

      partners.push({
        name,
        normalized_name: normalizer.normalizeCompanyName(name),
        shopify_partner_url,
        city,
        country,
        rating,
        reviews
      });
    }

    return partners;
  }

  /**
   * Fetches detailed profile information for a partner
   */
  async fetchPartnerProfile(shopifyPartnerUrl) {
    if (!shopifyPartnerUrl) return null;

    // Ensure clean URL format
    const url = shopifyPartnerUrl.replace("/in/partners/directory/partner/", "/partners/directory/partner/");
    const response = await fetchUrl(url);

    if (response.status !== 200 || !response.html) {
      return null;
    }

    const html = response.html;
    const details = {
      official_website: null,
      domain: null,
      linkedin_url: null,
      partner_tier: null,
      listed_email: null,
      listed_phone: null,
      shopify_services: [],
      city: null,
      state: null,
      country: "India",
      rating: null,
      reviews: 0
    };

    // Extract Partner Tier (e.g. Plus Partner, Select Partner, Premier)
    const tierMatch = html.match(/<h3[^>]*>([^<]*(?:Plus Partner|Premier Partner|Platinum Partner|Select Partner)[^<]*)<\/h3>/i) ||
      html.match(/<title[^>]*>([^<]*Plus[^<]*)<\/title>/i) ||
      html.match(/(Plus Partner|Premier Partner|Platinum Partner)/i);
    if (tierMatch) {
      details.partner_tier = tierMatch[1].trim();
    } else {
      details.partner_tier = "Shopify Partner";
    }

    // Extract Rating & Reviews if on detail page
    const ratingMatch = html.match(/Rating([0-9.]+)\(([0-9]+)\)/i);
    if (ratingMatch) {
      details.rating = parseFloat(ratingMatch[1]);
      details.reviews = parseInt(ratingMatch[2], 10);
    }

    // Extract Services
    const serviceMatches = [...html.matchAll(/href=["']\/partners\/directory\/services\/[^"']*\/([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    const services = new Set();
    serviceMatches.forEach((m) => {
      const text = m[2].replace(/<[^>]+>/g, "").trim();
      if (text && !text.includes("View all")) {
        services.add(text);
      }
    });
    details.shopify_services = Array.from(services);

    // Extract LinkedIn Company link
    const links = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)];
    for (const linkMatch of links) {
      const href = linkMatch[1];
      if (href.includes("linkedin.com/company/") && !href.includes("/company/shopify")) {
        details.linkedin_url = href.split("?")[0];
        break;
      }
    }

    const IGNORED_HOSTS = [
      "shopify.com", "shopifycloud.com", "facebook.com", "twitter.com", "instagram.com",
      "youtube.com", "tiktok.com", "pinterest.com", "linkedin.com", "google.com",
      "googletagmanager.com", "googleapis.com", "gstatic.com", "schema.org", "w3.org",
      "ravelcare.com", "smotect.com", "vasustore.com", "helloalva.com", "ahwstudio.com",
      "atelierrebul.be", "apple.com", "cloudflare.com"
    ];

    // Priority 1: Check under "Contact information"
    const contactSectionMatch = html.match(/Contact information[\s\S]*?<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (contactSectionMatch) {
      const candidate = contactSectionMatch[1].split("?")[0];
      const norm = normalizer.normalizeDomain(candidate);
      if (norm && !IGNORED_HOSTS.some(h => norm.includes(h))) {
        details.official_website = candidate;
        details.domain = norm;
      }
    }

    // Priority 2: General external links
    if (!details.official_website) {
      for (const linkMatch of links) {
        const href = linkMatch[1];
        const norm = normalizer.normalizeDomain(href);

        if (norm && !IGNORED_HOSTS.some(h => norm.includes(h))) {
          details.official_website = href.split("?")[0];
          details.domain = norm;
          break;
        }
      }
    }

    // Extract Location text (e.g. Surat, India)
    const locMatch = html.match(/Primary location<\/p>\s*<p[^>]*>([^<]+)<\/p>/i) ||
      html.match(/([A-Za-z\s]+),\s*India/i);
    if (locMatch) {
      const locStr = locMatch[1].replace(/<[^>]+>/g, "").trim();
      const parts = locStr.split(",");
      details.city = parts[0].trim();
      details.country = "India";
    }

    // Extract Listed Email from partner profile
    const emailMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (emailMatch) {
      details.listed_email = emailMatch[1].toLowerCase().trim();
    }

    return details;
  }
}

module.exports = new ShopifyDirectoryProvider();
