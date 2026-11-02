const crypto = require("node:crypto");

const FREE_LEAD_LIMIT = 5;
const AUTHORIZED_ADMIN_EMAIL = "himanshusoni7899@gmail.com";

function invalidInput(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeHost(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

function canonicalLeadKey(lead) {
  if (!lead || typeof lead !== "object" || Array.isArray(lead)) {
    throw invalidInput("Lead must be an object");
  }

  const hostFields = [
    lead.domain,
    lead.website,
    lead.website_url,
    lead.official_website,
    lead.developer_website
  ];
  for (const value of hostFields) {
    const host = normalizeHost(value);
    if (host) return `host:${host}`;
  }

  if (typeof lead.app_store_slug === "string" && lead.app_store_slug.trim()) {
    return `shopify-app:${lead.app_store_slug.trim().toLowerCase()}`;
  }
  if (typeof lead.appStoreSlug === "string" && lead.appStoreSlug.trim()) {
    return `shopify-app:${lead.appStoreSlug.trim().toLowerCase()}`;
  }

  for (const value of [lead.shopify_partner_url, lead.app_store_url]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      const path = url.pathname.replace(/\/+$/, "").toLowerCase();
      if (url.protocol === "https:" || url.protocol === "http:") {
        const host = normalizeHost(url.hostname);
        if (host) return `url:${host}${path}`;
      }
    } catch {
      continue;
    }
  }

  throw invalidInput("Lead is missing a stable website, app slug, or Shopify listing URL");
}

function getLeadSource(lead) {
  const source = lead.source || lead.source_type || lead.mode || "UNKNOWN";
  if (typeof source !== "string" || !source.trim() || source.length > 80) {
    throw invalidInput("Lead source must be a non-empty string of at most 80 characters");
  }
  return source.trim().toUpperCase();
}

async function getAccountState(client, userId) {
  const result = await client.query(`
    SELECT
      u.id,
      u.email_normalized,
      u.role,
      u.registered_at,
      u.disabled_at,
      b.admin_user_id,
      b.payment_launch_at,
      EXISTS (
        SELECT 1
        FROM saas_entitlements e
        WHERE e.user_id = u.id AND e.revoked_at IS NULL
      ) AS has_lifetime_entitlement,
      (
        SELECT COUNT(*)::INTEGER
        FROM saas_lead_usage usage
        WHERE usage.user_id = u.id
      ) AS free_leads_used
    FROM saas_users u
    CROSS JOIN saas_bootstrap_state b
    WHERE u.id = $1 AND b.singleton = TRUE
  `, [userId]);

  if (result.rowCount !== 1) {
    throw new Error("Account or SaaS bootstrap configuration was not found");
  }

  const account = result.rows[0];
  if (account.disabled_at) {
    throw new Error("This account is disabled");
  }

  const isAdmin = account.role === "ADMIN"
    && account.email_normalized === AUTHORIZED_ADMIN_EMAIL
    && String(account.id) === String(account.admin_user_id);
  if (account.role === "ADMIN" && !isAdmin) {
    throw new Error("Administrator identity does not match the authorized account");
  }

  const registeredAt = new Date(account.registered_at);
  const paymentLaunchAt = new Date(account.payment_launch_at);
  if (Number.isNaN(registeredAt.getTime()) || Number.isNaN(paymentLaunchAt.getTime())) {
    throw new Error("Account registration or payment launch timestamp is invalid");
  }

  const isGrandfathered = registeredAt < paymentLaunchAt;
  const freeLeadsUsed = Number(account.free_leads_used);
  if (!Number.isInteger(freeLeadsUsed) || freeLeadsUsed < 0) {
    throw new Error("Free-lead usage state is invalid");
  }

  return {
    isAdmin,
    isGrandfathered,
    hasLifetimeEntitlement: Boolean(account.has_lifetime_entitlement),
    freeLeadsUsed,
    unlimited: isAdmin || isGrandfathered || Boolean(account.has_lifetime_entitlement)
  };
}

async function getAccessSummary(pool, userId) {
  const client = await pool.connect();
  try {
    const account = await getAccountState(client, userId);
    const remaining = account.unlimited
      ? null
      : Math.max(0, FREE_LEAD_LIMIT - account.freeLeadsUsed);

    return {
      freeLeadLimit: FREE_LEAD_LIMIT,
      freeLeadsUsed: account.unlimited ? 0 : account.freeLeadsUsed,
      freeLeadsRemaining: remaining,
      hasLifetimeAccess: account.unlimited,
      accessType: account.isAdmin
        ? "ADMIN"
        : account.isGrandfathered
          ? "GRANDFATHERED"
          : account.hasLifetimeEntitlement
            ? "PAID"
            : "FREE"
    };
  } finally {
    client.release();
  }
}

async function saveUniqueLeads(pool, userId, leads) {
  if (!Array.isArray(leads)) throw invalidInput("Leads must be an array");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountResult = await client.query(
      "SELECT id FROM saas_users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (accountResult.rowCount !== 1) {
      throw new Error("Authenticated user account was not found");
    }

    const account = await getAccountState(client, userId);
    const saved = [];
    let duplicates = 0;
    let blocked = false;
    let freeLeadsUsed = account.freeLeadsUsed;

    for (const lead of leads) {
      const canonicalKey = canonicalLeadKey(lead);
      if (canonicalKey.length > 1024) {
        throw invalidInput("Lead canonical identifier exceeds 1024 characters");
      }
      const source = getLeadSource(lead);
      const payload = JSON.stringify(lead);
      if (payload === undefined) throw new Error("Lead could not be serialized");
      if (Buffer.byteLength(payload, "utf8") > 64 * 1024) {
        throw invalidInput("Each lead record must be 64 KB or smaller");
      }

      const existing = await client.query(
        "SELECT 1 FROM saas_user_leads WHERE user_id = $1 AND canonical_key = $2",
        [userId, canonicalKey]
      );
      if (existing.rowCount > 0) {
        duplicates++;
        continue;
      }

      if (!account.unlimited && freeLeadsUsed >= FREE_LEAD_LIMIT) {
        blocked = true;
        break;
      }

      const leadId = crypto.randomUUID();
      const inserted = await client.query(`
        INSERT INTO saas_user_leads (id, user_id, canonical_key, source, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (user_id, canonical_key) DO NOTHING
        RETURNING id
      `, [leadId, userId, canonicalKey, source, payload]);

      if (inserted.rowCount === 0) {
        throw new Error("Lead uniqueness changed during a locked save transaction");
      }

      saved.push({ id: leadId, canonicalKey, source });
      if (!account.unlimited) {
        await client.query(`
          INSERT INTO saas_lead_usage (id, user_id, user_lead_id, canonical_key, source)
          VALUES ($1, $2, $3, $4, $5)
        `, [crypto.randomUUID(), userId, leadId, canonicalKey, source]);
        freeLeadsUsed++;
      }
    }

    await client.query("COMMIT");
    return {
      saved,
      duplicates,
      blocked,
      freeLeadsUsed: account.unlimited ? 0 : freeLeadsUsed,
      freeLeadsRemaining: account.unlimited
        ? null
        : Math.max(0, FREE_LEAD_LIMIT - freeLeadsUsed),
      hasLifetimeAccess: account.unlimited
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listUserLeads(pool, userId, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Lead list limit must be between 1 and 100");
  }
  const result = await pool.query(`
    SELECT id, canonical_key, source, payload, saved_at
    FROM saas_user_leads
    WHERE user_id = $1
    ORDER BY saved_at DESC, id
    LIMIT $2
  `, [userId, limit]);
  return result.rows;
}

module.exports = {
  AUTHORIZED_ADMIN_EMAIL,
  FREE_LEAD_LIMIT,
  canonicalLeadKey,
  getAccessSummary,
  listUserLeads,
  saveUniqueLeads
};
