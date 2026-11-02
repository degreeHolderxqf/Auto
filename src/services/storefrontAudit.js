const cheerio = require("cheerio");
const { URL } = require("node:url");
const companyWebsite = require("../providers/companyWebsite");
const respectfulCrawler = require("../providers/respectfulDomainCrawler");

const MAX_PAGES = 12;
const MAX_EVIDENCE_PER_ISSUE = 6;

function normalizedHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

function classifyPage(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (/\/products\//.test(path)) return "Product";
  if (/\/collections(?:\/|$)/.test(path)) return "Collection";
  if (/\/pages\/(?:about|our-story|contact|shipping|delivery|refund|return|privacy|terms|faq)/.test(path) ||
      /\/(?:about|contact|shipping|delivery|refund|return|privacy|terms|faq)(?:\/|$)/.test(path)) return "Trust & policies";
  return "Homepage";
}

function cleanPageUrl(href, baseUrl, rootHost) {
  try {
    const url = new URL(href, baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (normalizedHost(url.hostname) !== rootHost) return null;
    url.hash = "";
    url.search = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function discoverPages(homepage, rootHost) {
  const $ = cheerio.load(homepage.html);
  const candidates = new Map();
  $("a[href]").each((_index, anchor) => {
    const url = cleanPageUrl($(anchor).attr("href"), homepage.url, rootHost);
    if (!url || new URL(url).pathname === "/") return;
    const type = classifyPage(url);
    if (!["Product", "Collection", "Trust & policies"].includes(type)) return;
    candidates.set(url, type);
  });

  const entries = [...candidates.entries()];
  const productPages = entries.filter(([, type]) => type === "Product").slice(0, 4);
  const collectionPages = entries.filter(([, type]) => type === "Collection").slice(0, 3);
  const trustPages = entries.filter(([, type]) => type === "Trust & policies").slice(0, 4);
  return [...productPages, ...collectionPages, ...trustPages]
    .slice(0, MAX_PAGES - 1)
    .map(([url, type]) => ({ url, type }));
}

function extractPage(url, type, html, status = 200) {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const description = String($('meta[name="description"]').attr("content") || "").trim();
  const headings = $("h1").map((_index, element) => $(element).text().trim()).get().filter(Boolean);
  const images = $("img");
  let imagesWithoutAlt = 0;
  images.each((_index, image) => {
    if (!String($(image).attr("alt") || "").trim()) imagesWithoutAlt += 1;
  });
  const productLinks = $("a[href*='/products/']").length;
  const hasAddToCart = [
    "form[action*='/cart/add']",
    "button[name='add']",
    "button[name='add-to-cart']",
    ".product-form__submit"
  ].some((selector) => $(selector).length > 0) ||
    $("button, input[type='submit']").toArray().some((element) => {
      const label = `${$(element).text()} ${$(element).attr("value") || ""} ${$(element).attr("aria-label") || ""}`;
      return /\b(?:add to (?:cart|bag)|buy now|purchase)\b/i.test(label);
    });
  const canonical = Boolean($('link[rel="canonical"]').attr("href"));
  const internalLinks = $("a[href]").map((_index, anchor) => cleanPageUrl($(anchor).attr("href"), url, normalizedHost(new URL(url).hostname))).get().filter(Boolean);

  $("script, style, noscript, svg").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const visibleText = $("main").text().replace(/\s+/g, " ").trim() || bodyText;
  const prices = [...new Set((bodyText.match(/(?:[\u0024\u20AC\u00A3\u20B9]\s?\d[\d,.]*|\b(?:USD|EUR|GBP|INR)\s?\d[\d,.]*)/gi) || []).slice(0, 5))];
  const reviewSignals = $("[class*='review'], [id*='review'], [class*='rating'], [id*='rating']").length > 0 ||
    /\b\d+(?:\.\d+)?\s*(?:out of 5|\/\s*5)\b|\b(?:customer )?reviews?\b/i.test(bodyText);
  return {
    url,
    type,
    status,
    title,
    description,
    headings,
    imageCount: images.length,
    imagesWithoutAlt,
    textLength: visibleText.length,
    textExcerpt: visibleText.slice(0, 500),
    bodyText: bodyText.slice(0, 12000),
    productLinks,
    hasAddToCart,
    reviewSignals,
    prices,
    canonical,
    internalLinks: [...new Set(internalLinks)].slice(0, 100)
  };
}

async function crawlStorefront(target, maxPages = MAX_PAGES) {
  const rootHost = normalizedHost(target.hostname);
  const rootUrl = new URL("/", target.origin).toString();
  const pages = [];
  const skipped = [];
  const publicHost = await companyWebsite.isPublicHost(target.hostname);
  if (!publicHost) {
    return {
      pages,
      skipped: [{ url: rootUrl, reason: "Website host is not publicly routable." }],
      limitations: ["The website host could not be verified as public, so no page crawl was performed."]
    };
  }

  const robots = await respectfulCrawler.readRobots(target.origin);
  if (!robots.ok) {
    return {
      pages,
      skipped: [{ url: rootUrl, reason: robots.reason }],
      limitations: ["The robots.txt policy could not be read; pages were not crawled."]
    };
  }
  const policyCache = new Map([[target.origin, Promise.resolve(robots)]]);
  const getPolicy = async (origin) => {
    if (!policyCache.has(origin)) policyCache.set(origin, respectfulCrawler.readRobots(origin));
    return policyCache.get(origin);
  };

  const homeResult = await respectfulCrawler.fetchPageWithRobots(
    rootUrl,
    rootHost,
    robots.policy,
    getPolicy
  );
  if (homeResult.skipped) {
    return {
      pages,
      skipped: [{ url: rootUrl, reason: homeResult.reason }],
      limitations: ["The homepage could not be inspected because it was blocked, unavailable, or disallowed by robots.txt."]
    };
  }
  if (homeResult.response.status < 200 || homeResult.response.status >= 300 ||
      !String(homeResult.response.headers?.["content-type"] || "").toLowerCase().includes("text/html")) {
    return {
      pages,
      skipped: [{ url: homeResult.pageUrl, reason: `Homepage returned HTTP ${homeResult.response.status} or was not HTML.` }],
      limitations: ["The homepage did not return a readable HTML document."]
    };
  }

  const homepage = extractPage(homeResult.pageUrl, "Homepage", homeResult.response.data);
  pages.push(homepage);
  const candidates = discoverPages({ url: homeResult.pageUrl, html: homeResult.response.data }, rootHost)
    .slice(0, Math.max(0, Math.min(Number(maxPages) - 1, MAX_PAGES - 1)));

  for (const candidate of candidates) {
    const result = await respectfulCrawler.fetchPageWithRobots(
      candidate.url,
      rootHost,
      robots.policy,
      getPolicy
    );
    if (result.skipped) {
      skipped.push({ url: candidate.url, reason: result.reason });
      continue;
    }
    const contentType = String(result.response.headers?.["content-type"] || "").toLowerCase();
    if (result.response.status < 200 || result.response.status >= 300 || !contentType.includes("text/html")) {
      skipped.push({ url: result.pageUrl, reason: `Page returned HTTP ${result.response.status} or was not HTML.` });
      continue;
    }
    pages.push(extractPage(result.pageUrl, candidate.type, result.response.data));
  }

  const limitations = [];
  if (pages.length < 2) limitations.push("Only the homepage was available for inspection; product and collection conclusions are limited.");
  if (skipped.length) limitations.push(`${skipped.length} discovered page(s) could not be inspected; see scope notes.`);
  limitations.push("Inspection is limited to publicly returned HTML. JavaScript-only content, logged-in experiences, checkout, and payment behavior were not tested.");
  return { pages, skipped, limitations };
}

function analyzeStorefront(pages, skipped = []) {
  const issues = [];
  const grouped = new Map();
  const addIssue = (definition, page, evidenceDescription) => {
    const key = `${definition.category}|${definition.title}`;
    let issue = grouped.get(key);
    if (!issue) {
      issue = {
        id: `storefront-${issues.length + 1}`,
        category: definition.category,
        title: definition.title,
        priority: definition.priority,
        impact: definition.impact,
        effort: definition.effort,
        observation: definition.observation,
        evidence: [],
        businessImpact: definition.businessImpact,
        recommendation: definition.recommendation,
        verificationStatus: definition.verificationStatus || "verified",
        confidence: definition.confidence || "medium"
      };
      grouped.set(key, issue);
      issues.push(issue);
    }
    if (page && issue.evidence.length < MAX_EVIDENCE_PER_ISSUE) {
      issue.evidence.push({ url: page.url, description: evidenceDescription });
    }
  };

  for (const page of pages) {
    const h1 = page.headings[0] || "";
    if (!page.title) {
      addIssue({
        category: "SEO & search visibility",
        title: "Page title is missing",
        priority: "medium",
        impact: "medium",
        effort: "30–60 minutes per template",
        observation: "No document title was present in the returned HTML.",
        businessImpact: "Search results and browser tabs may not clearly communicate what the page offers.",
        recommendation: "Add a concise, unique title that names the page or product and accurately describes its content."
      }, page, "The <title> element was not present in the returned HTML.");
    }
    if (!page.description) {
      addIssue({
        category: "SEO & search visibility",
        title: "Search description is missing",
        priority: "low",
        impact: "low",
        effort: "30–60 minutes per template",
        observation: "No meta description was detected in the returned HTML.",
        businessImpact: "Search engines may choose a less relevant page excerpt for search results.",
        recommendation: "Write a unique, useful meta description for the page; treat it as a search-result snippet, not a ranking guarantee."
      }, page, "No meta[name=description] element was detected.");
    }
    if (!page.canonical) {
      addIssue({
        category: "SEO & search visibility",
        title: "Canonical URL was not detected",
        priority: "low",
        impact: "low",
        effort: "30–60 minutes",
        observation: "The returned HTML did not contain a canonical link element.",
        businessImpact: "Canonical signals can help search engines understand the preferred URL when duplicate URLs exist.",
        recommendation: "Confirm the theme emits an appropriate canonical URL on this page and validate it in Search Console."
      }, page, "No link[rel=canonical] element was detected.");
    }
    if (page.headings.length === 0) {
      addIssue({
        category: "Mobile usability & accessibility",
        title: "No primary heading was detected",
        priority: "medium",
        impact: "medium",
        effort: "30–60 minutes",
        observation: "No H1 heading was detected in the returned HTML.",
        businessImpact: "Visitors and assistive technologies may have less clear page context.",
        recommendation: "Add one visible, descriptive H1 that reflects the page purpose and verify heading structure on mobile."
      }, page, "No H1 element was detected in the returned HTML.");
    } else if (page.headings.length > 1) {
      addIssue({
        category: "SEO & search visibility",
        title: "Multiple primary headings were detected",
        priority: "low",
        impact: "low",
        effort: "30–60 minutes",
        observation: `${page.headings.length} H1 headings were detected on this page.`,
        businessImpact: "A clear heading hierarchy makes page structure easier to understand and maintain.",
        recommendation: "Review the heading hierarchy and use one clear page-level heading, with subsequent headings nested by section."
      }, page, `Detected headings: ${page.headings.slice(0, 4).join(" | ")}`);
    }
    if (page.imagesWithoutAlt > 0) {
      addIssue({
        category: "Mobile usability & accessibility",
        title: "Some images lack alternative text",
        priority: "medium",
        impact: "medium",
        effort: "30–60 minutes per affected template",
        observation: `${page.imagesWithoutAlt} of ${page.imageCount} inspected image(s) had no non-empty alt text.`,
        businessImpact: "Meaningful product and promotional images may be less understandable to screen-reader users.",
        recommendation: "Add concise, accurate alt text to informative images; use empty alt text only for decorative images."
      }, page, `${page.imagesWithoutAlt} of ${page.imageCount} <img> elements had missing or blank alt attributes.`);
    }
  }

  const homepage = pages.find((page) => page.type === "Homepage");
  if (homepage) {
    if (!homepage.headings.length) {
      addIssue({
        category: "Homepage",
        title: "Homepage value proposition is not expressed as a detected heading",
        priority: "high",
        impact: "high",
        effort: "1–2 hours",
        observation: "The homepage returned no H1 heading in its HTML. Image-based text or JavaScript-rendered content may not be represented in this inspection.",
        businessImpact: "A first-time visitor may have to infer the store's offer and next step from visual content.",
        recommendation: "Add a concise live-text headline that explains the store's offer and a visible route to a relevant collection."
      }, homepage, "No H1 element was detected on the homepage.");
    }
    const homeText = homepage.bodyText.toLowerCase();
    const hasShoppingCta = homepage.internalLinks.some((url) => /\/(?:products|collections)(?:\/|$)/i.test(new URL(url).pathname));
    if (!hasShoppingCta) {
      addIssue({
        category: "Homepage",
        title: "A direct product-discovery link was not detected",
        priority: "medium",
        impact: "medium",
        effort: "1–2 hours",
        observation: "No internal link to a product or collection page was detected in the homepage HTML.",
        businessImpact: "Visitors may need extra navigation steps before reaching the catalog.",
        recommendation: "Provide a clear, keyboard-accessible Shop or Browse collections link in the visible homepage content."
      }, homepage, "No homepage anchor pointed to a /products/ or /collections/ path.");
    }
    if (!/\b(?:shipping|delivery|dispatch|returns?|refunds?)\b/i.test(homeText)) {
      addIssue({
        category: "Trust & policies",
        title: "Delivery and returns information was not detected on the homepage",
        priority: "low",
        impact: "low",
        effort: "1 hour",
        observation: "Delivery or returns wording was not found in the homepage text returned to this audit.",
        businessImpact: "Visitors may need to leave the page to answer basic fulfilment questions.",
        recommendation: "Surface accurate delivery and returns information near product discovery or link to the relevant policy."
      }, homepage, "The returned homepage text contained no delivery, shipping, return, or refund terms.");
    }
  }

  const productPages = pages.filter((page) => page.type === "Product");
  for (const page of productPages) {
    if (!page.prices.length) {
      addIssue({
        category: "Product pages",
        title: "Product price was not detected in returned HTML",
        priority: "high",
        impact: "high",
        effort: "Needs verification",
        observation: "No recognizable price string was detected in the returned product-page text.",
        businessImpact: "If price is not visible to shoppers, they cannot assess the purchase before interacting with the page.",
        recommendation: "Verify the price is visible on initial load and remains clear when product variants are selected.",
        verificationStatus: "needs_verification",
        confidence: "low"
      }, page, "Price patterns were not found in the returned page text; dynamic rendering can affect detection.");
    }
    if (!page.hasAddToCart) {
      addIssue({
        category: "Product pages",
        title: "Add-to-cart control was not detected in returned HTML",
        priority: "high",
        impact: "high",
        effort: "Needs verification",
        observation: "The inspected HTML did not contain a recognizable add-to-cart form or button.",
        businessImpact: "If shoppers cannot find the purchase action, the product page may not support a clear buying journey.",
        recommendation: "Verify the add-to-cart control is visible, labeled, and usable on desktop and mobile; this audit did not submit a cart action.",
        verificationStatus: "needs_verification",
        confidence: "low"
      }, page, "No recognized /cart/add form or add-to-cart button selector was detected.");
    }
    if (!page.reviewSignals) {
      addIssue({
        category: "Product pages",
        title: "Review or rating content was not detected",
        priority: "medium",
        impact: "medium",
        effort: "Needs verification",
        observation: "Review or rating markers were not detected in the HTML returned for this product page.",
        businessImpact: "First-time shoppers may have less on-page customer evidence to inform a purchase.",
        recommendation: "Confirm whether reviews are present after client-side rendering. If none are available, invite genuine customers to share honest feedback.",
        verificationStatus: "needs_verification",
        confidence: "low"
      }, page, "No review/rating markup or review wording was detected in the returned HTML.");
    }
    if (page.textLength < 120) {
      addIssue({
        category: "Product pages",
        title: "Limited product explanation was detected",
        priority: "medium",
        impact: "medium",
        effort: "1–2 hours",
        observation: `Only ${page.textLength} characters of main/body text were available in the returned HTML.`,
        businessImpact: "Shoppers may not have enough product context to assess features, fit, or use.",
        recommendation: "Verify the rendered page and provide concise benefits, specifications, usage guidance, and relevant purchase information."
      }, page, "Extracted product-page text was shorter than 120 characters.");
    }
  }

  const collectionPages = pages.filter((page) => page.type === "Collection");
  for (const page of collectionPages) {
    if (page.productLinks >= 2 && page.textLength < 250) {
      addIssue({
        category: "Collection & discovery",
        title: "Collection guidance was limited in returned HTML",
        priority: "low",
        impact: "low",
        effort: "1 hour",
        observation: `The collection linked to ${page.productLinks} product URL(s), while its extracted text was limited (${page.textLength} characters).`,
        businessImpact: "A short introduction can help shoppers understand how products differ and which one to explore.",
        recommendation: "If it fits the brand, add a brief collection introduction and clear product-selection cues without pushing products below the fold."
      }, page, `Found ${page.productLinks} product links and ${page.textLength} characters of extracted text.`);
    }
  }

  const allText = pages.map((page) => page.bodyText).join(" ").toLowerCase();
  const foundPolicyTypes = new Set(pages.filter((page) => page.type === "Trust & policies").map((page) => {
    const path = new URL(page.url).pathname.toLowerCase();
    if (/refund|return/.test(path)) return "returns";
    if (/shipping|delivery/.test(path)) return "shipping";
    if (/contact/.test(path)) return "contact";
    if (/about|story/.test(path)) return "about";
    return "policy";
  }));
  for (const [label, pattern] of [
    ["returns", /\/(?:pages\/)?(?:refund|return)/i],
    ["shipping", /\/(?:pages\/)?(?:shipping|delivery)/i],
    ["contact", /\/(?:pages\/)?contact/i],
    ["about", /\/(?:pages\/)?(?:about|our-story)/i]
  ]) {
    const hasLink = pages.some((page) => page.internalLinks.some((url) => pattern.test(new URL(url).pathname)));
    if (!hasLink && !foundPolicyTypes.has(label) && !allText.includes(label)) {
      addIssue({
        category: "Trust & policies",
        title: `${label[0].toUpperCase()}${label.slice(1)} information was not detected in the inspected pages`,
        priority: label === "returns" || label === "shipping" ? "medium" : "low",
        impact: label === "returns" || label === "shipping" ? "medium" : "low",
        effort: "Needs verification",
        observation: `A ${label} page or clear ${label} information was not detected in the pages inspected by this audit.`,
        businessImpact: "Shoppers may need to search for this information before deciding whether to purchase.",
        recommendation: `Confirm that the ${label} information is available and link to it from the site navigation or relevant product pages.`,
        verificationStatus: "needs_verification",
        confidence: "low"
      }, homepage || null, `No ${label} page link or matching text was detected in the inspected pages.`);
    }
  }

  if (skipped.length) {
    issues.push({
      id: `storefront-${issues.length + 1}`,
      category: "Audit scope",
      title: "Some discovered pages could not be inspected",
      priority: "low",
      impact: "low",
      effort: "Needs verification",
      observation: `${skipped.length} page(s) were discovered but not inspected.`,
      evidence: skipped.slice(0, MAX_EVIDENCE_PER_ISSUE).map((page) => ({ url: page.url, description: page.reason })),
      businessImpact: "The audit may not cover all store templates and customer-facing policies.",
      recommendation: "Review the scope notes and inspect inaccessible pages manually before making changes.",
      verificationStatus: "needs_verification",
      confidence: "high"
    });
  }
  return issues;
}

function buildAuditReport(auditInfo, crawl, issues, pageSpeedFindings = []) {
  const combinedIssues = [...issues];
  for (const finding of pageSpeedFindings) {
    combinedIssues.push({
      id: finding.id,
      category: "Performance & technical",
      title: finding.title,
      priority: Number(finding.score) < 0.5 ? "high" : "medium",
      impact: Number(finding.score) < 0.5 ? "high" : "medium",
      effort: "Needs technical review",
      observation: finding.observation,
      evidence: [{ url: auditInfo.website_url, description: `${finding.displayValue} · ${finding.source}` }],
      businessImpact: "Slow or unstable rendering can make product discovery and purchase interactions less comfortable, particularly on mobile connections.",
      recommendation: finding.solution,
      verificationStatus: "verified",
      confidence: "high"
    });
  }

  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  combinedIssues.sort((left, right) =>
    (priorityOrder[left.priority] ?? 4) - (priorityOrder[right.priority] ?? 4) ||
    Number(right.verificationStatus === "verified") - Number(left.verificationStatus === "verified")
  );
  const priorityCounts = combinedIssues.reduce((counts, issue) => {
    counts[issue.priority] = (counts[issue.priority] || 0) + 1;
    return counts;
  }, {});
  const verifiedCount = combinedIssues.filter((issue) => issue.verificationStatus === "verified").length;
  const needsVerificationCount = combinedIssues.length - verifiedCount;
  const homepage = crawl.pages.find((page) => page.type === "Homepage");
  const categories = [...new Set(combinedIssues.map((issue) => issue.category))];
  const summaryParts = [];
  summaryParts.push(`The inspection reviewed ${crawl.pages.length} publicly accessible page(s)${homepage ? " including the homepage" : ""}.`);
  if (verifiedCount) {
    const top = combinedIssues.filter((issue) => issue.verificationStatus === "verified")
      .sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a.priority) - ["critical", "high", "medium", "low"].indexOf(b.priority))
      .slice(0, 2)
      .map((issue) => issue.title.toLowerCase());
    summaryParts.push(`Verified observations include ${top.join(" and ")}.`);
  } else {
    summaryParts.push("No verified issues were found in the inspected content; this does not establish that the store has no usability or conversion issues.");
  }
  if (needsVerificationCount) {
    summaryParts.push(`${needsVerificationCount} item(s) require manual or browser-based verification before being treated as confirmed issues.`);
  }
  if (crawl.pages.length < 2) {
    summaryParts.push("The limited page coverage means product- and collection-level conclusions are incomplete.");
  }

  return {
    version: 1,
    generatedAt: auditInfo.created_at || new Date().toISOString(),
    scope: "Public storefront pages linked from the homepage, plus the selected PageSpeed Insights strategy.",
    pagesInspected: crawl.pages.map(({ url, type, status }) => ({ url, type, status })),
    pagesSkipped: crawl.skipped,
    limitations: crawl.limitations,
    sections: categories,
    executiveSummary: summaryParts.join(" "),
    priorityCounts,
    verifiedCount,
    needsVerificationCount,
    overallAssessment: crawl.pages.length < 2
      ? "PARTIAL — limited page coverage"
      : (needsVerificationCount ? "EVIDENCE-BASED — some checks need verification" : "EVIDENCE-BASED"),
    recommendedFirstSteps: combinedIssues
      .filter((issue) => issue.verificationStatus === "verified")
      .slice(0, 3)
      .map((issue) => issue.title),
    issues: combinedIssues
  };
}

module.exports = {
  crawlStorefront,
  analyzeStorefront,
  buildAuditReport,
  extractPage,
  discoverPages
};
