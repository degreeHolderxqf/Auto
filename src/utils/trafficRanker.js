const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");
const { URL } = require("node:url");

const REQUEST_TIMEOUT_MS = 3000;
const SHOPIFY_BASELINE_TRAFFIC = 2500;
const DEFAULT_BASELINE_TRAFFIC = 1000;

function normalizeHostname(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : "https://" + raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
        (parsed.port && parsed.port !== "443") || !parsed.hostname) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") || hostname.endsWith(".internal") || net.isIP(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const lower = address.toLowerCase().split("%")[0];
    const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return /^[23]/.test(lower) && !lower.startsWith("2001:db8:") && !lower.startsWith("2002:");
  }
  return false;
}

async function resolvePublicAddresses(hostname, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;

  let timer;
  try {
    const records = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
        if (typeof timer.unref === "function") timer.unref();
      })
    ]);
    if (!Array.isArray(records) || records.length === 0 || records.some((record) => !isPublicAddress(record.address))) return null;
    return records;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestShopifyHeaders(hostname, records, deadline) {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return resolve(false);

    let settled = false;
    let deadlineTimer;
    const request = https.request({
      hostname,
      path: "/",
      method: "HEAD",
      headers: { "User-Agent": "ShopifyStoreRevenueEstimator/1.0", Accept: "*/*" },
      servername: hostname,
      lookup: (_host, options, callback) => {
        if (typeof options === "function") callback = options;
        if (options && options.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      }
    }, (response) => {
      const hasShopifyHeader = Boolean(response.headers["x-shopify-stage"] || response.headers["x-shopid"]);
      response.resume();
      finish(hasShopifyHeader);
    });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve(Boolean(value));
    };

    deadlineTimer = setTimeout(() => {
      request.destroy();
      finish(false);
    }, remaining);
    if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
    request.on("error", () => finish(false));
    request.end();
  });
}

async function getFreeTrafficEstimate(domain) {
  const hostname = normalizeHostname(domain);
  if (!hostname) return DEFAULT_BASELINE_TRAFFIC;

  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  try {
    const records = await resolvePublicAddresses(hostname, deadline);
    if (!records) return DEFAULT_BASELINE_TRAFFIC;
    const hasShopifyHeaders = await requestShopifyHeaders(hostname, records, deadline);
    return hasShopifyHeaders ? SHOPIFY_BASELINE_TRAFFIC : DEFAULT_BASELINE_TRAFFIC;
  } catch {
    return DEFAULT_BASELINE_TRAFFIC;
  }
}

module.exports = { getFreeTrafficEstimate };
