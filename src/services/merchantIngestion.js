const fs = require("fs");
const path = require("path");
const os = require("os");
const csv = require("csv-parser");
const db = require("../db/database");
const logger = require("./logger");
const validator = require("./validator");
const normalizer = require("./normalizer");

/**
 * Merchant Lead Ingestion Service
 * Parses CSV/JSON files containing Shopify merchant leads from tools like StoreCensus, StoreLeads
 * Expected columns:
 * - store_name (required)
 * - website_url (required)
 * - contact_email
 * - contact_phone
 * - installed_apps (comma-separated or JSON array)
 * - tech_stack (comma-separated or JSON array)
 * - estimated_revenue
 * - country
 * - platform (default: "Shopify")
 */

class MerchantIngestion {
  constructor() {
    this.supportedFormats = [".csv", ".json"];
  }

  /**
   * Validate file format
   */
  validateFormat(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!this.supportedFormats.includes(ext)) {
      throw new Error(`Unsupported file format: ${ext}. Supported: ${this.supportedFormats.join(", ")}`);
    }
    return ext;
  }

  /**
   * Normalize and clean a lead record
   */
  normalizeLead(rawLead, rowIndex) {
    const value = (...keys) => {
      const wanted = new Set(keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "")));
      const foundKey = Object.keys(rawLead || {}).find((key) =>
        wanted.has(String(key).replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, ""))
      );
      return foundKey === undefined ? "" : rawLead[foundKey];
    };
    const text = (input) => input === null || input === undefined ? "" : String(input).trim();
    const lead = {};

    // Required fields
    lead.store_name = text(value("store_name", "store name", "name"));
    lead.website_url = text(value("website_url", "website url", "url"));

    if (!lead.store_name) {
      throw new Error(`Row ${rowIndex}: Missing required field 'store_name'`);
    }
    if (!lead.website_url) {
      throw new Error(`Row ${rowIndex}: Missing required field 'website_url'`);
    }

    // Normalize website URL
    if (!/^https?:\/\//i.test(lead.website_url)) {
      lead.website_url = "https://" + lead.website_url;
    }

    // Extract domain from URL
    try {
      const url = new URL(lead.website_url);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
        throw new Error("Website URL must use http or https");
      }
      lead.domain = url.hostname.replace(/^www\./, "");
    } catch {
      throw new Error(`Row ${rowIndex}: Invalid website URL '${lead.website_url}'`);
    }

    // Optional fields
    lead.contact_email = text(value("contact_email", "contact email", "email")).toLowerCase();
    lead.contact_email_type = text(value("contact_email_type", "email type")) || "Business Contact";
    lead.contact_email_source_url = text(value("contact_email_source_url", "email source url"));
    lead.contact_phone = text(value("contact_phone", "contact phone", "phone"));
    const whatsappAvailable = text(value("whatsapp_available", "whatsapp available")).toLowerCase();
    lead.whatsapp_available = ["yes", "no", "unknown"].includes(whatsappAvailable)
      ? whatsappAvailable
      : "unknown";
    if (lead.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.contact_email)) {
      logger.warn(`Row ${rowIndex}: Ignoring an invalid contact email`);
      lead.contact_email = "";
    }

    // Parse installed_apps (can be comma-separated or JSON)
    const rawApps = value("installed_apps", "installed apps", "apps");
    lead.installed_apps = this.parseArrayField(rawApps);

    // Parse tech_stack
    const rawTech = value("tech_stack", "tech stack", "tech");
    lead.tech_stack = this.parseArrayField(rawTech);

    // Estimated revenue
    lead.estimated_revenue = text(value("estimated_revenue", "estimated revenue", "revenue"));
    lead.store_description = text(value("store_description", "store description", "description"));
    const productCount = Number.parseInt(value("product_count", "product count"), 10);
    lead.product_count = Number.isInteger(productCount) && productCount >= 0 ? productCount : null;

    const rawPublicContactLinks = value("public_contact_links", "public contact links");
    if (rawPublicContactLinks && typeof rawPublicContactLinks === "object" && !Array.isArray(rawPublicContactLinks)) {
      lead.public_contact_links = rawPublicContactLinks;
    } else if (rawPublicContactLinks) {
      try {
        const parsedLinks = JSON.parse(String(rawPublicContactLinks));
        lead.public_contact_links = parsedLinks && typeof parsedLinks === "object" && !Array.isArray(parsedLinks)
          ? parsedLinks
          : {};
      } catch {
        lead.public_contact_links = {};
      }
    } else {
      lead.public_contact_links = {};
    }

    // Location
    lead.country = text(value("country")) || "US";
    lead.city = text(value("city"));
    lead.state = text(value("state"));

    // Platform (default Shopify)
    lead.platform = text(value("platform")) || "Shopify";

    // Additional metadata
    lead.source = text(value("source")) || "MERCHANT_UPLOAD";
    lead.lead_score = 0; // Will be calculated later
    lead.status = "DISCOVERED";

    // Normalize phone for WhatsApp
    if (lead.contact_phone) {
      lead.normalized_phone = this.normalizePhone(lead.contact_phone, lead.country);
      if (!lead.normalized_phone) {
        logger.warn(`Row ${rowIndex}: Ignoring an invalid contact phone`);
        lead.contact_phone = "";
      }
    }

    return lead;
  }

  /**
   * Parse array field - handles both comma-separated and JSON array
   */
  parseArrayField(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (value === null || value === undefined || value === "") return [];

    const trimmed = String(value).trim();
    if (!trimmed) return [];

    // Try JSON first
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
      } catch {
        // Fall through to comma-separated
      }
    }

    // Comma-separated
    return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
  }

  saveMerchantDetails(companyId, lead) {
    db.getRawDb().prepare(`
      INSERT INTO merchant_lead_details
        (company_id, website_url, installed_apps_json, tech_stack_json, estimated_revenue, store_description, product_count, public_contact_links_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id) DO UPDATE SET
        website_url = excluded.website_url,
        installed_apps_json = excluded.installed_apps_json,
        tech_stack_json = excluded.tech_stack_json,
        estimated_revenue = excluded.estimated_revenue,
        store_description = excluded.store_description,
        product_count = excluded.product_count,
        public_contact_links_json = excluded.public_contact_links_json
    `).run(
      companyId,
      lead.website_url,
      JSON.stringify(lead.installed_apps),
      JSON.stringify(lead.tech_stack),
      lead.estimated_revenue || null,
      lead.store_description || null,
      lead.product_count,
      JSON.stringify(lead.public_contact_links || {})
    );
  }

  async ingestUploadedData(fileName, content, options = {}) {
    const ext = path.extname(String(fileName || "")).toLowerCase();
    if (!this.supportedFormats.includes(ext)) {
      throw new Error(`Unsupported file format: ${ext}. Supported: ${this.supportedFormats.join(", ")}`);
    }
    if (typeof content !== "string" && !Buffer.isBuffer(content)) {
      throw new Error("Uploaded file content must be text or a Buffer");
    }

    const uploadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "merchant-leads-"));
    const uploadPath = path.join(uploadDir, `upload${ext}`);
    try {
      await fs.promises.writeFile(uploadPath, content, "utf8");
      return await this.ingest(uploadPath, { ...options, sourceName: fileName });
    } finally {
      await fs.promises.rm(uploadDir, { recursive: true, force: true });
    }
  }

  /**
   * Normalize phone number for WhatsApp
   */
  normalizePhone(phone, country = "US") {
    if (!phone) return null;
    const defaultCountry = normalizer.normalizeCountryCode(country, "US");
    return validator.normalizePhone(String(phone), defaultCountry)?.e164 || null;
  }

  /**
   * Calculate lead score based on available data
   */
  calculateLeadScore(lead) {
    let score = 0;

    // Has contact email = major signal
    if (lead.contact_email) score += 30;

    // Has contact phone = good signal
    if (lead.contact_phone) score += 20;

    // Has installed apps = can personalize
    if (lead.installed_apps && lead.installed_apps.length > 0) score += 25;

    // Has tech stack = technical context
    if (lead.tech_stack && lead.tech_stack.length > 0) score += 10;

    // Has estimated revenue = business size indicator
    if (lead.estimated_revenue) score += 15;

    // Known high-value apps
    const highValueApps = ["klaviyo", "snapmint", "recharge", "yotpo", "gorgias", "loyaltylion", "smile.io", "judge.me", "okendo", "postscript", "attentive", "omnisend", "privy", "justuno", "zipify", "pagefly", "shogun", "gempages"];
    const installedLower = lead.installed_apps.map((a) => a.toLowerCase());
    const highValueCount = installedLower.filter((a) => highValueApps.some((hv) => a.includes(hv))).length;
    score += Math.min(highValueCount * 5, 25);

    return Math.min(score, 100);
  }

  /**
   * Check if merchant already exists (by domain or store_name)
   */
  async checkDuplicate(lead) {
    const existingByDomain = lead.domain ? db.getCompanyByDomain(lead.domain) : null;
    if (existingByDomain) return existingByDomain;

    const existingByName = db.getCompanyByNormalizedName(lead.store_name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (existingByName) return existingByName;

    return null;
  }

  async importLeadRow(rawLead, rowNumber, sourceName, options, results) {
    try {
      const lead = this.normalizeLead(rawLead, rowNumber);
      lead.lead_score = this.calculateLeadScore(lead);

      const existing = await this.checkDuplicate(lead);
      const updateSourceAllowed = !options.updateOnlySource || existing?.source === options.updateOnlySource;
      if (existing && (options.skipDuplicates !== false || !updateSourceAllowed)) {
        results.skipped++;
        results.leads.push({ ...lead, id: existing.id, status: "SKIPPED_DUPLICATE" });
        return;
      }
      const isUpdate = Boolean(existing);

      const leadSource = options.source === "MERCHANT_STORE_DISCOVERY" ? "MERCHANT_STORE_DISCOVERY" : "MERCHANT_UPLOAD";
      const company = db.upsertCompany({
        name: lead.store_name,
        normalized_name: lead.store_name.toLowerCase().replace(/[^a-z0-9]/g, ""),
        domain: lead.domain,
        official_website: lead.website_url,
        city: lead.city,
        state: lead.state,
        country: lead.country,
        source: "MERCHANT_UPLOAD",
        status: lead.status,
        lead_score: lead.lead_score,
        phone: lead.contact_phone || null,
        normalized_phone: lead.normalized_phone || null,
        phone_type: lead.contact_phone ? "mobile" : null,
        phone_source: lead.contact_phone ? leadSource : null,
        whatsapp_available: lead.whatsapp_available,
        whatsapp_status: "READY",
        shopify_services: JSON.stringify(lead.tech_stack),
        notes: `Installed Apps: ${lead.installed_apps.join(", ")}; Estimated Revenue: ${lead.estimated_revenue || "Not publicly available"}`
      });
      this.saveMerchantDetails(company.id, lead);

      if (lead.contact_email) {
        db.upsertContact({
          company_id: company.id,
          email: lead.contact_email,
          email_type: lead.contact_email_type,
          confidence: "MEDIUM",
          source_url: lead.contact_email_source_url || lead.website_url,
          phone: lead.contact_phone || null,
          normalized_phone: lead.normalized_phone || null,
          phone_type: lead.contact_phone ? "mobile" : null,
          phone_source: lead.contact_phone ? leadSource : null,
          whatsapp_available: lead.whatsapp_available,
          whatsapp_status: lead.contact_phone ? "READY" : null,
          verified: 0,
          mx_valid: 0,
          notes: leadSource === "MERCHANT_STORE_DISCOVERY"
            ? "Public business contact found on the Shopify storefront"
            : "From merchant lead upload"
        });
      }

      const knownSources = isUpdate ? db.getSourcesByCompanyId(company.id) : [];
      if (!knownSources.some((source) => source.source_type === leadSource && source.url === sourceName)) {
        db.addSource({
          company_id: company.id,
          source_type: leadSource,
          url: sourceName,
          title: `${leadSource === "MERCHANT_STORE_DISCOVERY" ? "Discovered Shopify Store" : "Merchant Lead Upload"} - ${lead.store_name}`,
          evidence: JSON.stringify({
            installed_apps: lead.installed_apps,
            tech_stack: lead.tech_stack,
            estimated_revenue: lead.estimated_revenue,
            store_description: lead.store_description,
            product_count: lead.product_count
          })
        });
      }

      if (isUpdate) results.updated = (results.updated || 0) + 1;
      else results.imported++;
      results.leads.push({ ...lead, id: company.id, status: isUpdate ? "UPDATED" : "IMPORTED" });
    } catch (error) {
      results.errors.push({ row: rowNumber, error: error.message, data: rawLead });
      logger.error(`Row ${rowNumber} import error:`, error.message);
    }
  }

  async importDiscoveredStore(lead, websiteUrl) {
    const results = { imported: 0, updated: 0, skipped: 0, errors: [], leads: [] };
    await this.importLeadRow(
      {
        ...lead,
        website_url: websiteUrl,
        platform: "Shopify",
        source: "MERCHANT_STORE_DISCOVERY"
      },
      1,
      websiteUrl,
      { skipDuplicates: false, updateOnlySource: "MERCHANT_UPLOAD", source: "MERCHANT_STORE_DISCOVERY" },
      results
    );
    return results;
  }

  /**
   * Ingest leads from CSV file
   */
  async ingestFromCSV(filePath, options = {}) {
    const sourceName = options.sourceName || filePath;
    const results = { imported: 0, updated: 0, skipped: 0, errors: [], leads: [] };
    const parser = fs.createReadStream(filePath).pipe(csv({
      mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim()
    }));
    let rowNumber = 0;
    for await (const row of parser) {
      rowNumber++;
      await this.importLeadRow(row, rowNumber, sourceName, options, results);
    }
    logger.success(`CSV ingestion complete: ${results.imported} imported, ${results.skipped} skipped, ${results.errors.length} errors`);
    return results;
  }

  /**
   * Ingest leads from JSON file
   */
  async ingestFromJSON(filePath, options = {}) {
    const sourceName = options.sourceName || filePath;
    const results = { imported: 0, updated: 0, skipped: 0, errors: [], leads: [] };

    const content = fs.readFileSync(filePath, "utf-8");
    let data;

    try {
      data = JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON file: ${err.message}`);
    }

    // Handle both array and object with leads property
    const leadsArray = Array.isArray(data) ? data : data.leads !== undefined ? data.leads : data.data;
    if (!Array.isArray(leadsArray)) {
      throw new Error("JSON input must be an array or an object containing a leads/data array");
    }

    for (let i = 0; i < leadsArray.length; i++) {
      await this.importLeadRow(leadsArray[i], i + 1, sourceName, options, results);
    }

    logger.success(`JSON ingestion complete: ${results.imported} imported, ${results.skipped} skipped, ${results.errors.length} errors`);
    return results;
  }

  /**
   * Main ingestion entry point
   */
  async ingest(filePath, options = {}) {
    const ext = this.validateFormat(filePath);

    if (ext === ".csv") {
      return this.ingestFromCSV(filePath, options);
    } else if (ext === ".json") {
      return this.ingestFromJSON(filePath, options);
    }
  }

  /**
   * Get all merchant leads from database
   */
  getMerchantLeads(filters = {}) {
    const database = db.getRawDb();
    let query = `
      SELECT c.*,
             ct.email,
             ct.confidence as email_confidence,
             ct.email_type,
             ct.source_url as contact_email_source_url,
             COALESCE(ct.phone, c.phone) as phone,
             COALESCE(ct.normalized_phone, c.normalized_phone) as normalized_phone,
             COALESCE(ct.whatsapp_available, c.whatsapp_available) as whatsapp_available,
             m.website_url,
             m.installed_apps_json,
             m.tech_stack_json,
             m.estimated_revenue,
             m.store_description,
             m.product_count,
             m.public_contact_links_json
      FROM companies c
      LEFT JOIN contacts ct ON ct.company_id = c.id AND ct.email IS NOT NULL
      LEFT JOIN merchant_lead_details m ON m.company_id = c.id
      WHERE c.source = 'MERCHANT_UPLOAD'
    `;
    const params = [];

    if (filters.status) {
      query += " AND c.status = ?";
      params.push(filters.status);
    }
    if (filters.id) {
      query += " AND c.id = ?";
      params.push(filters.id);
    }
    if (filters.minScore) {
      query += " AND c.lead_score >= ?";
      params.push(filters.minScore);
    }
    if (filters.hasEmail) {
      query += " AND ct.email IS NOT NULL";
    }
    if (filters.hasPhone) {
      query += " AND COALESCE(ct.phone, c.phone) IS NOT NULL";
    }

    query += " ORDER BY c.lead_score DESC, c.created_at DESC";

    if (filters.limit) {
      const limit = Number.parseInt(filters.limit, 10);
      if (Number.isInteger(limit) && limit > 0) {
        query += ` LIMIT ${Math.min(limit, 10000)}`;
      }
    }

    const stmt = database.prepare(query);
    return stmt.all(...params).map((lead) => ({
      ...lead,
      store_name: lead.name,
      contact_email: lead.email || null,
      contact_phone: lead.normalized_phone || lead.phone || null,
      installed_apps: this.parseStoredArray(lead.installed_apps_json),
      tech_stack: this.parseStoredArray(lead.tech_stack_json),
      store_description: lead.store_description || null,
      product_count: lead.product_count ?? null,
      public_contact_links: this.parseStoredObject(lead.public_contact_links_json)
    }));
  }

  parseStoredObject(value) {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  parseStoredArray(value) {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        throw new Error("Expected a JSON array");
      }
      return parsed;
    } catch (error) {
      throw new Error(`Invalid stored merchant lead metadata: ${error.message}`);
    }
  }

  getMerchantLeadById(companyId) {
    return this.getMerchantLeads({ id: Number(companyId), limit: 1 })[0] || null;
  }

  /**
   * Get merchant leads eligible for outreach (has email or phone, not contacted)
   */
  getEligibleForOutreach(limit = null) {
    const database = db.getRawDb();
    let query = `
      SELECT c.*,
             ct.email,
             ct.confidence as email_confidence,
             ct.email_type,
             ct.phone,
             ct.normalized_phone,
             ct.whatsapp_available
      FROM companies c
      LEFT JOIN contacts ct ON ct.company_id = c.id AND (ct.email IS NOT NULL OR ct.phone IS NOT NULL)
      WHERE c.source = 'MERCHANT_UPLOAD'
        AND c.status NOT IN ('CONTACTED', 'SENT', 'EXCLUDED', 'SKIPPED_DUPLICATE')
        AND (ct.email IS NOT NULL OR ct.phone IS NOT NULL)
        AND c.id NOT IN (SELECT DISTINCT company_id FROM email_logs WHERE status IN ('SENT', 'DRY_RUN_SENT'))
        AND (ct.phone IS NULL OR ct.phone NOT IN (SELECT DISTINCT phone FROM whatsapp_logs WHERE status IN ('SENT', 'DRY_RUN_SENT')))
    `;
    const params = [];

    query += " ORDER BY c.lead_score DESC";

    if (limit) {
      query += ` LIMIT ${parseInt(limit, 10)}`;
    }

    const stmt = database.prepare(query);
    return stmt.all(...params);
  }
}

module.exports = new MerchantIngestion();
