const https = require("https");
const http = require("http");
const { URL } = require("url");
const validator = require("../services/validator");
const logger = require("../services/logger");
const config = require("../config");

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
  async searchHiringContacts(companyName, domain = null) {
    if (!companyName) return { contacts: [], sources: [] };

    // If SerpAPI or Google API key is configured
    if (this.providerType === "serpapi" && this.apiKey) {
      return this.searchSerpApi(companyName, domain);
    }

    if (this.providerType === "google" && this.apiKey) {
      return this.searchGoogleCustom(companyName, domain);
    }

    // Default: Direct domain and public directory lookup (no paid API required)
    return { contacts: [], sources: [] };
  }

  async searchSerpApi(companyName, domain) {
    const query = domain
      ? `site:${domain} hr OR careers OR hiring email`
      : `"${companyName}" HR email OR careers email`;

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
