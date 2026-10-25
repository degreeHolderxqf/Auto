const axios = require("axios");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const API_REQUEST_GAP_MS = 2500;
let apiQueue = Promise.resolve();
let lastApiRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function emailValues(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return unique(rows.map((item) => {
    if (typeof item === "string") return item;
    return item?.value || item?.email || item?.address || "";
  }).map((email) => email.toLowerCase()).filter((email) => EMAIL_PATTERN.test(email)));
}

function linkValues(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return unique(rows.map((item) => {
    if (typeof item === "string") return item;
    return item?.url || item?.profile_url || item?.link || item?.username || item?.handle || "";
  }));
}

function normalizeApiResponse(raw, inputTarget) {
  const body = raw?.data?.data || raw?.data || {};
  const org = body.organization || body.company || {};
  const people = Array.isArray(body.people) ? body.people : Array.isArray(body.contacts) ? body.contacts : [];
  const emails = [
    ...emailValues(body.emails),
    ...emailValues(body.email),
    ...emailValues(people.flatMap((person) => [person?.email, ...(Array.isArray(person?.emails) ? person.emails : [])]))
  ];
  const socials = body.socialLinks || body.social_links || body.profiles || {};
  const socialLinks = {
    LinkedIn: unique([
      ...linkValues(body.linkedin), ...linkValues(body.linkedin_url), ...linkValues(body.linkedinUrl),
      ...linkValues(org.linkedin), ...linkValues(org.linkedin_url), ...linkValues(socials.linkedin),
      ...people.flatMap((person) => linkValues(person?.linkedin_url || person?.linkedin))
    ]),
    Twitter: unique([
      ...linkValues(body.twitter), ...linkValues(body.twitter_url), ...linkValues(body.twitter_handle),
      ...linkValues(org.twitter), ...linkValues(org.twitter_url), ...linkValues(socials.twitter),
      ...people.flatMap((person) => linkValues(person?.twitter_url || person?.twitter_handle))
    ]),
    Instagram: unique([...linkValues(body.instagram), ...linkValues(socials.instagram)]),
    Facebook: unique([...linkValues(body.facebook), ...linkValues(socials.facebook)])
  };
  const domainCandidate = body.domain || body.website_domain || body.website_url || org.domain || org.website_domain || org.website || "";

  return {
    domain: String(domainCandidate || inputTarget.domain || "").trim().toLowerCase().replace(/^www\./, ""),
    emails: unique(emails),
    socialLinks,
    source: "API"
  };
}

function configured() {
  return Boolean(String(process.env.BULK_ENRICHMENT_API_URL || "").trim());
}

function pacedApiRequest(target) {
  const run = apiQueue.then(async () => {
    const waitMs = Math.max(0, API_REQUEST_GAP_MS - (Date.now() - lastApiRequestAt));
    if (waitMs) await sleep(waitMs);
    lastApiRequestAt = Date.now();
    return requestApi(target);
  });
  apiQueue = run.catch(() => undefined);
  return run;
}

async function requestApi(target) {
  const endpoint = String(process.env.BULK_ENRICHMENT_API_URL || "").trim();
  if (!endpoint) {
    return { domain: target.domain || "", emails: [], socialLinks: {}, source: "API", configured: false };
  }

  const params = target.domain
    ? { domain: target.domain }
    : { company_name: target.companyName };
  const headers = {
    Accept: "application/json",
    "User-Agent": "MyLocalB2BTool/1.0"
  };
  const apiKey = String(process.env.BULK_ENRICHMENT_API_KEY || "").trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await axios.get(endpoint, {
      params,
      headers,
      timeout: 12000,
      maxContentLength: 2 * 1024 * 1024,
      validateStatus: () => true
    });
    if (response.status === 429) {
      console.warn(`[bulk-enrich] Enrichment API rate limited ${target.domain || target.companyName}; continuing to fallback if a domain is available.`);
      return { domain: target.domain || "", emails: [], socialLinks: {}, source: "API", error: "rate_limited" };
    }
    if (response.status === 403 || response.status === 401) {
      console.warn(`[bulk-enrich] Enrichment API denied the request for ${target.domain || target.companyName} (HTTP ${response.status}).`);
      return { domain: target.domain || "", emails: [], socialLinks: {}, source: "API", error: "forbidden" };
    }
    if (response.status < 200 || response.status >= 300) {
      console.warn(`[bulk-enrich] Enrichment API returned HTTP ${response.status} for ${target.domain || target.companyName}.`);
      return { domain: target.domain || "", emails: [], socialLinks: {}, source: "API", error: `http_${response.status}` };
    }
    return normalizeApiResponse(response, target);
  } catch (error) {
    const detail = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT"
      ? "request timed out"
      : error.message;
    console.warn(`[bulk-enrich] Enrichment API failed for ${target.domain || target.companyName}: ${detail}`);
    return { domain: target.domain || "", emails: [], socialLinks: {}, source: "API", error: error.code || "network_error" };
  }
}

async function enrichTarget(target) {
  if (!configured()) return requestApi(target);
  return pacedApiRequest(target);
}

module.exports = { enrichTarget, normalizeApiResponse, configured, API_REQUEST_GAP_MS };
