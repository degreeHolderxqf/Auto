const db = require("../db/database");
const logger = require("./logger");
const normalizer = require("./normalizer");
const scoring = require("./scoring");

/**
 * Freelance Service Layer
 *
 * Centralized service for freelance opportunity management — separate from
 * merchant/merchant-lead and job-application modules. Handles company/contact
 * CRUD, qualification scoring, exclusions, deep lead details, and batch
 * state helpers used by the freelance outreach pipeline.
 */

class FreelanceService {
  constructor() {
    this.normalizer = normalizer;
    this.scoring = scoring;
  }

  // ── Discovery & Upsert ──────────────────────────────────────────────────

  /**
   * Normalize a freelance company record before upsert.
   */
  normalizeCompany(raw) {
    const name = (raw.name || raw.store_name || raw.company_name || "").trim();
    const normalizedName = raw.normalized_name || normalizer.normalizeCompanyName(name) || "";
    const domain = raw.domain || normalizer.normalizeDomain(raw.website || raw.official_website || raw.domain || "") || null;

    return {
      name,
      normalized_name: normalizedName || name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      domain,
      official_website: raw.official_website || raw.website || null,
      shopify_store_url: raw.shopify_store_url || null,
      city: raw.city || null,
      state: raw.state || null,
      country: raw.country || null,
      store_name: raw.store_name || raw.name || null,
      store_description: raw.store_description || null,
      installed_apps: Array.isArray(raw.installed_apps) ? raw.installed_apps : [],
      tech_stack: Array.isArray(raw.tech_stack) ? raw.tech_stack : [],
      product_count: raw.product_count || null,
      estimated_revenue: raw.estimated_revenue || null,
      employee_count: raw.employee_count || null,
      employee_count_min: raw.employee_count_min || null,
      employee_count_max: raw.employee_count_max || null,
      employee_size_range: raw.employee_size_range || null,
      employee_count_source: raw.employee_count_source || null,
      employee_count_source_url: raw.employee_count_source_url || null,
      employee_count_verified: Boolean(raw.employee_count_verified),
      employee_count_verified_at: raw.employee_count_verified_at || null,
      employee_count_status: raw.employee_count_status || "UNKNOWN",
      service_clarity_score: Number(raw.service_clarity_score) || 0,
      portfolio_score: Number(raw.portfolio_score) || 0,
      tech_depth_score: Number(raw.tech_depth_score) || 0,
      geographic_reach_score: Number(raw.geographic_reach_score) || 0,
      contact_accessibility_score: Number(raw.contact_accessibility_score) || 0,
      responsiveness_score: Number(raw.responsiveness_score) || 0,
      freelance_lead_score: Number(raw.freelance_lead_score) || 0,
      source: raw.source || "BRAVE_SEARCH",
      discovery_keywords: raw.discovery_keywords || null,
      status: raw.status || "DISCOVERED",
      notes: raw.notes || null
    };
  }

  /**
   * Upsert a freelance company (dedup by shopify_store_url / normalized_name / domain).
   * Returns the full company row with JSON fields parsed.
   */
  upsertCompany(companyData) {
    try {
      const normalized = this.normalizeCompany(companyData);
      const result = db.upsertFreelanceCompany(normalized);
      logger.debug("Freelance company upserted", { id: result.id, name: result.name });
      return result;
    } catch (err) {
      logger.error("Failed to upsert freelance company", err);
      throw err;
    }
  }

  /**
   * Upsert multiple freelance companies in one pass.
   * Returns { inserted, updated, skipped }.
   */
  upsertCompanies(companies = []) {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of companies) {
      try {
        if (!raw.name && !raw.store_name && !raw.company_name) {
          skipped++;
          continue;
        }
        const existing = this.findExistingCompany(raw);
        const result = this.upsertCompany(raw);
        if (existing) {
          updated++;
        } else {
          inserted++;
        }
      } catch (err) {
        logger.warn("Skipping freelance company due to error:", raw, err.message);
        skipped++;
      }
    }

    return { inserted, updated, skipped };
  }

  /**
   * Check if a company already exists by any dedup key.
   */
  findExistingCompany(raw) {
    const normalizedName = raw.normalized_name || (raw.name ? normalizer.normalizeCompanyName(raw.name) : null);
    const domain = raw.domain || (raw.website || raw.official_website ? normalizer.normalizeDomain(raw.website || raw.official_website) : null);

    if (raw.shopify_store_url) {
      const existing = db.getFreelanceCompanyByShopifyUrl(raw.shopify_store_url);
      if (existing) return existing;
    }
    if (normalizedName) {
      const existing = db.getFreelanceCompanyByNormalizedName(normalizedName);
      if (existing) return existing;
    }
    if (domain) {
      const existing = db.getFreelanceCompanyByDomain(domain);
      if (existing) return existing;
    }
    return null;
  }

  // ── Read ────────────────────────────────────────────────────────────────

  getCompanyById(id) {
    const company = db.getFreelanceCompanyById(id);
    if (!company) return null;
    return this._enrichCompany(company);
  }

  getCompanyByDomain(domain) {
    const company = db.getFreelanceCompanyByDomain(domain);
    return company ? this._enrichCompany(company) : null;
  }

  getAllCompanies(filters = {}) {
    const rows = db.getAllFreelanceCompanies(filters);
    return rows.map((row) => this._enrichCompany(row));
  }

  getCompanyStats() {
    return db.getFreelanceStatistics();
  }

  _enrichCompany(company) {
    const details = db.getFreelanceLeadDetails(company.id);
    const contacts = db.getFreelanceContactsByCompanyId(company.id);
    const sources = db.getFreelanceSourcesByCompanyId(company.id);
    return {
      ...company,
      contacts,
      sources,
      leadDetails: details || null,
      bestContact: contacts.length > 0 ? contacts[0] : null
    };
  }

  updateCompanyStatus(id, status, notes = null) {
    return db.updateFreelanceCompanyStatus(id, status, notes);
  }

  // ── Contacts ────────────────────────────────────────────────────────────

  upsertContact(contactData) {
    try {
      const normalized = {
        company_id: contactData.company_id,
        name: contactData.name || null,
        role: contactData.role || null,
        email: contactData.email || null,
        email_type: contactData.email_type || "General",
        confidence: contactData.confidence || "LOW",
        source_url: contactData.source_url || null,
        phone: contactData.phone || null,
        normalized_phone: contactData.normalized_phone || null,
        phone_type: contactData.phone_type || null,
        phone_source: contactData.phone_source || null,
        phone_source_url: contactData.phone_source_url || null,
        whatsapp_available: contactData.whatsapp_available || "unknown",
        whatsapp_status: contactData.whatsapp_status || "READY",
        verified: Boolean(contactData.verified),
        mx_valid: Boolean(contactData.mx_valid),
        notes: contactData.notes || null
      };
      const result = db.upsertFreelanceContact(normalized);
      logger.debug("Freelance contact upserted", { id: result.id, email: result.email });
      return result;
    } catch (err) {
      logger.error("Failed to upsert freelance contact", err);
      throw err;
    }
  }

  getContactsByCompanyId(companyId) {
    return db.getFreelanceContactsByCompanyId(companyId);
  }

  getBestContactForCompany(companyId) {
    return db.getBestFreelanceContactForCompany(companyId);
  }

  // ── Sources ─────────────────────────────────────────────────────────────

  addSource(sourceData) {
    return db.addFreelanceSource(sourceData);
  }

  getSourcesByCompanyId(companyId) {
    return db.getFreelanceSourcesByCompanyId(companyId);
  }

  // ── Exclusions ──────────────────────────────────────────────────────────

  addExclusion(companyName, normalizedName, domain = null, reason = "Manual exclusion") {
    return db.addFreelanceExclusion(companyName, normalizedName, domain, reason);
  }

  getAllExclusions() {
    return db.getAllFreelanceExclusions();
  }

  isExcluded(normalizedName, domain = null) {
    return db.isFreelanceExcluded(normalizedName, domain);
  }

  deleteExclusion(id) {
    return db.deleteFreelanceExclusion(id);
  }

  // ── Lead Details (deep qualification) ───────────────────────────────────

  upsertLeadDetails(detailsData) {
    try {
      db.upsertFreelanceLeadDetails(detailsData);
      logger.debug("Freelance lead details upserted", { company_id: detailsData.company_id });
    } catch (err) {
      logger.error("Failed to upsert freelance lead details", err);
      throw err;
    }
  }

  getLeadDetails(companyId) {
    return db.getFreelanceLeadDetails(companyId);
  }

  // ── Qualification scoring helpers ───────────────────────────────────────

  /**
   * Compute a freelance lead score (0-100) from the available signals.
   * Factors: service clarity, portfolio, tech depth, geographic reach,
   * contact accessibility, responsiveness, employee verification.
   */
  calculateLeadScore(companyData = {}) {
    const weights = {
      service_clarity: 0.20,
      portfolio: 0.20,
      tech_depth: 0.15,
      geographic_reach: 0.15,
      contact_accessibility: 0.15,
      responsiveness: 0.10,
      employee_verified: 0.05
    };

    const score =
      (Number(companyData.service_clarity_score) || 0) * weights.service_clarity +
      (Number(companyData.portfolio_score) || 0) * weights.portfolio +
      (Number(companyData.tech_depth_score) || 0) * weights.tech_depth +
      (Number(companyData.geographic_reach_score) || 0) * weights.geographic_reach +
      (Number(companyData.contact_accessibility_score) || 0) * weights.contact_accessibility +
      (Number(companyData.responsiveness_score) || 0) * weights.responsiveness +
      (Boolean(companyData.employee_count_verified) ? 100 : 0) * weights.employee_verified;

    return Math.min(100, Math.round(score));
  }

  // ── Outreach batch helpers ──────────────────────────────────────────────

  createOutreachBatch(batchId, channel, total, dryRun) {
    return db.createFreelanceOutreachBatch(batchId, channel, total, dryRun);
  }

  getOutreachBatch(batchId) {
    return db.getFreelanceOutreachBatch(batchId);
  }

  getNextOutreachBatchItems(batchId, limit) {
    return db.getNextFreelanceBatchItems(batchId, limit);
  }

  markBatchItemSent(batchId, companyId, messageId, attempts) {
    return db.markFreelanceBatchItemSent(batchId, companyId, messageId, attempts);
  }

  markBatchItemFailed(batchId, companyId, errorMsg, attempts) {
    return db.markFreelanceBatchItemFailed(batchId, companyId, errorMsg, attempts);
  }

  refreshBatchCounters(batchId) {
    return db.refreshFreelanceBatchCounters(batchId);
  }

  completeOutreachBatch(batchId, error = null) {
    return db.completeFreelanceOutreachBatch(batchId, error);
  }

  failOutreachBatch(batchId, error) {
    return db.failFreelanceOutreachBatch(batchId, error);
  }

  getOutreachBatchItems(batchId) {
    return db.getFreelanceOutreachBatchItems(batchId);
  }

  // ── Email / WhatsApp contact state ──────────────────────────────────────

  hasBeenContacted(email, companyId = null) {
    return db.hasFreelanceBeenContacted(email, companyId);
  }

  logEmail(logData) {
    return db.addFreelanceEmailLog(logData);
  }

  getEmailLogs(companyId = null) {
    if (companyId) {
      return db.getFreelanceEmailLogsByCompany(companyId);
    }
    return db.getAllFreelanceEmailLogs();
  }

  logWhatsApp(logData) {
    return db.logFreelanceWhatsAppMessage(logData);
  }

  getWhatsAppLogs() {
    return db.getAllFreelanceWhatsAppLogs();
  }

  isWhatsAppContacted(companyId, phone = null) {
    return db.isFreelanceWhatsAppContacted(companyId, phone);
  }

  isWhatsAppOptedOut(phone) {
    return db.isFreelanceWhatsAppOptedOut(phone);
  }
}

module.exports = new FreelanceService();
