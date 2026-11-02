const axios = require("axios");
const cheerio = require("cheerio");
const companyWebsite = require("./companyWebsite");

const USER_AGENT = "MyLocalB2BTool/1.0";
const MIN_REQUEST_GAP_MS = 2500;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;
const EMAIL_VALID_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}$/i;
const emailRejectPattern = /^(?:email@email\.com|example@|noreply@.*\.invalid$)/i;
const hostQueues = new Map();
const lastRequestByOrigin = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedSocialHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

function collectEmails($, sourceText) {
  const found = [];
  $("a[href^='mailto:']").each((_index, anchor) => {
    const href = String($(anchor).attr("href") || "").slice("mailto:".length).split("?")[0];
    try {
      found.push(decodeURIComponent(href));
    } catch {
      found.push(href);
    }
  });
  found.push(...(String(sourceText || "").match(EMAIL_PATTERN) || []));
  return [...new Set(found.map((email) => email.trim().toLowerCase()))]
    .filter((email) => EMAIL_VALID_PATTERN.test(email) && !emailRejectPattern.test(email) && !/\.(?:png|jpe?g|webp|gif|svg|js|css)$/i.test(email));
}

function collectSocialLinks($, pageUrl) {
  const links = { LinkedIn: [], Twitter: [], Instagram: [], Facebook: [] };
  const sets = Object.fromEntries(Object.keys(links).map((key) => [key, new Set()]));
  $("a[href]").each((_index, anchor) => {
    const href = String($(anchor).attr("href") || "").trim();
    try {
      const url = new URL(href, pageUrl);
      if (!["http:", "https:"].includes(url.protocol)) return;
      const host = normalizedSocialHost(url.hostname);
      let key = null;
      if (host === "linkedin.com") key = "LinkedIn";
      else if (["twitter.com", "x.com"].includes(host)) key = "Twitter";
      else if (host === "instagram.com") key = "Instagram";
      else if (["facebook.com", "fb.me"].includes(host)) key = "Facebook";
      if (!key) return;
      url.hash = "";
      sets[key].add(url.toString());
    } catch {
      // Ignore malformed or non-URL href values.
    }
  });
  for (const key of Object.keys(links)) links[key] = [...sets[key]];
  return links;
}

function regexForRobotsPath(pathPattern) {
  const source = String(pathPattern || "");
  const endAnchored = source.endsWith("$");
  const chars = endAnchored ? source.slice(0, -1) : source;
  const regexSpecialChars = new Set([".", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
  let expression = "^";
  for (const char of chars) {
    if (char === "*") expression += ".*";
    else expression += regexSpecialChars.has(char) ? `\\${char}` : char;
  }
  if (endAnchored) expression += "$";
  return new RegExp(expression);
}

function parseRobotsRules(robotsText, userAgent = USER_AGENT) {
  const groups = [];
  let group = null;
  let groupHasRules = false;
  for (const rawLine of String(robotsText || "").split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === "user-agent") {
      if (groupHasRules) {
        groups.push(group);
        group = null;
        groupHasRules = false;
      }
      if (!group) group = { agents: [], rules: [], crawlDelay: null };
      group.agents.push(value.toLowerCase());
      continue;
    }
    if (!group) continue;
    if ((directive === "allow" || directive === "disallow") && value) {
      group.rules.push({ allow: directive === "allow", path: value });
      groupHasRules = true;
    } else if (directive === "crawl-delay" && Number.isFinite(Number(value))) {
      group.crawlDelay = Math.max(group.crawlDelay || 0, Number(value));
      groupHasRules = true;
    }
  }
  if (group) groups.push(group);

  const agentToken = String(userAgent).split(/[\s/]/)[0].toLowerCase();
  const specific = groups
    .filter((item) => item.agents.some((agent) => agent !== "*" && agentToken.includes(agent)))
    .sort((a, b) => Math.max(...b.agents.map((agent) => agent.length)) - Math.max(...a.agents.map((agent) => agent.length)));
  let selectedGroups;
  if (specific.length) {
    const specificity = Math.max(...specific[0].agents.filter((agent) => agent !== "*").map((agent) => agent.length));
    selectedGroups = specific.filter((item) => Math.max(...item.agents.filter((agent) => agent !== "*").map((agent) => agent.length)) === specificity);
  } else {
    selectedGroups = groups.filter((item) => item.agents.includes("*"));
  }

  const rules = selectedGroups.flatMap((item) => item.rules);
  const crawlDelay = Math.max(0, ...selectedGroups.map((item) => item.crawlDelay || 0));
  return {
    crawlDelay,
    allows(pageUrl) {
      const parsed = new URL(pageUrl);
      const target = `${parsed.pathname}${parsed.search}`;
      const matching = rules
        .filter((rule) => regexForRobotsPath(rule.path).test(target))
        .sort((a, b) => b.path.replace(/[\*$]/g, "").length - a.path.replace(/[\*$]/g, "").length || Number(b.allow) - Number(a.allow))[0];
      return !matching || matching.allow;
    }
  };
}

function pacedGet(url, requestedGapMs = MIN_REQUEST_GAP_MS) {
  const origin = new URL(url).origin;
  const gapMs = Math.max(MIN_REQUEST_GAP_MS, Number(requestedGapMs) || 0);
  const previous = hostQueues.get(origin) || Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const elapsed = Date.now() - (lastRequestByOrigin.get(origin) || 0);
    if (lastRequestByOrigin.has(origin) && elapsed < gapMs) {
      await sleep(gapMs - elapsed);
    }
    lastRequestByOrigin.set(origin, Date.now());
    return axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      },
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: MAX_PAGE_BYTES,
      responseType: "text",
      validateStatus: () => true
    });
  });
  hostQueues.set(origin, current.catch(() => undefined));
  return current;
}

async function readRobots(origin) {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  try {
    const response = await pacedGet(robotsUrl);
    if (response.status === 404 || response.status === 410) {
      return { ok: true, policy: parseRobotsRules("") };
    }
    if (response.status !== 200) {
      console.warn(`[bulk-enrich] Skipping ${origin}; robots.txt returned HTTP ${response.status}.`);
      return { ok: false, reason: `robots.txt HTTP ${response.status}` };
    }
    return { ok: true, policy: parseRobotsRules(response.data) };
  } catch (error) {
    const detail = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" ? "timeout" : error.message;
    console.warn(`[bulk-enrich] Could not read robots.txt for ${origin}: ${detail}; skipping this domain.`);
    return { ok: false, reason: "robots.txt fetch failed" };
  }
}

async function fetchPageWithRobots(startUrl, rootDomain, initialPolicy, getPolicy) {
  let pageUrl = startUrl;
  let policy = initialPolicy;
  for (let redirectCount = 0; redirectCount <= 4; redirectCount++) {
    if (!policy.allows(pageUrl)) {
      return { skipped: true, reason: `robots.txt disallows ${pageUrl}` };
    }

    let response;
    try {
      response = await pacedGet(pageUrl, Math.max(MIN_REQUEST_GAP_MS, policy.crawlDelay * 1000));
    } catch (error) {
      const detail = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" ? "timeout" : error.message;
      console.warn(`[bulk-enrich] Request failed for ${pageUrl}: ${detail}.`);
      return { skipped: true, reason: detail };
    }

    if (response.status < 300 || response.status >= 400) {
      return { skipped: false, response, pageUrl };
    }
    const location = response.headers?.location;
    if (!location || redirectCount === 4) {
      return { skipped: true, reason: "redirect chain is invalid or too long" };
    }

    let destination;
    try {
      destination = new URL(location, pageUrl);
    } catch {
      return { skipped: true, reason: "invalid redirect destination" };
    }
    if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password ||
      normalizedSocialHost(destination.hostname) !== normalizedSocialHost(rootDomain)) {
      console.info(`[bulk-enrich] Redirect from ${pageUrl} leaves the target domain; not following it.`);
      return { skipped: true, reason: "redirect leaves the target domain" };
    }
    if (!(await companyWebsite.isPublicHost(destination.hostname))) {
      return { skipped: true, reason: "redirect destination is not a public host" };
    }

    const nextPolicy = await getPolicy(destination.origin);
    if (!nextPolicy.ok) return { skipped: true, reason: nextPolicy.reason };
    pageUrl = destination.toString();
    policy = nextPolicy.policy;
  }
  return { skipped: true, reason: "redirect chain is too long" };
}

function mergeSocialLinks(...values) {
  const result = { LinkedIn: [], Twitter: [], Instagram: [], Facebook: [] };
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    for (const key of Object.keys(result)) {
      const items = Array.isArray(value[key]) ? value[key] : value[key] ? [value[key]] : [];
      result[key] = [...new Set([...result[key], ...items.map((item) => String(item).trim()).filter(Boolean)])];
    }
  }
  return result;
}

function hasSocialLinks(links) {
  return Object.values(links || {}).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
}

async function crawlDomain(domain) {
  const result = { domain, emails: [], socialLinks: {}, source: "Web", pagesVisited: [], skipped: false };
  if (!domain) return { ...result, skipped: true, reason: "No domain available for fallback crawling." };

  const origin = `https://${domain}`;
  let publicHost = false;
  try {
    publicHost = await companyWebsite.isPublicHost(domain);
  } catch (error) {
    console.warn(`[bulk-enrich] Could not validate ${domain}: ${error.message}`);
  }
  if (!publicHost) {
    console.warn(`[bulk-enrich] Skipping non-public or invalid host ${domain}.`);
    return { ...result, skipped: true, reason: "Host is not public." };
  }

  const robots = await readRobots(origin);
  if (!robots.ok) return { ...result, skipped: true, reason: robots.reason };
  const policyCache = new Map([[origin, Promise.resolve(robots)]]);
  const getPolicy = async (pageOrigin) => {
    if (!policyCache.has(pageOrigin)) policyCache.set(pageOrigin, readRobots(pageOrigin));
    return policyCache.get(pageOrigin);
  };

  const combined = { LinkedIn: [], Twitter: [], Instagram: [], Facebook: [] };
  const pages = ["/", "/contact"];
  for (const pagePath of pages) {
    const pageUrl = new URL(pagePath, origin).toString();
    const fetched = await fetchPageWithRobots(pageUrl, domain, robots.policy, getPolicy);
    if (fetched.skipped) {
      console.info(`[bulk-enrich] Skipping ${pageUrl}: ${fetched.reason}.`);
      continue;
    }
    const { response } = fetched;
    if (response.status === 403 || response.status === 429) {
      console.warn(`[bulk-enrich] Access denied or rate limited at ${fetched.pageUrl} (HTTP ${response.status}); ending crawl for ${domain}.`);
      break;
    }
    if (response.status < 200 || response.status >= 300) {
      console.info(`[bulk-enrich] Skipping ${fetched.pageUrl}; HTTP ${response.status}.`);
      continue;
    }

    result.pagesVisited.push(fetched.pageUrl);
    const $ = cheerio.load(response.data);
    const pageText = $("body").text(" ");
    result.emails = [...new Set([...result.emails, ...collectEmails($, pageText)])];
    Object.assign(combined, mergeSocialLinks(combined, collectSocialLinks($, fetched.pageUrl)));
  }

  result.socialLinks = combined;
  if (result.emails.length || hasSocialLinks(result.socialLinks)) {
    console.info(`[bulk-enrich] Web fallback found ${result.emails.length} email(s) and ${Object.values(result.socialLinks).flat().length} social link(s) for ${domain}.`);
  }
  return result;
}

module.exports = {
  crawlDomain,
  parseRobotsRules,
  collectEmails,
  collectSocialLinks,
  fetchPageWithRobots,
  readRobots,
  USER_AGENT,
  MIN_REQUEST_GAP_MS
};
