const https = require("https");
const http = require("http");
const { URL } = require("url");
const normalizer = require("../services/normalizer");
const employeeVerifier = require("../services/employeeVerifier");
const logger = require("../services/logger");

function fetchUrl(targetUrl, timeout = 10000) {
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
            try {
              const nextUrl = new URL(res.headers.location, targetUrl).toString();
              return resolve(fetchUrl(nextUrl, timeout));
            } catch (e) {
              return resolve({ status: res.statusCode, html: "" });
            }
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

class LinkedInProvider {
  /**
   * Constructs a standard public LinkedIn company search URL if company LinkedIn wasn't found directly on website
   */
  generateCompanySearchUrl(companyName) {
    if (!companyName) return null;
    const cleanName = encodeURIComponent(companyName.trim());
    return `https://www.linkedin.com/company/${cleanName.toLowerCase()}`;
  }

  /**
   * Normalizes LinkedIn URL
   */
  cleanLinkedInUrl(rawUrl) {
    if (!rawUrl) return null;
    const match = rawUrl.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[a-zA-Z0-9_-]+/i);
    return match ? match[0] : null;
  }

  /**
   * Attempts to fetch public LinkedIn company page and extract employee headcount/range evidence.
   * @param {string} linkedinUrl
   * @returns {Promise<object|null>}
   */
  async getCompanyHeadcount(linkedinUrl) {
    const cleanUrl = this.cleanLinkedInUrl(linkedinUrl);
    if (!cleanUrl) return null;

    try {
      const res = await fetchUrl(cleanUrl);
      if (res.status === 200 && res.html && res.html.length > 300) {
        const evidence = employeeVerifier.parseHeadcountEvidence(res.html, "LinkedIn", cleanUrl);
        if (evidence.status !== "UNKNOWN") {
          return evidence;
        }
      }
    } catch (err) {
      // ignore network errors
    }

    return null;
  }

  /**
   * Parses LinkedIn text or snippet (e.g. from search result or directory profile)
   * @param {string} text
   * @param {string} sourceUrl
   * @returns {object}
   */
  parseLinkedInText(text, sourceUrl = "LinkedIn") {
    return employeeVerifier.parseHeadcountEvidence(text, "LinkedIn", sourceUrl);
  }
}

module.exports = new LinkedInProvider();
