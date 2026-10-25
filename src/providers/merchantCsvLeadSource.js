const fs = require("node:fs");
const path = require("node:path");
const csv = require("csv-parser");
const config = require("../config");

const LOCAL_LIST_FILES = [
  "verified_us_uk_shopify_25.csv",
  "shopify_us_uk_high_budget_50_leads.csv"
];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getValue(row, ...names) {
  const wanted = new Set(names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const key = Object.keys(row).find((header) =>
    wanted.has(String(header).replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, ""))
  );
  return key === undefined ? "" : String(row[key] || "").trim();
}

function parseList(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {
      // Treat malformed JSON as a comma-separated value below.
    }
  }
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const candidates = [];
    const input = fs.createReadStream(filePath);
    const stream = input.pipe(csv({
      mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim()
    }));

    stream.on("data", (row) => {
      const title = getValue(row, "store_name", "store name", "company name", "name");
      const rawUrl = getValue(row, "website_url", "website", "url");
      if (!title || !rawUrl) return;

      let url;
      try {
        url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(url.protocol)) return;

      const possibleEmail = getValue(row, "contact_email", "email", "contact");
      const contactEmail = EMAIL_PATTERN.test(possibleEmail) ? possibleEmail.toLowerCase() : "";
      const contactPhone = getValue(row, "contact_phone", "contact phone", "phone", "phone number", "mobile");
      const whatsappAvailable = getValue(row, "whatsapp_available", "whatsapp available").toLowerCase();
      const productCount = Number.parseInt(getValue(row, "product_count", "product count"), 10);
      candidates.push({
        url: `${url.protocol}//${url.host}/`,
        title,
        snippet: getValue(row, "niche", "product category", "description", "why good prospect"),
        country: getValue(row, "country"),
        contactEmail,
        contactPhone,
        whatsappAvailable: ["yes", "no", "unknown"].includes(whatsappAvailable) ? whatsappAvailable : "unknown",
        installedApps: parseList(getValue(row, "installed_apps", "installed apps", "apps")),
        techStack: parseList(getValue(row, "tech_stack", "tech stack", "technology")),
        storeDescription: getValue(row, "store_description", "store description"),
        productCount: Number.isInteger(productCount) && productCount >= 0 ? productCount : null,
        estimatedRevenue: getValue(row, "estimated_revenue", "estimated revenue"),
        source: path.basename(filePath)
      });
    });
    input.on("error", reject);
    stream.on("error", reject);
    stream.on("end", () => resolve(candidates));
  });
}

async function getLocalCandidates() {
  const candidates = [];
  for (const fileName of LOCAL_LIST_FILES) {
    const filePath = path.join(config.rootDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    candidates.push(...await readCsv(filePath));
  }
  return candidates;
}

module.exports = { getLocalCandidates };
