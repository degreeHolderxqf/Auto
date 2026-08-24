const https = require("https");
const http = require("http");
const { URL } = require("url");
const normalizer = require("../services/normalizer");
const validator = require("../services/validator");
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

class CompanyWebsiteProvider {
  /**
   * Crawls a company website and its subpages for contacts, careers URLs, employee headcount, and Shopify app evidence.
   */
  async researchWebsite(domain, officialWebsite = null) {
    const cleanDomain = normalizer.normalizeDomain(domain || officialWebsite);
    if (!cleanDomain) {
      return { contacts: [], careersUrl: null, linkedInUrl: null, publicApps: [], employeeInfo: null, sources: [] };
    }

    const startUrls = [
      officialWebsite || `https://${cleanDomain}`,
      `https://www.${cleanDomain}`,
      `http://${cleanDomain}`
    ];

    let homepageHtml = "";
    let effectiveBaseUrl = `https://${cleanDomain}`;

    for (const url of startUrls) {
      const res = await fetchUrl(url);
      if (res.status === 200 && res.html.length > 500) {
        homepageHtml = res.html;
        effectiveBaseUrl = url;
        break;
      }
    }

    if (!homepageHtml) {
      return { contacts: [], careersUrl: null, linkedInUrl: null, publicApps: [], employeeInfo: null, sources: [] };
    }

    const discoveredContacts = [];
    const sources = [];
    const publicApps = [];
    const crawledPagesHtml = [];
    let careersUrl = null;
    let linkedInUrl = null;

    // 1. Process Homepage
    const homepageEmails = validator.extractEmails(homepageHtml);
    homepageEmails.forEach((email) => {
      discoveredContacts.push({
        email,
        email_type: validator.classifyEmailType(email),
        source_url: effectiveBaseUrl,
        confidence: validator.calculateConfidence(email, effectiveBaseUrl, cleanDomain)
      });
    });

    sources.push({
      source_type: "Official Website Homepage",
      url: effectiveBaseUrl,
      title: "Company Homepage",
      evidence: `Found ${homepageEmails.length} public email(s)`
    });

    // Extract LinkedIn link from homepage
    const linkedInMatch = homepageHtml.match(/href=["'](https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[^"']+)["']/i);
    if (linkedInMatch) {
      linkedInUrl = linkedInMatch[1].split("?")[0];
    }

    // Check for Public Shopify App links
    const appMatches = [...homepageHtml.matchAll(/href=["'](https?:\/\/apps\.shopify\.com\/[^"']+)["']/gi)];
    appMatches.forEach((m) => {
      const appUrl = m[1].split("?")[0];
      if (!publicApps.includes(appUrl)) publicApps.push(appUrl);
    });

    // 2. Discover subpages (Careers, Jobs, Contact, Team, About)
    const targetSubpagePatterns = [
      /href=["']([^"']*(?:career|jobs?|join|work-with-us|opportunities)[^"']*)["']/gi,
      /href=["']([^"']*(?:contact|connect|reach-us)[^"']*)["']/gi,
      /href=["']([^"']*(?:about|team|people|leadership|company)[^"']*)["']/gi
    ];

    const subpageUrls = new Set();

    targetSubpagePatterns.forEach((pattern) => {
      const matches = [...homepageHtml.matchAll(pattern)];
      matches.forEach((m) => {
        try {
          const fullUrl = new URL(m[1], effectiveBaseUrl).toString();
          const normSubDomain = normalizer.normalizeDomain(fullUrl);
          // Only crawl internal links or legitimate careers portals
          if (normSubDomain === cleanDomain || fullUrl.includes("lever.co") || fullUrl.includes("greenhouse.io") || fullUrl.includes("workable.com")) {
            subpageUrls.add(fullUrl);
          }
        } catch (e) {
          // ignore malformed URLs
        }
      });
    });

    // Limit crawling up to 6 most relevant subpages
    const subpagesToCrawl = Array.from(subpageUrls).slice(0, 6);

    for (const subUrl of subpagesToCrawl) {
      const lower = subUrl.toLowerCase();
      const isCareers = lower.includes("career") || lower.includes("job") || lower.includes("join") || lower.includes("work");
      if (isCareers && !careersUrl) {
        careersUrl = subUrl;
      }

      const pageRes = await fetchUrl(subUrl);
      if (pageRes.status === 200 && pageRes.html) {
        crawledPagesHtml.push(pageRes.html);

        const pageEmails = validator.extractEmails(pageRes.html);
        pageEmails.forEach((email) => {
          discoveredContacts.push({
            email,
            email_type: isCareers ? "HR / Recruitment" : validator.classifyEmailType(email),
            source_url: subUrl,
            confidence: validator.calculateConfidence(email, subUrl, cleanDomain)
          });
        });

        if (pageEmails.length > 0) {
          sources.push({
            source_type: isCareers ? "Careers Page" : "Contact/Team Page",
            url: subUrl,
            title: isCareers ? "Company Careers Page" : "Company Subpage",
            evidence: `Found ${pageEmails.length} email(s): ${pageEmails.join(", ")}`
          });
        }

        // Check for LinkedIn on subpages if not found on homepage
        if (!linkedInUrl) {
          const subLinkedIn = pageRes.html.match(/href=["'](https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[^"']+)["']/i);
          if (subLinkedIn) linkedInUrl = subLinkedIn[1].split("?")[0];
        }

        // Check for App Store links on subpages
        const subAppMatches = [...pageRes.html.matchAll(/href=["'](https?:\/\/apps\.shopify\.com\/[^"']+)["']/gi)];
        subAppMatches.forEach((m) => {
          const appUrl = m[1].split("?")[0];
          if (!publicApps.includes(appUrl)) publicApps.push(appUrl);
        });
      }
    }

    // Deduplicate contacts by email
    const uniqueContacts = [];
    const seenEmails = new Set();

    // Sort contacts: HR first, then Management, then General; HIGH confidence first
    discoveredContacts.sort((a, b) => {
      const typeRank = (t) => (t === "HR / Recruitment" ? 1 : t === "Hiring Management" ? 2 : t === "Personal / Professional" ? 3 : 4);
      const confRank = (c) => (c === "HIGH" ? 1 : c === "MEDIUM" ? 2 : 3);
      return typeRank(a.email_type) - typeRank(b.email_type) || confRank(a.confidence) - confRank(b.confidence);
    });

    for (const contact of discoveredContacts) {
      if (!seenEmails.has(contact.email)) {
        seenEmails.add(contact.email);
        uniqueContacts.push(contact);
      }
    }

    // 3. Extract Employee Headcount Evidence from Homepage and Subpages
    let employeeEvidence = employeeVerifier.parseHeadcountEvidence(homepageHtml, "Official Website Homepage", effectiveBaseUrl);

    if (employeeEvidence.status === "UNKNOWN" || employeeEvidence.status === "NEED_MORE_VERIFICATION") {
      for (const pageHtml of crawledPagesHtml) {
        const subEmp = employeeVerifier.parseHeadcountEvidence(pageHtml, "Company About/Careers Page", effectiveBaseUrl);
        if (subEmp.status !== "UNKNOWN") {
          employeeEvidence = subEmp;
          if (subEmp.status === "QUALIFIED") break;
        }
      }
    }

    return {
      contacts: uniqueContacts,
      careersUrl,
      linkedInUrl,
      publicApps,
      employeeInfo: employeeEvidence,
      employeeEvidence,
      sources
    };
  }
}

module.exports = new CompanyWebsiteProvider();
