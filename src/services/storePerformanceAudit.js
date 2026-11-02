const { URL } = require("node:url");
const config = require("../config");
const db = require("../db/database");
const logger = require("./logger");
const companyWebsite = require("../providers/companyWebsite");
const merchantIngestion = require("./merchantIngestion");
const emailSender = require("./emailSender");
const emailTemplates = require("./emailTemplates");
const storefrontAudit = require("./storefrontAudit");

const ALLOWED_STRATEGIES = new Set(["mobile", "desktop"]);
const ALLOWED_MODES = new Set(["short", "report"]);
const AUDIT_DETAILS = {
  "largest-contentful-paint": {
    label: "Largest Contentful Paint",
    solution: "I can review the page's critical rendering path and prioritize the largest above-the-fold content."
  },
  "first-contentful-paint": {
    label: "First Contentful Paint",
    solution: "I can review the critical CSS and initial theme requests to identify what delays the first visible content."
  },
  "speed-index": {
    label: "Speed Index",
    solution: "I can inspect the storefront's critical rendering path and prioritize the assets that delay visible content."
  },
  "total-blocking-time": {
    label: "Total Blocking Time",
    solution: "I can inspect theme and third-party scripts and identify non-critical work that can be deferred."
  },
  "cumulative-layout-shift": {
    label: "Cumulative Layout Shift",
    solution: "I can review image, embed, and theme-section sizing to reduce unexpected layout movement."
  },
  "server-response-time": {
    label: "Initial server response",
    solution: "I can review storefront requests and theme-level work that may be contributing to the initial response time."
  },
  "render-blocking-resources": {
    label: "Render-blocking resources",
    solution: "I can inspect critical CSS and scripts and identify non-essential resources that can load later."
  },
  "unused-javascript": {
    label: "Unused JavaScript",
    solution: "I can review app and theme scripts to identify JavaScript that can be removed or loaded only when needed."
  },
  "unused-css-rules": {
    label: "Unused CSS",
    solution: "I can inspect theme and app stylesheets and identify unused rules that can be safely removed."
  },
  "uses-optimized-images": {
    label: "Image optimization",
    solution: "I can review product-image dimensions, formats, and responsive delivery to reduce unnecessary image bytes."
  },
  "modern-image-formats": {
    label: "Modern image formats",
    solution: "I can review image delivery and help serve appropriately sized modern formats where the storefront supports them."
  },
  "offscreen-images": {
    label: "Offscreen images",
    solution: "I can review below-the-fold images and ensure they load only when needed."
  }
};

function auditFailure(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getDatabase() {
  return db.getRawDb();
}

function getAuditById(id) {
  return getDatabase().prepare(`
    SELECT a.*, c.name AS store_name, c.domain, ct.email AS recipient_email,
           ct.name AS contact_name
    FROM merchant_performance_audits a
    JOIN companies c ON c.id = a.company_id
    LEFT JOIN contacts ct ON ct.company_id = c.id AND ct.email IS NOT NULL
    WHERE a.id = ?
    ORDER BY ct.id ASC
    LIMIT 1
  `).get(Number(id)) || null;
}

function parseAudit(row) {
  if (!row) return null;
  let findings = [];
  let metrics = {};
  let report = null;
  try {
    findings = JSON.parse(row.findings_json || "[]");
  } catch (error) {
    throw new Error(`Audit ${row.id} has invalid stored findings: ${error.message}`);
  }
  try {
    metrics = JSON.parse(row.metrics_json || "{}");
  } catch (error) {
    throw new Error(`Audit ${row.id} has invalid stored metrics: ${error.message}`);
  }
  try {
    report = JSON.parse(row.detailed_report_json || "null");
  } catch (error) {
    throw new Error(`Audit ${row.id} has invalid stored detailed report: ${error.message}`);
  }
  if (!report || typeof report !== "object" || !Array.isArray(report.issues) || !Array.isArray(report.pagesInspected)) {
    report = null;
  }
  const { findings_json, metrics_json, detailed_report_json, ...audit } = row;
  return { ...audit, findings, metrics, report };
}

function sanitizeTargetUrl(lead) {
  const candidate = lead.website_url || lead.official_website || `https://${lead.domain}`;
  let target;
  try {
    target = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    throw auditFailure("The merchant website URL is invalid.");
  }
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) {
    throw auditFailure("The merchant website must use a public HTTP or HTTPS URL.");
  }
  target.hash = "";
  target.search = "";
  if (target.pathname === "/") target.pathname = "";
  return target;
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      throw new Error(`The audit provider returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const message = parsed?.error?.message || parsed?.message || `HTTP ${response.status}`;
      throw new Error(`Audit provider request failed: ${message}`);
    }
    return parsed;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The audit provider request timed out. Please retry.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatMetric(value, unit) {
  if (!Number.isFinite(value)) return null;
  if (unit === "millisecond") return `${(value / 1000).toFixed(1)} s`;
  if (unit === "numeric") return value.toFixed(2);
  return String(Math.round(value));
}

function collectFindings(lighthouseResult) {
  const audits = lighthouseResult?.audits || {};
  const findings = [];

  const metricAudits = [
    ["largest-contentful-paint", "millisecond", 2500],
    ["first-contentful-paint", "millisecond", 1800],
    ["speed-index", "millisecond", 3400],
    ["total-blocking-time", "millisecond", 200],
    ["cumulative-layout-shift", "numeric", 0.1]
  ];
  for (const [id, unit, threshold] of metricAudits) {
    const audit = audits[id];
    const value = Number(audit?.numericValue);
    if (!audit || !Number.isFinite(value) || value <= threshold) continue;
    const definition = AUDIT_DETAILS[id];
    findings.push({
      id,
      title: definition.label,
      observation: `${definition.label} measured ${formatMetric(value, unit)} in the ${lighthouseResult.configSettings?.formFactor || "mobile"} PageSpeed audit.`,
      displayValue: audit.displayValue || formatMetric(value, unit),
      score: audit.score,
      solution: definition.solution,
      source: "Google PageSpeed Insights / Lighthouse"
    });
  }

  for (const [id, definition] of Object.entries(AUDIT_DETAILS)) {
    if (metricAudits.some(([metricId]) => metricId === id)) continue;
    const audit = audits[id];
    if (!audit || !Number.isFinite(audit.score) || audit.score >= 0.9 || !audit.displayValue) continue;
    findings.push({
      id,
      title: definition.label,
      observation: `${definition.label}: ${String(audit.displayValue).slice(0, 180)}.`,
      displayValue: String(audit.displayValue).slice(0, 180),
      score: audit.score,
      solution: definition.solution,
      source: "Google PageSpeed Insights / Lighthouse"
    });
  }
  return findings.slice(0, 4);
}

function getMetrics(lighthouseResult) {
  const audits = lighthouseResult?.audits || {};
  const names = [
    ["first-contentful-paint", "First Contentful Paint"],
    ["largest-contentful-paint", "Largest Contentful Paint"],
    ["total-blocking-time", "Total Blocking Time"],
    ["cumulative-layout-shift", "Cumulative Layout Shift"],
    ["speed-index", "Speed Index"]
  ];
  return Object.fromEntries(names
    .filter(([id]) => audits[id]?.displayValue)
    .map(([id, label]) => [label, audits[id].displayValue]));
}

async function runPageSpeed(target, strategy) {
  if (!config.pageSpeedApiKey) {
    throw auditFailure("PageSpeed Insights is not configured. Set PAGESPEED_API_KEY in the backend environment.", 503);
  }
  const url = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  url.searchParams.set("url", target.toString());
  url.searchParams.set("key", config.pageSpeedApiKey);
  url.searchParams.set("strategy", strategy.toUpperCase());
  url.searchParams.append("category", "PERFORMANCE");
  return fetchJson(url.toString(), {}, 45000);
}

function getVerifiedLcpValue(metrics, lcpAudit) {
  const value = metrics?.["Largest Contentful Paint"];
  if (typeof value === "string") {
    const cleaned = value.trim();
    if (/^\d+(?:[.,]\d+)?\s*(?:ms|s|sec|seconds?)?$/i.test(cleaned)) return cleaned;
  }
  return Number.isFinite(lcpAudit?.numericValue) && lcpAudit.numericValue > 0
    ? formatMetric(lcpAudit.numericValue, "millisecond")
    : null;
}

function generateAuditDraft(lead, metrics, strategy = "mobile", lcpAudit = null) {
  const storeName = String(lead.store_name || lead.name || "your Shopify store")
    .replace(/[\r\n]/g, " ").slice(0, 120);
  const strategyLabel = strategy === "desktop" ? "desktop" : "mobile";
  const lcpValue = getVerifiedLcpValue(metrics, lcpAudit);
  const auditContext = lcpValue
    ? `I was reviewing your store's ${strategyLabel} performance through Google PageSpeed Insights and noticed that its Largest Contentful Paint (LCP) reached ${lcpValue} in the ${strategyLabel} audit.\n\nWhen key content takes this long to appear, visitors may experience a slower, less seamless shopping journey. This can create friction during product discovery and potentially affect engagement and conversion opportunities.`
    : `I reviewed your store's ${strategyLabel} performance through Google PageSpeed Insights and would be happy to discuss opportunities to create a smoother shopping experience.`;

  return {
    subject: `${storeName}: A ${strategyLabel} performance opportunity`.slice(0, 200),
    body: [
      `Hi ${storeName} Team,`,
      "",
      auditContext,
      "",
      "I specialize in Shopify performance optimization, UX improvements, and CRO-focused enhancements. I'd be happy to help identify what's slowing down your store, prioritize the most impactful fixes, and create a smoother shopping experience without compromising your brand's design.",
      "",
      "Would you be open to a quick conversation about a few opportunities I noticed?",
      "",
      `Portfolio: ${emailTemplates.PORTFOLIO_URL}`,
      "",
      "Best regards,\nHimanshu Soni\nShopify Developer | Performance, UX & CRO"
    ].join("\n")
  };
}

function createAuditRecord(leadId, websiteUrl, strategy, mode) {
  const result = getDatabase().prepare(`
    INSERT INTO merchant_performance_audits
      (company_id, website_url, strategy, email_mode, status)
    VALUES (?, ?, ?, ?, 'ANALYZING')
  `).run(leadId, websiteUrl, strategy, mode);
  return Number(result.lastInsertRowid);
}

async function createAudit({ leadId, mode = "short", strategy = "mobile" }) {
  const id = Number(leadId);
  if (!Number.isSafeInteger(id) || id <= 0) throw auditFailure("leadId must be a positive integer.");
  if (!ALLOWED_MODES.has(mode)) throw auditFailure("mode must be 'short' or 'report'.");
  if (!ALLOWED_STRATEGIES.has(strategy)) throw auditFailure("strategy must be 'mobile' or 'desktop'.");

  const lead = merchantIngestion.getMerchantLeadById(id);
  if (!lead) throw auditFailure("Merchant lead not found.", 404);
  const target = sanitizeTargetUrl(lead);
  if (!(await companyWebsite.isPublicHost(target.hostname))) {
    throw auditFailure("The merchant website host is not publicly routable.");
  }
  const websiteUrl = target.toString();
  const auditId = createAuditRecord(id, websiteUrl, strategy, mode);

  try {
    const [pageSpeedOutcome, crawlOutcome] = await Promise.allSettled([
      runPageSpeed(target, strategy),
      storefrontAudit.crawlStorefront(target)
    ]);
    if (pageSpeedOutcome.status === "rejected") throw pageSpeedOutcome.reason;
    const pageSpeed = pageSpeedOutcome.value;
    const crawl = crawlOutcome.status === "fulfilled"
      ? crawlOutcome.value
      : {
          pages: [],
          skipped: [{ url: websiteUrl, reason: "The public page inspection failed unexpectedly." }],
          limitations: ["The public page inspection failed; only PageSpeed results are included."]
        };
    if (crawlOutcome.status === "rejected") {
      logger.warn(`Storefront page inspection failed for audit ${auditId}`, crawlOutcome.reason);
    }
    const lighthouse = pageSpeed.lighthouseResult;
    if (!lighthouse) throw new Error("PageSpeed Insights did not return a Lighthouse result.");
    const findings = collectFindings(lighthouse);
    const storefrontFindings = storefrontAudit.analyzeStorefront(crawl.pages, crawl.skipped);
    const performanceScore = Number.isFinite(lighthouse.categories?.performance?.score)
      ? Math.round(lighthouse.categories.performance.score * 100)
      : null;
    const metrics = getMetrics(lighthouse);
    const createdAt = new Date().toISOString();
    const report = storefrontAudit.buildAuditReport({
      website_url: websiteUrl,
      created_at: createdAt
    }, crawl, storefrontFindings, findings);
    const draftFindings = findings.length
      ? findings
      : report.issues.filter((issue) => issue.verificationStatus === "verified").map((issue) => ({
          id: issue.id,
          title: issue.title,
          observation: issue.observation,
          displayValue: issue.observation,
          score: null,
          solution: issue.recommendation,
          source: issue.category
        }));
    let draft = null;
    if (draftFindings.length) {
      draft = generateAuditDraft(
        lead,
        metrics,
        strategy,
        lighthouse.audits?.["largest-contentful-paint"]
      );
    }
    getDatabase().prepare(`
      UPDATE merchant_performance_audits
      SET status = 'REVIEW', performance_score = ?, findings_json = ?, metrics_json = ?,
          detailed_report_json = ?, email_subject = ?, email_body = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'ANALYZING'
    `).run(
      performanceScore,
      JSON.stringify(findings),
      JSON.stringify(metrics),
      JSON.stringify(report),
      draft?.subject || null,
      draft?.body || null,
      auditId
    );
  } catch (error) {
    getDatabase().prepare(`
      UPDATE merchant_performance_audits
      SET status = 'FAILED', error = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'ANALYZING'
    `).run(String(error.message || "Audit failed").slice(0, 1000), auditId);
    throw error;
  }
  return getAudit(auditId);
}

function getAudit(id) {
  return parseAudit(getAuditById(id));
}

function listAudits(status = null) {
  const allowedStatuses = new Set(["ANALYZING", "REVIEW", "APPROVED", "SENDING", "SENT", "DRY_RUN_SENT", "FAILED"]);
  if (status && !allowedStatuses.has(status)) throw auditFailure("Unknown audit status.");
  const rows = status
    ? getDatabase().prepare(`
        SELECT a.*, c.name AS store_name, c.domain, ct.email AS recipient_email,
               ct.name AS contact_name
        FROM merchant_performance_audits a
        JOIN companies c ON c.id = a.company_id
        LEFT JOIN contacts ct ON ct.company_id = c.id AND ct.email IS NOT NULL
        WHERE a.status = ?
        ORDER BY a.created_at DESC
        LIMIT 200
      `).all(status)
    : getDatabase().prepare(`
        SELECT a.*, c.name AS store_name, c.domain, ct.email AS recipient_email,
               ct.name AS contact_name
        FROM merchant_performance_audits a
        JOIN companies c ON c.id = a.company_id
        LEFT JOIN contacts ct ON ct.company_id = c.id AND ct.email IS NOT NULL
        ORDER BY a.created_at DESC
        LIMIT 200
      `).all();
  return rows.map(parseAudit);
}

function updateDraft(id, { subject, body, mode }) {
  const audit = getAudit(id);
  if (!audit) throw auditFailure("Audit not found.", 404);
  if (audit.status !== "REVIEW") throw auditFailure("Only drafts awaiting review can be edited.");
  if (typeof subject !== "string" || !subject.trim() || subject.trim().length > 200) {
    throw auditFailure("Subject is required and must be 200 characters or fewer.");
  }
  if (typeof body !== "string" || body.trim().length < 40 || body.length > 5000) {
    throw auditFailure("Email body must be between 40 and 5,000 characters.");
  }
  const nextMode = mode === undefined ? audit.email_mode : mode;
  if (!ALLOWED_MODES.has(nextMode)) throw auditFailure("mode must be 'short' or 'report'.");
  getDatabase().prepare(`
    UPDATE merchant_performance_audits
    SET email_subject = ?, email_body = ?, email_mode = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'REVIEW'
  `).run(subject.trim(), body.trim(), nextMode, Number(id));
  return getAudit(id);
}

function approveAudit(id) {
  const result = getDatabase().prepare(`
    UPDATE merchant_performance_audits
    SET status = 'APPROVED', approved_at = datetime('now'), error = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND status = 'REVIEW'
      AND email_subject IS NOT NULL AND email_body IS NOT NULL
  `).run(Number(id));
  if (!result.changes) {
    const audit = getAudit(id);
    if (!audit) throw auditFailure("Audit not found.", 404);
    throw auditFailure("Only a complete draft awaiting review can be approved.");
  }
  return getAudit(id);
}

function pdfEscape(value) {
  return String(value || "")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapPdfText(value, maxLength = 82) {
  const words = String(value || "").replace(/[^\x20-\x7E]/g, "?").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxLength) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function performanceSeverity(score) {
  if (!Number.isFinite(score)) return { label: "SCORE UNAVAILABLE", color: [0.75, 0.35, 0.05] };
  if (score < 50) return { label: "POOR - ATTENTION REQUIRED", color: [0.72, 0.12, 0.12] };
  if (score < 90) return { label: "NEEDS IMPROVEMENT", color: [0.78, 0.38, 0.04] };
  return { label: "GOOD", color: [0.08, 0.43, 0.28] };
}

function generateReportPdf(audit) {
  const report = audit.report && typeof audit.report === "object" ? audit.report : null;
  const issues = Array.isArray(report?.issues) ? report.issues : [];
  const legacyFindings = Array.isArray(audit.findings) ? audit.findings : [];
  const safeMetrics = audit.metrics && typeof audit.metrics === "object" ? Object.entries(audit.metrics) : [];
  const severity = performanceSeverity(audit.performance_score);
  const pageStreams = [];
  let commands = [];
  let y = 790;

  const startPage = () => {
    commands = [];
    rectangle(0, 744, 612, 98, [0.10, 0.13, 0.18]);
    textAt(42, 810, "SHOPIFY STORE PERFORMANCE & CRO AUDIT", 15, "F2", [1, 1, 1]);
    textAt(42, 787, `${audit.store_name || "Shopify Store"}  |  ${audit.domain || audit.website_url}`, 10, "F1", [0.88, 0.91, 0.95]);
    textAt(42, 768, `${(audit.strategy || "mobile").toUpperCase()} PageSpeed run  |  ${audit.created_at || "Date unavailable"}`, 9, "F1", [0.75, 0.80, 0.87]);
    y = 724;
  };
  const finishPage = () => {
    rectangle(36, 50, 540, 1, [0.82, 0.84, 0.87]);
    textAt(42, 35, "Prepared by Himanshu Soni | Shopify Performance Developer", 8, "F2", [0.24, 0.28, 0.34]);
    textAt(42, 22, emailTemplates.PORTFOLIO_URL, 8, "F1", [0.08, 0.32, 0.58]);
    pageStreams.push(Buffer.from(commands.join("\n"), "ascii"));
  };
  const rectangle = (x, yPos, width, height, color, stroke = false) => {
    commands.push(`${color[0]} ${color[1]} ${color[2]} ${stroke ? "RG" : "rg"}`);
    commands.push(`${x} ${yPos} ${width} ${height} re ${stroke ? "S" : "f"}`);
  };
  const textAt = (x, yPos, value, size = 10, font = "F1", color = [0.12, 0.16, 0.22]) => {
    commands.push(`${color[0]} ${color[1]} ${color[2]} rg`);
    commands.push(`BT /${font} ${size} Tf ${x} ${yPos} Td (${pdfEscape(value)}) Tj ET`);
  };
  const ensureSpace = (height) => {
    if (y - height < 68) {
      finishPage();
      startPage();
    }
  };
  const addLine = (text, options = {}) => {
    const size = options.size || 9;
    const font = options.bold ? "F2" : "F1";
    const color = options.color || [0.17, 0.20, 0.25];
    const lineHeight = options.lineHeight || size + 4;
    const lines = wrapPdfText(text, options.maxLength || 90);
    for (const line of lines) {
      ensureSpace(lineHeight);
      textAt(options.x || 42, y, line, size, font, color);
      y -= lineHeight;
    }
    y -= options.after || 0;
  };
  const addSection = (heading) => {
    ensureSpace(32);
    y -= 4;
    addLine(heading.toUpperCase(), { size: 12, bold: true, color: [0.10, 0.31, 0.50], after: 5, maxLength: 80 });
  };
  const addField = (label, text) => {
    addLine(label, { size: 9, bold: true, color: [0.20, 0.24, 0.30], after: 1 });
    addLine(text || "Not available from the inspected evidence.", { size: 9, after: 4 });
  };

  startPage();
  textAt(42, y, "Store performance and conversion review", 18, "F2", [0.10, 0.13, 0.18]);
  y -= 28;
  addLine(`Website: ${audit.website_url || "Unavailable"}`, { size: 10, bold: true });
  addLine(`Audit date: ${report?.generatedAt || audit.created_at || "Unavailable"} | Scope: ${report?.overallAssessment || "PageSpeed and publicly accessible storefront HTML"}`, { size: 9, after: 5 });
  rectangle(36, y - 48, 540, 42, severity.color);
  textAt(48, y - 22, `${severity.label} | Performance score: ${Number.isFinite(audit.performance_score) ? `${audit.performance_score}/100` : "Unavailable"}`, 10, "F2", [1, 1, 1]);
  y -= 62;
  addSection("Executive summary");
  addLine(report?.executiveSummary || "This report contains PageSpeed observations from a single test run. A multi-page storefront inspection was not stored for this audit.", { size: 9, after: 5 });
  addSection("Audit scope");
  addField("Pages inspected", report?.pagesInspected?.length
    ? report.pagesInspected.map((page) => `${page.type}: ${page.url}`).join(" | ")
    : "No storefront pages were successfully inspected.");
  if (report?.pagesSkipped?.length) {
    addField("Pages not inspected", report.pagesSkipped.map((page) => `${page.url} (${page.reason})`).join(" | "));
  }
  addField("Inspection limits", report?.limitations?.join(" ") ||
    "PageSpeed is one test run and does not establish conversion, checkout, or payment outcomes.");
  addSection("Performance measurements");
  addLine(`PageSpeed score: ${Number.isFinite(audit.performance_score) ? `${audit.performance_score}/100` : "Unavailable"} (${severity.label})`, { bold: true });
  for (const [name, value] of safeMetrics) addLine(`${name}: ${value}`, { size: 9 });
  addLine("Source: Google PageSpeed Insights / Lighthouse. Results vary between runs and network conditions.", { size: 8, color: [0.38, 0.41, 0.46], after: 5 });

  const counts = report?.priorityCounts || {};
  if (issues.length) {
    addSection("Issue overview");
    addLine(`${issues.length} evidence-based finding(s): ${counts.critical || 0} critical, ${counts.high || 0} high, ${counts.medium || 0} medium, ${counts.low || 0} low. ${report?.needsVerificationCount || 0} item(s) need additional verification.`, { size: 9, after: 6 });
  } else if (legacyFindings.length) {
    addSection(report ? "Verified performance findings" : "Verified issues to review");
    addLine(`${legacyFindings.length} verified PageSpeed issue(s) were identified in this run.`, { size: 9, after: 5 });
  } else {
    addSection("Issue overview");
    addLine("No qualifying issues were detected in the available evidence. This does not establish that the store has no usability or conversion issues.", { size: 9, after: 5 });
  }
  if (report?.recommendedFirstSteps?.length) {
    addSection("Recommended first steps");
    report.recommendedFirstSteps.forEach((step, index) => addLine(`${index + 1}. ${step}`, { size: 9, after: 2 }));
  }

  const reportIssues = issues.length ? issues : legacyFindings.map((finding) => ({
    category: "Performance & technical",
    title: finding.title,
    priority: "medium",
    effort: "Needs technical review",
    observation: finding.observation,
    evidence: [{ url: audit.website_url, description: `${finding.displayValue} · ${finding.source}` }],
    businessImpact: "This result may affect loading or rendering experience; conversion impact was not measured.",
    recommendation: finding.solution,
    verificationStatus: "verified",
    confidence: "high"
  }));
  const categories = [...new Set(reportIssues.map((issue) => issue.category || "Other"))];
  for (const category of categories) {
    addSection(category);
    const categoryIssues = reportIssues.filter((issue) => (issue.category || "Other") === category)
      .sort((left, right) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        return (order[left.priority] ?? 4) - (order[right.priority] ?? 4);
      });
    for (const issue of categoryIssues) {
      ensureSpace(95);
      addLine(`${issue.title}  |  ${String(issue.priority || "medium").toUpperCase()} PRIORITY  |  Effort: ${issue.effort || "Not estimated"}`, { size: 10, bold: true, color: [0.45, 0.14, 0.12], after: 3 });
      addField("WHAT WAS OBSERVED", issue.observation);
      if (issue.evidence?.length) {
        addField("EVIDENCE", issue.evidence.map((entry) => `${entry.url}: ${entry.description}`).join(" | "));
      }
      addField("WHY IT MAY MATTER", issue.businessImpact);
      addField("RECOMMENDATION", issue.recommendation);
      addLine(`Verification: ${issue.verificationStatus || "verified"} | Confidence: ${issue.confidence || "medium"}`, { size: 8, color: [0.38, 0.41, 0.46], after: 7 });
    }
  }

  if (report?.limitations?.length) {
    addSection("Limitations and verification notes");
    for (const limitation of report.limitations) addLine(`- ${limitation}`, { size: 9, after: 3 });
  }
  addLine("Disclaimer: This audit is based on publicly accessible website information and diagnostic results available at the time of analysis. Some findings may require additional verification or merchant account access. Recommendations support prioritization and do not guarantee specific business or performance outcomes.", {
    size: 8,
    color: [0.38, 0.41, 0.46],
    after: 4
  });
  finishPage();

  const pageObjectIds = pageStreams.map((_stream, index) => 5 + index * 2);
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "ascii"),
    Buffer.from(`2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageStreams.length} >>\nendobj\n`, "ascii"),
    Buffer.from("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n", "ascii"),
    Buffer.from("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n", "ascii")
  ];
  pageStreams.forEach((stream, index) => {
    const pageId = pageObjectIds[index];
    const contentId = pageId + 1;
    objects.push(Buffer.from(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
      "ascii"
    ));
    objects.push(Buffer.concat([
      Buffer.from(`${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n`, "ascii"),
      stream,
      Buffer.from("\nendstream\nendobj\n", "ascii")
    ]));
  });
  const header = Buffer.from("%PDF-1.4\n", "ascii");
  let offset = header.length;
  const offsets = [0];
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xrefOffset = offset;
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF"
  ].join("\n");
  return Buffer.concat([header, ...objects, Buffer.from(xref, "ascii")]);
}

function approveAndClaimSend(id) {
  const database = getDatabase();
  const transaction = database.prepare(`
    UPDATE merchant_performance_audits
    SET status = 'SENDING', updated_at = datetime('now')
    WHERE id = ? AND status = 'APPROVED'
  `);
  const result = transaction.run(Number(id));
  if (!result.changes) {
    const audit = getAudit(id);
    if (!audit) throw auditFailure("Audit not found.", 404);
    throw auditFailure("This audit must be approved and not already sent.");
  }
  return getAudit(id);
}

async function sendApprovedAudit(id) {
  let audit = approveAndClaimSend(id);
  let lead = merchantIngestion.getMerchantLeadById(audit.company_id);
  const email = lead?.contact_email || audit.recipient_email;
  const contacts = db.getContactsByCompanyId(audit.company_id);
  const contact = contacts.find((item) => item.email === email) || contacts[0] || null;
  try {
    if (!email) throw auditFailure("This merchant has no contact email.", 400);
    if (db.hasBeenContacted(email, audit.company_id)) {
      throw auditFailure("This merchant or contact has already been contacted; duplicate outreach was blocked.", 409);
    }
    const settings = require("./settingsService").getSettings(false);
    const dryRun = settings.dryRun;
    if (!dryRun) await emailSender.verifyTransporter();

    const mailOptions = {
      from: settings.emailFrom || settings.smtpUser || undefined,
      to: email,
      subject: audit.email_subject,
      text: audit.email_body,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;white-space:pre-wrap">${audit.email_body
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
      attachments: audit.email_mode === "report"
        ? [{
            filename: `${String(audit.domain || "store").replace(/[^a-z0-9.-]/gi, "-")}-performance-audit.pdf`,
            content: generateReportPdf(audit),
            contentType: "application/pdf"
          }]
        : []
    };
    const result = await emailSender.sendMailWithRetry(mailOptions, 0, dryRun);
    if (!result.success) throw new Error(result.error || "Email could not be sent.");
    const status = result.dryRun ? "DRY_RUN_SENT" : "SENT";
    getDatabase().prepare(`
      UPDATE merchant_performance_audits
      SET status = ?, sent_at = datetime('now'), message_id = ?, error = NULL,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'SENDING'
    `).run(status, result.messageId || null, Number(id));
    try {
      db.addEmailLog({
        company_id: audit.company_id,
        contact_id: contact?.id || null,
        email,
        subject: audit.email_subject,
        status,
        message_id: result.messageId,
        attempts: result.attempts
      });
      if (!result.dryRun) {
        db.updateCompanyStatus(audit.company_id, "CONTACTED", `Performance audit outreach sent to ${email}`);
      }
    } catch (logError) {
      logger.error(`Performance audit ${id} was sent but outreach bookkeeping failed`, logError);
    }
    audit = getAudit(id);
    return audit;
  } catch (error) {
    getDatabase().prepare(`
      UPDATE merchant_performance_audits
      SET status = 'FAILED', error = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'SENDING'
    `).run(String(error.message || "Email send failed").slice(0, 1000), Number(id));
    logger.error(`Performance audit email failed for audit ${id}`, error);
    throw error;
  }
}

function getAuditReport(id) {
  const audit = getAudit(id);
  if (!audit) throw auditFailure("Audit not found.", 404);
  return { audit, content: generateReportPdf(audit) };
}

module.exports = {
  createAudit,
  getAudit,
  listAudits,
  updateDraft,
  approveAudit,
  sendApprovedAudit,
  getAuditReport,
  collectFindings,
  generateReportPdf,
  generateAuditDraft,
  analyzeStorefront: storefrontAudit.analyzeStorefront,
  buildAuditReport: storefrontAudit.buildAuditReport,
  extractStorefrontPage: storefrontAudit.extractPage
};
