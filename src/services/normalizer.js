const normalizer = {
  /**
   * Normalizes a company name for fuzzy deduplication & exclusion matching.
   * e.g., "ABC Technologies Pvt. Ltd." -> "abc"
   * "Dynamic Dreamz" -> "dynamic dreamz"
   */
  normalizeCompanyName(rawName) {
    if (!rawName || typeof rawName !== "string") return "";

    let cleaned = rawName.toLowerCase().trim();

    // Remove text after pipes, hyphens, or colons if used as marketing taglines
    // e.g. "Blueslag Technologies | End-to-End D2C Growth" -> "Blueslag Technologies"
    // "KLoc - UI/UX | Theme Customization..." -> "KLoc"
    cleaned = cleaned.split("|")[0].split(" - ")[0].split(" • ")[0].split(" — ")[0].trim();
    if (cleaned.includes(":")) {
      cleaned = cleaned.split(":")[0].trim();
    }

    // Remove common company legal suffixes & corporate noise words
    const suffixes = [
      /\bpvt\.?\s*ltd\.?\b/gi,
      /\bprivate\s*limited\b/gi,
      /\bllc\b/gi,
      /\binc\.?\b/gi,
      /\bltd\.?\b/gi,
      /\btechnologies\b/gi,
      /\btechnology\b/gi,
      /\btech\b/gi,
      /\binfotech\b/gi,
      /\bsolutions\b/gi,
      /\btechnolabs\b/gi,
      /\bsoftware\b/gi,
      /\bconsultancy\b/gi,
      /\benterprises\b/gi,
      /\bgroup\b/gi,
      /\bagency\b/gi,
      /\bstudios?\b/gi,
      /\bdigital\b/gi,
      /\bcommerce\b/gi,
      /\becommerce\b/gi,
      /\binteractive\b/gi,
      /\bco\.?\b/gi,
      /\bcorp\.?\b/gi
    ];

    suffixes.forEach(pattern => {
      cleaned = cleaned.replace(pattern, " ");
    });

    // Remove punctuation, brackets, symbols, trademarks
    cleaned = cleaned.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\"'’™®•]/g, " ");

    // Collapse multiple whitespace
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    // If stripping left nothing (e.g. company was named just "Technologies"), fallback to raw stripped of punctuation
    if (!cleaned) {
      cleaned = rawName.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    }

    return cleaned;
  },

  /**
   * Normalizes a web domain or URL
   * e.g., "https://www.codifyinfotech.com/contact-us" -> "codifyinfotech.com"
   */
  normalizeDomain(rawUrlOrDomain) {
    if (!rawUrlOrDomain || typeof rawUrlOrDomain !== "string") return null;

    let domain = rawUrlOrDomain.trim().toLowerCase();

    // Strip protocols
    domain = domain.replace(/^https?:\/\//, "");

    // Strip leading www.
    domain = domain.replace(/^www\./, "");

    // Strip path, query params, hash
    domain = domain.split("/")[0].split("?")[0].split("#")[0].split(":")[0];

    // Basic domain validation
    if (domain.includes(".") && domain.length > 3 && !domain.includes(" ")) {
      return domain;
    }

    return null;
  },

  normalizeCountryCode(country, fallback = "IN") {
    const value = String(country || "").trim();
    if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
    const codes = {
      india: "IN",
      "united states": "US",
      usa: "US",
      "united kingdom": "GB",
      uk: "GB",
      canada: "CA",
      australia: "AU",
      germany: "DE",
      france: "FR",
      singapore: "SG",
      "united arab emirates": "AE",
      uae: "AE",
      netherlands: "NL",
      "new zealand": "NZ"
    };
    return codes[value.toLowerCase()] || fallback;
  },

  /**
   * Extract slug from a Shopify Partner directory URL
   */
  extractPartnerSlug(shopifyUrl) {
    if (!shopifyUrl) return null;
    const match = shopifyUrl.match(/partners\/directory\/partner\/([a-zA-Z0-9_-]+)/);
    return match ? match[1].toLowerCase() : null;
  },

  /**
   * Normalizes a job title for canonical ID generation.
   * Removes common noise words, punctuation, and normalizes whitespace.
   * e.g., "Senior Shopify Developer (Remote)" -> "senior shopify developer remote"
   */
  normalizeJobTitle(rawTitle) {
    if (!rawTitle || typeof rawTitle !== "string") return "";
    let cleaned = rawTitle.toLowerCase().trim();

    // Remove text in parentheses, brackets, and braces
    cleaned = cleaned.replace(/\s*\([^)]*\)\s*/g, " ");
    cleaned = cleaned.replace(/\s*\[[^\]]*\]\s*/g, " ");
    cleaned = cleaned.replace(/\s*\{[^}]*\}\s*/g, " ");

    // Remove location/job type noise
    const noise = [
      /\bremote\b/gi, /\bhybrid\b/gi, /\bon-site\b/gi, /\b onsite\b/gi,
      /\bpart-time\b/gi, /\bfull-time\b/gi, /\bcontract\b/gi, /\bfreelance\b/gi,
      /\bsenior\b/gi, /\bjunior\b/gi, /\blead\b/gi, /\bstaff\b/gi,
      /\bsr\.?\b/gi, /\bjr\.?\b/gi,
      /\b-\s*\d+\s*years?\b/gi,
      /\b\d+\+\s*years?\b/gi,
    ];
    noise.forEach((pattern) => {
      cleaned = cleaned.replace(pattern, " ");
    });

    // Remove punctuation and symbols
    cleaned = cleaned.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\"'•]/g, " ");

    // Collapse multiple whitespace
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    return cleaned;
  }
};

module.exports = normalizer;
