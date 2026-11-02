const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalLeadKey,
  FREE_LEAD_LIMIT,
  saveUniqueLeads
} = require("../src/services/saasAccessService");

function makeFakePool({ grandfathered = false } = {}) {
  const state = { leads: new Map(), usage: new Set() };
  const userId = "00000000-0000-4000-8000-000000000001";
  const launchAt = new Date("2026-11-02T12:00:00.000Z");
  const registeredAt = grandfathered
    ? new Date(launchAt.getTime() - 1000)
    : new Date(launchAt.getTime() + 1000);

  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rowCount: 0, rows: [] };
      if (statement.startsWith("SELECT id FROM saas_users WHERE id")) {
        return { rowCount: params[0] === userId ? 1 : 0, rows: [{ id: userId }] };
      }
      if (statement.includes("FROM saas_users u CROSS JOIN saas_bootstrap_state b")) {
        return {
          rowCount: 1,
          rows: [{
            id: userId,
            email_normalized: "user@example.com",
            role: "USER",
            registered_at: registeredAt,
            disabled_at: null,
            admin_user_id: null,
            payment_launch_at: launchAt,
            has_lifetime_entitlement: false,
            free_leads_used: state.usage.size
          }]
        };
      }
      if (statement.startsWith("SELECT 1 FROM saas_user_leads")) {
        const key = `${params[0]}:${params[1]}`;
        return { rowCount: state.leads.has(key) ? 1 : 0, rows: [] };
      }
      if (statement.startsWith("INSERT INTO saas_user_leads")) {
        const [, ownerId, canonicalKey, source] = params;
        const key = `${ownerId}:${canonicalKey}`;
        if (state.leads.has(key)) return { rowCount: 0, rows: [] };
        state.leads.set(key, { source });
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      if (statement.startsWith("INSERT INTO saas_lead_usage")) {
        state.usage.add(`${params[1]}:${params[3]}`);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in SaaS access test: ${statement}`);
    },
    release() {}
  };

  return {
    userId,
    state,
    pool: { async connect() { return client; } }
  };
}

test("canonicalizes website identities independently of URL path and tracking parameters", () => {
  assert.equal(
    canonicalLeadKey({ website: "https://www.Example.com/contact?source=campaign" }),
    "host:example.com"
  );
  assert.equal(
    canonicalLeadKey({ website_url: "example.com/about" }),
    "host:example.com"
  );
});

test("falls back to stable Shopify identifiers when no website is available", () => {
  assert.equal(canonicalLeadKey({ app_store_slug: "Example-App" }), "shopify-app:example-app");
  assert.equal(
    canonicalLeadKey({ app_store_url: "https://apps.shopify.com/example-app?utm_source=test" }),
    "url:apps.shopify.com/example-app"
  );
  assert.throws(() => canonicalLeadKey({ name: "No stable identifier" }), /stable website/);
});

test("keeps the approved free unique-lead limit at five", () => {
  assert.equal(FREE_LEAD_LIMIT, 5);
});

test("saves only five unique leads for a free account and treats duplicates as quota-free", async () => {
  const { pool, userId, state } = makeFakePool();
  const leads = Array.from({ length: 6 }, (_, index) => ({
    name: `Company ${index}`,
    website: `https://company-${index}.example`
  }));

  const result = await saveUniqueLeads(pool, userId, leads);
  assert.equal(result.saved.length, 5);
  assert.equal(result.blocked, true);
  assert.equal(result.freeLeadsUsed, 5);
  assert.equal(result.freeLeadsRemaining, 0);
  assert.equal(state.leads.size, 5);

  const duplicateOnly = await saveUniqueLeads(pool, userId, [leads[0]]);
  assert.equal(duplicateOnly.duplicates, 1);
  assert.equal(duplicateOnly.blocked, false);
  assert.equal(duplicateOnly.freeLeadsUsed, 5);
});

test("grandfathered accounts retain unlimited saves without consuming free quota", async () => {
  const { pool, userId, state } = makeFakePool({ grandfathered: true });
  const leads = Array.from({ length: 6 }, (_, index) => ({
    name: `Company ${index}`,
    website: `https://legacy-${index}.example`
  }));

  const result = await saveUniqueLeads(pool, userId, leads);
  assert.equal(result.saved.length, 6);
  assert.equal(result.blocked, false);
  assert.equal(result.hasLifetimeAccess, true);
  assert.equal(state.usage.size, 0);
});
