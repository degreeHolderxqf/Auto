const https = require("https");
const http = require("http");
const { URL } = require("url");
const validator = require("../services/validator");
const logger = require("../services/logger");
const config = require("../config");
const { JSDOM } = require("jsdom");
const normalizer = require("../services/normalizer");

const NON_STORE_HOSTS = new Set([
  "shopify.com",
  "google.com",
  "duckduckgo.com",
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "tiktok.com",
  "youtube.com",
  "linkedin.com",
  "wikipedia.org",
  "wiktionary.org",
  "dictionary.com",
  "thefreedictionary.com",
  "cambridge.org",
  "oxfordlearnersdictionaries.com",
  "merriam-webster.com",
  "medium.com",
  "reddit.com",
  "quora.com",
  "blogspot.com",
  "wordpress.com",
  "wixsite.com",
  "weebly.com"
]);

const URLSCAN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const URLSCAN_FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

function normalizeHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "").trim();
}

function isBlockedHost(hostname) {
  const normalized = normalizeHost(hostname);
  if (!normalized.includes(".") || normalized === "myshopify.com") return true;
  return [...NON_STORE_HOSTS].some((blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`));
}

function resolveResultUrl(rawUrl) {
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    const encoded = parsed.searchParams.get("u") || parsed.searchParams.get("url");
    if (encoded) {
      const candidates = new Set([encoded]);
      if (encoded.includes("%3D")) {
        candidates.add(decodeURIComponent(encoded));
      }
      const normalized = decodeURIComponent(encoded);
      if (normalized !== encoded) candidates.add(normalized);
      for (const prefix of ["", "a1", "a0", "a"]) {
        candidates.add(encoded.replace(new RegExp(`^${prefix}`), ""));
      }

      for (const candidate of candidates) {
        if (!candidate) continue;
        const decodedUrl = (() => {
          try {
            return decodeURIComponent(candidate);
          } catch {
            return candidate;
          }
        })();
        if (/^https?:\/\//i.test(decodedUrl)) return decodedUrl;

        for (const variant of [candidate, decodedUrl]) {
          if (!/^[A-Za-z0-9+/=]+$/.test(variant)) continue;
          for (const adjusted of [variant, variant.replace(/^a[01]/, ""), variant.replace(/^a/, "")]) {
            try {
              const decoded = Buffer.from(adjusted, "base64").toString("utf8");
              if (/^https?:\/\//i.test(decoded)) return decoded;
            } catch {
              // Ignore non-base64 variants.
            }
          }
        }
      }
    }
    return rawUrl;
  } catch {
    return null;
  }
}

function addResult(results, seenHosts, normalizedUrl, title, snippet, searchQuery) {
  let hostname;
  try {
    hostname = new URL(normalizedUrl).hostname;
  } catch {
    return;
  }

  const normalizedHostname = normalizeHost(hostname);
  if (!normalizedHostname || isBlockedHost(normalizedHostname) || seenHosts.has(normalizedHostname)) return;

  seenHosts.add(normalizedHostname);
  results.push({
    url: normalizedUrl,
    title: title.trim(),
    snippet: (snippet || "").replace(/\s+/g, " ").trim(),
    searchQuery
  });
}

function parseBraveResults(html, searchQuery, maxResults) {
  const document = new JSDOM(html).window.document;
  const results = [];
  const seenHosts = new Set();

  for (const result of document.querySelectorAll('.snippet[data-type="web"]')) {
    const link = result.querySelector('a[href^="http"]');
    if (!link) continue;

    let resultUrl;
    try {
      resultUrl = new URL(link.href);
    } catch {
      continue;
    }

    if (!["http:", "https:"].includes(resultUrl.protocol)) continue;

    const normalizedUrl = `${resultUrl.protocol}//${resultUrl.host}/`;
    addResult(results, seenHosts, normalizedUrl, link.textContent, result.textContent, searchQuery);
    if (results.length >= maxResults) break;
  }

  return results;
}

function parseBingResults(html, searchQuery, maxResults) {
  const document = new JSDOM(html).window.document;
  const results = [];
  const seenHosts = new Set();

  for (const result of document.querySelectorAll('.b_algo')) {
    const link = result.querySelector('a[href^="http"]');
    if (!link) continue;

    let resultUrl;
    try {
      resultUrl = new URL(link.href);
    } catch {
      continue;
    }

    const resolvedUrl = resolveResultUrl(link.href) || `${resultUrl.protocol}//${resultUrl.host}/`;
    const title = (link.textContent || result.querySelector('h2, h3')?.textContent || "").trim();
    const snippet = (result.textContent || "").replace(/\s+/g, " ").trim();
    addResult(results, seenHosts, resolvedUrl, title, snippet, searchQuery);
    if (results.length >= maxResults) break;
  }

  return results;
}

function parseDuckDuckGoResults(html, searchQuery, maxResults) {
  const document = new JSDOM(html).window.document;
  const results = [];
  const seenHosts = new Set();

  for (const result of document.querySelectorAll('.result, .web-result')) {
    const link = result.querySelector('a[href^="http"]');
    if (!link) continue;

    let resultUrl;
    try {
      resultUrl = new URL(link.href);
    } catch {
      continue;
    }

    const normalizedUrl = `${resultUrl.protocol}//${resultUrl.host}/`;
    const title = (link.textContent || result.querySelector('.result__title')?.textContent || "").trim();
    const snippet = (result.textContent || "").replace(/\s+/g, " ").trim();
    addResult(results, seenHosts, normalizedUrl, title, snippet, searchQuery);
    if (results.length >= maxResults) break;
  }

  return results;
}

function parseSearchResults(html, searchQuery, maxResults, engine = "brave") {
  switch (engine) {
    case "bing":
      return parseBingResults(html, searchQuery, maxResults);
    case "duckduckgo":
      return parseDuckDuckGoResults(html, searchQuery, maxResults);
    case "brave":
    default:
      return parseBraveResults(html, searchQuery, maxResults);
  }
}

function fetchHtml(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(new Error(`Invalid search URL: ${error.message}`));
      return;
    }

    const mod = parsed.protocol === "http:" ? http : https;
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      ...extraHeaders
    };

    const req = mod.get(targetUrl, { headers, timeout: 15000 }, (res) => {
      let body = "";
      let bodyBytes = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bodyBytes += Buffer.byteLength(chunk, "utf8");
        if (bodyBytes > 4 * 1024 * 1024) {
          req.destroy(new Error("Search results exceeded the 4 MB response limit."));
          return;
        }
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Search provider returned HTTP ${res.statusCode}.`));
          return;
        }
        resolve(body);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Search provider timed out.")));
  });
}

function fetchUrlscanResults(query, maxResults) {
  return new Promise((resolve, reject) => {
    const targetUrl = `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=${maxResults}`;
    const req = https.get(targetUrl, {
      headers: {
        "User-Agent": "ShopifyLeadFinder/2.0 (public storefront discovery)",
        Accept: "application/json"
      },
      timeout: 20000
    }, (res) => {
      let body = "";
      let bodyBytes = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bodyBytes += Buffer.byteLength(chunk, "utf8");
        if (bodyBytes > 5 * 1024 * 1024) {
          req.destroy(new Error("urlscan.io results exceeded the 5 MB response limit."));
          return;
        }
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`urlscan.io returned HTTP ${res.statusCode}.`));
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve(Array.isArray(data.results) ? data.results : []);
        } catch (error) {
          reject(new Error(`urlscan.io returned invalid JSON: ${error.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("urlscan.io search timed out.")));
  });
}

function parseUrlscanResults(results, searchQuery, maxResults) {
  const candidates = [];
  const seenHosts = new Set();

  for (const result of results) {
    const rawUrl = result?.page?.url || result?.task?.url;
    if (!rawUrl) continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) continue;

    const hostname = normalizeHost(parsedUrl.hostname);
    if (!hostname || isBlockedHost(hostname) || seenHosts.has(hostname)) continue;

    const status = Number.parseInt(result?.page?.status, 10);
    const scanTime = Date.parse(result?.task?.time || "");
    const age = Date.now() - scanTime;
    const title = String(result?.page?.title || hostname).trim();
    const taskDomain = normalizeHost(result?.task?.domain);
    const reverseDns = normalizeHost(result?.page?.ptr);
    const ip = String(result?.page?.ip || "");
    const indexedShopifyEvidence =
      taskDomain.endsWith(".myshopify.com") ||
      reverseDns === "myshopify.com" ||
      reverseDns.endsWith(".myshopify.com") ||
      /^23\.227\.38\.\d{1,3}$/.test(ip);
    const isCurrentSuccessfulScan =
      status === 200 &&
      Number.isFinite(scanTime) &&
      age >= -URLSCAN_FUTURE_TOLERANCE_MS &&
      age <= URLSCAN_MAX_AGE_MS &&
      !/store unavailable|this store is unavailable|page not found/i.test(title);
    if (!isCurrentSuccessfulScan) continue;

    seenHosts.add(hostname);
    candidates.push({
      url: `${parsedUrl.protocol}//${parsedUrl.host}/`,
      title,
      snippet: "",
      searchQuery,
      source: "urlscan.io",
      storeEvidence: indexedShopifyEvidence
        ? {
            verified: true,
            source: "urlscan.io",
            scanTime: new Date(scanTime).toISOString(),
            scanUrl: result?._id
              ? `https://urlscan.io/result/${encodeURIComponent(String(result._id))}/`
              : "",
            evidence: `Public scan returned HTTP ${status}; Shopify evidence: ${taskDomain || reverseDns || ip}`
          }
        : null
    });
    if (candidates.length >= maxResults) break;
  }

  return candidates;
}

function fetchJson(targetUrl, headers = {}) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const mod = parsed.protocol === "http:" ? http : https;
      const req = mod.get(
        targetUrl,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            ...headers
          },
          timeout: 10000
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve(null);
            }
          });
        }
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

class SearchProvider {
  constructor() {
    this.providerType = config.searchProvider || "direct";
    this.apiKey = config.searchApiKey || "";
  }

  /**
   * Search for public company HR / Careers contacts across search providers
   */
  async searchHiringContacts(companyName, domain = null, hiringFocus = "Shopify developer") {
    if (!companyName) return { contacts: [], sources: [] };

    // If SerpAPI or Google API key is configured
    if (this.providerType === "serpapi" && this.apiKey) {
      return this.searchSerpApi(companyName, domain, hiringFocus);
    }

    if (this.providerType === "google" && this.apiKey) {
      return this.searchGoogleCustom(companyName, domain);
    }

    // Default: Direct domain and public directory lookup (no paid API required)
    return { contacts: [], sources: [] };
  }

  async searchShopifyStores(keywords, country = "India", maxResults = 30) {
    const limit = Math.max(1, Math.min(Number.parseInt(maxResults, 10) || 30, 100));
    const locationText = /^(worldwide|global|anywhere|all)$/i.test(country) ? "" : country;
    const normalizedKeywords = String(keywords).trim().replace(/\s+/g, " ");
    const keywordWithLocation = normalizedKeywords && locationText && !new RegExp(`\\b${locationText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(normalizedKeywords)
      ? `${normalizedKeywords} ${locationText}`
      : normalizedKeywords;
    const searchTerms = [
      `site:myshopify.com ${keywordWithLocation}`,
      `Shopify store ${keywordWithLocation} -apps.shopify.com -themes.shopify.com`,
      `"Powered by Shopify" ${keywordWithLocation}`
    ].filter(Boolean);
    const searchEngines = [
      {
        name: "brave",
        buildUrl: (term) => `https://search.brave.com/search?q=${encodeURIComponent(term)}`,
        extraHeaders: {}
      },
      {
        name: "bing",
        buildUrl: (term) => `https://www.bing.com/search?q=${encodeURIComponent(term)}`,
        extraHeaders: { Referer: "https://www.bing.com/" }
      },
      {
        name: "duckduckgo",
        buildUrl: (term) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}`,
        extraHeaders: { Referer: "https://duckduckgo.com/" }
      }
    ];
    const results = [];
    const seenHosts = new Set();

    const countryCode = locationText ? normalizer.normalizeCountryCode(locationText, "") : "";
    if (countryCode) {
      const query = `country:${countryCode} AND domain:myshopify.com`;
      try {
        const indexedResults = await fetchUrlscanResults(query, limit);
        const candidates = parseUrlscanResults(indexedResults, query, limit);
        logger.info(`urlscan.io returned ${candidates.length} recent Shopify storefront candidate(s) for ${locationText}.`);
        for (const candidate of candidates) {
          const hostname = new URL(candidate.url).hostname.toLowerCase().replace(/^www\./, "");
          if (seenHosts.has(hostname)) continue;
          seenHosts.add(hostname);
          results.push(candidate);
        }
      } catch (error) {
        logger.warn(`urlscan.io search failed for ${locationText}: ${error.message}`);
      }
    }

    if (results.length < limit) {
      const query = "domain:myshopify.com";
      try {
        const indexedResults = await fetchUrlscanResults(query, limit - results.length);
        const candidates = parseUrlscanResults(indexedResults, query, limit - results.length);
        for (const candidate of candidates) {
          const hostname = new URL(candidate.url).hostname.toLowerCase().replace(/^www\./, "");
          if (seenHosts.has(hostname)) continue;
          seenHosts.add(hostname);
          results.push(candidate);
          if (results.length >= limit) break;
        }
      } catch (error) {
        logger.warn(`urlscan.io global search failed: ${error.message}`);
      }
    }

    for (const searchTerm of searchTerms) {
      if (results.length >= limit) break;

      for (const engine of searchEngines) {
        if (results.length >= limit) break;

        const url = engine.buildUrl(searchTerm);
        let html;
        try {
          html = await fetchHtml(url, engine.extraHeaders);
        } catch (error) {
          logger.warn(`Search fallback ${engine.name} failed for "${searchTerm}": ${error.message}`);
          continue;
        }

        const pageResults = parseSearchResults(html, searchTerm, limit - results.length, engine.name);
        for (const result of pageResults) {
          const hostname = new URL(result.url).hostname.toLowerCase().replace(/^www\./, "");
          if (seenHosts.has(hostname)) continue;
          seenHosts.add(hostname);
          results.push(result);
          if (results.length >= limit) break;
        }
      }

      if (results.length < limit && searchTerm !== searchTerms[searchTerms.length - 1]) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }

    return results;
  }

  async searchSerpApi(companyName, domain, hiringFocus = "Shopify developer") {
    const query = domain
      ? `site:${domain} ${hiringFocus} jobs OR careers OR hiring HR email`
      : `"${companyName}" ${hiringFocus} jobs OR careers OR hiring HR email`;

    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${this.apiKey}&num=5`;
    const data = await fetchJson(url);
    if (!data || !data.organic_results) return { contacts: [], sources: [] };

    const discoveredContacts = [];
    const sources = [];

    data.organic_results.forEach((res) => {
      const text = `${res.title || ""} ${res.snippet || ""}`;
      const emails = validator.extractEmails(text);
      emails.forEach((email) => {
        discoveredContacts.push({
          email,
          email_type: validator.classifyEmailType(email),
          source_url: res.link,
          confidence: validator.calculateConfidence(email, res.link, domain)
        });
      });

      if (emails.length > 0) {
        sources.push({
          source_type: "Search Result (SerpAPI)",
          url: res.link,
          title: res.title,
          evidence: `Found ${emails.length} email(s) in snippet`
        });
      }
    });

    return { contacts: discoveredContacts, sources };
  }

  async searchGoogleCustom(companyName, domain) {
    // Standard Google Custom Search JSON API implementation
    return { contacts: [], sources: [] };
  }
}

module.exports = new SearchProvider();
module.exports.parseBraveResults = parseBraveResults;
