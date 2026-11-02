const assert = require("node:assert/strict");
process.env.DATABASE_PATH = ":memory:";
const {
  collectFindings,
  generateReportPdf,
  generateAuditDraft,
  analyzeStorefront,
  buildAuditReport,
  extractStorefrontPage
} = require("./src/services/storePerformanceAudit");
const db = require("./src/db/database");
const emailTemplates = require("./src/services/emailTemplates");
const portfolioUrl = emailTemplates.PORTFOLIO_URL;

const lighthouseResult = {
  configSettings: { formFactor: "mobile" },
  audits: {
    "largest-contentful-paint": {
      numericValue: 4200,
      displayValue: "4.2 s",
      score: 0.2
    },
    "total-blocking-time": {
      numericValue: 350,
      displayValue: "350 ms",
      score: 0.3
    },
    "cumulative-layout-shift": {
      numericValue: 0.02,
      displayValue: "0.02",
      score: 0.9
    },
    "unused-javascript": {
      score: 0.4,
      displayValue: "Potential savings of 120 KiB"
    }
  }
};

const findings = collectFindings(lighthouseResult);
assert.equal(findings.length, 3);
assert.match(findings[0].observation, /4\.2 s in the mobile PageSpeed audit/);

const auditDraft = generateAuditDraft(
  { store_name: "Sample Store" },
  { "Largest Contentful Paint": "4.2 s" },
  "mobile"
);
assert.equal(auditDraft.subject, "Sample Store: A mobile performance opportunity");
assert.match(auditDraft.body, /LCP\) reached 4\.2 s in the mobile audit/);
assert.ok(auditDraft.body.includes(portfolioUrl));
assert.ok(!auditDraft.body.includes("19 seconds"));

const missingLcpDraft = generateAuditDraft({ store_name: "Sample Store" }, {}, "mobile");
assert.ok(!missingLcpDraft.body.includes("LCP"));
assert.ok(!missingLcpDraft.body.includes("takes this long"));
assert.ok(!missingLcpDraft.body.includes("{{"));

const desktopDraft = generateAuditDraft(
  { store_name: "Sample Store" },
  { "Largest Contentful Paint": "3200 ms" },
  "desktop"
);
assert.equal(desktopDraft.subject, "Sample Store: A desktop performance opportunity");
assert.match(desktopDraft.body, /3200 ms in the desktop audit/);

const numericLcpDraft = generateAuditDraft(
  { store_name: "Sample Store" },
  {},
  "mobile",
  { numericValue: 4200 }
);
assert.match(numericLcpDraft.body, /4\.2 s in the mobile audit/);

const pdf = generateReportPdf({
  store_name: "Sample Store",
  domain: "sample.example",
  website_url: "https://sample.example",
  strategy: "mobile",
  performance_score: 42,
  created_at: "2026-10-26",
  metrics: { "Largest Contentful Paint": "4.2 s" },
  findings
});
assert.equal(pdf.subarray(0, 8).toString("ascii"), "%PDF-1.4");
assert.equal(pdf.subarray(-5).toString("ascii"), "%%EOF");
assert.match(pdf.toString("ascii"), /POOR - ATTENTION REQUIRED/);
assert.match(pdf.toString("ascii"), /VERIFIED ISSUES TO REVIEW/);
assert.ok(pdf.toString("ascii").includes(portfolioUrl));
const xrefOffset = Number(pdf.toString("ascii").match(/startxref\n(\d+)/)?.[1]);
assert.equal(pdf.subarray(xrefOffset, xrefOffset + 4).toString("ascii"), "xref");
assert.ok(
  db.getRawDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("merchant_performance_audits")
);

const homepage = extractStorefrontPage(
  "https://sample.example/",
  "Homepage",
  '<html><head><title>Sample</title></head><body><main><a href="/products/item">Item</a><img src="/hero.jpg"></main></body></html>'
);
const productPage = extractStorefrontPage(
  "https://sample.example/products/item",
  "Product",
  '<html><head><title>Item</title><meta name="description" content="Sample product"></head><body><main><h1>Sample Item</h1><p>A product description with enough information for this test page.</p></main></body></html>'
);
const storefrontIssues = analyzeStorefront([homepage, productPage], []);
assert.ok(storefrontIssues.some((issue) => issue.category === "Homepage" && issue.title.includes("value proposition")));
assert.ok(storefrontIssues.some((issue) => issue.category === "Product pages" && issue.title.includes("Add-to-cart")));
assert.ok(storefrontIssues.some((issue) => issue.verificationStatus === "needs_verification"));

const report = buildAuditReport({
  website_url: "https://sample.example/",
  created_at: "2026-10-26T00:00:00.000Z"
}, {
  pages: [homepage, productPage],
  skipped: [],
  limitations: ["Checkout was not tested."]
}, storefrontIssues, findings);
assert.equal(report.pagesInspected.length, 2);
assert.ok(report.verifiedCount > 0);
assert.ok(report.needsVerificationCount > 0);
assert.ok(report.recommendedFirstSteps.length > 0);
const detailedPdf = generateReportPdf({
  store_name: "Sample Store",
  domain: "sample.example",
  website_url: "https://sample.example/",
  strategy: "mobile",
  performance_score: 42,
  created_at: "2026-10-26",
  metrics: { "Largest Contentful Paint": "4.2 s" },
  findings,
  report
});
assert.ok(Number(detailedPdf.toString("ascii").match(/\/Count (\d+)/)?.[1]) > 1);
assert.match(detailedPdf.toString("ascii"), /EXECUTIVE SUMMARY/);
assert.match(detailedPdf.toString("ascii"), /WHY IT MAY MATTER/);

(async () => {
  const generalTemplate = await emailTemplates.renderTemplate("freelancingStores", {
    store_name: "Sample Store"
  });
  assert.equal(generalTemplate.subject, "Shopify improvements for Sample Store");
  assert.equal(generalTemplate.body, [
    "Hi Sample Store Team,",
    "",
    "I came across your store and noticed a few opportunities to improve its performance, user experience, and overall shopping journey.",
    "",
    "I'm a freelance Shopify developer specializing in custom theme development, store improvements, speed optimization, and conversion-focused enhancements.",
    "",
    "I'd love to share a few ideas tailored to your store and help you implement improvements that make sense for your business.",
    "",
    "Would you be open to a quick conversation?",
    "",
    `Portfolio: ${portfolioUrl}`,
    "",
    "Best regards,",
    "Himanshu Soni",
    "Freelance Shopify Developer | Performance, UX & CRO"
  ].join("\n"));

  const outreachEmailGenerator = require("./src/services/outreachEmailGenerator");
  const generatedGeneralEmail = await outreachEmailGenerator.generateEmail(
    { name: "Sample Store", store_name: "Sample Store" },
    null,
    {
      templateId: "freelancingStores",
      baseMailOptions: {
        to: "preview@example.test",
        attachments: [{ filename: "audit.pdf" }]
      }
    }
  );
  assert.equal(generatedGeneralEmail.subject, generalTemplate.subject);
  assert.equal(generatedGeneralEmail.text, generalTemplate.body);
  assert.deepEqual(generatedGeneralEmail.attachments, []);
  assert.ok(generatedGeneralEmail.html.includes("Hi Sample Store Team"));

  const { handleStorePerformanceAuditRoute } = require("./src/api/storePerformanceAuditRoutes");
  let response = null;
  const handled = await handleStorePerformanceAuditRoute(
    { method: "GET", url: "/api/merchant/audits" },
    {},
    "/api/merchant/audits",
    {
      parseBody: async () => ({}),
      sendJson: (_res, statusCode, payload) => { response = { statusCode, payload }; },
      sendError: (_res, statusCode, message) => { response = { statusCode, payload: { error: message } }; }
    }
  );
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.audits, []);

  const serverlessHandler = require("./src/server.cjs");
  const serverlessResponse = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
  await serverlessHandler(
    { method: "GET", url: "/api/merchant/audits", headers: { host: "localhost" } },
    serverlessResponse
  );
  assert.equal(serverlessResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(serverlessResponse.body).audits, []);
  console.log("Store performance audit checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
