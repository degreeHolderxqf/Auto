"use strict";

/**
 * Freelance/job-board lead enrichment.
 *
 * Sources must be supplied by the operator as an export, an authorized RSS feed,
 * or a board for which automated access is permitted. Upwork RSS was retired in
 * 2024 and both Upwork and Fiverr prohibit automated scraping in their terms;
 * this service deliberately does not automate access to either site.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const config = require("../config");
const logger = require("./logger");
const companyWebsite = require("../providers/companyWebsite");

const DEFAULT_OUTPUT = path.join(config.outputDir, "freelance_leads");
const MAX_WORKERS = 4;
const MAX_DOMAINS_PER_JOB = 3;
const NON_COMPANY_HOSTS = new Set([
  "upwork.com", "fiverr.com", "linkedin.com", "facebook.com", "instagram.com",
  "youtube.com", "twitter.com", "x.com", "tiktok.com", "google.com", "github.com",
  "dropbox.com", "drive.google.com", "docs.google.com", "notion.so", "medium.com"
]);

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63})(?::\d{1,5})?(?:\/[^\s<>"'()[\]{}]*)?/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/gi;

function stripHtml(input) {
  return String(input || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCandidate(candidate) {
  return String(candidate || "").replace(/[.,;:!?]+$/g, "").replace(/[)\]}]+$/g, "");
}

function hostnameFromCandidate(candidate) {
  const cleaned = cleanCandidate(candidate);
  if (!cleaned) return null;

  try {
    const withScheme = /^https?:\/\//i.test(cleaned)
      ? cleaned
      : `https://${cleaned.replace(/^www\./i, "www.")}`;
    const parsed = new URL(withScheme);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!hostname.includes(".") || hostname.length > 253) return null;
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
}

/** Find links and bare domains in a job title/description, including myshopify.com. */
function extractDomains(text) {
  const source = stripHtml(text);
  const withoutEmails = source.replace(EMAIL_RE, " ");
  const candidates = [
    ...(withoutEmails.match(URL_RE) || []),
    ...(withoutEmails.match(DOMAIN_RE) || [])
  ];
  const seen = new Set();
  const domains = [];

  for (const candidate of candidates) {
    const domain = hostnameFromCandidate(candidate);
    if (!domain || NON_COMPANY_HOSTS.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

/**
 * Conservative company-name pattern matching. A name is returned only when the
 * post explicitly labels it as a company, brand, business, or store.
 */
function extractCompanyNames(text) {
  const source = stripHtml(text);
  const patterns = [
    /\b(?:our|the)\s+(?:company|brand|store|business)(?:\s+name)?\s*(?:is|:|called)\s*["']?([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,4})/g,
    /\b(?:company|brand|store|business)(?:\s+name)?\s*[:=]\s*["']?([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,4})/g,
    /\bfor\s+(?:our\s+)?([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,3})\s+(?:brand|company|store|business)\b/g
  ];
  const ignored = new Set(["Shopify", "WordPress", "WooCommerce", "Website", "Ecommerce", "E-commerce"]);
  const names = new Set();

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = (match[1] || "").trim().replace(/[.,;:!?]+$/g, "");
      if (name.length >= 2 && !ignored.has(name)) names.add(name);
    }
  }
  return [...names];
}

function normalizeJob(raw, fallbackPlatform = "Unknown") {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title || raw["Job Title"] || raw.jobTitle || "").trim();
  const description = String(raw.description || raw["Job Description"] || raw.jobDescription || raw.contentSnippet || raw.content || "").trim();
  const link = String(raw.link || raw["Job Link"] || raw.jobLink || raw.url || "").trim();
  const platform = String(raw.platform || raw["Job Platform"] || raw.jobPlatform || fallbackPlatform).trim();
  if (!title || !link) return null;
  try {
    const parsed = new URL(link);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  return { title, description: stripHtml(description), link, platform };
}

async function loadJobExport(inputPath) {
  if (!inputPath) return [];
  const resolved = path.resolve(inputPath);
  const contents = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(contents);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : [];
  return rows.map((job) => normalizeJob(job, parsed.platform || "Import")).filter(Boolean);
}

function isBlockedPlatformHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  return host === "upwork.com" || host.endsWith(".upwork.com") || host === "fiverr.com" || host.endsWith(".fiverr.com");
}

/** Parse a published RSS feed from an operator-approved source, one feed at a time. */
async function fetchAuthorizedRssFeeds(feeds = []) {
  if (!feeds.length) return [];
  let Parser;
  try {
    Parser = require("rss-parser");
  } catch {
    throw new Error("RSS support needs the rss-parser package. Run npm install in Testing/ccc.");
  }

  const parser = new Parser({ timeout: 15000 });
  const jobs = [];
  for (const feed of feeds) {
    if (!feed || feed.authorized !== true) {
      logger.warn("Skipped RSS feed without explicit authorization.");
      continue;
    }
    let feedUrl;
    try {
      feedUrl = new URL(feed.url);
    } catch {
      logger.warn("Skipped RSS feed with an invalid URL.");
      continue;
    }
    if (!/^https?:$/.test(feedUrl.protocol) || isBlockedPlatformHost(feedUrl.hostname)) {
      logger.warn(`Skipped unsupported or restricted RSS source: ${feedUrl.hostname}`);
      continue;
    }
    try {
      const parsed = await parser.parseURL(feedUrl.toString());
      for (const item of parsed.items || []) {
        const job = normalizeJob({
          title: item.title,
          description: item.contentSnippet || item.content || item.summary || "",
          link: item.link,
          platform: feed.platform || parsed.title || feedUrl.hostname
        });
        if (job) jobs.push(job);
      }
    } catch (error) {
      logger.warn(`RSS feed failed for ${feedUrl.hostname}: ${error.message}`);
    }
  }
  return jobs;
}

function robotsAllows(robotsText, pathname) {
  let activeForWildcard = false;
  let rules = [];
  let wildcardRules = [];
  for (const line of String(robotsText || "").split(/\r?\n/)) {
    const clean = line.split("#")[0].trim();
    const match = clean.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "user-agent") {
      if (rules.length) wildcardRules = rules;
      activeForWildcard = value === "*";
      rules = [];
    } else if (activeForWildcard && (key === "allow" || key === "disallow") && value) {
      rules.push({ allow: key === "allow", path: value });
    }
  }
  if (activeForWildcard && rules.length) wildcardRules = rules;
  const matching = wildcardRules
    .filter((rule) => pathname.startsWith(rule.path.replace(/\*.*$/, "")))
    .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))[0];
  return !matching || matching.allow;
}

async function checkBoardPermission(board) {
  if (!board || board.authorized !== true) {
    throw new Error("Board automation requires board.authorized=true after checking the board's terms.");
  }
  const pageUrl = new URL(board.url);
  if (!/^https?:$/.test(pageUrl.protocol) || isBlockedPlatformHost(pageUrl.hostname)) {
    throw new Error("This board host is not enabled for browser automation.");
  }
  const robotsUrl = new URL("/robots.txt", pageUrl.origin);
  const response = await fetch(robotsUrl, {
    headers: { "User-Agent": "FreelanceLeadDiscovery/1.0 (respectful public board reader)" },
    signal: AbortSignal.timeout(10000)
  });
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    throw new Error(`robots.txt returned HTTP ${response.status}; stopping.`);
  }
  if (response.ok) {
    const robotsText = await response.text();
    if (!robotsAllows(robotsText, pageUrl.pathname)) {
      throw new Error(`robots.txt disallows ${pageUrl.pathname}; stopping.`);
    }
  }
  return pageUrl;
}

/**
 * Read a board that expressly permits automation. This is not a Fiverr/Upwork
 * scraper. It uses one browser page, a stable identifying UA, and stops on
 * access-denied/rate-limit/challenge responses instead of attempting evasion.
 */
async function fetchAuthorizedBoard(board) {
  const pageUrl = await checkBoardPermission(board);
  const selectors = board.selectors || {};
  if (!selectors.item || !selectors.title || !selectors.link) {
    throw new Error("Authorized board config must define selectors.item, selectors.title, and selectors.link.");
  }
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch {
    throw new Error("Browser board support needs the puppeteer package. Run npm install in Testing/ccc.");
  }

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("FreelanceLeadDiscovery/1.0 (authorized public job-board reader)");
    const response = await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
    const status = response ? response.status() : 0;
    if ([401, 403, 429].includes(status)) throw new Error(`Board returned HTTP ${status}; stopping without retry.`);
    await page.waitForSelector(selectors.item, { timeout: 10000 });

    const challenge = await page.evaluate(() => /cloudflare|verify you are human|captcha|access denied/i.test(document.body?.innerText || ""));
    if (challenge) throw new Error("An access challenge was detected; stopping without bypassing it.");

    const rows = await page.evaluate((css) => {
      return Array.from(document.querySelectorAll(css.item)).map((item) => {
        const title = item.querySelector(css.title)?.textContent?.trim() || "";
        const description = css.description ? item.querySelector(css.description)?.textContent?.trim() || "" : "";
        const anchor = item.querySelector(css.link);
        return { title, description, link: anchor?.href || "" };
      });
    }, selectors);
    return rows.map((row) => normalizeJob({ ...row, platform: board.platform || pageUrl.hostname })).filter(Boolean);
  } finally {
    await browser.close();
  }
}

function getOfficialDomainSearchConfig() {
  return {
    provider: String(config.searchProvider || "").toLowerCase(),
    apiKey: config.searchApiKey || "",
    googleCx: process.env.GOOGLE_CSE_ID || ""
  };
}

/** Resolve a name using an enabled search API; never guesses a domain from a name. */
async function resolveCompanyDomain(companyName, options = {}) {
  if (typeof options.domainResolver === "function") {
    const resolved = await options.domainResolver(companyName);
    return hostnameFromCandidate(resolved);
  }

  const { provider, apiKey, googleCx } = getOfficialDomainSearchConfig();
  if (!apiKey) return null;
  const query = `"${companyName}" contact official website`;
  let links = [];

  if (provider === "serpapi") {
    const searchUrl = new URL("https://serpapi.com/search.json");
    searchUrl.searchParams.set("engine", "google");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("api_key", apiKey);
    searchUrl.searchParams.set("num", "5");
    const response = await fetch(searchUrl, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`SerpAPI returned HTTP ${response.status}`);
    const data = await response.json();
    links = (data.organic_results || []).map((item) => item.link);
  } else if (provider === "google" && googleCx) {
    // Google documents this API as closed to new customers; existing customers
    // can use it through its announced transition period. GOOGLE_CSE_ID is cx.
    const searchUrl = new URL("https://www.googleapis.com/customsearch/v1");
    searchUrl.searchParams.set("key", apiKey);
    searchUrl.searchParams.set("cx", googleCx);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("num", "5");
    const response = await fetch(searchUrl, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Google Custom Search returned HTTP ${response.status}`);
    const data = await response.json();
    links = (data.items || []).map((item) => item.link);
  } else {
    return null;
  }

  for (const link of links) {
    const domain = hostnameFromCandidate(link);
    if (domain && !NON_COMPANY_HOSTS.has(domain) && !isBlockedPlatformHost(domain)) return domain;
  }
  return null;
}

async function getPublicEmail(domain, options = {}) {
  const result = await companyWebsite.researchWebsite(`https://${domain}`, `https://${domain}`, {
    maxSubpages: options.maxSubpages || 4,
    respectRobots: true,
    crawlDelayMs: options.crawlDelayMs || 500
  });
  const contact = (result.contacts || []).find((entry) => entry.email);
  return contact ? contact.email : "";
}

async function processJobPost(rawJob, options = {}) {
  const job = normalizeJob(rawJob);
  if (!job) return [];
  const fullText = `${job.title}\n${job.description}`;
  let domains = extractDomains(fullText).slice(0, MAX_DOMAINS_PER_JOB);
  let companyName = "";

  if (domains.length === 0) {
    const names = extractCompanyNames(fullText);
    for (const candidateName of names) {
      const domain = await resolveCompanyDomain(candidateName, options);
      if (domain) {
        domains = [domain];
        companyName = candidateName;
        break;
      }
    }
  }

  if (domains.length === 0) {
    return [{
      "Job Title": job.title,
      "Job Platform": job.platform,
      "Extracted Domain": "",
      "Extracted Email": "",
      "Job Link": job.link
    }];
  }

  const records = [];
  for (const domain of domains) {
    let email = "";
    try {
      email = await getPublicEmail(domain, options);
    } catch (error) {
      logger.warn(`Website research failed for ${domain}: ${error.message}`);
    }
    records.push({
      "Job Title": job.title,
      "Job Platform": job.platform,
      "Extracted Domain": domain,
      "Extracted Email": email,
      "Job Link": job.link,
      companyName
    });
  }
  return records;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(MAX_WORKERS, Number.parseInt(concurrency, 10) || 2, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        output[index] = await worker(items[index], index);
      } catch (error) {
        logger.warn(`Job processing failed: ${error.message}`);
        output[index] = [];
      }
    }
  }));
  return output.flat();
}

function csvCell(value) {
  const text = String(value || "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeResults(records, outputBase = DEFAULT_OUTPUT) {
  const outputPath = path.resolve(outputBase);
  const base = /\.(?:csv|json)$/i.test(outputPath) ? outputPath.replace(/\.(?:csv|json)$/i, "") : outputPath;
  await fs.mkdir(path.dirname(base), { recursive: true });
  const columns = ["Job Title", "Job Platform", "Extracted Domain", "Extracted Email", "Job Link"];
  const csv = [columns.map(csvCell).join(",")];
  for (const record of records) csv.push(columns.map((column) => csvCell(record[column])).join(","));
  await fs.writeFile(`${base}.csv`, `${csv.join("\r\n")}\r\n`, "utf8");
  const jsonRecords = records.map((record) => Object.fromEntries(columns.map((column) => [column, record[column] || ""])));
  await fs.writeFile(`${base}.json`, `${JSON.stringify(jsonRecords, null, 2)}\n`, "utf8");
  return { csvPath: `${base}.csv`, jsonPath: `${base}.json` };
}

async function runFreelanceLeadDiscovery(options = {}) {
  const jobs = [];
  if (options.jobsFile) jobs.push(...await loadJobExport(options.jobsFile));
  for (const entry of options.jobs || []) {
    const job = normalizeJob(entry);
    if (job) jobs.push(job);
  }
  if (options.feeds?.length) jobs.push(...await fetchAuthorizedRssFeeds(options.feeds));
  for (const board of options.boards || []) {
    try {
      jobs.push(...await fetchAuthorizedBoard(board));
    } catch (error) {
      logger.warn(`Board ingestion skipped: ${error.message}`);
    }
  }

  const uniqueJobs = [];
  const seenJobs = new Set();
  for (const job of jobs) {
    const key = `${job.platform.toLowerCase()}|${job.link}`;
    if (!seenJobs.has(key)) {
      seenJobs.add(key);
      uniqueJobs.push(job);
    }
  }

  logger.info(`Processing ${uniqueJobs.length} authorized/imported job post(s).`);
  const records = await mapWithConcurrency(uniqueJobs, options.concurrency || process.env.FREELANCE_MAX_CONCURRENCY || 2,
    (job) => processJobPost(job, options));
  const uniqueRecords = [];
  const seenRecords = new Set();
  for (const record of records) {
    const key = `${record["Job Link"]}|${record["Extracted Domain"]}`;
    if (!seenRecords.has(key)) {
      seenRecords.add(key);
      uniqueRecords.push(record);
    }
  }

  const files = await writeResults(uniqueRecords, options.outputBase || DEFAULT_OUTPUT);
  logger.success(`Wrote ${uniqueRecords.length} result row(s): ${files.csvPath}, ${files.jsonPath}`);
  return { jobsProcessed: uniqueJobs.length, records: uniqueRecords, files };
}

module.exports = {
  extractDomains,
  extractCompanyNames,
  normalizeJob,
  loadJobExport,
  fetchAuthorizedRssFeeds,
  fetchAuthorizedBoard,
  resolveCompanyDomain,
  processJobPost,
  runFreelanceLeadDiscovery,
  writeResults
};
