const { URL } = require("node:url");

const REVIEW_PROVIDERS = [
  ["Judge.me", /judge\.me|judgeme/i],
  ["Loox", /loox/i],
  ["Yotpo", /yotpo/i],
  ["Stamped", /stamped\.io|stamped\.reviews/i]
];

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseJsonLd(html) {
  const result = [];
  const scripts = String(html || "").matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    try {
      result.push(JSON.parse(decodeHtml(match[1].trim())));
    } catch {
      // Ignore malformed public structured data and continue with other signals.
    }
  }
  return result;
}

function flattenObjects(value, result = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 10) return result;
  if (Array.isArray(value)) {
    for (const entry of value) flattenObjects(entry, result, depth + 1);
    return result;
  }
  result.push(value);
  for (const child of Object.values(value)) flattenObjects(child, result, depth + 1);
  return result;
}

function parseFinitePrice(value) {
  const raw = value && typeof value === "object" ? value.price ?? value.lowPrice : value;
  const parsed = Number(String(raw ?? "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function productFromStructuredData(object, baseUrl) {
  const type = object && object["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (!types.some((item) => String(item || "").toLowerCase() === "product")) return null;

  const offers = Array.isArray(object.offers) ? object.offers : object.offers ? [object.offers] : [];
  const offerPrice = (offer) => {
    if (offer && offer.lowPrice && offer.highPrice) {
      return (parseFinitePrice(offer.lowPrice) + parseFinitePrice(offer.highPrice)) / 2;
    }
    return parseFinitePrice(offer);
  };
  const prices = offers.map(offerPrice).filter((price) => Number.isFinite(price));
  const availablePrices = offers.filter((offer) => /instock/i.test(String(offer && offer.availability || "")))
    .map(offerPrice).filter((price) => Number.isFinite(price));
  const firstOffer = offers[0] || {};
  let url = object.url || firstOffer.url || null;
  try {
    if (url) url = new URL(url, baseUrl).toString();
  } catch {
    url = null;
  }
  const availability = String(firstOffer.availability || "").toLowerCase();
  const aggregateRating = object.aggregateRating || {};
  const reviewCountValue = aggregateRating.reviewCount ?? aggregateRating.ratingCount;
  const reviewCount = Number.parseInt(String(reviewCountValue ?? ""), 10);

  return {
    title: decodeHtml(object.name || "").trim() || null,
    productType: decodeHtml(object.category || "").trim() || null,
    prices,
    availablePrices,
    currency: String(firstOffer.priceCurrency || object.priceCurrency || "").toUpperCase() || null,
    url,
    availability: availability.includes("instock") ? "in_stock" : availability.includes("outofstock") ? "out_of_stock" : null,
    reviewCount: Number.isInteger(reviewCount) && reviewCount >= 0 ? reviewCount : null
  };
}

function parseStructuredPage(html, baseUrl) {
  const objects = parseJsonLd(html).flatMap((item) => flattenObjects(item));
  const products = objects.map((object) => productFromStructuredData(object, baseUrl)).filter(Boolean);
  const reviews = products
    .filter((product) => Number.isInteger(product.reviewCount))
    .map((product) => ({ count: product.reviewCount, sourceUrl: product.url || baseUrl }));

  // Some themes expose itemprop values without a complete JSON-LD Product object.
  if (!products.some((product) => product.prices.length) && /itemprop=["']price["']/i.test(html)) {
    const match = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)|content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
    const price = parseFinitePrice(match && (match[1] || match[2]));
    if (price) {
      products.push({ title: null, productType: null, prices: [price], availablePrices: [], currency: null, url: baseUrl, availability: null, reviewCount: null });
    }
  }
  return { products, reviews };
}

function getShopifySignals(html, productFeedAvailable = false) {
  const text = String(html || "");
  const signals = [];
  const add = (name, pattern) => { if (pattern.test(text)) signals.push(name); };
  add("shopify_cdn", /cdn\.shopify\.com/i);
  add("shopify_section_markup", /shopify-section/i);
  add("shopify_theme_object", /Shopify\.theme\s*=/i);
  add("shopify_shop_object", /Shopify\.shop\s*=/i);
  add("shopify_asset_path", /(?:src|href)=["'][^"']*\/cdn\/shop\//i);
  add("myshopify_reference", /[a-z0-9-]+\.myshopify\.com/i);
  add("shopify_generator", /<meta\b(?=[^>]*name=["']generator["'])(?=[^>]*content=["'][^"']*shopify)[^>]*>/i);
  add("shopify_canonical_url", /<link\b(?=[^>]*rel=["']canonical["'])(?=[^>]*href=["'][^"']+\.myshopify\.com)[^>]*>/i);
  if (productFeedAvailable) signals.push("public_shopify_product_feed");
  return [...new Set(signals)];
}

function getReviewProviders(html) {
  const text = String(html || "");
  return REVIEW_PROVIDERS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function getProductLinks(html, baseUrl, limit = 2) {
  const links = [];
  const pattern = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1/gi;
  for (const match of textMatches(String(html || ""), pattern)) {
    try {
      const url = new URL(decodeHtml(match), baseUrl);
      const base = new URL(baseUrl);
      if (url.hostname === base.hostname && url.protocol === "https:" && /\/products\/[^/?#]+/i.test(url.pathname)) {
        url.search = "";
        url.hash = "";
        if (!links.includes(url.toString())) links.push(url.toString());
      }
    } catch {
      // Skip malformed or cross-origin links.
    }
    if (links.length >= limit) break;
  }
  return links;
}

function* textMatches(text, pattern) {
  let match;
  while ((match = pattern.exec(text))) yield match[2];
}

function extractCurrencyFromHtml(html) {
  const text = String(html || "");
  const patterns = [
    /<meta\b[^>]*(?:property|name)=["'](?:product:price:currency|og:price:currency)["'][^>]*content=["']([A-Z]{3})["']/i,
    /<meta\b[^>]*content=["']([A-Z]{3})["'][^>]*(?:property|name)=["'](?:product:price:currency|og:price:currency)["']/i,
    /(?:priceCurrency|currencyCode|currency_code)\s*["']?\s*[:=]\s*["']([A-Z]{3})["']/i,
    /Shopify\.currency\s*=\s*\{[\s\S]{0,300}?\bactive\s*:\s*["']([A-Z]{3})["']/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

function extractMetaProduct(html, baseUrl) {
  const text = String(html || "");
  const getMeta = (key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["']`, "i")
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return decodeHtml(match[1]);
    }
    return null;
  };
  const price = parseFinitePrice(getMeta("product:price:amount"));
  if (!price) return null;
  return {
    title: getMeta("og:title") || getMeta("title"),
    prices: [price],
    currency: getMeta("product:price:currency"),
    url: baseUrl,
    availability: null,
    reviewCount: null
  };
}

async function inspectStorefront(domain, options = {}) {
  const safeGet = options.safeGet;
  const deadline = options.deadline || Date.now() + 5000;
  let homepage = options.homepage || null;
  let homepageError = null;
  if (!homepage) {
    try {
      homepage = await safeGet(`https://${domain}/`, deadline);
    } catch (error) {
      homepageError = error;
    }
  }

  const html = homepage && homepage.body || "";
  const baseUrl = homepage && homepage.finalUrl || `https://${domain}/`;
  let productFeed = options.productFeed || null;
  const productFeedAvailable = Boolean(productFeed);
  const shopifySignals = getShopifySignals(html, productFeedAvailable);
  const strongSignals = shopifySignals.filter((signal) => [
    "shopify_cdn", "shopify_shop_object", "shopify_asset_path", "myshopify_reference", "shopify_canonical_url", "public_shopify_product_feed"
  ].includes(signal)).length;
  const shopify = strongSignals >= 1 || shopifySignals.length >= 3;
  const shopifyConfidence = strongSignals >= 2 || shopifySignals.length >= 4 ? "HIGH" : shopify ? "MEDIUM" : "NONE";

  const providers = new Set(getReviewProviders(html));
  const parsedPages = [];
  if (html) parsedPages.push(parseStructuredPage(html, baseUrl));

  const hasPricedFeed = Boolean(productFeed && Array.isArray(productFeed.productPrices) && productFeed.productPrices.length);
  const hasPricedStructuredData = parsedPages.some((page) => page.products.some((product) => product.prices.length));
  const hasPublicReviewCount = parsedPages.some((page) => page.reviews.length);
  if ((!hasPricedFeed || !hasPricedStructuredData || !hasPublicReviewCount) && safeGet && deadline - Date.now() > 100) {
    const links = getProductLinks(html, baseUrl, 2);
    const responses = await Promise.allSettled(links.map((url) => safeGet(url, deadline)));
    responses.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const response = result.value;
      getReviewProviders(response.body).forEach((provider) => providers.add(provider));
      parsedPages.push(parseStructuredPage(response.body, response.finalUrl || links[index]));
      const metaProduct = extractMetaProduct(response.body, response.finalUrl || links[index]);
      if (metaProduct) parsedPages[parsedPages.length - 1].products.push(metaProduct);
    });
  }

  const products = parsedPages.flatMap((page) => page.products);
  if (productFeed && Array.isArray(productFeed.productRecords)) products.unshift(...productFeed.productRecords);
  if (!products.length && html) {
    const metaProduct = extractMetaProduct(html, baseUrl);
    if (metaProduct) products.push(metaProduct);
  }
  const reviews = parsedPages.flatMap((page) => page.reviews);
  const review = reviews.sort((a, b) => b.count - a.count)[0] || null;
  const currency = (productFeed && productFeed.currency) || products.find((product) => product.currency)?.currency || extractCurrencyFromHtml(html);

  return {
    accessible: Boolean(homepage),
    homepageUrl: baseUrl,
    homepageError: homepageError && { code: homepageError.code || null, message: homepageError.message },
    shopify,
    shopifyStatus: shopify ? "SHOPIFY" : homepage ? "NOT_SHOPIFY" : "UNKNOWN",
    shopifyConfidence,
    shopifySignals,
    reviewWidgetDetected: providers.size > 0,
    reviewProviders: [...providers],
    reviewCount: review && review.count,
    reviewCountSourceUrl: review && review.sourceUrl,
    reviewCountSource: review ? "public_product_structured_data" : null,
    currency,
    productRecords: products,
    dataSources: [homepage ? "public_storefront_html" : null, productFeed ? "public_products_json" : null,
      products.length ? "public_product_structured_data" : null].filter(Boolean)
  };
}

module.exports = {
  inspectStorefront,
  parseStructuredPage,
  getShopifySignals,
  getReviewProviders,
  getProductLinks,
  extractCurrencyFromHtml,
  extractMetaProduct
};
