const assert = require("node:assert/strict");

process.env.DATABASE_PATH = ":memory:";

const db = require("./src/db/database");
const { estimateStoreRevenue } = require("./src/services/revenueEstimator");

async function main() {
  const estimate = await estimateStoreRevenue("indian-store.example.com", {
    dedupe: false,
    getProducts: async () => ({
      productCount: 3,
      variantPrices: [8999, 15999, 24999],
      productRecords: [
        { title: "Small", prices: [8999], currency: null },
        { title: "Medium", prices: [15999], currency: null },
        { title: "Large", prices: [24999], currency: null }
      ],
      payload: {}
    }),
    safeGet: async (url) => {
      if (url === "https://indian-store.example.com/") {
        return { body: "<html><body>Indian Shopify store</body></html>" };
      }
      if (url === "https://indian-store.example.com/cart.js") {
        return { body: JSON.stringify({ currency: "INR", items: [] }) };
      }
      throw new Error(`Unexpected URL ${url}`);
    },
    getDomainRank: async () => ({ available: true, rank: 1234 }),
    inspectStorefront: async () => ({ shopify: true, reviewProviders: [], reviewCount: null }),
    now: () => new Date("2026-10-24T00:00:00.000Z")
  });

  assert.equal(estimate.statusCode, "ESTIMATED");
  assert.equal(estimate.currency, "USD");
  assert.equal(estimate.storeCurrency, "INR");
  assert.ok(Math.abs(estimate.aov - 15999 / 84) < 1e-10);

  const company = db.upsertCompany({
    name: "Indian Merchant Currency Fixture",
    normalized_name: "indian merchant currency fixture",
    domain: "indian-store.example.com",
    source: "MERCHANT_UPLOAD",
    app_relevance_score: 100,
    status: "DISCOVERED"
  });
  db.upsertContact({
    company_id: company.id,
    email: "currency-fixture@example.com",
    confidence: "HIGH",
    email_type: "Business",
    verified: 1,
    mx_valid: 1
  });
  db.upsertMerchantRevenueEstimate({
    ...estimate,
    company_id: company.id,
    domain: "indian-store.example.com"
  });

  const apiServer = require("./src/server").startServer(0);
  if (!apiServer.address()) {
    await new Promise((resolve) => apiServer.once("listening", resolve));
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${apiServer.address().port}/api/leads?search=Indian%20Merchant%20Currency%20Fixture`
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    const lead = data.leads[0];
    assert.equal(lead.revenue_currency, "INR");
    assert.equal(lead.store_currency, "INR");

    const expectedRupees = 15999 * estimate.traffic * 0.015;
    assert.ok(Math.abs(lead.estimated_monthly_revenue - expectedRupees) < 1e-8);
    assert.equal(lead.estimated_monthly_revenue_min, estimate.estimatedRevenueRange.min * 84);
    assert.equal(lead.estimated_monthly_revenue_max, estimate.estimatedRevenueRange.max * 84);

    const companiesResponse = await fetch(
      `http://127.0.0.1:${apiServer.address().port}/api/companies?search=Indian%20Merchant%20Currency%20Fixture`
    );
    const companiesData = await companiesResponse.json();
    const apiCompany = companiesData.companies[0];
    assert.equal(apiCompany.revenue_currency, "INR");
    assert.match(apiCompany.estimated_revenue, /^₹/);

    const serverlessHandler = require("./src/server.cjs");
    const serverlessResponse = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      writeHead(statusCode) { this.statusCode = statusCode; },
      end(body) { this.body = String(body || ""); }
    };
    await serverlessHandler({
      url: "/api/leads?search=Indian%20Merchant%20Currency%20Fixture",
      method: "GET",
      headers: { host: "localhost" },
      on() {}
    }, serverlessResponse);
    const serverlessLead = JSON.parse(serverlessResponse.body).leads[0];
    assert.equal(serverlessLead.revenue_currency, "INR");
    assert.ok(Math.abs(serverlessLead.estimated_monthly_revenue - expectedRupees) < 1e-8);

    const formatted = new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: lead.revenue_currency,
      maximumFractionDigits: 0
    }).format(lead.estimated_monthly_revenue);
    assert.match(formatted, /^₹/);
    console.log(`Currency check passed: ${formatted}/mo`);
  } finally {
    await new Promise((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
    db.getRawDb().close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
