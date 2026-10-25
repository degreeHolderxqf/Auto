const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");
const { URL } = require("node:url");
const { inspectStorefront } = require("./storefrontSignals");
const domainRankService = require("./domainRankService");

const REQUEST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const inFlightEstimates = new Map();
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;
const USD_PER_CURRENCY = Object.freeze({
  USD: 1,
  INR: 1 / 84,
  PKR: 1 / 278,
  GBP: 1.25,
  AUD: 0.65,
  CAD: 0.73,
  EUR: 1.08,
  CHF: 1.08
});

function normalizeDomain(input) {
  const raw = String(input || "").trim();
  if (!raw) throw Object.assign(new Error("A store domain is required."), { code: "DOMAIN_INVALID" });

  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw Object.assign(new Error("The store domain is invalid."), { code: "DOMAIN_INVALID" });
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== "443") || !parsed.hostname) {
    throw Object.assign(new Error("Only public HTTPS store domains are supported."), { code: "DOMAIN_INVALID" });
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw Object.assign(new Error("The store domain must be a public DNS name."), { code: "DOMAIN_INVALID" });
  }
  if (net.isIP(hostname.replace(/^\[|\]$/g, ""))) {
    throw Object.assign(new Error("IP-address URLs are not accepted as store domains."), { code: "DOMAIN_INVALID" });
  }
  return hostname;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0 || b === 2)) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0 && octets[2] === 113) return false;
    return true;
  }
  if (family === 6) {
    const lower = address.toLowerCase().split("%")[0];
    const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPublicAddress(mapped[1]);
    // Allow global unicast (2000::/3) and reject the documentation range.
    return /^[23]/.test(lower) && !lower.startsWith("2001:db8:");
  }
  return false;
}

async function resolvePublicAddress(hostname, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("Store request timed out."), { code: "PROVIDER_TIMEOUT" });

  let timer;
  let records;
  try {
    records = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Store DNS lookup timed out."), { code: "PROVIDER_TIMEOUT" })), remaining);
        if (typeof timer.unref === "function") timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
    throw Object.assign(new Error("The store domain did not resolve exclusively to public IP addresses."), { code: "DOMAIN_INVALID" });
  }
  return records;
}

function safeGet(urlString, deadline, redirectCount = 0) {
  return new Promise(async (resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
        throw Object.assign(new Error("Only public HTTPS URLs are allowed."), { code: "DOMAIN_INVALID" });
      }
      const records = await resolvePublicAddress(parsed.hostname, deadline);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Object.assign(new Error("Store request timed out."), { code: "PROVIDER_TIMEOUT" });

      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const request = https.request(parsed, {
        method: "GET",
        headers: {
          Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
          "User-Agent": "ShopifyStoreRevenueEstimator/1.0"
        },
        lookup: (_hostname, options, callback) => {
          if (typeof options === "function") callback = options;
          if (options && options.all) callback(null, records);
          else callback(null, records[0].address, records[0].family);
        },
        servername: parsed.hostname
      }, (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            finish(reject, Object.assign(new Error("Store redirected too many times."), { code: "TOO_MANY_REDIRECTS" }));
            return;
          }
          let nextUrl;
          try {
            nextUrl = new URL(location, parsed).toString();
          } catch {
            finish(reject, Object.assign(new Error("Store returned an invalid redirect."), { code: "UNSAFE_REDIRECT" }));
            return;
          }
          safeGet(nextUrl, deadline, redirectCount + 1).then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error)
          );
          return;
        }

        const declaredLength = Number.parseInt(response.headers["content-length"], 10);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(reject, Object.assign(new Error("Store response exceeded the size limit."), { code: "RESPONSE_TOO_LARGE" }));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(Object.assign(new Error("Store response exceeded the size limit."), { code: "RESPONSE_TOO_LARGE" }));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (statusCode < 200 || statusCode >= 300) {
            finish(reject, Object.assign(new Error(`Store returned HTTP ${statusCode}.`), {
              code: statusCode === 429 ? "PRODUCT_SOURCE_RATE_LIMITED" : "PRODUCT_DATA_UNAVAILABLE",
              statusCode
            }));
            return;
          }
          finish(resolve, { body: Buffer.concat(chunks).toString("utf8"), finalUrl: parsed.toString() });
        });
        response.on("error", (error) => finish(reject, error));
      });

      request.setTimeout(remaining, () => {
        request.destroy(Object.assign(new Error("Store request timed out."), { code: "PROVIDER_TIMEOUT" }));
      });
      request.on("error", (error) => finish(reject, error));
      request.end();
    } catch (error) {
      reject(error);
    }
  });
}

function normalizeCurrency(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!CURRENCY_CODE_RE.test(code)) return null;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return code;
  } catch {
    return null;
  }
}

function formatRevenueValue(value, currency) {
  const amount = Number(value);
  const code = normalizeCurrency(currency);
  if (!Number.isFinite(amount) || !code) return null;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0
    }).format(amount);
  } catch {
    return `${Math.round(amount)} ${code}`;
  }
}

function convertCurrencyAmount(value, fromCurrency, toCurrency) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  if (!Number.isFinite(amount) || !from || !to) return null;
  if (from === to) return amount;
  if (!USD_PER_CURRENCY[from] || !USD_PER_CURRENCY[to]) return null;
  return amount * USD_PER_CURRENCY[from] / USD_PER_CURRENCY[to];
}

function convertRevenueToStoreCurrency(estimate) {
  const from = normalizeCurrency(estimate && estimate.revenue_currency);
  const to = normalizeCurrency(estimate && estimate.store_currency);
  if (!from || !to || from === to) return estimate;

  const fields = [
    "estimated_monthly_revenue",
    "estimated_monthly_revenue_min",
    "estimated_monthly_revenue_max",
    "estimated_annual_revenue",
    "estimated_annual_revenue_min",
    "estimated_annual_revenue_max",
    "estimated_aov",
    "product_price_proxy",
    "product_price_min",
    "product_price_max",
    "product_price_p25",
    "product_price_p75"
  ];
  const converted = {};
  for (const field of fields) {
    if (estimate[field] === null || estimate[field] === undefined) continue;
    const amount = convertCurrencyAmount(estimate[field], from, to);
    if (amount === null) return estimate;
    converted[field] = amount;
  }
  if (!Object.keys(converted).length) return estimate;
  return { ...estimate, ...converted, revenue_currency: to };
}

function findCurrency(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return null;
  for (const [key, child] of Object.entries(value)) {
    if (["currencycode", "pricecurrency", "presentmentcurrencycode", "currency"].includes(key.toLowerCase())) {
      if (typeof child === "string") {
        const currency = normalizeCurrency(child);
        if (currency) return currency;
      }
      if (child && typeof child === "object") {
        for (const nestedKey of ["active", "activeCurrency", "code", "currencyCode", "iso_code"]) {
          const currency = normalizeCurrency(child[nestedKey]);
          if (currency) return currency;
        }
      }
    }
    const nested = findCurrency(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function extractCurrencyFromHtml(html) {
  const text = String(html || "");
  const shopifyCurrency = text.match(/Shopify\.currency\s*=\s*\{[\s\S]{0,300}?\bactive\s*:\s*["']([A-Z]{3})["']/i);
  const shopifyCurrencyCode = normalizeCurrency(shopifyCurrency && shopifyCurrency[1]);
  if (shopifyCurrencyCode) return shopifyCurrencyCode;
  const patterns = [
    /(?:Shopify\.currency\.active|currencyCode|priceCurrency|currency_code)\s*["']?\s*[:=]\s*["']([A-Z]{3})["']/i,
    /["'](?:og:price:currency|product:price:currency)["'][^>]*content=["']([A-Z]{3})["']/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const currency = normalizeCurrency(match && match[1]);
    if (currency) return currency;
  }
  return null;
}

function parsePrice(value) {
  const raw = typeof value === "object" && value !== null ? value.amount : value;
  if (raw === null || raw === undefined || raw === "") return null;
  const normalized = String(raw).replace(/[^0-9.-]/g, "").trim();
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function currencyFromDomain(domain) {
  const hostname = String(domain || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0]
    .replace(/^www\./, "").replace(/\.$/, "");
  if (hostname.endsWith(".co.in") || hostname.endsWith(".in")) return "INR";
  if (hostname.endsWith(".com.pk") || hostname.endsWith(".pk")) return "PKR";
  if (hostname.endsWith(".co.uk") || hostname.endsWith(".uk")) return "GBP";
  if (hostname.endsWith(".com.au") || hostname.endsWith(".au")) return "AUD";
  if (hostname.endsWith(".ca")) return "CAD";
  if ([".it", ".de", ".fr", ".es", ".eu"].some((suffix) => hostname.endsWith(suffix))) return "EUR";
  if (hostname.endsWith(".ch")) return "CHF";
  return null;
}

function normalizeAovToUsd(amount, domain, currency) {
  const code = normalizeCurrency(currency) || currencyFromDomain(domain);
  if (code && USD_PER_CURRENCY[code]) return amount * USD_PER_CURRENCY[code];
  return amount;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarizeProducts(payload) {
  const products = Array.isArray(payload) ? payload : payload && payload.products;
  if (!Array.isArray(products) || products.length === 0) {
    throw Object.assign(new Error("The public product endpoint returned no products."), { code: "PRODUCT_DATA_UNAVAILABLE" });
  }
  const productRecords = products.slice(0, 30).map((product) => {
    const variants = Array.isArray(product && product.variants) ? product.variants : [];
    const availablePrices = variants.filter((variant) => variant && variant.available !== false)
      .map((variant) => parsePrice(variant && variant.price)).filter(Number.isFinite);
    const allPrices = variants.map((variant) => parsePrice(variant && variant.price)).filter(Number.isFinite);
    const prices = allPrices;
    const fallbackPrice = parsePrice(product && product.price);
    if (!prices.length && fallbackPrice) prices.push(fallbackPrice);
    const url = product && (product.url || product.handle) ? String(product.url || `/products/${product.handle}`) : null;
    return {
      title: product && product.title ? String(product.title) : null,
      productType: product && (product.product_type || product.productType) ? String(product.product_type || product.productType) : null,
      prices,
      availablePrices,
      currency: findCurrency(product),
      url,
      availability: product && product.available === true ? "in_stock" : product && product.available === false ? "out_of_stock" : null
    };
  });
  const variantPrices = productRecords.flatMap((product) => product.prices).filter(Number.isFinite);
  const productPrices = productRecords.map((product) => median(product.availablePrices.length ? product.availablePrices : product.prices)).filter(Number.isFinite);
  return {
    productCount: products.length,
    productRecords,
    variantPrices,
    productPrices,
    medianProductPrice: median(variantPrices),
    lowerProductPrice: percentile(productPrices, 0.25),
    upperProductPrice: percentile(productPrices, 0.75),
    currency: findCurrency(payload)
  };
}

async function getPublicProducts(domain, options = {}) {
  const deadline = options.deadline || Date.now() + (options.timeoutMs || REQUEST_TIMEOUT_MS);
  const request = options.safeGet || safeGet;
  const response = await request(`https://${domain}/products.json?limit=30`, deadline);
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw Object.assign(new Error("The public product endpoint did not return valid JSON."), { code: "PRODUCT_DATA_INVALID" });
  }
  const summary = summarizeProducts(payload);
  for (const product of summary.productRecords) {
    if (product.url && !/^https?:\/\//i.test(product.url)) {
      product.url = new URL(product.url.startsWith("/") ? product.url : `/products/${product.url}`, `https://${domain}`).toString();
    }
  }
  return { ...summary, productSamples: summary.productPrices.length, payload };
}

async function getStoreCurrency(domain, productPayload, options = {}) {
  const fromProducts = findCurrency(productPayload);
  if (fromProducts) return fromProducts;
  const fromHomepage = extractCurrencyFromHtml(options.homepageHtml);
  if (fromHomepage) return fromHomepage;
  if (typeof options.fetchCurrency === "function") return normalizeCurrency(await options.fetchCurrency(domain));

  const deadline = options.deadline || Date.now() + (options.timeoutMs || REQUEST_TIMEOUT_MS);
  if (deadline - Date.now() <= 0) return null;
  try {
    const response = await (options.safeGet || safeGet)(`https://${domain}/cart.js`, deadline);
    const payload = JSON.parse(response.body);
    const currency = findCurrency(payload);
    if (currency) return currency;
  } catch {
    // Non-Shopify stores can still expose currency in homepage markup.
  }
  if (options.homepageHtml || deadline - Date.now() <= 0) return null;
  try {
    const response = await (options.safeGet || safeGet)(`https://${domain}/`, deadline);
    return extractCurrencyFromHtml(response.body);
  } catch {
    return null;
  }
}

function trafficFromDomainRank(rankResult) {
  return domainRankService.trafficEstimateFromRank(rankResult);
}

async function getEstimatedTraffic(domain, options = {}) {
  let rankResult = null;
  try {
    rankResult = await (options.getDomainRank || domainRankService.getDomainRank)(domain);
  } catch {
    // A failed local lookup follows the same fixed baseline as an unranked domain.
  }
  return {
    available: true,
    statusCode: "SUCCESS",
    provider: "Local Tranco Rank Proxy",
    estimatedMonthlyVisits: trafficFromDomainRank(rankResult),
    rank: rankResult && rankResult.available ? rankResult.rank : null,
    period: "monthly proxy estimate",
    metric: "Tranco rank bucket proxy",
    confidence: "LOW"
  };
}

function getFreeTrafficEstimate(domain, options = {}) {
  return getEstimatedTraffic(domain, options).then((result) => result.estimatedMonthlyVisits);
}

function homepageReviewSignal(html) {
  const text = String(html || "");
  const patterns = [
    ["Judge.me", /judge\.me|judgeme/i],
    ["Loox", /loox/i],
    ["Yotpo", /yotpo/i],
    ["Stamped", /stamped\.io/i],
    ["Reviews", /reviews/i]
  ];
  const providers = patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return { detected: providers.length > 0, providers };
}

function makeSuccessEstimate(domain, timestamp, metrics = {}, extras = {}) {
  const trafficValue = Number(metrics.traffic);
  const traffic = Number.isFinite(trafficValue) && trafficValue >= 0 ? Math.round(trafficValue) : 1500;
  const aovValue = Number(metrics.aov);
  const aov = Number.isFinite(aovValue) && aovValue > 0 ? aovValue : 40;
  const conversionValue = Number(metrics.conversionRate);
  const conversionRate = Number.isFinite(conversionValue) && conversionValue > 0 && conversionValue < 1
    ? conversionValue
    : 0.015;
  const estimatedRevenue = traffic * aov * conversionRate;
  const estimatedRevenueMin = Math.round(estimatedRevenue * 0.8);
  const estimatedRevenueMax = Math.round(estimatedRevenue * 1.2);
  const annualRevenue = estimatedRevenue * 12;
  const annualRevenueMin = estimatedRevenueMin * 12;
  const annualRevenueMax = estimatedRevenueMax * 12;

  return {
    ...extras,
    status: "success",
    statusCode: "ESTIMATED",
    domain: domain || null,
    estimated_monthly_revenue: estimatedRevenue,
    estimated_monthly_revenue_min: estimatedRevenueMin,
    estimated_monthly_revenue_max: estimatedRevenueMax,
    estimated_traffic: traffic,
    estimatedRevenue,
    estimatedRevenueRange: {
      min: estimatedRevenueMin,
      base: estimatedRevenue,
      max: estimatedRevenueMax,
      isStatisticalInterval: false
    },
    estimatedAnnualRevenue: annualRevenue,
    estimatedAnnualRevenueRange: {
      min: annualRevenueMin,
      base: annualRevenue,
      max: annualRevenueMax,
      isStatisticalInterval: false
    },
    aov,
    aovMethod: metrics.aovMethod || "median_public_shopify_variant_price_proxy",
    conversion_rate: conversionRate,
    conversionRate,
    conversionRateScenarios: { low: conversionRate, base: conversionRate, high: conversionRate },
    traffic,
    trafficProvider: "Local Tranco Rank Proxy",
    trafficMetric: "Tranco rank bucket proxy",
    trafficPeriod: "monthly",
    currency: metrics.currency || "USD",
    storeCurrency: metrics.storeCurrency || metrics.currency || "USD",
    method: "Zero-Cost Proxy Model",
    confidence: "Low-Medium",
    reason: null,
    timestamp
  };
}

async function estimateStoreRevenueInternal(domainInput, options = {}) {
  let timestamp;
  try {
    timestamp = (options.now || (() => new Date()))().toISOString();
  } catch {
    timestamp = new Date().toISOString();
  }

  let domain = null;
  try {
    domain = normalizeDomain(domainInput);
  } catch {
    // Invalid inputs use only local fallback values; they are never requested over HTTPS.
  }

  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const safeRequest = options.safeGet || safeGet;
  const productsGetter = options.getProducts || getPublicProducts;
  const rankGetter = options.getDomainRank || domainRankService.getDomainRank;
  const requestTasks = [
    domain ? Promise.resolve().then(() => rankGetter(domain)) : Promise.resolve(null),
    domain
      ? Promise.resolve().then(() => safeRequest("https://" + domain + "/", deadline))
      : Promise.reject(new Error("Invalid store domain.")),
    domain
      ? Promise.resolve().then(() => productsGetter(domain, { deadline, safeGet: safeRequest }))
      : Promise.reject(new Error("Invalid store domain."))
  ];
  const [rankResult, homepageResult, productsResult] = await Promise.allSettled(requestTasks);

  const rank = rankResult.status === "fulfilled" ? rankResult.value : null;
  const traffic = trafficFromDomainRank(rank);
  const homepage = homepageResult.status === "fulfilled" ? homepageResult.value : null;
  const html = homepage && homepage.body ? String(homepage.body) : "";
  const reviewSignal = homepageReviewSignal(html);
  const conversionRate = reviewSignal.detected ? 0.025 : 0.015;

  let products = null;
  if (productsResult.status === "fulfilled") {
    const value = productsResult.value;
    try {
      if (value && Array.isArray(value.variantPrices)) {
        products = value;
      } else if (value && Array.isArray(value.productRecords)) {
        const variantPrices = value.productRecords.flatMap((product) => Array.isArray(product.prices) ? product.prices : [])
          .map(parsePrice).filter(Number.isFinite);
        products = { ...value, variantPrices };
      } else {
        products = summarizeProducts(value && value.payload ? value.payload : value);
      }
    } catch {
      products = null;
    }
  }

  const variantPrices = products && Array.isArray(products.variantPrices)
    ? products.variantPrices.map(parsePrice).filter(Number.isFinite)
    : [];
  const rawAov = median(variantPrices);
  const productRecords = products && Array.isArray(products.productRecords) ? products.productRecords : [];
  const productCurrency = normalizeCurrency(products && products.currency) ||
    productRecords.map((product) => normalizeCurrency(product.currency)).find(Boolean) ||
    null;
  const storeCurrency = productCurrency || await getStoreCurrency(
    domain,
    products && products.payload ? products.payload : products,
    { deadline, safeGet: safeRequest, homepageHtml: html }
  ) || currencyFromDomain(domain);
  // The conservative fallback is already denominated in USD. Use the
  // storefront currency before falling back to a country-code TLD proxy.
  const aov = rawAov === null ? 40 : normalizeAovToUsd(rawAov, domain, storeCurrency);
  const revenueCurrency = rawAov === null || (storeCurrency && USD_PER_CURRENCY[storeCurrency])
    ? "USD"
    : storeCurrency || "USD";
  const priceValues = variantPrices.length ? variantPrices : (products && Array.isArray(products.productPrices) ? products.productPrices : []);
  const normalizedPriceValues = priceValues
    .map(parsePrice)
    .filter(Number.isFinite)
    .map((price) => normalizeAovToUsd(price, domain, storeCurrency));

  let storefront = null;
  if (domain) {
    try {
      storefront = await (options.inspectStorefront || inspectStorefront)(domain, {
        safeGet: safeRequest,
        deadline,
        homepage,
        productFeed: products
      });
    } catch {
      storefront = null;
    }
  }

  const detectedShopify = Boolean(products) || Boolean(storefront && storefront.shopify);
  const storefrontProviders = storefront && Array.isArray(storefront.reviewProviders) ? storefront.reviewProviders : [];
  const reviewProviders = [...new Set([...reviewSignal.providers, ...storefrontProviders])];
  const shopifySignals = [...new Set([
    ...(storefront && Array.isArray(storefront.shopifySignals) ? storefront.shopifySignals : []),
    ...(products ? ["public_shopify_product_feed"] : [])
  ])];
  const sources = [
    ...(products ? ["Shopify /products.json?limit=30"] : []),
    ...(homepage ? ["Store homepage HTML review footprint"] : []),
    "Local Tranco rank bucket traffic proxy"
  ];
  if (rank && rank.available) sources.push(rank.source || "Local Tranco rank dataset");

  const extras = {
    productCount: products && Number.isFinite(Number(products.productCount)) ? Number(products.productCount) : productRecords.length || null,
    productPriceProxy: aov,
    productPriceMin: normalizedPriceValues.length ? Math.min(...normalizedPriceValues) : null,
    productPriceMax: normalizedPriceValues.length ? Math.max(...normalizedPriceValues) : null,
    productPriceP25: percentile(normalizedPriceValues, 0.25),
    productPriceP75: percentile(normalizedPriceValues, 0.75),
    productSamples: variantPrices.length,
    productRecords,
    domainRank: rank && rank.available ? rank.rank : null,
    domainRankStatus: rank && rank.available ? "AVAILABLE" : "RANK_NOT_AVAILABLE",
    domainRankSource: rank && rank.source || null,
    domainRankPublicationDate: rank && rank.publication_date || null,
    domainRankDatasetKey: rank && rank.dataset_key || null,
    shopifyStatus: detectedShopify ? "SHOPIFY" : "UNKNOWN",
    shopifyConfidence: detectedShopify ? "LOW" : "NONE",
    shopifySignals,
    reviewWidgetDetected: reviewSignal.detected,
    reviewProviders,
    reviewCount: storefront && Number.isInteger(storefront.reviewCount) ? storefront.reviewCount : null,
    reviewCountStatus: storefront && Number.isInteger(storefront.reviewCount) ? "AVAILABLE" : "REVIEW_COUNT_NOT_AVAILABLE",
    reviewCountSource: storefront && storefront.reviewCountSource || null,
    reviewCountSourceUrl: storefront && storefront.reviewCountSourceUrl || null,
    reviewCountObservedAt: storefront && Number.isInteger(storefront.reviewCount) ? timestamp : null,
    latestDataSources: [...new Set(sources)],
    dataSources: [...new Set(sources)],
    latestAssumptions: [
      "Traffic is a fixed Tranco-rank bucket proxy and is not measured site traffic.",
      "AOV is the median public variant price normalized to USD using a fixed exchange-rate proxy for the detected store currency; the $40 fallback is already USD.",
      "Review footprints select a proxy conversion rate; store conversion is not measured.",
      "Revenue minimum and maximum are a 20% sensitivity band, not statistical confidence limits."
    ],
    assumptions: [
      "Traffic is a fixed Tranco-rank bucket proxy and is not measured site traffic.",
      "AOV is the median public variant price normalized to USD using a fixed exchange-rate proxy for the detected store currency; the $40 fallback is already USD.",
      "Review footprints select a proxy conversion rate; store conversion is not measured.",
      "Revenue minimum and maximum are a 20% sensitivity band, not statistical confidence limits."
    ]
  };

  return makeSuccessEstimate(domain, timestamp, {
    traffic,
    aov,
    aovMethod: variantPrices.length ? "median_public_shopify_variant_price_proxy_currency_fx_normalized_to_usd" : "conservative_40_usd_fallback",
    conversionRate,
    currency: revenueCurrency,
    storeCurrency: storeCurrency || revenueCurrency
  }, extras);
}

function estimateStoreRevenue(domain, options = {}) {
  let key = null;
  try {
    key = normalizeDomain(domain);
  } catch {
    // Invalid inputs are not deduplicated or fetched; the estimator returns fallback math.
  }
  if (key && options.dedupe !== false && inFlightEstimates.has(key)) return inFlightEstimates.get(key);

  const task = estimateStoreRevenueInternal(key || domain, options).catch((error) => {
    let timestamp;
    try {
      timestamp = (options.now || (() => new Date()))().toISOString();
    } catch {
      timestamp = new Date().toISOString();
    }
    return makeSuccessEstimate(key, timestamp, { traffic: 1500, aov: 40, conversionRate: 0.015 }, {
      assumptions: ["A conservative fallback estimate was used after an unexpected collection error."],
      latestAssumptions: ["A conservative fallback estimate was used after an unexpected collection error."],
      dataSources: [],
      latestDataSources: [],
      reason: error && error.message ? error.message : "Public proxy data was unavailable."
    });
  });

  if (key && options.dedupe !== false) {
    inFlightEstimates.set(key, task);
    task.finally(() => {
      if (inFlightEstimates.get(key) === task) inFlightEstimates.delete(key);
    }).catch(() => undefined);
  }
  return task;
}

module.exports = {
  estimateStoreRevenue,
  getEstimatedTraffic,
  getFreeTrafficEstimate,
  trafficFromDomainRank,
  getPublicProducts,
  summarizeProducts,
  extractCurrencyFromHtml,
  getStoreCurrency,
  formatRevenueValue,
  convertCurrencyAmount,
  convertRevenueToStoreCurrency,
  normalizeDomain,
  isPublicAddress,
  median
};
