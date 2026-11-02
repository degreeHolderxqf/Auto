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

    // Find existing company by ID, shopify_partner_url, app_store_slug, normalized_name, or domain
    let existing = null;
    if (companyData.id) {
      existing = database.prepare("SELECT * FROM companies WHERE id = ?").get(companyData.id);
    }
    if (!existing && companyData.shopify_partner_url) {
      existing = database.prepare("SELECT * FROM companies WHERE shopify_partner_url = ?").get(companyData.shopify_partner_url);
    }
    if (!existing && companyData.app_store_slug) {
      existing = database.prepare("SELECT * FROM companies WHERE app_store_slug = ?").get(companyData.app_store_slug);
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
          app_store_url = COALESCE(?, app_store_url),
          app_store_slug = COALESCE(?, app_store_slug),
          source = COALESCE(?, source),
          developer_name = COALESCE(?, developer_name),
          developer_location = COALESCE(?, developer_location),
          developer_website = COALESCE(?, developer_website),
          support_email = COALESCE(?, support_email),
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
          india_confidence = COALESCE(?, india_confidence),
          india_evidence = COALESCE(?, india_evidence),
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
        companyData.app_store_url || null,
        companyData.app_store_slug || null,
        companyData.source || null,
        companyData.developer_name || null,
        companyData.developer_location || null,
        companyData.developer_website || null,
        companyData.support_email || null,
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
        companyData.india_confidence || null,
        companyData.india_evidence ? (typeof companyData.india_evidence === "object" ? JSON.stringify(companyData.india_evidence) : companyData.india_evidence) : null,
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
          name, normalized_name, domain, shopify_partner_url, app_store_url, app_store_slug,
          source, developer_name, developer_location, developer_website, support_email,
          official_website, city, state, country, partner_tier, rating, reviews,
          employee_count, employee_count_min, employee_count_max, employee_size_range,
          employee_count_source, employee_count_source_url, employee_count_verified,
          employee_count_verified_at, employee_count_status, india_confidence, india_evidence,
          app_relevance_score, lead_score, shopify_services, public_apps,
          careers_url, linkedin_url, phone, normalized_phone, phone_type, phone_source, phone_source_url,
          whatsapp_available, whatsapp_status, status, notes, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
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
        companyData.app_store_url || null,
        companyData.app_store_slug || null,
        companyData.source || "SHOPIFY_PARTNER_DIRECTORY",
        companyData.developer_name || null,
        companyData.developer_location || null,
        companyData.developer_website || null,
        companyData.support_email || null,
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
        companyData.india_confidence || "UNKNOWN",
        companyData.india_evidence ? (typeof companyData.india_evidence === "object" ? JSON.stringify(companyData.india_evidence) : companyData.india_evidence) : null,
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

  getCompanyByAppStoreSlug(slug) {
    if (!slug) return null;
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM companies WHERE app_store_slug = ?");
    return stmt.get(slug);
  },

  getAllCompanies(filters = {}) {
    const database = getDatabase();
    let query = "SELECT * FROM companies WHERE 1=1";
    const params = [];

    if (filters.status) {
      query += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.source) {
      query += " AND source = ?";
      params.push(filters.source);
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

  // API-facing company list with optional revenue enrichment fields. Keeping
  // this query separate preserves existing workflow queries and response data.
  getAllCompaniesWithRevenue(filters = {}) {
    const database = getDatabase();
    let query = `
      SELECT c.*,
        r.estimated_monthly_revenue AS estimated_monthly_revenue,
        r.estimated_monthly_revenue_min AS estimated_monthly_revenue_min,
        r.estimated_monthly_revenue_max AS estimated_monthly_revenue_max,
        r.estimated_annual_revenue AS estimated_annual_revenue,
        r.estimated_annual_revenue_min AS estimated_annual_revenue_min,
        r.estimated_annual_revenue_max AS estimated_annual_revenue_max,
        r.currency AS revenue_currency,
        r.store_currency AS store_currency,
        r.aov AS estimated_aov,
        r.aov_method AS revenue_aov_method,
        r.conversion_rate AS estimated_conversion_rate,
        r.estimated_traffic AS estimated_monthly_visits,
        r.traffic_provider AS revenue_traffic_provider,
        r.traffic_metric AS revenue_traffic_metric,
        r.traffic_period AS revenue_traffic_period,
        r.confidence AS revenue_estimation_confidence,
        r.method AS revenue_estimation_method,
        r.status AS revenue_estimation_status,
        r.reason AS revenue_estimation_reason,
        r.data_sources_json AS revenue_data_sources_json,
        r.assumptions_json AS revenue_assumptions_json,
        r.updated_at AS revenue_last_updated_at,
        r.estimate_updated_at AS revenue_estimate_updated_at,
        r.product_count AS revenue_product_count,
        r.product_price_proxy,
        r.product_price_min,
        r.product_price_max,
        r.product_price_p25,
        r.product_price_p75,
        r.product_samples,
        r.product_records_json AS revenue_product_records_json,
        r.domain_rank,
        r.domain_rank_status,
        r.domain_rank_source,
        r.domain_rank_publication_date,
        r.domain_rank_dataset_key,
        r.shopify_status,
        r.shopify_confidence,
        r.shopify_signals_json AS shopify_signals_json,
        r.review_widget_detected,
        r.review_providers_json,
        r.review_count,
        r.review_count_status,
        r.review_count_source,
        r.review_count_observed_at,
        r.review_count_previous,
        r.review_count_change,
        r.latest_data_sources_json,
        r.latest_assumptions_json
      FROM companies c
      LEFT JOIN merchant_revenue_estimates r ON r.company_id = c.id
      WHERE 1=1`;
    const params = [];

    if (filters.status) {
      query += " AND c.status = ?";
      params.push(filters.status);
    }
    if (filters.source) {
      query += " AND c.source = ?";
      params.push(filters.source);
    }
    query += " ORDER BY c.lead_score DESC, c.app_relevance_score DESC, c.rating DESC";
    if (filters.limit) query += ` LIMIT ${Math.max(1, Math.min(parseInt(filters.limit, 10) || 10000, 10000))}`;

    const parseJsonArray = (value) => {
      try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    return database.prepare(query).all(...params).map((row) => ({
      ...row,
      revenue_data_sources: parseJsonArray(row.revenue_data_sources_json),
      revenue_assumptions: parseJsonArray(row.revenue_assumptions_json),
      revenue_product_records: parseJsonArray(row.revenue_product_records_json),
      shopify_signals: parseJsonArray(row.shopify_signals_json),
      review_providers: parseJsonArray(row.review_providers_json),
      latest_revenue_data_sources: parseJsonArray(row.latest_data_sources_json),
      latest_revenue_assumptions: parseJsonArray(row.latest_assumptions_json)
    }));
  },

  getMerchantRevenueEstimate(companyId) {
    const row = getDatabase().prepare("SELECT * FROM merchant_revenue_estimates WHERE company_id = ?").get(companyId);
    if (!row) return null;
    const parseJsonArray = (value) => {
      try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    return {
      ...row,
      data_sources: parseJsonArray(row.data_sources_json),
      assumptions: parseJsonArray(row.assumptions_json),
      product_records: parseJsonArray(row.product_records_json),
      shopify_signals: parseJsonArray(row.shopify_signals_json),
      review_providers: parseJsonArray(row.review_providers_json),
      latest_data_sources: parseJsonArray(row.latest_data_sources_json),
      latest_assumptions: parseJsonArray(row.latest_assumptions_json)
    };
  },

  upsertMerchantRevenueEstimate(estimate) {
    if (!estimate || !Number.isInteger(Number(estimate.company_id)) || !estimate.domain) {
      throw new Error("A company ID and domain are required to save a revenue estimate.");
    }
    const range = estimate.estimatedRevenueRange || {};
    const annualRange = estimate.estimatedAnnualRevenueRange || {};
    const finite = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const database = getDatabase();
    const successfulEstimate = ["SUCCESS", "ESTIMATED"].includes(String(estimate.statusCode || (estimate.status === "success" ? "SUCCESS" : "")).toUpperCase()) &&
      finite(estimate.estimatedRevenue) !== null;
    const signalArray = (value) => JSON.stringify(Array.isArray(value) ? value : []);
    const productRecords = Array.isArray(estimate.productRecords)
      ? estimate.productRecords.slice(0, 30).map((product) => ({
          title: product.title || null,
          productType: product.productType || null,
          prices: Array.isArray(product.prices) ? product.prices.slice(0, 20) : [],
          availablePrices: Array.isArray(product.availablePrices) ? product.availablePrices.slice(0, 20) : [],
          currency: product.currency || null,
          url: product.url || null,
          availability: product.availability || null
        }))
      : [];
    database.prepare(`
      INSERT INTO merchant_revenue_estimates (
        company_id, domain, estimated_monthly_revenue, estimated_monthly_revenue_min,
        estimated_monthly_revenue_max, estimated_annual_revenue, estimated_annual_revenue_min,
        estimated_annual_revenue_max, currency, store_currency, aov, aov_method, conversion_rate,
        estimated_traffic, traffic_provider, traffic_metric, traffic_period, confidence,
        method, status, reason, data_sources_json, assumptions_json, estimate_updated_at,
        product_count, product_price_proxy, product_price_min, product_price_max, product_price_p25, product_price_p75, product_samples,
        product_records_json, domain_rank, domain_rank_status, domain_rank_source,
        domain_rank_publication_date, domain_rank_dataset_key, shopify_status, shopify_confidence,
        shopify_signals_json, review_widget_detected, review_providers_json, review_count,
        review_count_status, review_count_source, review_count_observed_at, review_count_previous,
        review_count_change, latest_data_sources_json, latest_assumptions_json, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? THEN COALESCE(?, datetime('now')) ELSE NULL END,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now'))
      )
      ON CONFLICT(company_id) DO UPDATE SET
        domain = excluded.domain,
        estimated_monthly_revenue = COALESCE(excluded.estimated_monthly_revenue, merchant_revenue_estimates.estimated_monthly_revenue),
        estimated_monthly_revenue_min = COALESCE(excluded.estimated_monthly_revenue_min, merchant_revenue_estimates.estimated_monthly_revenue_min),
        estimated_monthly_revenue_max = COALESCE(excluded.estimated_monthly_revenue_max, merchant_revenue_estimates.estimated_monthly_revenue_max),
        estimated_annual_revenue = COALESCE(excluded.estimated_annual_revenue, merchant_revenue_estimates.estimated_annual_revenue),
        estimated_annual_revenue_min = COALESCE(excluded.estimated_annual_revenue_min, merchant_revenue_estimates.estimated_annual_revenue_min),
        estimated_annual_revenue_max = COALESCE(excluded.estimated_annual_revenue_max, merchant_revenue_estimates.estimated_annual_revenue_max),
        currency = COALESCE(excluded.currency, merchant_revenue_estimates.currency),
        store_currency = COALESCE(excluded.store_currency, merchant_revenue_estimates.store_currency),
        aov = COALESCE(excluded.aov, merchant_revenue_estimates.aov),
        aov_method = COALESCE(excluded.aov_method, merchant_revenue_estimates.aov_method),
        conversion_rate = COALESCE(excluded.conversion_rate, merchant_revenue_estimates.conversion_rate),
        estimated_traffic = COALESCE(excluded.estimated_traffic, merchant_revenue_estimates.estimated_traffic),
        traffic_provider = COALESCE(excluded.traffic_provider, merchant_revenue_estimates.traffic_provider),
        traffic_metric = COALESCE(excluded.traffic_metric, merchant_revenue_estimates.traffic_metric),
        traffic_period = COALESCE(excluded.traffic_period, merchant_revenue_estimates.traffic_period),
        confidence = COALESCE(excluded.confidence, merchant_revenue_estimates.confidence),
        method = COALESCE(excluded.method, merchant_revenue_estimates.method),
        status = excluded.status,
        reason = excluded.reason,
        data_sources_json = CASE WHEN excluded.estimated_monthly_revenue IS NOT NULL THEN excluded.data_sources_json ELSE merchant_revenue_estimates.data_sources_json END,
        assumptions_json = CASE WHEN excluded.estimated_monthly_revenue IS NOT NULL THEN excluded.assumptions_json ELSE merchant_revenue_estimates.assumptions_json END,
        estimate_updated_at = COALESCE(excluded.estimate_updated_at, merchant_revenue_estimates.estimate_updated_at),
        product_count = COALESCE(excluded.product_count, merchant_revenue_estimates.product_count),
        product_price_proxy = COALESCE(excluded.product_price_proxy, merchant_revenue_estimates.product_price_proxy),
        product_price_min = COALESCE(excluded.product_price_min, merchant_revenue_estimates.product_price_min),
        product_price_max = COALESCE(excluded.product_price_max, merchant_revenue_estimates.product_price_max),
        product_price_p25 = COALESCE(excluded.product_price_p25, merchant_revenue_estimates.product_price_p25),
        product_price_p75 = COALESCE(excluded.product_price_p75, merchant_revenue_estimates.product_price_p75),
        product_samples = COALESCE(excluded.product_samples, merchant_revenue_estimates.product_samples),
        product_records_json = CASE WHEN excluded.product_count IS NOT NULL AND excluded.product_records_json != '[]' THEN excluded.product_records_json ELSE merchant_revenue_estimates.product_records_json END,
        domain_rank = COALESCE(excluded.domain_rank, merchant_revenue_estimates.domain_rank),
        domain_rank_status = COALESCE(excluded.domain_rank_status, merchant_revenue_estimates.domain_rank_status),
        domain_rank_source = COALESCE(excluded.domain_rank_source, merchant_revenue_estimates.domain_rank_source),
        domain_rank_publication_date = COALESCE(excluded.domain_rank_publication_date, merchant_revenue_estimates.domain_rank_publication_date),
        domain_rank_dataset_key = COALESCE(excluded.domain_rank_dataset_key, merchant_revenue_estimates.domain_rank_dataset_key),
        shopify_status = COALESCE(excluded.shopify_status, merchant_revenue_estimates.shopify_status),
        shopify_confidence = CASE WHEN excluded.shopify_status IN ('SHOPIFY', 'NOT_SHOPIFY') THEN excluded.shopify_confidence ELSE merchant_revenue_estimates.shopify_confidence END,
        shopify_signals_json = CASE WHEN excluded.shopify_status IN ('SHOPIFY', 'NOT_SHOPIFY') THEN excluded.shopify_signals_json ELSE merchant_revenue_estimates.shopify_signals_json END,
        review_widget_detected = CASE WHEN excluded.shopify_status IN ('SHOPIFY', 'NOT_SHOPIFY') THEN excluded.review_widget_detected ELSE merchant_revenue_estimates.review_widget_detected END,
        review_providers_json = CASE WHEN excluded.shopify_status IN ('SHOPIFY', 'NOT_SHOPIFY') THEN excluded.review_providers_json ELSE merchant_revenue_estimates.review_providers_json END,
        review_count = COALESCE(excluded.review_count, merchant_revenue_estimates.review_count),
        review_count_status = COALESCE(excluded.review_count_status, merchant_revenue_estimates.review_count_status),
        review_count_source = COALESCE(excluded.review_count_source, merchant_revenue_estimates.review_count_source),
        review_count_observed_at = COALESCE(excluded.review_count_observed_at, merchant_revenue_estimates.review_count_observed_at),
        review_count_previous = COALESCE(excluded.review_count_previous, merchant_revenue_estimates.review_count_previous),
        review_count_change = COALESCE(excluded.review_count_change, merchant_revenue_estimates.review_count_change),
        latest_data_sources_json = excluded.latest_data_sources_json,
        latest_assumptions_json = excluded.latest_assumptions_json,
        updated_at = excluded.updated_at
    `).run(
      Number(estimate.company_id),
      estimate.domain,
      successfulEstimate ? finite(estimate.estimatedRevenue) : null,
      successfulEstimate ? finite(range.min) : null,
      successfulEstimate ? finite(range.max) : null,
      successfulEstimate ? finite(estimate.estimatedAnnualRevenue) : null,
      successfulEstimate ? finite(annualRange.min) : null,
      successfulEstimate ? finite(annualRange.max) : null,
      successfulEstimate ? estimate.currency || null : null,
      estimate.storeCurrency || estimate.currency || null,
      successfulEstimate ? finite(estimate.aov) : null,
      successfulEstimate ? estimate.aovMethod || null : null,
      successfulEstimate ? finite(estimate.conversionRate) : null,
      successfulEstimate ? finite(estimate.traffic) : null,
      successfulEstimate ? estimate.trafficProvider || null : null,
      successfulEstimate ? estimate.trafficMetric || null : null,
      successfulEstimate ? estimate.trafficPeriod || null : null,
      successfulEstimate ? estimate.confidence || null : null,
      successfulEstimate ? estimate.method || "traffic_based_model" : null,
      estimate.statusCode || (successfulEstimate ? "ESTIMATED" : "INSUFFICIENT_DATA"),
      estimate.reason || null,
      signalArray(successfulEstimate ? estimate.dataSources : []),
      signalArray(successfulEstimate ? estimate.assumptions : []),
      successfulEstimate ? 1 : 0,
      estimate.timestamp || null
      ,finite(estimate.productCount),
      finite(estimate.productPriceProxy),
      finite(estimate.productPriceMin),
      finite(estimate.productPriceMax),
      finite(estimate.productPriceP25),
      finite(estimate.productPriceP75),
      finite(estimate.productSamples),
      JSON.stringify(productRecords),
      finite(estimate.domainRank),
      estimate.domainRankStatus || null,
      estimate.domainRankSource || null,
      estimate.domainRankPublicationDate || null,
      estimate.domainRankDatasetKey || null,
      estimate.shopifyStatus || null,
      estimate.shopifyConfidence || null,
      signalArray(estimate.shopifySignals),
      estimate.reviewWidgetDetected ? 1 : 0,
      signalArray(estimate.reviewProviders),
      finite(estimate.reviewCount),
      estimate.reviewCountStatus || null,
      estimate.reviewCountSource || null,
      estimate.reviewCountObservedAt || null,
      finite(estimate.reviewCountPrevious),
      finite(estimate.reviewCountChange),
      signalArray(estimate.latestDataSources || estimate.dataSources),
      signalArray(estimate.latestAssumptions || estimate.assumptions),
      estimate.timestamp || null
    );
    if (Number.isInteger(Number(estimate.reviewCount)) && Number(estimate.reviewCount) >= 0) {
      const snapshot = this.recordMerchantReviewSnapshot({
        companyId: Number(estimate.company_id),
        domain: estimate.domain,
        provider: estimate.reviewCountSource || "public_product_structured_data",
        reviewCount: Number(estimate.reviewCount),
        sourceUrl: estimate.reviewCountSourceUrl || null,
        observedAt: estimate.reviewCountObservedAt || estimate.timestamp || new Date().toISOString()
      });
      if (snapshot) {
        database.prepare(`
          UPDATE merchant_revenue_estimates
          SET review_count_previous = ?, review_count_change = ?
          WHERE company_id = ?
        `).run(snapshot.previousReviewCount, snapshot.reviewCountChange, Number(estimate.company_id));
      }
    }
    return this.getMerchantRevenueEstimate(Number(estimate.company_id));
  },

  importDomainRankDataset(dataset) {
    if (!dataset || !dataset.source || !dataset.datasetKey || !dataset.publicationDate || !Array.isArray(dataset.rows)) {
      throw new Error("A source, dataset key, publication date, and rank rows are required.");
    }
    const database = getDatabase();
    let datasetId;
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.prepare(`
        INSERT INTO domain_rank_datasets (source, dataset_key, publication_date, row_count, file_sha256, source_url)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, dataset_key) DO UPDATE SET
          publication_date = excluded.publication_date,
          row_count = excluded.row_count,
          file_sha256 = excluded.file_sha256,
          source_url = excluded.source_url,
          imported_at = datetime('now')
      `).run(dataset.source, dataset.datasetKey, dataset.publicationDate, dataset.rows.length, dataset.fileSha256 || null, dataset.sourceUrl || null);
      datasetId = database.prepare("SELECT id FROM domain_rank_datasets WHERE source = ? AND dataset_key = ?").get(dataset.source, dataset.datasetKey).id;
      database.prepare("DELETE FROM domain_ranks WHERE dataset_id = ?").run(datasetId);
      const insertRank = database.prepare("INSERT INTO domain_ranks (dataset_id, domain, rank) VALUES (?, ?, ?)");
      for (const row of dataset.rows) insertRank.run(datasetId, row.domain, row.rank);
      database.exec("COMMIT;");
    } catch (error) {
      try { database.exec("ROLLBACK;"); } catch {}
      throw error;
    }
    return database.prepare("SELECT * FROM domain_rank_datasets WHERE id = ?").get(datasetId);
  },

  getDomainRank(domain) {
    return getDatabase().prepare(`
      SELECT r.rank, d.source, d.publication_date, d.dataset_key, d.imported_at
      FROM domain_ranks r
      JOIN domain_rank_datasets d ON d.id = r.dataset_id
      WHERE r.domain = ?
      ORDER BY d.publication_date DESC, d.imported_at DESC
      LIMIT 1
    `).get(domain) || null;
  },

  recordMerchantReviewSnapshot(snapshot) {
    if (!snapshot || !Number.isInteger(Number(snapshot.companyId)) || !snapshot.domain ||
        !snapshot.provider || !Number.isInteger(Number(snapshot.reviewCount)) || Number(snapshot.reviewCount) < 0) return null;
    const observedAt = snapshot.observedAt || new Date().toISOString();
    const snapshotDate = String(observedAt).slice(0, 10);
    const database = getDatabase();
    database.prepare(`
      INSERT OR IGNORE INTO merchant_review_snapshots
        (company_id, domain, provider, review_count, source_url, snapshot_date, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(Number(snapshot.companyId), snapshot.domain, snapshot.provider, Number(snapshot.reviewCount), snapshot.sourceUrl || null, snapshotDate, observedAt);
    const latest = database.prepare(`
      SELECT * FROM merchant_review_snapshots
      WHERE company_id = ? AND provider = ?
      ORDER BY snapshot_date DESC LIMIT 1
    `).get(Number(snapshot.companyId), snapshot.provider);
    const previous = database.prepare(`
      SELECT * FROM merchant_review_snapshots
      WHERE company_id = ? AND provider = ? AND snapshot_date < ?
      ORDER BY snapshot_date DESC LIMIT 1
    `).get(Number(snapshot.companyId), snapshot.provider, latest.snapshot_date);
    return {
      ...latest,
      previousReviewCount: previous ? previous.review_count : null,
      reviewCountChange: previous ? latest.review_count - previous.review_count : null
    };
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
        typeof contactData.whatsapp_available === "boolean" ? (contactData.whatsapp_available ? "true" : "false") : (contactData.whatsapp_available || "unknown"),
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

  // Builds the WHERE clause shared by the Ready Queue eligibility query.
  // Returns { whereSql, params } so the count and the rows can use the same
  // single source of truth and never drift apart.
  _buildReadyQueueWhere() {
    const database = getDatabase();
    const threshold = config.minEmployeeCount;
    const minScore = config.minAppRelevanceScore;
    const params = [];

    // Status filter: include DISCOVERED, READY, APPROVED, EMAIL_FOUND, ACTIVE
    // The original bug was that DISCOVERED was excluded, leaving the queue at 0
    // because most newly discovered companies are still in DISCOVERED status.
    // We now include DISCOVERED but exclude explicit terminal/negative statuses.
    params.push("DISCOVERED", "READY", "APPROVED", "EMAIL_FOUND", "ACTIVE");
    const statusClause = `c.status IN (?, ?, ?, ?, ?)`;

    const clauses = [statusClause];

    // App relevance score is honored when set to a positive number.
    // 0 / null / undefined = no filter (Employee Size is OFF by default).
    if (minScore && Number(minScore) > 0) {
      clauses.push(`c.app_relevance_score >= ?`);
      params.push(Number(minScore));
    }

    // Employee size filter only applies when explicitly enabled.
    // 0 / null / undefined means "off" — no filter is applied.
    if (threshold && Number(threshold) > 0) {
      clauses.push(`(
        (c.employee_count IS NOT NULL AND c.employee_count >= ?) OR
        (c.employee_count_min IS NOT NULL AND c.employee_count_min >= ?)
      )`);
      params.push(Number(threshold), Number(threshold));
      clauses.push(`(c.employee_count_verified = 1 OR c.employee_count_verified IS NULL)`);
      clauses.push(`(c.employee_count_status = 'QUALIFIED' OR c.employee_count_status IS NULL)`);
    }

    // Eligible for outreach only when a contact with an email exists
    clauses.push(`ct.email IS NOT NULL`);

    // Exclude companies that have already been emailed
    clauses.push(`c.id NOT IN (SELECT DISTINCT company_id FROM email_logs WHERE status IN ('SENT', 'DRY_RUN_SENT'))`);
    clauses.push(`ct.email NOT IN (SELECT DISTINCT email FROM email_logs WHERE status IN ('SENT', 'DRY_RUN_SENT'))`);

    return { whereSql: clauses.map((c) => `(${c})`).join(" AND "), params };
  },

  // Active Leads: strictly uncontacted, employee_count >= minThreshold verified (if configured), valid eligible email contacts
  getFinalQualifiedLeads(limit = null) {
    const database = getDatabase();
    const { whereSql, params } = this._buildReadyQueueWhere();

    let query = `
      SELECT
        c.*,
        r.estimated_monthly_revenue AS estimated_monthly_revenue,
        r.estimated_monthly_revenue_min AS estimated_monthly_revenue_min,
        r.estimated_monthly_revenue_max AS estimated_monthly_revenue_max,
        r.estimated_annual_revenue AS estimated_annual_revenue,
        r.estimated_annual_revenue_min AS estimated_annual_revenue_min,
        r.estimated_annual_revenue_max AS estimated_annual_revenue_max,
        r.currency AS revenue_currency,
        r.store_currency AS store_currency,
        r.aov AS estimated_aov,
        r.aov_method AS revenue_aov_method,
        r.conversion_rate AS estimated_conversion_rate,
        r.estimated_traffic AS estimated_monthly_visits,
        r.traffic_provider AS revenue_traffic_provider,
        r.traffic_metric AS revenue_traffic_metric,
        r.traffic_period AS revenue_traffic_period,
        r.confidence AS revenue_estimation_confidence,
        r.method AS revenue_estimation_method,
        r.status AS revenue_estimation_status,
        r.reason AS revenue_estimation_reason,
        r.data_sources_json AS revenue_data_sources_json,
        r.assumptions_json AS revenue_assumptions_json,
        r.updated_at AS revenue_last_updated_at,
        ct.id as contact_id,
        ct.name as contact_name,
        ct.role as contact_role,
        ct.email,
        ct.email_type,
        ct.confidence as email_confidence,
        ct.source_url as email_source_url
      FROM companies c
      LEFT JOIN merchant_revenue_estimates r ON r.company_id = c.id
      LEFT JOIN (
        SELECT * FROM contacts
        GROUP BY company_id
        HAVING min(
          CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END * 10 +
          CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
        )
      ) ct ON ct.company_id = c.id
      WHERE ${whereSql}
      ORDER BY c.lead_score DESC, c.app_relevance_score DESC, c.rating DESC
    `;
    if (limit) {
      query += ` LIMIT ${parseInt(limit, 10)}`;
    }
    const stmt = database.prepare(query);
    const parseJsonArray = (value) => {
      try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    return stmt.all(...params).map((row) => ({
      ...row,
      revenue_data_sources: parseJsonArray(row.revenue_data_sources_json),
      revenue_assumptions: parseJsonArray(row.revenue_assumptions_json)
    }));
  },

  // Records shown when a dashboard metric is selected. Contact and send
  // metrics return one row per underlying record; company metrics return one
  // row per company with its best public contact attached.
  getDashboardMetricRecords(metric) {
    const database = getDatabase();
    const threshold = Number(config.minEmployeeCount) || 0;
    const bestContactJoin = `
      LEFT JOIN contacts bc ON bc.id = (
        SELECT id
        FROM contacts
        WHERE company_id = c.id
        ORDER BY
          CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
          CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
        LIMIT 1
      )
    `;
    const companyRows = (whereSql, params = []) => database.prepare(`
      SELECT
        c.*,
        bc.id AS best_contact_id,
        bc.name AS best_contact_name,
        bc.role AS best_contact_role,
        bc.email AS best_contact_email,
        bc.email_type AS best_contact_email_type,
        bc.confidence AS best_contact_confidence,
        bc.source_url AS best_contact_source_url,
        bc.phone AS best_contact_phone,
        bc.normalized_phone AS best_contact_normalized_phone,
        bc.phone_type AS best_contact_phone_type,
        bc.whatsapp_available AS best_contact_whatsapp_available
      FROM companies c
      ${bestContactJoin}
      WHERE ${whereSql}
      ORDER BY c.lead_score DESC, c.app_relevance_score DESC, c.rating DESC
    `).all(...params).map((row) => ({
      ...row,
      contact_id: row.best_contact_id || null,
      contact_name: row.best_contact_name || null,
      contact_role: row.best_contact_role || null,
      email: row.best_contact_email || null,
      email_type: row.best_contact_email_type || null,
      email_confidence: row.best_contact_confidence || null,
      email_source_url: row.best_contact_source_url || null,
      phone: row.best_contact_phone || row.phone || null,
      normalized_phone: row.best_contact_normalized_phone || row.normalized_phone || null,
      phone_type: row.best_contact_phone_type || row.phone_type || null,
      whatsapp_available: row.best_contact_whatsapp_available || row.whatsapp_available || null,
      record_id: row.id
    }));

    switch (metric) {
      case "discovered":
        return companyRows("1 = 1");

      case "merchantContacts":
        return companyRows(`
          c.source = 'MERCHANT_UPLOAD' AND (
            EXISTS (
              SELECT 1 FROM contacts mc
              WHERE mc.company_id = c.id AND (
                NULLIF(TRIM(mc.email), '') IS NOT NULL OR
                NULLIF(TRIM(mc.phone), '') IS NOT NULL OR
                NULLIF(TRIM(mc.normalized_phone), '') IS NOT NULL
              )
            ) OR
            NULLIF(TRIM(c.phone), '') IS NOT NULL OR
            NULLIF(TRIM(c.normalized_phone), '') IS NOT NULL
          )
        `);

      case "employeeVerified":
        if (threshold > 0) {
          return companyRows(`
            ((c.employee_count >= ?) OR (c.employee_count_min >= ?))
            AND (c.employee_count_verified = 1 OR c.employee_count_status = 'QUALIFIED')
          `, [threshold, threshold]);
        }
        return companyRows("c.employee_count_verified = 1 OR c.employee_count IS NOT NULL");

      case "emailContacts": {
        const rows = database.prepare(`
          SELECT
            c.*,
            ct.id AS record_id,
            ct.id AS contact_id,
            ct.name AS contact_name,
            ct.role AS contact_role,
            ct.email AS email,
            ct.email_type AS email_type,
            ct.confidence AS email_confidence,
            ct.source_url AS email_source_url,
            ct.phone AS record_phone,
            ct.normalized_phone AS record_normalized_phone,
            ct.phone_type AS record_phone_type,
            ct.phone_source AS record_phone_source,
            ct.phone_source_url AS record_phone_source_url,
            ct.whatsapp_available AS record_whatsapp_available,
            ct.whatsapp_status AS record_whatsapp_status
          FROM contacts ct
          JOIN companies c ON c.id = ct.company_id
          ORDER BY
            CASE ct.confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
            c.lead_score DESC,
            c.name COLLATE NOCASE
        `).all();
        return rows.map((row) => ({
          ...row,
          phone: row.record_phone || row.phone || null,
          normalized_phone: row.record_normalized_phone || row.normalized_phone || null,
          phone_type: row.record_phone_type || row.phone_type || null,
          phone_source: row.record_phone_source || row.phone_source || null,
          phone_source_url: row.record_phone_source_url || row.phone_source_url || null,
          whatsapp_available: row.record_whatsapp_available || row.whatsapp_available || null,
          whatsapp_status: row.record_whatsapp_status || row.whatsapp_status || null,
          record_detail: `${row.email_confidence || "LOW"} confidence · ${row.email_type || "Contact"}`
        }));
      }

      case "readyToSend":
        return this.getFinalQualifiedLeads(null).map((row) => ({
          ...row,
          record_id: row.contact_id || row.id
        }));

      case "emailsSent": {
        return database.prepare(`
          SELECT
            c.*,
            el.id AS record_id,
            el.email AS email,
            el.status AS email_status,
            el.sent_at AS activity_at,
            el.subject AS activity_subject,
            el.message_id AS activity_message_id,
            el.contact_id AS contact_id,
            COALESCE(sent_contact.name, best_contact.name) AS contact_name,
            COALESCE(sent_contact.role, best_contact.role) AS contact_role,
            COALESCE(sent_contact.email_type, best_contact.email_type) AS email_type,
            COALESCE(sent_contact.confidence, best_contact.confidence) AS email_confidence,
            COALESCE(sent_contact.source_url, best_contact.source_url) AS email_source_url,
            COALESCE(sent_contact.phone, best_contact.phone, c.phone) AS record_phone,
            COALESCE(sent_contact.normalized_phone, best_contact.normalized_phone, c.normalized_phone) AS record_normalized_phone,
            COALESCE(sent_contact.phone_type, best_contact.phone_type, c.phone_type) AS record_phone_type,
            COALESCE(sent_contact.whatsapp_available, best_contact.whatsapp_available, c.whatsapp_available) AS record_whatsapp_available
          FROM email_logs el
          JOIN companies c ON c.id = el.company_id
          LEFT JOIN contacts sent_contact ON sent_contact.id = el.contact_id
          LEFT JOIN contacts best_contact ON best_contact.id = (
            SELECT id FROM contacts
            WHERE company_id = c.id
            ORDER BY
              CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
              CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
            LIMIT 1
          )
          WHERE el.status = 'SENT'
          ORDER BY el.sent_at DESC, c.name COLLATE NOCASE
        `).all().map((row) => ({
          ...row,
          phone: row.record_phone || null,
          normalized_phone: row.record_normalized_phone || null,
          phone_type: row.record_phone_type || null,
          whatsapp_available: row.record_whatsapp_available || null,
          record_detail: [row.activity_subject, row.activity_at].filter(Boolean).join(" · ")
        }));
      }

      case "excludedTooLow": {
        const tooLowClause = threshold > 0
          ? `OR (c.employee_count IS NOT NULL AND c.employee_count < ${threshold})
             OR (c.employee_count_max IS NOT NULL AND c.employee_count_max < ${threshold})
             OR c.status = 'REJECTED_HEADCOUNT'
             OR c.employee_count_status = 'REJECTED'`
          : "";
        return companyRows(`c.status = 'EXCLUDED' ${tooLowClause ? tooLowClause : ""}`)
          .map((row) => ({
            ...row,
            record_detail: row.status === "EXCLUDED" ? "Excluded / blacklisted" : "Below employee threshold"
          }));
      }

      default:
        throw new Error(`Unknown dashboard metric: ${metric}`);
    }
  },

  // Single source of truth for the Ready Queue count. Must return the same
  // number of records as getFinalQualifiedLeads() so the dashboard and the
  // outreach list can never disagree.
  getReadyQueueCount() {
    const database = getDatabase();
    const { whereSql, params } = this._buildReadyQueueWhere();
    const query = `
      SELECT count(*) as count
      FROM companies c
      LEFT JOIN (
        SELECT * FROM contacts
        GROUP BY company_id
        HAVING min(
          CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END * 10 +
          CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
        )
      ) ct ON ct.company_id = c.id
      WHERE ${whereSql}
    `;
    return database.prepare(query).get(...params).count;
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

    const excludedOrTooLow = threshold && threshold > 0 ? database.prepare(`
      SELECT count(*) as count FROM companies
      WHERE status = 'EXCLUDED'
         OR (employee_count IS NOT NULL AND employee_count < ${threshold})
         OR (employee_count_max IS NOT NULL AND employee_count_max < ${threshold})
         OR status = 'REJECTED_HEADCOUNT'
         OR employee_count_status = 'REJECTED'
    `).get().count : excluded;

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
    const merchantStoreCoverage = database.prepare(`
      SELECT
        count(DISTINCT c.id) as stores,
        count(DISTINCT CASE
          WHEN NULLIF(TRIM(ct.email), '') IS NOT NULL OR
            COALESCE(NULLIF(TRIM(ct.phone), ''), NULLIF(TRIM(ct.normalized_phone), ''),
              NULLIF(TRIM(c.phone), ''), NULLIF(TRIM(c.normalized_phone), '')) IS NOT NULL THEN c.id
        END) as with_contact,
        count(DISTINCT CASE WHEN NULLIF(TRIM(ct.email), '') IS NOT NULL THEN c.id END) as with_email,
        count(DISTINCT CASE
          WHEN COALESCE(NULLIF(TRIM(ct.phone), ''), NULLIF(TRIM(ct.normalized_phone), ''),
            NULLIF(TRIM(c.phone), ''), NULLIF(TRIM(c.normalized_phone), '')) IS NOT NULL THEN c.id
        END) as with_phone,
        count(DISTINCT CASE
          WHEN COALESCE(ct.whatsapp_available, c.whatsapp_available) = 'yes' THEN c.id
        END) as with_whatsapp
      FROM companies c
      LEFT JOIN contacts ct ON ct.company_id = c.id
      WHERE c.source = 'MERCHANT_UPLOAD'
    `).get();
    
    // Ready-to-send count must come from the same eligibility logic as
    // getFinalQualifiedLeads so the dashboard count and the outreach list
    // count can never drift apart.
    const readyToSend = this.getReadyQueueCount();

    const sent = database.prepare("SELECT count(*) as count FROM email_logs WHERE status = 'SENT'").get().count;
    const contacted = database.prepare("SELECT count(*) as count FROM companies WHERE status IN ('CONTACTED', 'SENT')").get().count;
    const failed = database.prepare("SELECT count(*) as count FROM email_logs WHERE status = 'FAILED'").get().count;

    return {
      totalDiscovered,
      candidates,
      excluded,
      excludedOrTooLow,
      duplicates,
      employeeVerified,
      minEmployeeCount: threshold && threshold > 0 ? threshold : null,
      employeeTooLow,
      employeeUncertain,
      employeeConflicting,
      qualified,
      totalContacts,
      highConfidence,
      mediumConfidence,
      noContact,
      merchantStores: merchantStoreCoverage.stores,
      merchantStoresWithContact: merchantStoreCoverage.with_contact,
      merchantStoresWithEmail: merchantStoreCoverage.with_email,
      merchantStoresWithPhone: merchantStoreCoverage.with_phone,
      merchantStoresWithWhatsApp: merchantStoreCoverage.with_whatsapp,
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

  /**
   * Save a single setting by key. Additive helper for settingsService.
   * @param {string} key - Setting key
   * @param {*} value - Setting value (will be JSON-stringified if object, else String())
   */
  saveSetting(key, value) {
    const database = getDatabase();
    if (value === undefined) return false;
    const strVal = typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value !== null ? value : "");
    const stmt = database.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `);
    stmt.run(key, strVal);
    return true;
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
  },

  // ─── Freelance Opportunities Module ───────────────────────────────────────────

  // Freelance Company CRUD
  upsertFreelanceCompany(companyData) {
    const database = getDatabase();

    let existing = null;
    if (companyData.id) {
      existing = database.prepare("SELECT * FROM freelance_companies WHERE id = ?").get(companyData.id);
    }
    if (!existing && companyData.shopify_store_url) {
      existing = database.prepare("SELECT * FROM freelance_companies WHERE shopify_store_url = ?").get(companyData.shopify_store_url);
    }
    if (!existing && companyData.normalized_name) {
      existing = database.prepare("SELECT * FROM freelance_companies WHERE normalized_name = ?").get(companyData.normalized_name);
    }
    if (!existing && companyData.domain) {
      existing = database.prepare("SELECT * FROM freelance_companies WHERE domain = ?").get(companyData.domain);
    }

    if (existing) {
      const updateStmt = database.prepare(`
        UPDATE freelance_companies SET
          name = COALESCE(?, name),
          normalized_name = COALESCE(?, normalized_name),
          domain = COALESCE(?, domain),
          official_website = COALESCE(?, official_website),
          shopify_store_url = COALESCE(?, shopify_store_url),
          city = COALESCE(?, city),
          state = COALESCE(?, state),
          country = COALESCE(?, country),
          store_name = COALESCE(?, store_name),
          store_description = COALESCE(?, store_description),
          installed_apps_json = COALESCE(?, installed_apps_json),
          tech_stack_json = COALESCE(?, tech_stack_json),
          product_count = COALESCE(?, product_count),
          estimated_revenue = COALESCE(?, estimated_revenue),
          employee_count = COALESCE(?, employee_count),
          employee_count_min = COALESCE(?, employee_count_min),
          employee_count_max = COALESCE(?, employee_count_max),
          employee_size_range = COALESCE(?, employee_size_range),
          employee_count_source = COALESCE(?, employee_count_source),
          employee_count_source_url = COALESCE(?, employee_count_source_url),
          employee_count_verified = COALESCE(?, employee_count_verified),
          employee_count_verified_at = COALESCE(?, employee_count_verified_at),
          employee_count_status = COALESCE(?, employee_count_status),
          service_clarity_score = COALESCE(?, service_clarity_score),
          portfolio_score = COALESCE(?, portfolio_score),
          tech_depth_score = COALESCE(?, tech_depth_score),
          geographic_reach_score = COALESCE(?, geographic_reach_score),
          contact_accessibility_score = COALESCE(?, contact_accessibility_score),
          responsiveness_score = COALESCE(?, responsiveness_score),
          freelance_lead_score = COALESCE(?, freelance_lead_score),
          source = COALESCE(?, source),
          discovery_keywords = COALESCE(?, discovery_keywords),
          status = CASE WHEN ? IS NOT NULL THEN ? ELSE status END,
          notes = COALESCE(?, notes),
          updated_at = datetime('now')
        WHERE id = ?
      `);

      updateStmt.run(
        companyData.name,
        companyData.normalized_name,
        companyData.domain || null,
        companyData.official_website || null,
        companyData.shopify_store_url || null,
        companyData.city || null,
        companyData.state || null,
        companyData.country || null,
        companyData.store_name || null,
        companyData.store_description || null,
        JSON.stringify(companyData.installed_apps || []),
        JSON.stringify(companyData.tech_stack || []),
        companyData.product_count || null,
        companyData.estimated_revenue || null,
        companyData.employee_count != null ? Number(companyData.employee_count) : null,
        companyData.employee_count_min != null ? Number(companyData.employee_count_min) : null,
        companyData.employee_count_max != null ? Number(companyData.employee_count_max) : null,
        companyData.employee_size_range || null,
        companyData.employee_count_source || null,
        companyData.employee_count_source_url || null,
        companyData.employee_count_verified != null ? (companyData.employee_count_verified ? 1 : 0) : null,
        companyData.employee_count_verified_at || null,
        companyData.employee_count_status || null,
        companyData.service_clarity_score || 0,
        companyData.portfolio_score || 0,
        companyData.tech_depth_score || 0,
        companyData.geographic_reach_score || 0,
        companyData.contact_accessibility_score || 0,
        companyData.responsiveness_score || 0,
        companyData.freelance_lead_score || 0,
        companyData.source || "BRAVE_SEARCH",
        companyData.discovery_keywords || null,
        companyData.status || null,
        companyData.status || null,
        companyData.notes || null,
        existing.id
      );

      return this.getFreelanceCompanyById(existing.id);
    } else {
      const insertStmt = database.prepare(`
        INSERT INTO freelance_companies (
          name, normalized_name, domain, official_website, shopify_store_url,
          city, state, country, store_name, store_description,
          installed_apps_json, tech_stack_json, product_count, estimated_revenue,
          employee_count, employee_count_min, employee_count_max, employee_size_range,
          employee_count_source, employee_count_source_url, employee_count_verified,
          employee_count_verified_at, employee_count_status,
          service_clarity_score, portfolio_score, tech_depth_score,
          geographic_reach_score, contact_accessibility_score, responsiveness_score,
          freelance_lead_score, source, discovery_keywords, status, notes
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?
        )
      `);

      const res = insertStmt.run(
        companyData.name,
        companyData.normalized_name,
        companyData.domain || null,
        companyData.official_website || null,
        companyData.shopify_store_url || null,
        companyData.city || null,
        companyData.state || null,
        companyData.country || null,
        companyData.store_name || null,
        companyData.store_description || null,
        JSON.stringify(companyData.installed_apps || []),
        JSON.stringify(companyData.tech_stack || []),
        companyData.product_count || null,
        companyData.estimated_revenue || null,
        companyData.employee_count != null ? Number(companyData.employee_count) : null,
        companyData.employee_count_min != null ? Number(companyData.employee_count_min) : null,
        companyData.employee_count_max != null ? Number(companyData.employee_count_max) : null,
        companyData.employee_size_range || null,
        companyData.employee_count_source || null,
        companyData.employee_count_source_url || null,
        companyData.employee_count_verified ? 1 : 0,
        companyData.employee_count_verified_at || null,
        companyData.employee_count_status || "UNKNOWN",
        companyData.service_clarity_score || 0,
        companyData.portfolio_score || 0,
        companyData.tech_depth_score || 0,
        companyData.geographic_reach_score || 0,
        companyData.contact_accessibility_score || 0,
        companyData.responsiveness_score || 0,
        companyData.freelance_lead_score || 0,
        companyData.source || "BRAVE_SEARCH",
        companyData.discovery_keywords || null,
        companyData.status || "DISCOVERED",
        companyData.notes || null
      );

      return this.getFreelanceCompanyById(Number(res.lastInsertRowid));
    }
  },

  getFreelanceCompanyById(id) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_companies WHERE id = ?");
    const row = stmt.get(id);
    if (!row) return null;
    // Parse JSON fields
    try { row.installed_apps = JSON.parse(row.installed_apps_json || '[]'); } catch { row.installed_apps = []; }
    try { row.tech_stack = JSON.parse(row.tech_stack_json || '[]'); } catch { row.tech_stack = []; }
    return row;
  },

  getFreelanceCompanyByDomain(domain) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_companies WHERE domain = ?");
    return stmt.get(domain);
  },

  getFreelanceCompanyByNormalizedName(normalizedName) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_companies WHERE normalized_name = ?");
    return stmt.get(normalizedName);
  },

  getFreelanceCompanyByShopifyUrl(url) {
    if (!url) return null;
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_companies WHERE shopify_store_url = ?");
    return stmt.get(url);
  },

  getAllFreelanceCompanies(filters = {}) {
    const database = getDatabase();
    let query = "SELECT * FROM freelance_companies WHERE 1=1";
    const params = [];

    if (filters.status) {
      query += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.source) {
      query += " AND source = ?";
      params.push(filters.source);
    }
    if (filters.minLeadScore) {
      query += " AND freelance_lead_score >= ?";
      params.push(filters.minLeadScore);
    }
    if (filters.verifiedOnly) {
      query += " AND employee_count_verified = 1 AND employee_count_status = 'QUALIFIED'";
    }
    if (filters.search) {
      query += " AND (name LIKE ? OR domain LIKE ? OR store_name LIKE ?)";
      params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    }

    query += " ORDER BY freelance_lead_score DESC, service_clarity_score DESC, portfolio_score DESC";

    if (filters.limit) {
      query += ` LIMIT ${parseInt(filters.limit, 10)}`;
    }

    const stmt = database.prepare(query);
    return stmt.all(...params);
  },

  updateFreelanceCompanyStatus(id, status, notes = null) {
    const database = getDatabase();
    if (notes) {
      const stmt = database.prepare("UPDATE freelance_companies SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?");
      stmt.run(status, notes, id);
    } else {
      const stmt = database.prepare("UPDATE freelance_companies SET status = ?, updated_at = datetime('now') WHERE id = ?");
      stmt.run(status, id);
    }
    return this.getFreelanceCompanyById(id);
  },

  // Freelance Contact CRUD
  upsertFreelanceContact(contactData) {
    const database = getDatabase();
    const existing = contactData.email
      ? database.prepare("SELECT * FROM freelance_contacts WHERE email = ?").get(contactData.email)
      : null;
    const normalizedWhatsappAvailable = typeof contactData.whatsapp_available === "boolean"
      ? (contactData.whatsapp_available ? "true" : "false")
      : (typeof contactData.whatsapp_available === "string"
        ? contactData.whatsapp_available.toLowerCase()
        : (contactData.whatsapp_available || "unknown"));
    const normalizedVerified = contactData.verified ? 1 : 0;
    const normalizedMxValid = contactData.mx_valid ? 1 : 0;

    if (existing) {
      const stmt = database.prepare(`
        UPDATE freelance_contacts SET
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
        normalizedWhatsappAvailable,
        contactData.whatsapp_status || null,
        contactData.source_url || null,
        normalizedVerified,
        normalizedMxValid,
        contactData.notes || null,
        existing.id
      );

      return database.prepare("SELECT * FROM freelance_contacts WHERE id = ?").get(existing.id);
    } else {
      const stmt = database.prepare(`
        INSERT INTO freelance_contacts (
          company_id, name, role, email, email_type, confidence, source_url,
          phone, normalized_phone, phone_type, phone_source, phone_source_url,
          whatsapp_available, whatsapp_status, verified, mx_valid, notes
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
        normalizedWhatsappAvailable,
        contactData.whatsapp_status || "READY",
        normalizedVerified,
        normalizedMxValid,
        contactData.notes || null
      );

      return database.prepare("SELECT * FROM freelance_contacts WHERE id = ?").get(Number(res.lastInsertRowid));
    }
  },

  getFreelanceContactsByCompanyId(companyId) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_contacts WHERE company_id = ? ORDER BY CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END");
    return stmt.all(companyId);
  },

  getBestFreelanceContactForCompany(companyId) {
    const database = getDatabase();
    const stmt = database.prepare(`
      SELECT * FROM freelance_contacts
      WHERE company_id = ?
      ORDER BY
        CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        CASE email_type WHEN 'HR / Recruitment' THEN 1 WHEN 'Hiring Management' THEN 2 ELSE 3 END
      LIMIT 1
    `);
    return stmt.get(companyId);
  },

  // Freelance Sources
  addFreelanceSource(sourceData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO freelance_sources (company_id, source_type, url, title, evidence)
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

  getFreelanceSourcesByCompanyId(companyId) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_sources WHERE company_id = ?");
    return stmt.all(companyId);
  },

  // Freelance Exclusions
  addFreelanceExclusion(companyName, normalizedName, domain = null, reason = "Manual exclusion") {
    const database = getDatabase();
    const existing = database.prepare("SELECT * FROM freelance_exclusions WHERE normalized_name = ?").get(normalizedName);
    if (!existing) {
      const stmt = database.prepare(`
        INSERT INTO freelance_exclusions (company_name, normalized_name, domain, reason)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(companyName, normalizedName, domain || null, reason);
    }
  },

  getAllFreelanceExclusions() {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_exclusions ORDER BY created_at DESC");
    return stmt.all();
  },

  isFreelanceExcluded(normalizedName, domain = null) {
    const database = getDatabase();
    if (normalizedName) {
      const stmt = database.prepare("SELECT 1 FROM freelance_exclusions WHERE normalized_name = ?");
      if (stmt.get(normalizedName)) return true;
    }
    if (domain) {
      const stmt = database.prepare("SELECT 1 FROM freelance_exclusions WHERE domain = ?");
      if (stmt.get(domain)) return true;
    }
    return false;
  },

  deleteFreelanceExclusion(id) {
    const database = getDatabase();
    const stmt = database.prepare("DELETE FROM freelance_exclusions WHERE id = ?");
    stmt.run(id);
  },

  // Freelance Email Logs
  addFreelanceEmailLog(logData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO freelance_email_logs (
        company_id, contact_id, email, subject, status, message_id, error, attempts
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    stmt.run(
      logData.company_id,
      logData.contact_id || null,
      logData.email,
      logData.subject || null,
      logData.status,
      logData.message_id || null,
      logData.error || null,
      logData.attempts || 1
    );
  },

  getAllFreelanceEmailLogs() {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_email_logs ORDER BY sent_at DESC");
    return stmt.all();
  },

  getFreelanceEmailLogsByCompany(companyId) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_email_logs WHERE company_id = ? ORDER BY sent_at DESC");
    return stmt.all(companyId);
  },

  hasFreelanceBeenContacted(email, companyId = null) {
    const database = getDatabase();
    if (!email && !companyId) return false;

    const normEmail = email ? String(email).trim().toLowerCase() : "";

    if (companyId) {
      const stmt = database.prepare(`
        SELECT 1 FROM freelance_email_logs
        WHERE (LOWER(email) = ? OR company_id = ?)
          AND status IN ('SENT', 'DRY_RUN_SENT')
        LIMIT 1
      `);
      if (stmt.get(normEmail, companyId)) return true;
    }

    if (normEmail) {
      const stmt = database.prepare("SELECT 1 FROM freelance_email_logs WHERE LOWER(email) = ? AND status IN ('SENT', 'DRY_RUN_SENT') LIMIT 1");
      if (stmt.get(normEmail)) return true;
    }

    return false;
  },

  // Freelance WhatsApp Logs
  logFreelanceWhatsAppMessage(logData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO freelance_whatsapp_logs (
        company_id, contact_id, phone, message, status, message_id, error
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
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

    if (logData.status === "SENT" || logData.status === "DRY_RUN_SENT") {
      database.prepare("UPDATE freelance_companies SET whatsapp_status = 'SENT', updated_at = datetime('now') WHERE id = ?").run(logData.company_id);
    } else if (logData.status === "FAILED") {
      database.prepare("UPDATE freelance_companies SET whatsapp_status = 'FAILED', updated_at = datetime('now') WHERE id = ?").run(logData.company_id);
    }

    return Number(res.lastInsertRowid);
  },

  getAllFreelanceWhatsAppLogs() {
    const database = getDatabase();
    const stmt = database.prepare(`
      SELECT wl.*, c.name as company_name, c.domain, ct.name as contact_name
      FROM freelance_whatsapp_logs wl
      LEFT JOIN freelance_companies c ON c.id = wl.company_id
      LEFT JOIN freelance_contacts ct ON ct.id = wl.contact_id
      ORDER BY wl.sent_at DESC
    `);
    return stmt.all();
  },

  isFreelanceWhatsAppContacted(companyId, phone = null) {
    const database = getDatabase();
    if (companyId) {
      const stmt = database.prepare("SELECT 1 FROM freelance_whatsapp_logs WHERE company_id = ? AND status IN ('SENT', 'DRY_RUN_SENT') LIMIT 1");
      if (stmt.get(companyId)) return true;
    }
    if (phone) {
      const stmt = database.prepare(`
        SELECT 1 FROM freelance_whatsapp_logs
        WHERE phone = ? AND status IN ('SENT', 'DRY_RUN_SENT')
        LIMIT 1
      `);
      if (stmt.get(phone)) return true;
    }
    return false;
  },

  isFreelanceWhatsAppOptedOut(phone) {
    if (!phone) return false;
    const database = getDatabase();
    const stmt = database.prepare(`
      SELECT 1 FROM freelance_whatsapp_logs
      WHERE phone = ? AND status = 'OPTED_OUT'
      LIMIT 1
    `);
    return !!stmt.get(phone);
  },

  // Freelance Lead Details (deep qualification evidence)
  upsertFreelanceLeadDetails(detailsData) {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO freelance_lead_details (
        company_id, service_offerings_json, portfolio_items_json,
        client_testimonials_json, service_gaps_json, tech_stack_evidence_json,
        geographic_evidence_json, qualification_evidence_json, outreach_personalization_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id) DO UPDATE SET
        service_offerings_json = excluded.service_offerings_json,
        portfolio_items_json = excluded.portfolio_items_json,
        client_testimonials_json = excluded.client_testimonials_json,
        service_gaps_json = excluded.service_gaps_json,
        tech_stack_evidence_json = excluded.tech_stack_evidence_json,
        geographic_evidence_json = excluded.geographic_evidence_json,
        qualification_evidence_json = excluded.qualification_evidence_json,
        outreach_personalization_json = excluded.outreach_personalization_json
    `);

    stmt.run(
      detailsData.company_id,
      JSON.stringify(detailsData.service_offerings || []),
      JSON.stringify(detailsData.portfolio_items || []),
      JSON.stringify(detailsData.client_testimonials || []),
      JSON.stringify(detailsData.service_gaps || []),
      JSON.stringify(detailsData.tech_stack_evidence || []),
      JSON.stringify(detailsData.geographic_evidence || []),
      JSON.stringify(detailsData.qualification_evidence || {}),
      JSON.stringify(detailsData.outreach_personalization || {})
    );
  },

  getFreelanceLeadDetails(companyId) {
    const database = getDatabase();
    const stmt = database.prepare("SELECT * FROM freelance_lead_details WHERE company_id = ?");
    const row = stmt.get(companyId);
    if (!row) return null;
    const result = {};
    for (const key of ['service_offerings', 'portfolio_items', 'client_testimonials', 'service_gaps', 'tech_stack_evidence', 'geographic_evidence', 'qualification_evidence', 'outreach_personalization']) {
      try {
        result[key] = JSON.parse(row[`${key}_json`] || '[]');
      } catch {
        result[key] = [];
      }
    }
    if (typeof row.qualification_evidence_json === 'string' && row.qualification_evidence_json.startsWith('{')) {
      try { result.qualification_evidence = JSON.parse(row.qualification_evidence_json); } catch { result.qualification_evidence = {}; }
    }
    if (typeof row.outreach_personalization_json === 'string' && row.outreach_personalization_json.startsWith('{')) {
      try { result.outreach_personalization = JSON.parse(row.outreach_personalization_json); } catch { result.outreach_personalization = {}; }
    }
    return result;
  },

  // Freelance Outreach Batch Tracking
  createFreelanceOutreachBatch(batchId, channel, total, dryRun) {
    const database = getDatabase();
    database.prepare(`
      INSERT INTO freelance_outreach_batches (id, channel, status, dry_run, total, pending)
      VALUES (?, ?, 'QUEUED', ?, ?, ?)
    `).run(batchId, channel, dryRun ? 1 : 0, total, total);
    return batchId;
  },

  getFreelanceOutreachBatch(batchId) {
    const database = getDatabase();
    const batch = database.prepare("SELECT * FROM freelance_outreach_batches WHERE id = ?").get(batchId);
    if (!batch) return null;
    return { ...batch, dry_run: Boolean(batch.dry_run) };
  },

  lockFreelanceBatchItem(batchId, companyId) {
    const database = getDatabase();
    const result = database.prepare(`
      UPDATE freelance_outreach_items
      SET status = 'PROCESSING', processed_at = NULL
      WHERE batch_id = ? AND company_id = ? AND status = 'PENDING'
    `).run(batchId, companyId);
    return result.changes > 0;
  },

  getNextFreelanceBatchItems(batchId, limit) {
    const database = getDatabase();
    const items = database.prepare(`
      SELECT foi.*, fc.name as company_name, fco.email as contact_email, fco.name as contact_name
      FROM freelance_outreach_items foi
      LEFT JOIN freelance_companies fc ON fc.id = foi.company_id
      LEFT JOIN freelance_contacts fco ON fco.id = foi.contact_id
      WHERE foi.batch_id = ? AND foi.status = 'PENDING'
      ORDER BY foi.position ASC
      LIMIT ?
    `).all(batchId, limit);

    const locked = [];
    for (const item of items) {
      if (this.lockFreelanceBatchItem(batchId, item.company_id)) {
        locked.push(item);
      }
    }
    return locked;
  },

  markFreelanceBatchItemSent(batchId, companyId, messageId, attempts) {
    const database = getDatabase();
    database.prepare(`
      UPDATE freelance_outreach_items
      SET status = 'SENT', message_id = ?, attempts = ?, processed_at = datetime('now')
      WHERE batch_id = ? AND company_id = ?
    `).run(messageId, attempts, batchId, companyId);
  },

  markFreelanceBatchItemFailed(batchId, companyId, errorMsg, attempts) {
    const database = getDatabase();
    database.prepare(`
      UPDATE freelance_outreach_items
      SET status = 'FAILED', error = ?, attempts = ?, processed_at = datetime('now')
      WHERE batch_id = ? AND company_id = ?
    `).run(errorMsg, attempts, batchId, companyId);
  },

  refreshFreelanceBatchCounters(batchId) {
    const database = getDatabase();
    const counters = database.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END) as processing
      FROM freelance_outreach_items WHERE batch_id = ?
    `).get(batchId);

    database.prepare(`
      UPDATE freelance_outreach_batches
      SET total = ?, sent = ?, failed = ?, pending = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(counters.total, counters.sent, counters.failed, counters.pending, batchId);

    return this.getFreelanceOutreachBatch(batchId);
  },

  completeFreelanceOutreachBatch(batchId, error = null) {
    const database = getDatabase();
    database.prepare(`
      UPDATE freelance_outreach_batches
      SET status = 'COMPLETED', completed_at = datetime('now'), error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(error || null, batchId);

    database.prepare(`
      UPDATE freelance_outreach_items SET status = 'PENDING', attempts = 0
      WHERE batch_id = ? AND status = 'PROCESSING'
    `).run(batchId);
  },

  failFreelanceOutreachBatch(batchId, error) {
    const database = getDatabase();
    database.prepare(`
      UPDATE freelance_outreach_batches
      SET status = 'FAILED', error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(error, batchId);
  },

  getFreelanceOutreachBatchItems(batchId) {
    const database = getDatabase();
    const stmt = database.prepare(`
      SELECT *, fc.name as company_name, fc.domain
      FROM freelance_outreach_items foi
      LEFT JOIN freelance_companies fc ON fc.id = foi.company_id
      WHERE foi.batch_id = ?
      ORDER BY foi.position ASC
    `);
    return stmt.all(batchId);
  },

  // Freelance Statistics
  getFreelanceStatistics() {
    const database = getDatabase();
    const totalDiscovered = database.prepare("SELECT count(*) as count FROM freelance_companies").get().count;
    const verified = database.prepare("SELECT count(*) as count FROM freelance_companies WHERE employee_count_verified = 1 OR employee_count_status = 'QUALIFIED'").get().count;
    const qualified = database.prepare("SELECT count(*) as count FROM freelance_companies WHERE freelance_lead_score >= 60 AND employee_count_verified = 1").get().count;
    const contactable = database.prepare("SELECT count(*) as count FROM freelance_companies WHERE status IN ('READY', 'QUALIFIED')").get().count;
    const outreachReady = database.prepare("SELECT count(*) as count FROM freelance_companies WHERE status = 'OUTREACH_READY'").get().count;
    const sent = database.prepare("SELECT count(*) as count FROM freelance_email_logs WHERE status = 'SENT'").get().count;
    const excluded = database.prepare("SELECT count(*) as count FROM freelance_exclusions").get().count;
    const whatsappSent = database.prepare("SELECT count(*) as count FROM freelance_whatsapp_logs WHERE status IN ('SENT', 'DRY_RUN_SENT')").get().count;

    return {
      totalDiscovered,
      verified,
      qualified,
      contactable,
      outreachReady,
      sent,
      excluded,
      whatsappSent
    };
  },

  // ─── Email Batch Tracking ────────────────────────────────────────────────────

  /**
   * Create a new batch record. Returns the batch id.
   */
  createEmailBatch(batchId, mode, totalLeads, leadIds, chunkSize) {
    const database = getDatabase();
    database.prepare(`
      INSERT INTO email_batches (id, mode, status, total, pending, lead_ids_json, chunk_size)
      VALUES (?, ?, 'PROCESSING', ?, ?, ?, ?)
    `).run(batchId, mode, totalLeads, totalLeads, JSON.stringify(leadIds), chunkSize);
    return batchId;
  },

  /**
   * Get a batch by id.
   */
  getEmailBatch(batchId) {
    const database = getDatabase();
    return database.prepare("SELECT * FROM email_batches WHERE id = ?").get(batchId) || null;
  },

  /**
   * Atomically lock a PENDING batch item, transitioning it to PROCESSING.
   * Returns true if the row was newly locked, false if it was already
   * claimed by another execution. Safe under concurrent runs.
   */
  lockBatchItem(batchId, companyId) {
    const database = getDatabase();
    const result = database.prepare(`
      UPDATE email_batch_items
      SET status = 'PROCESSING', processed_at = NULL
      WHERE batch_id = ? AND company_id = ? AND status = 'PENDING'
    `).run(batchId, companyId);
    return result.changes > 0;
  },

  /**
   * Get the next N pending items for a batch, locking each one atomically.
   * Only returns items that weren't already claimed by another concurrent run.
   */
  getNextBatchItems(batchId, limit) {
    const database = getDatabase();
    const items = database.prepare(`
      SELECT ebi.*, c.name as company_name, ct.name as contact_name,
             ct.role as contact_role, ct.email_type
      FROM email_batch_items ebi
      LEFT JOIN companies c ON c.id = ebi.company_id
      LEFT JOIN contacts ct ON ct.id = ebi.contact_id
      WHERE ebi.batch_id = ?
        AND ebi.status = 'PENDING'
      ORDER BY ebi.position ASC
      LIMIT ?
    `).all(batchId, limit);
    // Atomically lock each one so concurrent executions can't double-send.
    const locked = [];
    for (const item of items) {
      if (this.lockBatchItem(batchId, item.company_id)) {
        locked.push(item);
      }
    }
    return locked;
  },

  /**
   * Mark a batch item as SENT.
   */
  markBatchItemSent(batchId, companyId, messageId, attempts) {
    const database = getDatabase();
    database.prepare(`
      UPDATE email_batch_items
      SET status = 'SENT', message_id = ?, attempts = ?, processed_at = datetime('now')
      WHERE batch_id = ? AND company_id = ?
    `).run(messageId, attempts, batchId, companyId);
    // Also create the traditional email_log entry so the rest of the system
    // (hasBeenContacted, history, etc.) works without changes.
    const item = database.prepare("SELECT * FROM email_batch_items WHERE batch_id = ? AND company_id = ?").get(batchId, companyId);
    if (item) {
      database.prepare(`
        INSERT OR IGNORE INTO email_logs
          (company_id, contact_id, email, subject, status, message_id, attempts)
        VALUES (?, ?, ?, ?, 'SENT', ?, ?)
      `).run(item.company_id, item.contact_id, item.email, item.subject, messageId, attempts);
    }
  },

  /**
   * Mark a batch item as FAILED.
   */
  markBatchItemFailed(batchId, companyId, errorMsg, attempts) {
    const database = getDatabase();
    database.prepare(`
      UPDATE email_batch_items
      SET status = 'FAILED', error = ?, attempts = ?, processed_at = datetime('now')
      WHERE batch_id = ? AND company_id = ?
    `).run(errorMsg, attempts, batchId, companyId);
  },

  /**
   * Recount a batch's counters from the items table and persist to the batch row.
   * Returns the updated batch row.
   */
  refreshEmailBatchCounters(batchId) {
    const database = getDatabase();
    const counters = database.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END) as processing
      FROM email_batch_items WHERE batch_id = ?
    `).get(batchId);
    database.prepare(`
      UPDATE email_batches
      SET total = ?, sent = ?, failed = ?, pending = ?, processing = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(counters.total, counters.sent, counters.failed, counters.pending, counters.processing, batchId);
    return this.getEmailBatch(batchId);
  },

  /**
   * Mark a batch as completed (all items in terminal state).
   */
  completeEmailBatch(batchId, error = null) {
    const database = getDatabase();
    database.prepare(`
      UPDATE email_batches
      SET status = 'COMPLETED', completed_at = datetime('now'),
          error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(error || null, batchId);
    // Release any stuck PROCESSING items back to PENDING so they can be retried
    // in a fresh batch (don't leave them locked forever).
    database.prepare(`
      UPDATE email_batch_items SET status = 'PENDING', attempts = 0
      WHERE batch_id = ? AND status = 'PROCESSING'
    `).run(batchId);
  },

  /**
   * Mark a batch as failed.
   */
  failEmailBatch(batchId, error) {
    const database = getDatabase();
    database.prepare(`
      UPDATE email_batches
      SET status = 'FAILED', error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(error, batchId);
  }
};

module.exports = db;
