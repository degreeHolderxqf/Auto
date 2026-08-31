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
  },

  /**
   * Phone Number Normalization with libphonenumber-js
   */
  normalizePhone(phoneStr, defaultCountry = "IN") {
    if (!phoneStr || typeof phoneStr !== "string") return null;
    try {
      const { parsePhoneNumberFromString } = require("libphonenumber-js");
      const parsed = parsePhoneNumberFromString(phoneStr, defaultCountry);
      if (parsed && parsed.isValid()) {
        return {
          formatted: parsed.formatInternational(), // e.g. +91 98765 43210
          e164: parsed.format("E.164"), // e.g. +919876543210
          country: parsed.country,
          nationalNumber: parsed.nationalNumber
        };
      }
    } catch {}
    return null;
  },

  /**
   * Extracts and filters public business phone numbers from HTML/text.
   * STRICT RULE: Ignores customer support, sales inquiries, and toll-free helpline numbers.
   */
  extractPhones(textOrHtml, defaultCountry = "IN", sourceUrl = null) {
    if (!textOrHtml || typeof textOrHtml !== "string") return [];

    const discovered = [];
    const seen = new Set();

    // 1. Detect explicit WhatsApp direct links (wa.me / api.whatsapp.com)
    const waRegex = /(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com\/send\?(?:[^"'\s]*&)?phone=)(\+?[0-9]{7,15})/gi;
    const waMatches = [...textOrHtml.matchAll(waRegex)];
    for (const match of waMatches) {
      const norm = this.normalizePhone(match[1], defaultCountry);
      if (norm && !seen.has(norm.e164)) {
        seen.add(norm.e164);
        discovered.push({
          raw: match[1],
          phone: norm.formatted,
          normalized_phone: norm.e164,
          phone_type: "BUSINESS",
          source_url: sourceUrl,
          whatsapp_available: "yes"
        });
      }
    }

    // 2. Detect tel: links
    const telRegex = /href=["']tel:([^"']+)["']/gi;
    const telMatches = [...textOrHtml.matchAll(telRegex)];
    for (const match of telMatches) {
      const raw = match[1].split("?")[0].trim();
      const norm = this.normalizePhone(raw, defaultCountry);
      if (norm && !seen.has(norm.e164)) {
        // Check if toll-free or sales
        if (norm.nationalNumber.startsWith("1800") || norm.nationalNumber.startsWith("1860") || norm.nationalNumber.startsWith("800")) {
          continue; // Skip toll-free helpdesk
        }
        seen.add(norm.e164);
        discovered.push({
          raw,
          phone: norm.formatted,
          normalized_phone: norm.e164,
          phone_type: "COMPANY",
          source_url: sourceUrl,
          whatsapp_available: "unknown"
        });
      }
    }

    // 3. Scan plain text for formatted international & domestic phone numbers
    const generalPhoneRegex = /(?:\+?[1-9]\d{0,2}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)?\d{3,4}[ -]?\d{3,5}/g;
    const textMatches = [...textOrHtml.matchAll(generalPhoneRegex)];

    for (const match of textMatches) {
      const rawCandidate = match[0].trim();
      if (rawCandidate.length < 8 || rawCandidate.length > 20) continue;
      // Skip strings that are purely digits of typical IDs or postal codes
      if (/^\d{5,6}$/.test(rawCandidate)) continue;

      const norm = this.normalizePhone(rawCandidate, defaultCountry);
      if (norm && !seen.has(norm.e164)) {
        // Skip toll-free helpline numbers
        if (norm.nationalNumber.startsWith("1800") || norm.nationalNumber.startsWith("1860") || norm.nationalNumber.startsWith("800")) {
          continue;
        }

        // Check context around the phone number within the current line / tag block
        const before = textOrHtml.substring(0, match.index || 0);
        const lastBreak = Math.max(
          before.lastIndexOf("\n"),
          before.lastIndexOf("<p"),
          before.lastIndexOf("<div"),
          before.lastIndexOf("<li"),
          before.lastIndexOf("<tr"),
          before.lastIndexOf(">")
        );
        const start = lastBreak >= 0 ? lastBreak : Math.max(0, (match.index || 0) - 50);

        const after = textOrHtml.substring((match.index || 0) + rawCandidate.length);
        const nextBreakIndex = after.search(/\n|<\/p>|<\/div>|<\/li>|<\/tr>|<br|<hr|</i);
        const end = nextBreakIndex >= 0 ? (match.index || 0) + rawCandidate.length + nextBreakIndex : Math.min(textOrHtml.length, (match.index || 0) + rawCandidate.length + 50);

        const context = textOrHtml.substring(start, end).toLowerCase();

        // STRICT FILTER: If labeled customer care, support, sales inquiry, billing, toll free -> ignore
        const isSupportOrSales = context.includes("customer care") || context.includes("support") || context.includes("help desk") || context.includes("toll free") || context.includes("toll-free") || context.includes("sales inquiry") || context.includes("sales hotline");
        const isHiring = context.includes("career") || context.includes("job") || context.includes("recruitment") || context.includes("talent") || context.includes("hr") || context.includes("hiring");

        if (isSupportOrSales && !isHiring) {
          continue;
        }

        let phoneType = "COMPANY";
        if (isHiring) {
          phoneType = "HR / RECRUITMENT";
        } else if (context.includes("whatsapp") || context.includes("chat")) {
          phoneType = "BUSINESS";
        }

        seen.add(norm.e164);
        discovered.push({
          raw: rawCandidate,
          phone: norm.formatted,
          normalized_phone: norm.e164,
          phone_type: phoneType,
          source_url: sourceUrl,
          whatsapp_available: phoneType === "BUSINESS" || context.includes("whatsapp") ? "yes" : "unknown"
        });
      }
    }

    return discovered;
  }
};

module.exports = validator;
