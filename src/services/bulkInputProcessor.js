const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const csv = require("csv-parser");

const INPUT_HEADER_NAMES = new Set([
  "domain", "website", "websiteurl", "url", "companydomain", "target",
  "companyname", "company", "organization", "name"
]);

function normalizedKey(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(row, aliases) {
  const wanted = new Set(aliases.map(normalizedKey));
  const key = Object.keys(row || {}).find((candidate) => wanted.has(normalizedKey(candidate)));
  return key === undefined ? "" : row[key];
}

function parseDomain(value) {
  const raw = String(value || "").trim();
  if (!raw || /\s/.test(raw) || raw.includes("@")) return null;
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!hostname.includes(".") || hostname.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

function normalizeTarget(row, rowNumber) {
  if (typeof row === "string") {
    const raw = row.trim();
    if (!raw) return null;
    const domain = parseDomain(raw);
    return { domain, companyName: domain ? "" : raw, rowNumber };
  }
  const domainValue = pick(row, ["domain", "website", "website_url", "url", "company_domain", "target"]);
  const companyName = String(pick(row, ["company_name", "company", "organization", "name"]) || "").trim();
  const domain = parseDomain(domainValue);
  if (!domain && !companyName) {
    console.warn(`[bulk-enrich] Input row ${rowNumber} has no usable domain or company name; skipping.`);
    return null;
  }
  return { domain, companyName, rowNumber };
}

async function readCsv(filePath) {
  let firstLine = "";
  const peekStream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: peekStream, crlfDelay: Infinity });
  try {
    for await (const line of lineReader) {
      firstLine = line;
      break;
    }
  } finally {
    lineReader.close();
    peekStream.destroy();
  }
  const headerCells = firstLine.split(",").map((cell) => normalizedKey(cell.replace(/^"|"$/g, "")));
  const hasHeader = headerCells.some((cell) => INPUT_HEADER_NAMES.has(cell));

  return new Promise((resolve, reject) => {
    const records = [];
    const source = fs.createReadStream(filePath);
    const parser = source.pipe(csv(hasHeader ? undefined : { headers: ["domain"] }));
    source.on("error", reject);
    parser.on("data", (row) => records.push(row));
    parser.on("error", reject);
    parser.on("end", () => resolve(records));
  });
}

async function readJson(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.targets)) return parsed.targets;
  if (Array.isArray(parsed.leads)) return parsed.leads;
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error("JSON input must be an array or an object with a targets or leads array.");
}

async function parseInputFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  let rows;
  if (extension === ".csv") rows = await readCsv(absolutePath);
  else if (extension === ".json") rows = await readJson(absolutePath);
  else throw new Error("Input must be a .csv or .json file.");

  const deduplicated = new Map();
  rows.forEach((row, index) => {
    const target = normalizeTarget(row, index + 2);
    if (!target) return;
    const key = target.domain || `company:${target.companyName.toLowerCase()}`;
    const prior = deduplicated.get(key);
    if (!prior || (!prior.companyName && target.companyName)) deduplicated.set(key, target);
  });
  return [...deduplicated.values()];
}

module.exports = { parseInputFile, parseDomain, normalizeTarget };
