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
          employee_count = COALESCE(?, employee_count),
          employee_count_min = COALESCE(?, employee_count_min),
          employee_count_max = COALESCE(?, employee_count_max),
          employee_size_range = COALESCE(?, employee_size_range),
          employee_count_source = COALESCE(?, employee_count_source),
          employee_count_source_url = COALESCE(?, employee_count_source_url),
          employee_count_verified = COALESCE(?, employee_count_verified),
          employee_count_verified_at = COALESCE(?, employee_count_verified_at),
          employee_count_status = COALESCE(?, employee_count_status),
          app_relevance_score = CASE WHEN ? > 0 THEN ? ELSE app_relevance_score END,
          lead_score = CASE WHEN ? > 0 THEN ? ELSE lead_score END,
          shopify_services = COALESCE(?, shopify_services),
          public_apps = COALESCE(?, public_apps),
          careers_url = COALESCE(?, careers_url),
          linkedin_url = COALESCE(?, linkedin_url),
          phone = COALESCE(?, phone),
          normalized_phone = COALESCE(?, normalized_phone),
          phone_type = COALESCE(?, phone_type),
          phone_source = COALESCE(?, phone_source),
          phone_source_url = COALESCE(?, phone_source_url),
          whatsapp_available = COALESCE(?, whatsapp_available),
          whatsapp_status = COALESCE(?, whatsapp_status),
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
        companyData.employee_count != null ? Number(companyData.employee_count) : null,
        companyData.employee_count_min != null ? Number(companyData.employee_count_min) : null,
        companyData.employee_count_max != null ? Number(companyData.employee_count_max) : null,
        companyData.employee_size_range || null,
        companyData.employee_count_source || companyData.employee_source || null,
        companyData.employee_count_source_url || null,
        companyData.employee_count_verified != null ? (companyData.employee_count_verified ? 1 : 0) : null,
        companyData.employee_count_verified_at || null,
        companyData.employee_count_status || null,
        companyData.app_relevance_score || 0,
        companyData.app_relevance_score || 0,
        companyData.lead_score || 0,
        companyData.lead_score || 0,
        companyData.shopify_services ? (typeof companyData.shopify_services === "object" ? JSON.stringify(companyData.shopify_services) : companyData.shopify_services) : null,
        companyData.public_apps ? (typeof companyData.public_apps === "object" ? JSON.stringify(companyData.public_apps) : companyData.public_apps) : null,
        companyData.careers_url || null,
        companyData.linkedin_url || null,
        companyData.phone || null,
        companyData.normalized_phone || null,
        companyData.phone_type || null,
        companyData.phone_source || null,
        companyData.phone_source_url || null,
        companyData.whatsapp_available || null,
        companyData.whatsapp_status || null,
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
          employee_count, employee_count_min, employee_count_max, employee_size_range,
          employee_count_source, employee_count_source_url, employee_count_verified,
          employee_count_verified_at, employee_count_status,
          app_relevance_score, lead_score, shopify_services, public_apps,
          careers_url, linkedin_url, phone, normalized_phone, phone_type, phone_source, phone_source_url,
          whatsapp_available, whatsapp_status, status, notes, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
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
        companyData.employee_count != null ? Number(companyData.employee_count) : null,
        companyData.employee_count_min != null ? Number(companyData.employee_count_min) : null,
        companyData.employee_count_max != null ? Number(companyData.employee_count_max) : null,
        companyData.employee_size_range || null,
        companyData.employee_count_source || companyData.employee_source || null,
        companyData.employee_count_source_url || null,
        companyData.employee_count_verified ? 1 : 0,
        companyData.employee_count_verified_at || null,
        companyData.employee_count_status || "UNKNOWN",
        companyData.app_relevance_score || 0,
        companyData.lead_score || 0,
        companyData.shopify_services ? (typeof companyData.shopify_services === "object" ? JSON.stringify(companyData.shopify_services) : companyData.shopify_services) : null,
        companyData.public_apps ? (typeof companyData.public_apps === "object" ? JSON.stringify(companyData.public_apps) : companyData.public_apps) : null,
        companyData.careers_url || null,
        companyData.linkedin_url || null,
        companyData.phone || null,
        companyData.normalized_phone || null,
        companyData.phone_type || null,
        companyData.phone_source || null,
        companyData.phone_source_url || null,
        companyData.whatsapp_available || "unknown",
        companyData.whatsapp_status || "READY",
        companyData.status || "DISCOVERED",
        companyData.notes || null
      );

      return this.getCompanyById(Number(res.lastInsertRowid));
    }
  },

  getCompanyById(id) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE id = ?");
    return stmt.get(id);
  },

  getCompanyByNormalizedName(normalizedName) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE normalized_name = ?");
    return stmt.get(normalizedName);
  },

  getCompanyByDomain(domain) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE domain = ?");
    return stmt.get(domain);
  },

  getCompanyByShopifyUrl(url) {
    if (!url) return null;
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE shopify_partner_url = ?");
    return stmt.get(url);
  },

  getAllCompanies(filters = {}) {
    const database = getDatabase();
    let query = "SELECT * FROM companies WHERE 1=1";
    const params = [];

    if (filters.status) {
      query += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.minAppRelevanceScore) {
      query += " AND app_relevance_score >= ?";
      params.push(filters.minAppRelevanceScore);
    }
    if (filters.minLeadScore) {
      query += " AND lead_score >= ?";
      params.push(filters.minLeadScore);
    }
    if (filters.minEmployees) {
      query += " AND (employee_count >= ? OR employee_count_min >= ?)";
      params.push(filters.minEmployees, filters.minEmployees);
    }
    if (filters.verifiedOnly) {
      query += " AND employee_count_verified = 1 AND employee_count_status = 'QUALIFIED'";
    }

    query += " ORDER BY lead_score DESC, app_relevance_score DESC, rating DESC";

    if (filters.limit) {
      query += ` LIMIT ${parseInt(filters.limit, 10)}`;
    }

    const stmt = database.prepare(query);
    return stmt.all(...params);
  },

  updateCompanyStatus(id, status, notes = null) {
    const database = getDatabase();
    if (notes) {
      const stmt = database.prepare("UPDATE companies SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?");
      stmt.run(status, notes, id);
    } else {
      const stmt = database.prepare("UPDATE companies SET status = ?, updated_at = datetime('now') WHERE id = ?");
      stmt.run(status, id);
    }
    return this.getCompanyById(id);
  },

  // Contact CRUD
  upsertContact(contactData) {
    const database = getDatabase();
    const existing = database.prepare("SELECT * FROM contacts WHERE email = ?").get(contactData.email);

    if (existing) {
      const stmt = database.prepare(`
        UPDATE contacts SET
          company_id = COALESCE(?, company_id),
          name = COALESCE(?, name),
          role = COALESCE(?, role),
          email_type = COALESCE(?, email_type),
          confidence = CASE 
            WHEN ? = 'HIGH' THEN 'HIGH'
            WHEN ? = 'MEDIUM' AND confidence != 'HIGH' THEN 'MEDIUM'
            ELSE confidence
          END,
          phone = COALESCE(?, phone),
          normalized_phone = COALESCE(?, normalized_phone),
          phone_type = COALESCE(?, phone_type),
          phone_source = COALESCE(?, phone_source),
          phone_source_url = COALESCE(?, phone_source_url),
          whatsapp_available = COALESCE(?, whatsapp_available),
          whatsapp_status = COALESCE(?, whatsapp_status),
          source_url = COALESCE(?, source_url),
          verified = CASE WHEN ? = 1 THEN 1 ELSE verified END,
          mx_valid = CASE WHEN ? = 1 THEN 1 ELSE mx_valid END,
          notes = COALESCE(?, notes)
        WHERE id = ?
      `);

      stmt.run(
        contactData.company_id || null,
        contactData.name || null,
        contactData.role || null,
        contactData.email_type || null,
        contactData.confidence || "LOW",
        contactData.confidence || "LOW",
        contactData.phone || null,
        contactData.normalized_phone || null,
        contactData.phone_type || null,
        contactData.phone_source || null,
        contactData.phone_source_url || null,
        contactData.whatsapp_available || null,
        contactData.whatsapp_status || null,
        contactData.source_url || null,
        contactData.verified ? 1 : 0,
        contactData.mx_valid ? 1 : 0,
        contactData.notes || null,
        existing.id
      );

      return database.prepare("SELECT * FROM contacts WHERE id = ?").get(existing.id);
    } else {
      const stmt = database.prepare(`
        INSERT INTO contacts (
          company_id, name, role, email, email_type, confidence, source_url,
          phone, normalized_phone, phone_type, phone_source, phone_source_url, whatsapp_available, whatsapp_status,
          verified, mx_valid, notes
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?
        )
      `);

      const res = stmt.run(
        contactData.company_id,
        contactData.name || null,
        contactData.role || null,
        contactData.email,
        contactData.email_type || "General",
        contactData.confidence || "LOW",
        contactData.source_url || null,
        contactData.phone || null,
        contactData.normalized_phone || null,
        contactData.phone_type || null,
        contactData.phone_source || null,
        contactData.phone_source_url || null,
        contactData.whatsapp_available || "unknown",
        contactData.whatsapp_status || "READY",
        contactData.verified ? 1 : 0,
        contactData.mx_valid ? 1 : 0,
        contactData.notes || null
      );

      return database.prepare("SELECT * FROM contacts WHERE id = ?").get(Number(res.lastInsertRowid));
    }
  },

  getContactsByCompanyId(companyId) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM contacts WHERE company_id = ? ORDER BY CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END");
    return stmt.all(companyId);
  },

  getBestContactForCompany(companyId) {
    const database = getDatabase();
    const stmt = database.prepare(`
      SELECT * FROM contacts 
      WHERE company_id = ? 
      ORDER BY 
        CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
      LIMIT 1
    `);
    return stmt.get(companyId);
  },

  // Sources
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
  addExclusion(companyName, normalizedName, domain = null, reason = "Manual exclusion") {
    const database = getDatabase();
    const existing = database.prepare("SELECT * FROM exclusions WHERE normalized_name = ?").get(normalizedName);
    if (!existing) {
      const stmt = database.prepare(`
        INSERT INTO exclusions (company_name, normalized_name, domain, reason)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(companyName, normalizedName, domain || null, reason);
    }
  },

  getAllExclusions() {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM exclusions ORDER BY created_at DESC");
    return stmt.all();
  },

  isExcluded(normalizedName, domain = null) {
    const database = getDatabase();
    if (normalizedName) {
      const stmt = database.prepare("SELECT 1 FROM exclusions WHERE normalized_name = ?");
      if (stmt.get(normalizedName)) return true;
    }
    if (domain) {
      const stmt = database.prepare("SELECT 1 FROM exclusions WHERE domain = ?");
      if (stmt.get(domain)) return true;
    }
    return false;
  },

  deleteExclusion(id) {
    const database = getDatabase();
    const stmt = database.prepare("DELETE FROM exclusions WHERE id = ?");
    stmt.run(id);
  },

  // Email Logs
  addEmailLog(logData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO email_logs (
        company_id, contact_id, campaign_id, email, subject, status, message_id, error, attempts
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
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
    if (!email && !companyId) return false;

    const normEmail = email ? String(email).trim().toLowerCase() : "";

    // 1. Check company table status
    if (companyId) {
      const comp = database.prepare("SELECT status FROM companies WHERE id = ?").get(companyId);
      if (comp && (comp.status === "SENT" || comp.status === "CONTACTED")) {
        return true;
      }
    }

    // 2. Check email_logs for matching email or company_id
    if (companyId && normEmail) {
      const stmt = database.prepare(`
        SELECT 1 FROM email_logs 
        WHERE (LOWER(email) = ? OR company_id = ?) 
          AND status IN ('SENT', 'DRY_RUN_SENT')
        LIMIT 1
      `);
      return !!stmt.get(normEmail, companyId);
    }

    if (companyId) {
      const stmt = database.prepare("SELECT 1 FROM email_logs WHERE company_id = ? AND status IN ('SENT', 'DRY_RUN_SENT') LIMIT 1");
      return !!stmt.get(companyId);
    }

    if (normEmail) {
      const stmt = database.prepare("SELECT 1 FROM email_logs WHERE LOWER(email) = ? AND status IN ('SENT', 'DRY_RUN_SENT') LIMIT 1");
      return !!stmt.get(normEmail);
    }

    return false;
  },

  getAllEmailLogs() {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM email_logs ORDER BY sent_at DESC");
    return stmt.all();
  },

  // Active Leads: strictly uncontacted, employee_count >= minThreshold verified (if configured), valid eligible email contacts
  getFinalQualifiedLeads(limit = null) {
    const database = getDatabase();
    const threshold = config.minEmployeeCount;

    let employeeFilter = "";
    let statusExclusions = "'CONTACTED', 'SENT', 'EXCLUDED', 'SKIPPED_DUPLICATE', 'FAILED'";

    if (threshold && threshold > 0) {
      statusExclusions += ", 'REJECTED_HEADCOUNT', 'UNCERTAIN_HEADCOUNT', 'NOT_ELIGIBLE'";
      employeeFilter = `
        AND ((c.employee_count IS NOT NULL AND c.employee_count >= ${threshold}) OR (c.employee_count_min IS NOT NULL AND c.employee_count_min >= ${threshold}))
        AND (c.employee_count_verified = 1 OR c.employee_count_verified IS NULL)
        AND (c.employee_count_status = 'QUALIFIED' OR c.employee_count_status IS NULL)
      `;
    }

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
      WHERE c.status NOT IN (${statusExclusions})
        ${employeeFilter}
        AND ct.email IS NOT NULL
        AND c.id NOT IN (SELECT DISTINCT company_id FROM email_logs WHERE status IN ('SENT', 'DRY_RUN_SENT'))
        AND ct.email NOT IN (SELECT DISTINCT email FROM email_logs WHERE status IN ('SENT', 'DRY_RUN_SENT'))
      ORDER BY c.lead_score DESC, c.app_relevance_score DESC, c.rating DESC
    `;
    if (limit) {
      query += ` LIMIT ${parseInt(limit, 10)}`;
    }
    const stmt = database.prepare(query);
    return stmt.all();
  },

  // Contacted / Excluded History (Never deleted, permanently tracked)
  getContactedLeads() {
    const database = getDatabase();
    const query = `
      SELECT 
        c.id as company_id,
        c.name as company_name,
        c.domain,
        c.official_website,
        c.employee_count,
        c.employee_size_range,
        c.employee_count_source,
        c.status,
        el.email as sent_email,
        el.subject as email_subject,
        el.status as email_status,
        el.sent_at,
        el.message_id
      FROM companies c
      LEFT JOIN email_logs el ON el.company_id = c.id
      WHERE c.status IN ('CONTACTED', 'SENT') OR el.status IN ('SENT', 'DRY_RUN_SENT')
      GROUP BY c.id
      ORDER BY el.sent_at DESC, c.updated_at DESC
    `;
    return database.prepare(query).all();
  },

  // Statistics Summary
  getStatistics() {
    const database = getDatabase();
    const threshold = config.minEmployeeCount;

    const totalDiscovered = database.prepare("SELECT count(*) as count FROM companies").get().count;
    const candidates = database.prepare("SELECT count(*) as count FROM companies WHERE status != 'EXCLUDED'").get().count;
    const excluded = database.prepare("SELECT count(*) as count FROM companies WHERE status = 'EXCLUDED'").get().count;
    const duplicates = database.prepare("SELECT count(*) as count FROM companies WHERE status = 'SKIPPED_DUPLICATE'").get().count;
    
    // Employee breakdown metrics
    const employeeVerified = threshold && threshold > 0 ? database.prepare(`
      SELECT count(*) as count FROM companies 
      WHERE ((employee_count >= ${threshold}) OR (employee_count_min >= ${threshold}))
        AND (employee_count_verified = 1 OR employee_count_status = 'QUALIFIED')
    `).get().count : database.prepare("SELECT count(*) as count FROM companies WHERE employee_count_verified = 1 OR employee_count IS NOT NULL").get().count;

    const employeeTooLow = threshold && threshold > 0 ? database.prepare(`
      SELECT count(*) as count FROM companies 
      WHERE (employee_count IS NOT NULL AND employee_count < ${threshold})
         OR (employee_count_max IS NOT NULL AND employee_count_max < ${threshold})
         OR status = 'REJECTED_HEADCOUNT'
         OR employee_count_status = 'REJECTED'
    `).get().count : 0;

    const employeeUncertain = threshold && threshold > 0 ? database.prepare(`
      SELECT count(*) as count FROM companies 
      WHERE employee_count_status IN ('UNCERTAIN', 'NEED_MORE_VERIFICATION', 'UNKNOWN')
         OR status = 'UNCERTAIN_HEADCOUNT'
    `).get().count : 0;

    const employeeConflicting = database.prepare(`
      SELECT count(*) as count FROM companies 
      WHERE employee_count_status = 'CONFLICTING'
    `).get().count;

    const qualified = threshold && threshold > 0 ? database.prepare(`
      SELECT count(*) as count FROM companies 
      WHERE app_relevance_score >= 70 
        AND ((employee_count >= ${threshold}) OR (employee_count_min >= ${threshold}))
        AND (employee_count_verified = 1 OR employee_count_status = 'QUALIFIED')
    `).get().count : database.prepare(`
      SELECT count(*) as count FROM companies 
      WHERE app_relevance_score >= 70
    `).get().count;

    const totalContacts = database.prepare("SELECT count(*) as count FROM contacts").get().count;
    const highConfidence = database.prepare("SELECT count(*) as count FROM contacts WHERE confidence = 'HIGH'").get().count;
    const mediumConfidence = database.prepare("SELECT count(*) as count FROM contacts WHERE confidence = 'MEDIUM'").get().count;
    const noContact = database.prepare("SELECT count(*) as count FROM companies WHERE id NOT IN (SELECT DISTINCT company_id FROM contacts)").get().count;
    
    const readyToSend = threshold && threshold > 0 ? database.prepare(`
      SELECT count(*) as count FROM companies 
      WHERE status IN ('READY', 'APPROVED', 'EMAIL_FOUND', 'ACTIVE') 
        AND ((employee_count >= ${threshold}) OR (employee_count_min >= ${threshold}))
        AND (employee_count_verified = 1 OR employee_count_status = 'QUALIFIED')
    `).get().count : database.prepare(`
      SELECT count(*) as count FROM companies 
      WHERE status IN ('READY', 'APPROVED', 'EMAIL_FOUND', 'ACTIVE')
    `).get().count;

    const sent = database.prepare("SELECT count(*) as count FROM email_logs WHERE status = 'SENT'").get().count;
    const contacted = database.prepare("SELECT count(*) as count FROM companies WHERE status IN ('CONTACTED', 'SENT')").get().count;
    const failed = database.prepare("SELECT count(*) as count FROM email_logs WHERE status = 'FAILED'").get().count;

    return {
      totalDiscovered,
      candidates,
      excluded,
      duplicates,
      employeeVerified,
      employeeTooLow,
      employeeUncertain,
      employeeConflicting,
      qualified,
      totalContacts,
      highConfidence,
      mediumConfidence,
      noContact,
      readyToSend,
      sent,
      contacted,
      failed
    };
  },

  // Dynamic Settings CRUD
  getSetting(key, defaultValue = null) {
    const database = getDatabase();
    const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : defaultValue;
  },

  setSetting(key, value) {
    const database = getDatabase();
    const strVal = typeof value === "object" ? JSON.stringify(value) : String(value !== null && value !== undefined ? value : "");
    const stmt = database.prepare(`
      INSERT INTO settings (key, value, updated_at) 
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET 
        value = excluded.value, 
        updated_at = datetime('now')
    `);
    stmt.run(key, strVal);
    return strVal;
  },

  getAllSettings() {
    const database = getDatabase();
    const rows = database.prepare("SELECT key, value FROM settings").all();
    const result = {};
    for (const r of rows) {
      try {
        result[r.key] = JSON.parse(r.value);
      } catch {
        result[r.key] = r.value;
      }
    }
    return result;
  },

  saveAllSettings(settingsObj = {}) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO settings (key, value, updated_at) 
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET 
        value = excluded.value, 
        updated_at = datetime('now')
    `);

    database.exec("BEGIN TRANSACTION;");
    try {
      for (const [k, v] of Object.entries(settingsObj)) {
        if (v !== undefined) {
          const strVal = typeof v === "object" ? JSON.stringify(v) : String(v !== null ? v : "");
          stmt.run(k, strVal);
        }
      }
      database.exec("COMMIT;");
    } catch (e) {
      database.exec("ROLLBACK;");
      throw e;
    }
    return this.getAllSettings();
  },

  // WhatsApp Logs & Outreach
  logWhatsAppMessage(logData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO whatsapp_logs (
        company_id, contact_id, phone, message, status, message_id, error, sent_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, datetime('now')
      )
    `);
    const res = stmt.run(
      logData.company_id,
      logData.contact_id || null,
      logData.phone,
      logData.message,
      logData.status,
      logData.message_id || null,
      logData.error || null
    );

    // Update company whatsapp_status
    if (logData.status === "SENT" || logData.status === "DRY_RUN_SENT") {
      database.prepare("UPDATE companies SET whatsapp_status = 'SENT', updated_at = datetime('now') WHERE id = ?").run(logData.company_id);
    } else if (logData.status === "FAILED") {
      database.prepare("UPDATE companies SET whatsapp_status = 'FAILED', updated_at = datetime('now') WHERE id = ?").run(logData.company_id);
    } else if (logData.status === "OPTED_OUT") {
      database.prepare("UPDATE companies SET whatsapp_status = 'OPTED_OUT', updated_at = datetime('now') WHERE id = ?").run(logData.company_id);
    }

    return Number(res.lastInsertRowid);
  },

  getAllWhatsAppLogs() {
    const database = getDatabase();
    const stmt = database.prepare(`
      SELECT wl.*, c.name as company_name, c.domain, ct.name as contact_name
      FROM whatsapp_logs wl
      LEFT JOIN companies c ON c.id = wl.company_id
      LEFT JOIN contacts ct ON ct.id = wl.contact_id
      ORDER BY wl.sent_at DESC
    `);
    return stmt.all();
  },

  getWhatsAppLogsByCompany(companyId) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM whatsapp_logs WHERE company_id = ? ORDER BY sent_at DESC");
    return stmt.all(companyId);
  },

  updateCompanyWhatsAppStatus(companyId, status) {
    const database = getDatabase();
    database.prepare("UPDATE companies SET whatsapp_status = ?, updated_at = datetime('now') WHERE id = ?").run(status, companyId);
    return this.getCompanyById(companyId);
  },

  updateWhatsAppStatusByPhone(phone, status) {
    const database = getDatabase();
    const cleanPhone = phone.replace(/\D/g, "");
    database.prepare(`
      UPDATE companies 
      SET whatsapp_status = ?, updated_at = datetime('now') 
      WHERE normalized_phone = ? OR phone = ? OR REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), ' ', '') = ?
    `).run(status, phone, phone, cleanPhone);

    database.prepare(`
      UPDATE contacts 
      SET whatsapp_status = ? 
      WHERE normalized_phone = ? OR phone = ? OR REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), ' ', '') = ?
    `).run(status, phone, phone, cleanPhone);
  },

  isWhatsAppContacted(companyId, phone = null) {
    const database = getDatabase();
    if (companyId) {
      const stmt = database.prepare("SELECT 1 FROM whatsapp_logs WHERE company_id = ? AND status IN ('SENT', 'DRY_RUN_SENT') LIMIT 1");
      if (stmt.get(companyId)) return true;
    }
    if (phone) {
      const cleanPhone = phone.replace(/\D/g, "");
      const stmt = database.prepare(`
        SELECT 1 FROM whatsapp_logs 
        WHERE (phone = ? OR REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), ' ', '') = ?)
          AND status IN ('SENT', 'DRY_RUN_SENT') 
        LIMIT 1
      `);
      if (stmt.get(phone, cleanPhone)) return true;
    }
    return false;
  },

  isWhatsAppOptedOut(phone) {
    if (!phone) return false;
    const database = getDatabase();
    const cleanPhone = phone.replace(/\D/g, "");
    const stmt = database.prepare(`
      SELECT 1 FROM whatsapp_logs 
      WHERE (phone = ? OR REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), ' ', '') = ?)
        AND status = 'OPTED_OUT'
      LIMIT 1
    `);
    return !!stmt.get(phone, cleanPhone);
  }
};

module.exports = db;
