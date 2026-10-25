const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const net = require("node:net");
const { URL } = require("node:url");
const db = require("../db/database");

const MAX_DATASET_BYTES = 100 * 1024 * 1024;
const MAX_DATASET_ROWS = 2_000_000;

function normalizeRankDomain(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  let hostname;
  try {
    hostname = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
  hostname = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".local") || net.isIP(hostname)) return null;
  return hostname;
}

function validatePublicationDate(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error("publicationDate must use YYYY-MM-DD format.");
  }
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("publicationDate is not a valid calendar date.");
  }
  return date;
}

function parseTrancoCsv(contents) {
  const rows = [];
  const seen = new Set();
  const lines = String(contents || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const rankText = line.slice(0, comma).trim().replace(/^"|"$/g, "");
    const domainText = line.slice(comma + 1).trim().replace(/^"|"$/g, "");
    if (/^(rank|position)$/i.test(rankText)) continue;
    const rank = Number.parseInt(rankText, 10);
    const domain = normalizeRankDomain(domainText);
    if (!Number.isSafeInteger(rank) || rank < 1 || !domain || seen.has(domain)) continue;
    seen.add(domain);
    rows.push({ rank, domain });
    if (rows.length > MAX_DATASET_ROWS) throw new Error(`Ranking file exceeded ${MAX_DATASET_ROWS} valid rows.`);
  }
  if (!rows.length) throw new Error("No valid rank,domain rows were found in the Tranco file.");
  return rows;
}

async function importTrancoFile({ filePath, publicationDate, listId, sourceUrl } = {}) {
  if (!filePath) throw new Error("A downloaded Tranco CSV path is required.");
  const date = validatePublicationDate(publicationDate);
  const stat = await fs.stat(filePath);
  if (stat.size <= 0 || stat.size > MAX_DATASET_BYTES) throw new Error("Tranco CSV must be between 1 byte and 100 MB.");
  const data = await fs.readFile(filePath);
  const rows = parseTrancoCsv(data.toString("utf8"));
  const datasetKey = String(listId || `tranco-${date}`).trim();
  if (!datasetKey || datasetKey.length > 120) throw new Error("listId must be between 1 and 120 characters.");
  const result = db.importDomainRankDataset({
    source: "tranco",
    datasetKey,
    publicationDate: date,
    rows,
    fileSha256: crypto.createHash("sha256").update(data).digest("hex"),
    sourceUrl: sourceUrl || "https://tranco-list.eu/"
  });
  return { ...result, publicationDate: date, datasetKey, rowCount: rows.length };
}

function getDomainRank(domain) {
  const normalized = normalizeRankDomain(domain);
  if (!normalized) return { available: false, status: "RANK_NOT_AVAILABLE", rank: null, domain: null };
  const rank = db.getDomainRank(normalized);
  if (!rank) return { available: false, status: "RANK_NOT_AVAILABLE", rank: null, domain: normalized };
  return { available: true, status: "AVAILABLE", domain: normalized, ...rank };
}

function trafficEstimateFromRank(rankResult) {
  const rank = Number(rankResult && typeof rankResult === "object" ? rankResult.rank : rankResult);
  if ((rankResult && rankResult.available === false) || !Number.isSafeInteger(rank) || rank < 1) return 1500;
  if (rank <= 100000) return 100000;
  if (rank <= 500000) return 30000;
  if (rank <= 1000000) return 10000;
  return 1500;
}

function getDomainTrafficEstimate(domain) {
  try {
    const rankResult = getDomainRank(domain);
    return {
      ...rankResult,
      estimated_traffic: trafficEstimateFromRank(rankResult),
      traffic_provider: "Local Tranco Rank Proxy",
      traffic_metric: "Tranco rank bucket proxy",
      traffic_period: "monthly"
    };
  } catch {
    return {
      available: false,
      status: "RANK_NOT_AVAILABLE",
      domain: null,
      rank: null,
      estimated_traffic: 1500,
      traffic_provider: "Local Tranco Rank Proxy",
      traffic_metric: "Tranco rank bucket proxy",
      traffic_period: "monthly"
    };
  }
}

module.exports = {
  importTrancoFile,
  parseTrancoCsv,
  normalizeRankDomain,
  getDomainRank,
  trafficEstimateFromRank,
  getDomainTrafficEstimate,
  validatePublicationDate
};
