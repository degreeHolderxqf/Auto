const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

process.env.DATABASE_PATH = ":memory:";
const {
  estimateStoreRevenue,
  getEstimatedTraffic,
  getPublicProducts,
  isPublicAddress,
  normalizeDomain,
  summarizeProducts
} = require("./src/services/revenueEstimator");
const { importTrancoFile, getDomainRank } = require("./src/services/domainRankService");
const { runMigrations } = require("./src/db/migrations");
const db = require("./src/db/database");

const settingsFree = {
  revenueEstimationMode: "free",
  trafficProvider: "dataforseo",
  dataForSeoLogin: "test-login",
  dataForSeoPassword: "test-password"
};

function productPage(reviewCount = 7) {
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Sample Product",
      url: "https://shop.example/products/sample-product",
      offers: { "@type": "Offer", price: "50.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
      aggregateRating: { "@type": "AggregateRating", reviewCount, ratingValue: "4.8" }
    })}</script>
  </head><body><h1>Sample Product</h1><div class="jdgm-widget"></div></body></html>`;
}

async function main() {
  assert.equal(normalizeDomain("https://www.example.com/path"), "example.com");
  assert.throws(() => normalizeDomain("http://127.0.0.1"), { code: "DOMAIN_INVALID" });
  assert.throws(() => normalizeDomain("localhost"), { code: "DOMAIN_INVALID" });
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);

  const parsedProducts = summarizeProducts({
    currencyCode: "USD",
    products: [
      { title: "Small", handle: "small", variants: [{ price: "20.00" }, { price: "24.00" }] },
      { title: "Medium", variants: [{ price: "35.00", available: true }] },
      { title: "Large", variants: [{ price: "1000.00", available: false }, { price: "50.00" }] }
    ]
  });
  assert.equal(parsedProducts.productCount, 3);
  assert.equal(parsedProducts.medianProductPrice, 35);
  assert.equal(parsedProducts.currency, "USD");
  assert.equal(parsedProducts.productRecords[0].title, "Small");

  const productResult = await getPublicProducts("example.com", {
    safeGet: async (url) => {
      assert.match(url, /^https:\/\/example\.com\/products\.json\?limit=30$/);
      return { body: JSON.stringify({ currency: "CAD", products: [{ title: "Jacket", handle: "jacket", variants: [{ price: "42.00", available: true }] }] }) };
    }
  });
  assert.equal(productResult.medianProductPrice, 42);
  assert.equal(productResult.currency, "CAD");
  assert.equal(productResult.productRecords[0].url, "https://example.com/products/jacket");

  let billableCalls = 0;
  const noProvider = await getEstimatedTraffic("example.com", {
    config: settingsFree,
    requestTraffic: async () => { billableCalls++; throw new Error("free mode must not call paid APIs"); }
  });
  assert.equal(noProvider.available, false);
  assert.equal(noProvider.statusCode, "TRAFFIC_DATA_UNAVAILABLE");
  assert.equal(billableCalls, 0);

  // Blocked products.json falls back to public product-page JSON-LD and observable review signals.
  const fallbackResult = await estimateStoreRevenue("shop.example", {
    config: settingsFree,
    safeGet: async (url) => {
      if (url.endsWith("/products.json?limit=30")) {
        throw Object.assign(new Error("HTTP 403"), { code: "PRODUCT_DATA_UNAVAILABLE" });
      }
      if (url === "https://shop.example/") {
        return {
          finalUrl: url,
          body: `<html><head><meta property="og:price:currency" content="USD"><script src="https://cdn.shopify.com/theme.js"></script><script src="https://cdn.judge.me/widget.js"></script></head><body><div id="shopify-section-header"><a href="/products/sample-product">Sample</a></div></body></html>`
        };
      }
      if (url === "https://shop.example/products/sample-product") return { finalUrl: url, body: productPage(7) };
      throw new Error(`Unexpected URL ${url}`);
    },
    getDomainRank: async () => ({ available: true, rank: 1234, source: "tranco", publication_date: "2026-10-23", dataset_key: "daily-test" }),
    now: () => new Date("2026-10-24T00:00:00.000Z")
  });
  assert.equal(fallbackResult.statusCode, "PARTIAL_DATA");
  assert.equal(fallbackResult.estimatedRevenue, null);
  assert.equal(fallbackResult.traffic, null);
  assert.equal(fallbackResult.productPriceProxy, 50);
  assert.equal(fallbackResult.currency, "USD");
  assert.equal(fallbackResult.domainRank, 1234);
  assert.equal(fallbackResult.domainRankStatus, "AVAILABLE");
  assert.equal(fallbackResult.reviewWidgetDetected, true);
  assert.ok(fallbackResult.reviewProviders.includes("Judge.me"));
  assert.equal(fallbackResult.reviewCount, 7);
  assert.equal(fallbackResult.productRecords[0].title, "Sample Product");
  assert.equal(billableCalls, 0);

  const rankUnavailable = await estimateStoreRevenue("unknown.example", {
    config: { revenueEstimationMode: "free" },
    safeGet: async (url) => url === "https://unknown.example/"
      ? { finalUrl: url, body: "<html><body>A plain brochure site.</body></html>" }
      : (() => { throw new Error("blocked"); })(),
    getDomainRank: async () => ({ available: false, status: "RANK_NOT_AVAILABLE", rank: null })
  });
  assert.equal(rankUnavailable.statusCode, "NOT_SHOPIFY");
  assert.equal(rankUnavailable.domainRankStatus, "RANK_NOT_AVAILABLE");

  const missingPrice = await estimateStoreRevenue("catalog.example", {
    config: { revenueEstimationMode: "free" },
    safeGet: async (url) => ({
      finalUrl: url,
      body: url.endsWith("/")
        ? '<html><head><script>Shopify.theme = {};</script></head><body><div class="shopify-section"></div></body></html>'
        : JSON.stringify({ products: [{ title: "No public price", variants: [] }] })
    }),
    getDomainRank: async () => ({ available: false, status: "RANK_NOT_AVAILABLE", rank: null })
  });
  assert.equal(missingPrice.statusCode, "PARTIAL_DATA");
  assert.equal(missingPrice.productCount, 1);
  assert.equal(missingPrice.productPriceProxy, null);
  assert.equal(missingPrice.estimatedRevenue, null);

  const missingCurrency = await estimateStoreRevenue("no-currency.example", {
    config: { revenueEstimationMode: "free" },
    safeGet: async (url) => ({
      finalUrl: url,
      body: url.endsWith("/") ? '<html><head><script src="https://cdn.shopify.com/theme.js"></script></head><body></body></html>' : ""
    }),
    getProducts: async () => ({
      productCount: 1,
      productPrices: [45],
      medianProductPrice: 45,
      productRecords: [{ title: "Unpriced currency", prices: [45], url: "https://no-currency.example/products/a" }],
      payload: {}
    }),
    getDomainRank: async () => ({ available: false, rank: null })
  });
  assert.equal(missingCurrency.statusCode, "PARTIAL_DATA");
  assert.equal(missingCurrency.productPriceProxy, 45);
  assert.equal(missingCurrency.currency, null);
  assert.equal(missingCurrency.estimatedRevenue, null);

  const networkFailure = await estimateStoreRevenue("timeout.example", {
    config: { revenueEstimationMode: "free" },
    safeGet: async () => { throw Object.assign(new Error("timed out"), { code: "PROVIDER_TIMEOUT" }); },
    getDomainRank: async () => ({ available: false, rank: null })
  });
  assert.equal(networkFailure.statusCode, "RETRYABLE_ERROR");
  const invalidDomain = await estimateStoreRevenue("127.0.0.1", { config: settingsFree });
  assert.equal(invalidDomain.statusCode, "DOMAIN_INVALID");

  const paidSettings = {
    revenueEstimationMode: "paid",
    trafficProvider: "dataforseo",
    dataForSeoLogin: "test-login",
    dataForSeoPassword: "test-password",
    revenueLowConversionRate: 0.005,
    revenueBaseConversionRate: 0.015,
    revenueHighConversionRate: 0.03
  };
  const estimate = await estimateStoreRevenue("paid-shop.example", {
    config: paidSettings,
    dedupe: false,
    getEstimatedTraffic: async () => ({
      available: true,
      statusCode: "SUCCESS",
      provider: "MockTraffic",
      estimatedMonthlyVisits: 10000,
      metric: "search_traffic_etv",
      period: "monthly search traffic estimate",
      limitations: ["Search-driven traffic only."]
    }),
    getProducts: async () => ({
      productCount: 3,
      productPrices: [20, 40, 60],
      productRecords: [20, 40, 60].map((price, index) => ({ title: `Product ${index}`, prices: [price], currency: "USD", url: `https://paid-shop.example/products/${index}` })),
      medianProductPrice: 40,
      lowerProductPrice: 20,
      upperProductPrice: 60,
      currency: "USD",
      payload: { currency: "USD" }
    }),
    safeGet: async (url) => ({ finalUrl: url, body: '<html><head><script src="https://cdn.shopify.com/theme.js"></script></head><body><div class="shopify-section"></div></body></html>' }),
    getDomainRank: async () => ({ available: false, rank: null }),
    now: () => new Date("2026-10-24T00:00:00.000Z")
  });
  assert.equal(estimate.statusCode, "ESTIMATED");
  assert.equal(estimate.estimatedRevenue, 6000);
  assert.deepEqual(estimate.estimatedRevenueRange, { min: 1500, base: 6000, max: 15000, isStatisticalInterval: false });
  assert.equal(estimate.estimatedAnnualRevenue, 72000);
  assert.equal(estimate.currency, "USD");
  assert.equal(estimate.aov, 40);
  assert.equal(estimate.confidence, "LOW");
  assert.match(estimate.assumptions.join(" "), /search-traffic metric, not total site visits/i);

  const noCredentials = await getEstimatedTraffic("example.com", {
    config: { revenueEstimationMode: "paid", trafficProvider: "dataforseo", dataForSeoLogin: "", dataForSeoPassword: "" },
    requestTraffic: async () => { throw new Error("must not request without credentials"); }
  });
  assert.equal(noCredentials.available, false);
  assert.equal(noCredentials.statusCode, "TRAFFIC_DATA_UNAVAILABLE");
  const mockedTraffic = await getEstimatedTraffic("paid-shop.example", {
    config: paidSettings,
    requestTraffic: async (_url, _body, requestOptions) => {
      assert.equal(requestOptions.auth.username, "test-login");
      return { data: { tasks: [{ status_code: 20000, result: [{ items: [{ target: "paid-shop.example", metrics: {
        organic: { etv: 1200.4 }, paid: { etv: 99.6 }
      } }] }] }] } };
    }
  });
  assert.equal(mockedTraffic.estimatedMonthlyVisits, 1300);
  assert.equal(mockedTraffic.metric, "search_traffic_etv");

  // One request per domain when concurrent callers ask for the same enrichment.
  let dedupedHomepageRequests = 0;
  const dedupeOptions = {
    config: { revenueEstimationMode: "free" },
    safeGet: async (url) => {
      dedupedHomepageRequests++;
      return { finalUrl: url, body: '<html><head><script src="https://cdn.shopify.com/theme.js"></script></head><body></body></html>' };
    },
    getProducts: async () => ({ productCount: 1, productPrices: [25], currency: "USD", payload: { currency: "USD" } }),
    getDomainRank: async () => ({ available: false, rank: null })
  };
  const [dedupeA, dedupeB] = await Promise.all([
    estimateStoreRevenue("dedupe.example", dedupeOptions),
    estimateStoreRevenue("dedupe.example", dedupeOptions)
  ]);
  assert.equal(dedupeA.statusCode, "PARTIAL_DATA");
  assert.equal(dedupeB.statusCode, "PARTIAL_DATA");
  assert.equal(dedupedHomepageRequests, 1);

  const { shouldRefreshRevenueEstimate } = require("./src/workflows/merchantStoreDiscovery");
  assert.equal(shouldRefreshRevenueEstimate({ status: "ESTIMATED", updated_at: new Date().toISOString() }), false);
  assert.equal(shouldRefreshRevenueEstimate({ status: "PARTIAL_DATA", updated_at: new Date().toISOString() }), false);
  assert.equal(shouldRefreshRevenueEstimate({ status: "ESTIMATED", updated_at: new Date(Date.now() - 40 * 86400000).toISOString() }), true);

  const migrationDb = new DatabaseSync(":memory:");
  runMigrations(migrationDb);
  const revenueColumns = new Set(migrationDb.prepare("PRAGMA table_info(merchant_revenue_estimates)").all().map((column) => column.name));
  assert.ok(revenueColumns.has("company_id"));
  assert.ok(revenueColumns.has("estimated_monthly_revenue"));
  assert.ok(revenueColumns.has("estimated_traffic"));
  assert.ok(revenueColumns.has("domain_rank"));
  assert.ok(revenueColumns.has("review_count"));
  assert.ok(migrationDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='domain_ranks'").get());
  assert.ok(migrationDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='merchant_review_snapshots'").get());
  const migrationCompany = migrationDb.prepare("INSERT INTO companies (name, normalized_name) VALUES (?, ?)")
    .run("Migration Fixture", "migration fixture");
  migrationDb.prepare(`
    INSERT INTO merchant_revenue_estimates (company_id, domain, estimated_monthly_revenue, status)
    VALUES (?, ?, ?, ?)
  `).run(Number(migrationCompany.lastInsertRowid), "migration.example", 321, "ESTIMATED");
  runMigrations(migrationDb);
  assert.equal(migrationDb.prepare("SELECT estimated_monthly_revenue FROM merchant_revenue_estimates WHERE company_id=?")
    .get(Number(migrationCompany.lastInsertRowid)).estimated_monthly_revenue, 321, "rerunning additive migrations retains existing estimates");
  migrationDb.close();

  const rankFile = path.join(os.tmpdir(), `tranco-fixture-${process.pid}.csv`);
  fs.writeFileSync(rankFile, "1,shop.example\n2,other.example\n");
  const firstImport = await importTrancoFile({ filePath: rankFile, publicationDate: "2026-10-23", listId: "fixture-list" });
  assert.equal(firstImport.rowCount, 2);
  assert.equal(getDomainRank("www.shop.example").rank, 1);
  fs.writeFileSync(rankFile, "3,shop.example\n4,new.example\n");
  await importTrancoFile({ filePath: rankFile, publicationDate: "2026-10-24", listId: "fixture-list" });
  assert.equal(db.getDomainRank("shop.example").rank, 3);
  assert.equal(db.getDomainRank("shop.example").publication_date, "2026-10-24");
  assert.equal(db.getRawDb().prepare("SELECT count(*) AS count FROM domain_rank_datasets WHERE source='tranco'").get().count, 1);
  fs.unlinkSync(rankFile);

  const company = db.upsertCompany({
    name: "Revenue Estimate Fixture",
    normalized_name: "revenue estimate fixture",
    domain: "shop.example",
    source: "MERCHANT_UPLOAD"
  });
  const saved = db.upsertMerchantRevenueEstimate({
    company_id: company.id,
    domain: "shop.example",
    status: "estimated",
    statusCode: "ESTIMATED",
    estimatedRevenue: 6000,
    estimatedRevenueRange: { min: 1000, max: 18000 },
    estimatedAnnualRevenue: 72000,
    currency: "USD",
    aov: 40,
    conversionRate: 0.015,
    traffic: 10000,
    dataSources: ["DataForSEO", "public_products_json"],
    assumptions: ["search traffic scenario"],
    productCount: 3,
    productPriceProxy: 40,
    productPriceMin: 20,
    productPriceMax: 60,
    productPriceP25: 30,
    productPriceP75: 50,
    productSamples: 3,
    productRecords: [{ title: "Product", prices: [40], currency: "USD", url: "https://shop.example/products/item", availability: "in_stock" }],
    domainRank: 3,
    domainRankStatus: "AVAILABLE",
    domainRankSource: "tranco",
    domainRankPublicationDate: "2026-10-24",
    shopifyStatus: "SHOPIFY",
    shopifyConfidence: "HIGH",
    shopifySignals: ["shopify_cdn"],
    reviewWidgetDetected: true,
    reviewProviders: ["Judge.me"],
    reviewCount: 7,
    reviewCountSource: "public_product_structured_data",
    reviewCountSourceUrl: "https://shop.example/products/item",
    reviewCountObservedAt: "2026-10-24T00:00:00.000Z",
    timestamp: "2026-10-24T00:00:00.000Z"
  });
  assert.equal(saved.estimated_monthly_revenue, 6000);
  assert.equal(saved.status, "ESTIMATED");
  assert.equal(saved.review_count_previous, null);

  const partial = db.upsertMerchantRevenueEstimate({
    company_id: company.id,
    domain: "shop.example",
    status: "partial_data",
    statusCode: "PARTIAL_DATA",
    estimatedRevenue: null,
    currency: null,
    aov: null,
    traffic: null,
    domainRank: 3,
    domainRankStatus: "AVAILABLE",
    productCount: 3,
    productPriceProxy: 42,
    productSamples: 2,
    shopifyStatus: "SHOPIFY",
    reviewWidgetDetected: true,
    reviewProviders: ["Judge.me"],
    reviewCount: 9,
    reviewCountSource: "public_product_structured_data",
    reviewCountObservedAt: "2026-10-25T00:00:00.000Z",
    timestamp: "2026-10-25T00:00:00.000Z"
  });
  assert.equal(partial.estimated_monthly_revenue, 6000, "a partial refresh preserves the last valid estimate");
  assert.equal(partial.currency, "USD");
  assert.equal(partial.store_currency, "USD");
  assert.equal(partial.status, "PARTIAL_DATA");
  assert.equal(partial.estimate_updated_at, "2026-10-24T00:00:00.000Z");
  assert.equal(partial.product_price_proxy, 42, "new product signals remain separately current");
  assert.equal(partial.review_count_previous, 7);
  assert.equal(partial.review_count_change, 2);
  assert.equal(db.getRawDb().prepare("SELECT count(*) AS count FROM merchant_review_snapshots WHERE company_id=?").get(company.id).count, 2);

  const joinedCompany = db.getAllCompaniesWithRevenue({ source: "MERCHANT_UPLOAD" }).find((row) => row.id === company.id);
  assert.equal(joinedCompany.estimated_monthly_revenue, 6000);
  assert.equal(joinedCompany.revenue_currency, "USD");
  assert.equal(joinedCompany.revenue_estimation_status, "PARTIAL_DATA");
  assert.equal(joinedCompany.domain_rank, 3);
  assert.equal(joinedCompany.review_count_change, 2);
  assert.equal(joinedCompany.revenue_product_records.length, 1);

  // Exercise manual refresh without saved Shopify verification, using an invalid local domain to avoid network access.
  const manualCompany = db.upsertCompany({
    name: "Manual Revenue Refresh Fixture",
    normalized_name: "manual revenue refresh fixture",
    domain: "127.0.0.1",
    source: "MERCHANT_UPLOAD"
  });
  require("./src/services/merchantIngestion").saveMerchantDetails(manualCompany.id, {
    website_url: "https://127.0.0.1",
    installed_apps: [],
    tech_stack: [],
    estimated_revenue: "not public",
    store_description: "",
    product_count: null,
    public_contact_links: {}
  });
  const handler = require("./src/server.cjs");
  let responseBody = "";
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body) { responseBody = String(body || ""); }
  };
  await handler({
    url: `/api/companies/${manualCompany.id}/revenue-estimate`,
    method: "POST",
    headers: { host: "localhost" },
    on() {}
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(responseBody).estimate.status, "DOMAIN_INVALID");

  responseBody = "";
  response.statusCode = 200;
  await handler({ url: "/api/companies", method: "GET", headers: { host: "localhost" }, on() {} }, response);
  const apiCompany = JSON.parse(responseBody).companies.find((entry) => entry.id === company.id);
  assert.equal(apiCompany.estimated_revenue, "$6,000");
  assert.equal(apiCompany.revenue_estimation_status, "PARTIAL_DATA");
  assert.equal(apiCompany.estimated_monthly_revenue, 6000);
  assert.equal(apiCompany.revenue_estimate_updated_at, "2026-10-24T00:00:00.000Z");

  db.getRawDb().close();

  console.log("Revenue estimator checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
