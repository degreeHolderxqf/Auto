const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { runMigrations } = require("./migrations");
const logger = require("../services/logger");

let dbInstance = null;

function getDatabase() {
  if (dbInstance) return dbInstance;

  const dbDir = path.dirname(config.databasePath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new DatabaseSync(config.databasePath);
  try {
    dbInstance.exec("PRAGMA journal_mode = WAL;");
    dbInstance.exec("PRAGMA busy_timeout = 5000;");
    dbInstance.exec("PRAGMA synchronous = NORMAL;");
  } catch (e) {
    // pragma fallback
  }
  runMigrations(dbInstance);
  return dbInstance;
}

const db = {
  getRawDb() {
    return getDatabase();
  },

  // Company CRUD
  upsertCompany(companyData) {
    const database = getDatabase();

    // Find existing company by ID, shopify_partner_url, normalized_name, or domain
    let existing = null;
    if (companyData.id) {
      existing = database.prepare("SELECT * FROM companies WHERE id = ?").get(companyData.id);
    }
    if (!existing && companyData.shopify_partner_url) {
      existing = database.prepare("SELECT * FROM companies WHERE shopify_partner_url = ?").get(companyData.shopify_partner_url);
    }
    if (!existing && companyData.normalized_name) {
      existing = database.prepare("SELECT * FROM companies WHERE normalized_name = ?").get(companyData.normalized_name);
    }
    if (!existing && companyData.domain) {
      existing = database.prepare("SELECT * FROM companies WHERE domain = ?").get(companyData.domain);
    }

    if (existing) {
      const updateStmt = database.prepare(`
        UPDATE companies SET
          name = COALESCE(?, name),
          normalized_name = COALESCE(?, normalized_name),
          domain = COALESCE(?, domain),
          shopify_partner_url = COALESCE(?, shopify_partner_url),
          official_website = COALESCE(?, official_website),
          city = COALESCE(?, city),
          state = COALESCE(?, state),
          country = COALESCE(?, country),
          partner_tier = COALESCE(?, partner_tier),
          rating = COALESCE(?, rating),
          reviews = COALESCE(?, reviews),
          app_relevance_score = CASE WHEN ? > 0 THEN ? ELSE app_relevance_score END,
          lead_score = CASE WHEN ? > 0 THEN ? ELSE lead_score END,
          shopify_services = COALESCE(?, shopify_services),
          public_apps = COALESCE(?, public_apps),
          careers_url = COALESCE(?, careers_url),
          linkedin_url = COALESCE(?, linkedin_url),
          status = CASE WHEN ? IS NOT NULL AND ? != 'DISCOVERED' THEN ? ELSE status END,
          notes = COALESCE(?, notes),
          updated_at = datetime('now')
        WHERE id = ?
      `);

      updateStmt.run(
        companyData.name || null,
        companyData.normalized_name || null,
        companyData.domain || null,
        companyData.shopify_partner_url || null,
        companyData.official_website || null,
        companyData.city || null,
        companyData.state || null,
        companyData.country || null,
        companyData.partner_tier || null,
        companyData.rating != null ? Number(companyData.rating) : null,
        companyData.reviews != null ? Number(companyData.reviews) : null,
        companyData.app_relevance_score || 0,
        companyData.app_relevance_score || 0,
        companyData.lead_score || 0,
        companyData.lead_score || 0,
        companyData.shopify_services ? (typeof companyData.shopify_services === "object" ? JSON.stringify(companyData.shopify_services) : companyData.shopify_services) : null,
        companyData.public_apps ? (typeof companyData.public_apps === "object" ? JSON.stringify(companyData.public_apps) : companyData.public_apps) : null,
        companyData.careers_url || null,
        companyData.linkedin_url || null,
        companyData.status || null,
        companyData.status || null,
        companyData.status || null,
        companyData.notes || null,
        existing.id
      );

      return this.getCompanyById(existing.id);
    } else {
      const insertStmt = database.prepare(`
        INSERT INTO companies (
          name, normalized_name, domain, shopify_partner_url, official_website,
          city, state, country, partner_tier, rating, reviews,
          app_relevance_score, lead_score, shopify_services, public_apps,
          careers_url, linkedin_url, status, notes, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, datetime('now')
        )
      `);

      const res = insertStmt.run(
        companyData.name,
        companyData.normalized_name,
        companyData.domain || null,
        companyData.shopify_partner_url || null,
        companyData.official_website || null,
        companyData.city || null,
        companyData.state || null,
        companyData.country || "India",
        companyData.partner_tier || null,
        companyData.rating != null ? Number(companyData.rating) : null,
        companyData.reviews != null ? Number(companyData.reviews) : 0,
        companyData.app_relevance_score || 0,
        companyData.lead_score || 0,
        companyData.shopify_services ? (typeof companyData.shopify_services === "object" ? JSON.stringify(companyData.shopify_services) : companyData.shopify_services) : null,
        companyData.public_apps ? (typeof companyData.public_apps === "object" ? JSON.stringify(companyData.public_apps) : companyData.public_apps) : null,
        companyData.careers_url || null,
        companyData.linkedin_url || null,
        companyData.status || "DISCOVERED",
        companyData.notes || null
      );

      return this.getCompanyById(Number(res.lastInsertRowid));
    }
  },

  getCompanyByNormalizedName(normalizedName) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE normalized_name = ?");
    return stmt.get(normalizedName);
  },

  getCompanyByShopifyUrl(url) {
    if (!url) return null;
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE shopify_partner_url = ?");
    return stmt.get(url);
  },

  getCompanyByDomain(domain) {
    if (!domain) return null;
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE domain = ?");
    return stmt.get(domain);
  },

  getCompanyById(id) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE id = ?");
    return stmt.get(id);
  },

  getAllCompanies(options = {}) {
    const database = getDatabase();
    let query = "SELECT * FROM companies";
    const params = [];

    if (options.status) {
      query += " WHERE status = ?";
      params.push(options.status);
    }

    if (options.minAppRelevanceScore) {
      query += (params.length ? " AND" : " WHERE") + " app_relevance_score >= ?";
      params.push(options.minAppRelevanceScore);
    }

    query += " ORDER BY lead_score DESC, app_relevance_score DESC, reviews DESC";

    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    const stmt = database.prepare(query);
    return stmt.all(...params);
  },

  updateCompanyStatus(id, status, notes = null) {
    const database = getDatabase();
    const stmt = database.prepare(`
      UPDATE companies 
      SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(status, notes, id);
  },

  // Contact CRUD
  upsertContact(contactData) {
    const database = getDatabase();
    const cleanEmail = contactData.email.toLowerCase().trim();
    const existing = this.getContactByEmail(cleanEmail);

    if (existing) {
      const updateStmt = database.prepare(`
        UPDATE contacts SET
          company_id = ?,
          name = COALESCE(?, name),
          role = COALESCE(?, role),
          email_type = COALESCE(?, email_type),
          confidence = CASE 
            WHEN ? = 'HIGH' THEN 'HIGH'
            WHEN ? = 'MEDIUM' AND confidence != 'HIGH' THEN 'MEDIUM'
            ELSE confidence
          END,
          source_url = COALESCE(?, source_url),
          verified = CASE WHEN ? = 1 THEN 1 ELSE verified END,
          mx_valid = CASE WHEN ? = 1 THEN 1 ELSE mx_valid END,
          notes = COALESCE(?, notes)
        WHERE id = ?
      `);

      updateStmt.run(
        contactData.company_id,
        contactData.name || null,
        contactData.role || null,
        contactData.email_type || "General",
        contactData.confidence || "LOW",
        contactData.confidence || "LOW",
        contactData.source_url || null,
        contactData.verified ? 1 : 0,
        contactData.mx_valid ? 1 : 0,
        contactData.notes || null,
        existing.id
      );

      return this.getContactByEmail(cleanEmail);
    } else {
      const insertStmt = database.prepare(`
        INSERT INTO contacts (
          company_id, name, role, email, email_type, confidence, source_url, verified, mx_valid, notes
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);

      insertStmt.run(
        contactData.company_id,
        contactData.name || null,
        contactData.role || null,
        cleanEmail,
        contactData.email_type || "General",
        contactData.confidence || "LOW",
        contactData.source_url || null,
        contactData.verified ? 1 : 0,
        contactData.mx_valid ? 1 : 0,
        contactData.notes || null
      );

      return this.getContactByEmail(cleanEmail);
    }
  },

  getContactByEmail(email) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM contacts WHERE email = ?");
    return stmt.get(email.toLowerCase().trim());
  },

  getContactsByCompanyId(companyId) {
    const database = getDatabase();
    const stmt = database.prepare(`
      SELECT * FROM contacts 
      WHERE company_id = ? 
      ORDER BY 
        CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
    `);
    return stmt.all(companyId);
  },

  // Sources CRUD
  addSource(sourceData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO sources (company_id, source_type, url, title, evidence)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      sourceData.company_id,
      sourceData.source_type,
      sourceData.url,
      sourceData.title || null,
      sourceData.evidence || null
    );
  },

  getSourcesByCompanyId(companyId) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM sources WHERE company_id = ?");
    return stmt.all(companyId);
  },

  // Exclusions CRUD
  addExclusion(exclusionData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT OR IGNORE INTO exclusions (company_name, normalized_name, domain, reason)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(
      exclusionData.company_name,
      exclusionData.normalized_name,
      exclusionData.domain || null,
      exclusionData.reason || "Manual Exclusion"
    );
  },

  isExcluded(normalizedName, domain = null) {
    const database = getDatabase();
    if (domain) {
      const stmt = database.prepare("SELECT 1 FROM exclusions WHERE normalized_name = ? OR domain = ?");
      return !!stmt.get(normalizedName, domain);
    }
    const stmt = database.prepare("SELECT 1 FROM exclusions WHERE normalized_name = ?");
    return !!stmt.get(normalizedName);
  },

  getAllExclusions() {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM exclusions");
    return stmt.all();
  },

  // Email Logs CRUD
  addEmailLog(logData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO email_logs (company_id, contact_id, campaign_id, email, subject, status, message_id, error, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      logData.company_id,
      logData.contact_id || null,
      logData.campaign_id || null,
      logData.email,
      logData.subject || null,
      logData.status,
      logData.message_id || null,
      logData.error || null,
      logData.attempts || 1
    );
  },

  hasBeenContacted(email, companyId = null) {
    const database = getDatabase();
    if (companyId) {
      const stmt = database.prepare("SELECT 1 FROM email_logs WHERE (email = ? OR company_id = ?) AND status = 'SENT'");
      return !!stmt.get(email, companyId);
    }
    const stmt = database.prepare("SELECT 1 FROM email_logs WHERE email = ? AND status = 'SENT'");
    return !!stmt.get(email);
  },

  getAllEmailLogs() {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM email_logs ORDER BY sent_at DESC");
    return stmt.all();
  },

  // Full Lead View with Best Contact
  getFinalQualifiedLeads(limit = null) {
    const database = getDatabase();
    let query = `
      SELECT 
        c.*,
        ct.id as contact_id,
        ct.name as contact_name,
        ct.role as contact_role,
        ct.email,
        ct.email_type,
        ct.confidence as email_confidence,
        ct.source_url as email_source_url
      FROM companies c
      LEFT JOIN (
        SELECT * FROM contacts 
        GROUP BY company_id
        HAVING min(
          CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END * 10 +
          CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
        )
      ) ct ON ct.company_id = c.id
      WHERE c.status NOT IN ('EXCLUDED', 'SKIPPED_DUPLICATE', 'FAILED')
      ORDER BY c.lead_score DESC, c.app_relevance_score DESC, c.rating DESC
    `;
    if (limit) {
      query += ` LIMIT ${parseInt(limit, 10)}`;
    }
    const stmt = database.prepare(query);
    return stmt.all();
  },

  // Statistics Summary
  getStatistics() {
    const database = getDatabase();
    const totalDiscovered = database.prepare("SELECT count(*) as count FROM companies").get().count;
    const candidates = database.prepare("SELECT count(*) as count FROM companies WHERE status != 'EXCLUDED'").get().count;
    const excluded = database.prepare("SELECT count(*) as count FROM companies WHERE status = 'EXCLUDED'").get().count;
    const duplicates = database.prepare("SELECT count(*) as count FROM companies WHERE status = 'SKIPPED_DUPLICATE'").get().count;
    const qualified = database.prepare("SELECT count(*) as count FROM companies WHERE app_relevance_score >= 70").get().count;
    const totalContacts = database.prepare("SELECT count(*) as count FROM contacts").get().count;
    const highConfidence = database.prepare("SELECT count(*) as count FROM contacts WHERE confidence = 'HIGH'").get().count;
    const mediumConfidence = database.prepare("SELECT count(*) as count FROM contacts WHERE confidence = 'MEDIUM'").get().count;
    const noContact = database.prepare("SELECT count(*) as count FROM companies WHERE id NOT IN (SELECT DISTINCT company_id FROM contacts)").get().count;
    const readyToSend = database.prepare("SELECT count(*) as count FROM companies WHERE status IN ('READY', 'APPROVED', 'EMAIL_FOUND')").get().count;
    const sent = database.prepare("SELECT count(*) as count FROM email_logs WHERE status = 'SENT'").get().count;
    const failed = database.prepare("SELECT count(*) as count FROM email_logs WHERE status = 'FAILED'").get().count;

    return {
      totalDiscovered,
      candidates,
      excluded,
      duplicates,
      qualified,
      totalContacts,
      highConfidence,
      mediumConfidence,
      noContact,
      readyToSend,
      sent,
      failed
    };
  }
};

module.exports = db;
