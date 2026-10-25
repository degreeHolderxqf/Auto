const puppeteer = require("puppeteer");
const companyWebsite = require("../providers/companyWebsite");
const normalizer = require("./normalizer");
const validator = require("./validator");

// Keep one browser for the worker pool and cap active tabs to bound memory use.
const MAX_CONCURRENT_PAGES = 3;
const NAVIGATION_TIMEOUT_MS = 15000;
const CONTACT_PATHS = [
  "/pages/contact",
  "/pages/contact-us",
  "/pages/about-us",
  "/policies/privacy-policy",
  "/policies/terms-of-service"
];
const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media"]);
let browserPromise = null;
let browserInstance = null;
let activePages = 0;
const pageWaiters = [];
const publicHostCache = new Map();
let idleCloseTimer = null;

function emptyContactResult() {
  return {
    emails: [],
    whatsappLinks: [],
    whatsappNumbers: [],
    instagramLinks: [],
    facebookLinks: [],
    scannedUrls: []
  };
}

function acquirePageSlot() {
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages++;
    return Promise.resolve();
  }
  return new Promise((resolve) => pageWaiters.push(resolve));
}

function releasePageSlot() {
  const next = pageWaiters.shift();
  if (next) {
    next();
    return;
  }
  activePages = Math.max(0, activePages - 1);
  if (activePages === 0) scheduleIdleClose();
}

function scheduleIdleClose() {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    void closeBrowserIfIdle();
  }, 30000);
  idleCloseTimer.unref?.();
}

async function closeBrowserIfIdle() {
  if (activePages > 0 || !browserPromise) return;
  const pendingBrowser = browserPromise;
  browserPromise = null;
  browserInstance = null;
  try {
    const browser = await pendingBrowser;
    if (browser.connected) await browser.close();
  } catch {
    // Chromium can already be gone after a failed navigation.
  }
}

async function getBrowser() {
  if (browserInstance?.connected) return browserInstance;
  if (browserPromise) return browserPromise;

  browserPromise = puppeteer.launch({ headless: true })
    .then((browser) => {
      browserInstance = browser;
      browser.once("disconnected", () => {
        if (browserInstance === browser) {
          browserInstance = null;
          browserPromise = null;
        }
      });
      return browser;
    })
    .catch((error) => {
      browserInstance = null;
      browserPromise = null;
      throw error;
    });

  return browserPromise;
}

async function isPublicHostCached(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!publicHostCache.has(host)) {
    const check = companyWebsite.isPublicHost(host);
    publicHostCache.set(host, check);
    check.catch(() => publicHostCache.delete(host));
  }
  return publicHostCache.get(host);
}

function isChallenge(status, title, bodyText) {
  if ([401, 403, 429].includes(status)) return true;
  const visibleStart = `${title || ""}\n${String(bodyText || "").slice(0, 1200)}`;
  return /checking your browser|verify you are human|attention required|just a moment|challenge-platform|cf-chl-|captcha/i.test(visibleStart);
}

function findPageEmails(snapshot) {
  const groups = [
    { source: "footer", text: snapshot.footerText },
    { source: "mailto link", text: (snapshot.mailtoLinks || []).join("\n") },
    { source: "body text", text: snapshot.bodyText }
  ];
  const seen = new Set();
  const findings = [];

  for (const group of groups) {
    for (const email of validator.extractEmails(group.text || "")) {
      if (seen.has(email)) continue;
      seen.add(email);
      findings.push({ email, source: group.source });
    }
  }
  return findings;
}

function cleanLinkCandidate(value) {
  return String(value || "").trim().replace(/[),.;!?]+$/g, "");
}

function classifyPublicLink(value, sourceUrl) {
  const candidate = cleanLinkCandidate(value);
  if (!candidate || /^(?:mailto|tel|javascript):/i.test(candidate)) return null;

  try {
    const url = new URL(candidate.startsWith("//") ? `https:${candidate}` : candidate, sourceUrl);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let type = null;
    if (host === "wa.me" || host === "api.whatsapp.com") type = "whatsapp";
    else if (host === "instagram.com") type = "instagram";
    else if (host === "facebook.com" || host === "m.facebook.com" || host === "fb.me") type = "facebook";
    if (!type) return null;

    let phone = null;
    if (type === "whatsapp") {
      if (host === "wa.me") {
        const directNumber = url.pathname.match(/^\/(\+?[0-9]{7,15})(?:\/|$)/)?.[1];
        if (directNumber) phone = directNumber.replace(/\D/g, "");
      } else {
        const queryNumber = url.searchParams.get("phone");
        if (queryNumber && /^\+?[0-9\s().-]{7,20}$/.test(queryNumber)) {
          phone = queryNumber.replace(/\D/g, "");
        }
      }
    }
    return { type, url: url.toString(), phone };
  } catch {
    return null;
  }
}

function findPageLinks(snapshot, sourceUrl) {
  const candidates = [...(snapshot.hrefs || [])];
  const plainUrls = String(snapshot.bodyText || "").match(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi) || [];
  candidates.push(...plainUrls.map((url) => url.startsWith("www.") ? `https://${url}` : url));

  const links = { whatsapp: [], instagram: [], facebook: [] };
  const seen = new Set();
  for (const candidate of candidates) {
    const found = classifyPublicLink(candidate, sourceUrl);
    if (!found || seen.has(`${found.type}:${found.url}`)) continue;
    seen.add(`${found.type}:${found.url}`);
    links[found.type].push(found);
  }
  return links;
}

function addPageLinks(total, pageLinks) {
  const keys = ["whatsapp", "instagram", "facebook"];
  for (const key of keys) {
    const existing = new Set(total[key].map((item) => item.url));
    for (const item of pageLinks[key]) {
      if (existing.has(item.url)) continue;
      total[key].push(item);
      existing.add(item.url);
      console.info(`[email-extractor] Found ${key} link at ${item.url}`);
    }
  }
}

async function scanPage(page, targetUrl, siteDomain) {
  let response = null;
  try {
    // Navigation is restricted by the configured timeout.
    response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS
    });
  } catch (error) {
    console.warn(`[email-extractor] Navigation failed for ${targetUrl}: ${error.message}`);
    return { emails: [], links: { whatsapp: [], instagram: [], facebook: [] }, blocked: true, status: 0, url: targetUrl };
  }

  // Let client-rendered footer content settle briefly without human-like evasion.
  await new Promise((resolve) => setTimeout(resolve, 450));

  let snapshot;
  try {
    snapshot = await page.evaluate(() => ({
      title: document.title || "",
      footerText: Array.from(document.querySelectorAll("footer"))
        .map((footer) => footer.innerText || "")
        .join("\n"),
      bodyText: document.body?.innerText || "",
      mailtoLinks: Array.from(document.querySelectorAll('a[href^="mailto:"]'))
        .map((link) => link.getAttribute("href") || ""),
      hrefs: Array.from(document.querySelectorAll("a[href]"))
        .map((link) => link.getAttribute("href") || "")
    }));
  } catch (error) {
    console.warn(`[email-extractor] Could not inspect rendered content at ${targetUrl}: ${error.message}`);
    return { emails: [], links: { whatsapp: [], instagram: [], facebook: [] }, blocked: true, status: response?.status() || 0, url: targetUrl };
  }

  const status = response?.status() || 0;
  if (isChallenge(status, snapshot.title, snapshot.bodyText)) {
    console.warn(`[email-extractor] Access challenge or denial at ${targetUrl}; stopping without attempting to bypass it.`);
    return { emails: [], links: { whatsapp: [], instagram: [], facebook: [] }, blocked: true, status, url: page.url() || targetUrl };
  }

  const sourceUrl = page.url() || targetUrl;
  let finalDomain;
  try {
    finalDomain = normalizer.normalizeDomain(new URL(sourceUrl).hostname);
  } catch {
    finalDomain = "";
  }
  if (finalDomain !== siteDomain) {
    console.warn(`[email-extractor] Stopped after a cross-site redirect from ${targetUrl}.`);
    return { emails: [], links: { whatsapp: [], instagram: [], facebook: [] }, blocked: true, status, url: sourceUrl };
  }

  const findings = findPageEmails(snapshot);
  const links = findPageLinks(snapshot, sourceUrl);
  for (const finding of findings) {
    console.info(`[email-extractor] Found ${finding.email} in ${finding.source} at ${sourceUrl}`);
  }
  return { emails: findings, links, blocked: false, status, url: sourceUrl };
}

function toEmailContacts(findings, sourceUrl, siteDomain) {
  return findings.map(({ email }) => ({
    email,
    email_type: validator.classifyEmailType(email),
    source_url: sourceUrl,
    confidence: validator.calculateConfidence(email, sourceUrl, siteDomain)
  }));
}

function makePublicLinksResult(contactLinks, scannedUrls) {
  const whatsappLinks = contactLinks.whatsapp;
  return {
    whatsappLinks: whatsappLinks.map(({ url }) => url),
    whatsappNumbers: [...new Set(whatsappLinks.map(({ phone }) => phone).filter(Boolean))],
    instagramLinks: contactLinks.instagram.map(({ url }) => url),
    facebookLinks: contactLinks.facebook.map(({ url }) => url),
    scannedUrls
  };
}

async function extractPublicContacts(websiteUrl) {
  let homepageUrl;
  try {
    homepageUrl = new URL(websiteUrl);
    if (!["http:", "https:"].includes(homepageUrl.protocol) || homepageUrl.username || homepageUrl.password) {
      throw new Error("Only public HTTP or HTTPS storefront URLs are supported.");
    }
    homepageUrl.pathname = "/";
    homepageUrl.search = "";
    homepageUrl.hash = "";
  } catch {
    return emptyContactResult();
  }

  const siteDomain = normalizer.normalizeDomain(homepageUrl.hostname);
  let isPublicHost;
  try {
    isPublicHost = await companyWebsite.isPublicHost(homepageUrl.hostname);
  } catch (error) {
    console.warn(`[email-extractor] Could not validate ${homepageUrl.hostname}: ${error.message}`);
    return emptyContactResult();
  }
  if (!siteDomain || !isPublicHost) {
    console.warn(`[email-extractor] Skipping non-public or invalid host: ${homepageUrl.hostname}`);
    return emptyContactResult();
  }

  await acquirePageSlot();
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    await page.setRequestInterception(true);

    // Retain the public-host SSRF guard and restrict top-level navigation to this site.
    page.on("request", (request) => {
      void (async () => {
        try {
          if (request.isInterceptResolutionHandled?.()) return;
          const requestUrl = request.url();
          if (/^(?:data|blob|about):/i.test(requestUrl)) {
            await request.continue();
            return;
          }

          const parsed = new URL(requestUrl);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            await request.abort();
            return;
          }
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            if (normalizer.normalizeDomain(parsed.hostname) !== siteDomain) {
              await request.abort();
              return;
            }
          }
          if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
            await request.abort();
            return;
          }
          if (!(await isPublicHostCached(parsed.hostname))) {
            await request.abort();
            return;
          }
          await request.continue();
        } catch {
          try {
            if (!request.isInterceptResolutionHandled?.()) await request.abort();
          } catch {
            // Chromium may resolve a request while its page is closing.
          }
        }
      })();
    });

    const contactLinks = { whatsapp: [], instagram: [], facebook: [] };
    const scannedUrls = [];
    const homepage = await scanPage(page, homepageUrl.toString(), siteDomain);
    if (homepage.blocked) return { ...emptyContactResult(), scannedUrls: [homepage.url] };
    scannedUrls.push(homepage.url);
    addPageLinks(contactLinks, homepage.links);
    if (homepage.emails.length) {
      const result = makePublicLinksResult(contactLinks, scannedUrls);
      result.emails = toEmailContacts(homepage.emails, homepage.url, siteDomain);
      return result;
    }

    console.info(`[email-extractor] No email found on homepage ${homepageUrl.origin}; checking contact, about, and policy pages.`);
    for (const contactPath of CONTACT_PATHS) {
      const contactUrl = new URL(contactPath, homepageUrl.origin).toString();
      const result = await scanPage(page, contactUrl, siteDomain);
      if (result.blocked) {
        return { ...makePublicLinksResult(contactLinks, scannedUrls), emails: [] };
      }
      scannedUrls.push(result.url);
      addPageLinks(contactLinks, result.links);
      if (result.emails.length) {
        const contacts = makePublicLinksResult(contactLinks, scannedUrls);
        contacts.emails = toEmailContacts(result.emails, result.url, siteDomain);
        return contacts;
      }
    }

    console.info(`[email-extractor] No public email found on checked pages for ${siteDomain}.`);
    return { ...makePublicLinksResult(contactLinks, scannedUrls), emails: [] };
  } catch (error) {
    console.warn(`[email-extractor] Contact extraction failed for ${siteDomain}: ${error.message}`);
    return emptyContactResult();
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // The page can already be closed after a navigation error.
      }
    }
    releasePageSlot();
  }
}

// Keep the email-only API for any existing callers.
async function extractPublicEmails(websiteUrl) {
  const result = await extractPublicContacts(websiteUrl);
  return result.emails;
}

async function closeEmailBrowser() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
  await closeBrowserIfIdle();
}

module.exports = {
  extractPublicContacts,
  extractPublicEmails,
  closeEmailBrowser,
  MAX_CONCURRENT_PAGES,
  NAVIGATION_TIMEOUT_MS,
  CONTACT_PATHS
};
