const dns = require("dns").promises;
const normalizer = require("./normalizer");

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "10minutemail.com", "tempmail.com", "guerrillamail.com",
  "throwawaymail.com", "temp-mail.org", "sharklasers.com", "dispostable.com",
  "trashmail.com", "yopmail.com", "getairmail.com", "mohmal.com", "crazymailing.com"
]);

const IGNORED_DOMAINS = new Set([
  "example.com", "domain.com", "test.com", "shopify.com", "shopifycloud.com",
  "myshopify.com", "facebook.com", "twitter.com", "instagram.com", "youtube.com",
  "linkedin.com", "google.com", "apple.com", "w3.org", "sentry.io", "cloudflare.com",
  "github.com", "schema.org", "gravatar.com", "wixpress.com", "wordpress.org"
]);

const HR_PREFIXES = [
  "hr", "career", "careers", "recruiter", "recruitment", "talent",
  "talentacquisition", "hiring", "people", "peopleops", "peopleoperations",
  "jobs", "job", "work", "join", "joinus", "workwithus", "opportunities"
];

const MANAGEMENT_PREFIXES = [
  "founder", "ceo", "cto", "coo", "vp", "director", "head", "lead", "engineering"
];

const GENERAL_PREFIXES = [
  "info", "hello", "contact", "connect", "team", "hi", "inquiry", "enquiries", "office"
];

const AVOID_PREFIXES = [
  "support", "sales", "billing", "accounts", "admin", "help", "care", "customercare", "privacy", "noreply", "no-reply"
];

const validator = {
  /**
   * Basic RFC email format check
   */
  isValidEmailFormat(email) {
    if (!email || typeof email !== "string") return false;
    const cleaned = email.trim().toLowerCase();

    // Check basic length and structure
    if (cleaned.length < 5 || cleaned.length > 254) return false;
    if (cleaned.includes(" ") || cleaned.includes("..") || cleaned.includes("/") || cleaned.includes("\\")) return false;

    // Check email extension noise (e.g. image filenames parsed as email)
    if (/\.(png|jpg|jpeg|gif|webp|svg|css|js|woff|woff2|ttf|pdf)$/i.test(cleaned)) return false;

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(cleaned)) return false;

    const parts = cleaned.split("@");
    if (parts.length !== 2) return false;

    const domain = parts[1];
    if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return false;

    // Check ignored & disposable domains
    if (DISPOSABLE_DOMAINS.has(domain) || IGNORED_DOMAINS.has(domain)) return false;

    // Reject obvious placeholders
    const local = parts[0];
    if (["test", "sample", "yourname", "name", "email", "username", "john.doe"].includes(local)) return false;

    return true;
  },

  /**
   * Clean and normalize email string
   */
  cleanEmail(email) {
    if (!email || typeof email !== "string") return null;
    let cleaned = email.trim().toLowerCase();
    cleaned = cleaned.replace(/["'<>()[\]]/g, "");
    cleaned = cleaned.replace(/^mailto:/i, "");
    cleaned = cleaned.replace(/@www\./i, "@");
    return this.isValidEmailFormat(cleaned) ? cleaned : null;
  },

  /**
   * Extract all valid emails from text or HTML
   */
  extractEmails(text) {
    if (!text || typeof text !== "string") return [];
    const matches = [...text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)];
    const valid = new Set();

    for (const match of matches) {
      const cleaned = this.cleanEmail(match[0]);
      if (cleaned) valid.add(cleaned);
    }

    return Array.from(valid);
  },

  /**
   * Classify email contact type & priority
   */
  classifyEmailType(email) {
    if (!email) return "Unknown";
    const local = email.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");

    for (const prefix of HR_PREFIXES) {
      if (local === prefix || local.startsWith(prefix)) {
        return "HR / Recruitment";
      }
    }

    for (const prefix of MANAGEMENT_PREFIXES) {
      if (local === prefix || local.startsWith(prefix)) {
        return "Hiring Management";
      }
    }

    for (const prefix of GENERAL_PREFIXES) {
      if (local === prefix || local.startsWith(prefix)) {
        return "General";
      }
    }

    for (const prefix of AVOID_PREFIXES) {
      if (local === prefix || local.startsWith(prefix)) {
        return "Support / Sales";
      }
    }

    // Default: could be named person e.g. himanshu@company.com
    return "Personal / Professional";
  },

  /**
   * Check DNS MX records for domain
   */
  async checkMxRecords(domainOrEmail) {
    const domain = domainOrEmail.includes("@") ? domainOrEmail.split("@")[1] : domainOrEmail;
    if (!domain) return false;

    try {
      const records = await dns.resolveMx(domain);
      return Array.isArray(records) && records.length > 0;
    } catch (err) {
      return false;
    }
  },

  /**
   * Determine confidence level for an email
   */
  calculateConfidence(email, sourceUrl, companyDomain = null) {
    if (!email) return "LOW";
    const emailDomain = email.split("@")[1].toLowerCase();
    const normCompanyDomain = normalizer.normalizeDomain(companyDomain);

    const isDirectWebsite = sourceUrl && normCompanyDomain && sourceUrl.includes(normCompanyDomain);
    const isDomainMatch = normCompanyDomain && (emailDomain === normCompanyDomain || normCompanyDomain.includes(emailDomain) || emailDomain.includes(normCompanyDomain));

    if (isDirectWebsite && (isDomainMatch || emailDomain === "gmail.com")) {
      return "HIGH";
    }

    if (isDomainMatch) {
      return "HIGH";
    }

    if (sourceUrl && (sourceUrl.includes("shopify.com") || sourceUrl.includes("linkedin.com"))) {
      return "HIGH";
    }

    return "MEDIUM";
  }
};

module.exports = validator;
