const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db/database");
const logger = require("./services/logger");
const config = require("./config");
const exclusionService = require("./services/exclusionService");
const outreachEmailGenerator = require("./services/outreachEmailGenerator");
const emailTemplates = require("./services/emailTemplates");
const emailSender = require("./services/emailSender");
const { handleEmailTemplateRoute } = require("./api/emailTemplateRoutes");
const { handleStorePerformanceAuditRoute } = require("./api/storePerformanceAuditRoutes");
const {
  authenticateLegacyRequest,
  authorizeCronRequest,
  handleSaasAuthRoute
} = require("./api/saasAuthRoutes");
const resumeStorage = require("./services/resumeStorage");
const exportService = require("./services/exportService");
const { runDiscovery } = require("./workflows/discoverWorkflow");
const { runResearch, researchCompany } = require("./workflows/researchWorkflow");
const { runLeadGeneration } = require("./workflows/leadWorkflow");
const { runSend } = require("./workflows/sendWorkflow");
const { parseRequestBody } = require("./utils/requestBody");
const {
  estimateStoreRevenue,
  formatRevenueValue,
  convertRevenueToStoreCurrency
} = require("./services/revenueEstimator");

const parseBody = parseRequestBody;

function normalizeErrorValue(value) {
  if (value === null || value === undefined) return "Unknown error";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "Unknown error";
    // Defensive: never leak the JS default "[object Object]" to clients.
    if (trimmed === "[object Object]") return "Unknown error";
    return trimmed;
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => normalizeErrorValue(entry)).filter(Boolean);
    return parts.length ? parts.join("; ") : "Unknown error";
  }
  if (typeof value === "object") {
    // Walk in order, looking for any nested string field that yields a useful message.
    const keys = ["message", "error", "details", "reason", "description", "statusText"];
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null) {
        const nested = normalizeErrorValue(value[key]);
        if (nested && nested !== "Unknown error") return nested;
      }
    }
    // Special-case Evolution API "exists: false" probe responses so the client
    // gets a readable explanation rather than a serialized blob.
    const respMsg = value.response?.message;
    if (Array.isArray(respMsg) && respMsg.length > 0) {
      const parts = respMsg.map((entry) => {
        if (!entry || typeof entry !== "object") return String(entry);
        const number = entry.number || entry.jid || "number";
        if (entry.exists === false) return `${number} is not a registered WhatsApp number`;
        if (entry.exists === true) return `${number} is a valid WhatsApp number`;
        if (entry.message) return `${number}: ${entry.message}`;
        return JSON.stringify(entry);
      }).filter(Boolean);
      if (parts.length) return parts.join("; ");
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}" && json !== "[]") return json;
    } catch {
      // fall through
    }
    return "Unknown error";
  }
  return String(value) || "Unknown error";
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Origin, X-Requested-With",
    "Access-Control-Max-Age": "86400"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message, details = null) {
  sendJson(res, statusCode, {
    success: false,
    error: normalizeErrorValue(message),
    details: details === undefined || details === null ? null : normalizeErrorValue(details)
  });
}

function getEvolutionHttpStatus(errorCode, upstreamStatus = 0) {
  if (upstreamStatus === 401 || upstreamStatus === 403) return upstreamStatus;
  if (upstreamStatus === 429) return 429;
  if (upstreamStatus >= 500) return upstreamStatus;

  switch (errorCode) {
    case "EVOLUTION_INVALID_URL":
    case "EVOLUTION_MISSING_API_KEY":
    case "EVOLUTION_BAD_REQUEST":
    case "INSTANCE_CREATE_FAILED":
    case "QR_NOT_AVAILABLE":
    case "QR_GENERATION_FAILED":
      return 400;
    case "EVOLUTION_AUTH_ERROR":
      return 401;
    case "EVOLUTION_OFFLINE":
      return 503;
    case "EVOLUTION_TIMEOUT":
      return 504;
    case "EVOLUTION_RATE_LIMIT":
      return 429;
    case "EVOLUTION_ENDPOINT_NOT_FOUND":
    case "INSTANCE_NOT_FOUND":
      return 404;
    case "EVOLUTION_API_SERVER_ERROR":
      return upstreamStatus >= 500 ? upstreamStatus : 502;
    default:
      return 400;
  }
}

function sendEvolutionError(res, result) {
  const errorCode = result.errorCode || result.error || "EVOLUTION_API_ERROR";
  const httpStatus = getEvolutionHttpStatus(errorCode, result.status);
  const normalizedError = normalizeErrorValue(result.details || result.message || result.error || "Evolution API request failed");
  sendJson(res, httpStatus, {
    success: false,
    error: normalizedError,
    errorCode,
    upstreamStatus: result.status || 0,
    online: result.online,
    authenticated: result.authenticated,
    profile: result.profile || null,
    version: result.version || null,
    instanceName: result.instanceName || null
  });
}

function startServer(port = process.env.PORT || 3000) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS preflight
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Origin, X-Requested-With",
        "Access-Control-Max-Age": "86400"
      });
      res.end();
      return;
    }

    try {
      if (await handleSaasAuthRoute(req, res, pathname, { parseBody, sendJson })) return;

      const isCronWorker = pathname === "/api/email/batch/worker" && req.method === "POST";
      if (isCronWorker) {
        if (!authorizeCronRequest(req) && !await authenticateLegacyRequest(req, res, sendJson)) return;
      } else if (pathname !== "/health" && !await authenticateLegacyRequest(req, res, sendJson)) {
        return;
      }

      if (await handleEmailTemplateRoute(req, res, pathname, { parseBody, sendJson, sendError })) return;
      if (await handleStorePerformanceAuditRoute(req, res, pathname, { parseBody, sendJson, sendError })) return;

      // 1. Health Check
      if (pathname === "/health") {
        sendJson(res, 200, {
          status: "healthy",
          uptime: process.uptime(),
          mode: config.dryRun ? "DRY_RUN" : "LIVE",
          minEmployeeCount: config.minEmployeeCount,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // 2. Stats API
      if (pathname === "/api/stats") {
        const stats = db.getStatistics();
        const database = db.getRawDb();

        // Add source breakdown
        const bySource = database.prepare(`
          SELECT source, COUNT(*) as count FROM companies GROUP BY source
        `).all();

        sendJson(res, 200, {
          success: true,
          stats: {
            ...stats,
            bySource
          }
        });
        return;
      }

      // Dashboard metric detail lists. These rows power the clickable cards
      // and preserve one row per email contact or sent-email record where needed.
      if (pathname === "/api/dashboard/records" && req.method === "GET") {
        const metric = url.searchParams.get("metric") || "";
        const validMetrics = new Set([
          "discovered",
          "merchantContacts",
          "employeeVerified",
          "emailContacts",
          "readyToSend",
          "emailsSent",
          "excludedTooLow"
        ]);
        if (!validMetrics.has(metric)) {
          sendError(res, 400, "A valid dashboard metric is required");
          return;
        }

        let records = db.getDashboardMetricRecords(metric);
        const merchantLeads = require("./services/merchantIngestion").getMerchantLeads({ limit: 10000 });
        const merchantById = new Map(merchantLeads.map((lead) => [lead.id, lead]));
        records = records.map((record) => {
          const merchant = merchantById.get(record.id);
          if (!merchant) return record;
          return {
            ...record,
            email: record.email || merchant.contact_email || null,
            contact_email: merchant.contact_email || null,
            phone: record.phone || merchant.phone || null,
            normalized_phone: record.normalized_phone || merchant.normalized_phone || null,
            installed_apps: record.installed_apps || merchant.installed_apps,
            tech_stack: record.tech_stack || merchant.tech_stack,
            store_description: record.store_description || merchant.store_description,
            product_count: record.product_count ?? merchant.product_count,
            estimated_revenue: record.estimated_revenue || merchant.estimated_revenue
          };
        });
        sendJson(res, 200, { success: true, metric, count: records.length, records });
        return;
      }

      // 3. Leads List API (Filtered & Paginated)
      if (pathname === "/api/leads" && req.method === "GET") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam && limitParam !== "all" ? parseInt(limitParam, 10) : null;
        const statusFilter = url.searchParams.get("status");
        const sourceFilter = url.searchParams.get("source");
        const minScoreParam = url.searchParams.get("minScore");
        const minScore = minScoreParam ? parseInt(minScoreParam, 10) : 0;
        const searchQuery = (url.searchParams.get("search") || "").trim().toLowerCase();

        let leads = db.getFinalQualifiedLeads(limit);

        if (statusFilter && statusFilter !== "ALL") {
          leads = leads.filter((l) => l.status === statusFilter);
        }

        if (sourceFilter && sourceFilter !== "ALL") {
          leads = leads.filter((l) => l.source === sourceFilter);
        }

        if (minScore > 0) {
          leads = leads.filter((l) => (l.lead_score || 0) >= minScore);
        }

        if (searchQuery) {
          leads = leads.filter((l) =>
            (l.name && l.name.toLowerCase().includes(searchQuery)) ||
            (l.domain && l.domain.toLowerCase().includes(searchQuery)) ||
            (l.city && l.city.toLowerCase().includes(searchQuery)) ||
            (l.email && l.email.toLowerCase().includes(searchQuery)) ||
            (l.shopify_services && l.shopify_services.toLowerCase().includes(searchQuery))
          );
        }

        leads = leads.map(convertRevenueToStoreCurrency);
        sendJson(res, 200, { success: true, count: leads.length, leads });
        return;
      }

      // 4. Single Lead Detail API
      if (pathname.startsWith("/api/leads/") && req.method === "GET") {
        const id = parseInt(pathname.replace("/api/leads/", ""), 10);
        if (isNaN(id)) {
          sendError(res, 400, "Invalid company ID");
          return;
        }

        const company = db.getCompanyById(id);
        if (!company) {
          sendError(res, 404, "Lead not found");
          return;
        }

        const contacts = db.getContactsByCompanyId(id);
        const sources = db.getSourcesByCompanyId(id);
        const emailLogs = db.getAllEmailLogs().filter((l) => l.company_id === id);

        sendJson(res, 200, {
          success: true,
          lead: {
            company,
            contacts,
            sources,
            emailLogs
          }
        });
        return;
      }

      // 5. Companies API
      if (pathname === "/api/companies" && req.method === "GET") {
        const status = url.searchParams.get("status") || undefined;
        const source = url.searchParams.get("source") || undefined;
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam && limitParam !== "all" ? parseInt(limitParam, 10) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 10000)) {
          sendError(res, 400, "limit must be 'all' or an integer between 1 and 10000");
          return;
        }
        let companies = db.getAllCompaniesWithRevenue({ status, source, limit })
          .map(convertRevenueToStoreCurrency);
        if (!source || source === "MERCHANT_UPLOAD") {
          const merchantLeads = require("./services/merchantIngestion").getMerchantLeads({ limit: 10000 });
          const merchantById = new Map(merchantLeads.map((lead) => [lead.id, lead]));
          companies = companies.map((company) => {
            const merchant = merchantById.get(company.id);
            const calculatedRevenue = company.estimated_monthly_revenue !== null && company.estimated_monthly_revenue !== undefined
              ? formatRevenueValue(company.estimated_monthly_revenue, company.revenue_currency)
              : null;
            return merchant ? {
              ...company,
              email: merchant.contact_email,
              contact_email: merchant.contact_email,
              phone: merchant.phone,
              normalized_phone: merchant.normalized_phone,
              installed_apps: merchant.installed_apps,
              tech_stack: merchant.tech_stack,
              store_description: merchant.store_description,
              product_count: merchant.product_count,
              estimated_revenue: calculatedRevenue || merchant.estimated_revenue || null
            } : {
              ...company,
              estimated_revenue: calculatedRevenue || company.estimated_revenue || null
            };
          });
        } else {
          companies = companies.map((company) => {
            const calculatedRevenue = company.estimated_monthly_revenue !== null && company.estimated_monthly_revenue !== undefined
              ? formatRevenueValue(company.estimated_monthly_revenue, company.revenue_currency)
              : null;
            return {
              ...company,
              estimated_revenue: calculatedRevenue || company.estimated_revenue || null
            };
          });
        }
        const search = (url.searchParams.get("search") || "").trim().toLowerCase();
        if (search) {
          companies = companies.filter((company) =>
            [company.name, company.domain, company.city, company.shopify_services]
              .some((value) => String(value || "").toLowerCase().includes(search))
          );
        }
        sendJson(res, 200, { success: true, count: companies.length, companies });
        return;
      }

      const revenueRefreshMatch = pathname.match(/^\/api\/companies\/(\d+)\/revenue-estimate$/);
      if (revenueRefreshMatch && req.method === "POST") {
        const companyId = Number.parseInt(revenueRefreshMatch[1], 10);
        const company = db.getCompanyById(companyId);
        if (!company) {
          sendError(res, 404, "Company not found");
          return;
        }
        const merchantIngestion = require("./services/merchantIngestion");
        const merchant = merchantIngestion.getMerchantLeadById(companyId);
        if (!merchant) {
          sendError(res, 400, "Revenue refresh is available for merchant storefront records");
          return;
        }

        const domain = company.domain || merchant.domain;
        const estimate = await estimateStoreRevenue(domain);
        const saved = db.upsertMerchantRevenueEstimate({ ...estimate, company_id: companyId, domain });
        const displayEstimate = convertRevenueToStoreCurrency({
          ...saved,
          revenue_currency: saved.currency,
          estimated_aov: saved.aov,
          product_price_proxy: saved.product_price_proxy,
          product_price_min: saved.product_price_min,
          product_price_max: saved.product_price_max,
          product_price_p25: saved.product_price_p25,
          product_price_p75: saved.product_price_p75
        });
        sendJson(res, 200, {
          success: true,
          estimate: {
            ...displayEstimate,
            estimated_revenue: displayEstimate.estimated_monthly_revenue !== null && displayEstimate.estimated_monthly_revenue !== undefined
              ? formatRevenueValue(displayEstimate.estimated_monthly_revenue, displayEstimate.revenue_currency)
              : merchant.estimated_revenue || null
          }
        });
        return;
      }

      // 6. Exclusions & Contacted API
      if (pathname === "/api/exclusions" && req.method === "GET") {
        const exclusions = db.getAllExclusions();
        const contacted = db.getContactedLeads();
        sendJson(res, 200, { success: true, count: exclusions.length, exclusions, contacted });
        return;
      }

      if (pathname === "/api/exclusions" && req.method === "POST") {
        const body = await parseBody(req);
        if (!body.name) {
          sendError(res, 400, "Company name is required");
          return;
        }

        await exclusionService.addExclusion(body.name, body.domain || null, body.reason || "Web UI Exclusion");
        sendJson(res, 201, { success: true, message: `Added "${body.name}" to exclusions` });
        return;
      }

      // 7. Dynamic Settings API (Get & Save Configuration)
      if (pathname === "/api/settings" && req.method === "GET") {
        const settingsService = require("./services/settingsService");
        const settings = settingsService.getSettings(true);
        sendJson(res, 200, { success: true, settings });
        return;
      }

      if (pathname === "/api/settings" && req.method === "POST") {
        const settingsService = require("./services/settingsService");
        const body = await parseBody(req);
        const updated = settingsService.updateSettings(body);
        sendJson(res, 200, { success: true, message: "Settings successfully updated", settings: updated });
        return;
      }

      // Upload resume PDF (base64-encoded in JSON body)
      if (pathname === "/api/upload-resume" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          const { file, filename } = body;

          if (!file || !filename) {
            sendError(res, 400, "No file or filename provided");
            return;
          }

          if (!filename.toLowerCase().endsWith(".pdf")) {
            sendError(res, 400, "Only PDF files are supported");
            return;
          }

          const MAX_SIZE_MB = 10;
          const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

          let buffer;
          try {
            buffer = Buffer.from(file, "base64");
          } catch {
            sendError(res, 400, "Invalid base64 file data");
            return;
          }

          if (buffer.length === 0) {
            sendError(res, 400, "File is empty");
            return;
          }

          if (buffer.length > MAX_SIZE_BYTES) {
            sendError(res, 400, `File size exceeds ${MAX_SIZE_MB}MB limit`);
            return;
          }

          // Validate PDF magic bytes
          const header = buffer.slice(0, 4).toString("ascii");
          if (header !== "%PDF") {
            sendError(res, 400, "File is not a valid PDF");
            return;
          }

          try {
            const stored = await resumeStorage.saveResume(filename, buffer);

            const settingsService = require("./services/settingsService");
            const updated = settingsService.updateSettings({
              resumePath: stored.reference,
              resumeFilename: stored.filename
            });

            sendJson(res, 200, { success: true, message: "Resume uploaded successfully", settings: updated });
          } catch (fsError) {
            sendError(res, 500, `Failed to save resume file: ${fsError.message}`, fsError.message);
          }
        } catch (e) {
          sendError(res, 500, "Failed to upload resume", e.message);
        }
        return;
      }

      // Remove resume (revert to env fallback)
      if (pathname === "/api/remove-resume" && req.method === "POST") {
        try {
          const settingsService = require("./services/settingsService");
          const current = settingsService.getSettings(false);
          await resumeStorage.removeResume(current.resumePath);
          const updated = settingsService.updateSettings({
            resumePath: "",
            resumeFilename: ""
          });
          sendJson(res, 200, { success: true, message: "Resume removed", settings: updated });
        } catch (e) {
          sendError(res, 500, "Failed to remove resume", e.message);
        }
        return;
      }

      // 8. Test SMTP Connection API
      if (pathname === "/api/settings/test-smtp" && req.method === "POST") {
        const settingsService = require("./services/settingsService");
        const body = await parseBody(req);
        const result = await settingsService.testSmtpConnection(body);
        if (result.success) {
          sendJson(res, 200, { success: true, message: result.message });
        } else {
          sendError(res, 400, result.error);
        }
        return;
      }

      // 9. Email Preview API
      if (pathname.startsWith("/api/email/preview/") && req.method === "GET") {
        const companyId = parseInt(pathname.replace("/api/email/preview/", ""), 10);
        if (isNaN(companyId)) {
          sendError(res, 400, "Invalid company ID");
          return;
        }

        const company = db.getCompanyById(companyId);
        if (!company) {
          sendError(res, 404, "Company not found");
          return;
        }

        const contacts = db.getContactsByCompanyId(companyId);
        const bestContact = contacts.length > 0 ? contacts[0] : null;

        const templateId = url.searchParams.get("templateId") || await emailTemplates.getActiveTemplateId();
        const emailData = await outreachEmailGenerator.generateEmail(company, bestContact, { templateId });
        const selectedTemplate = (await emailTemplates.getTemplates()).find((item) => item.id === templateId);
        sendJson(res, 200, {
          success: true,
          preview: {
            to: bestContact ? bestContact.email : "[No Public Email Found]",
            recipientName: bestContact && bestContact.name ? bestContact.name : `${company.name} Hiring Team`,
            companyName: company.name,
            templateId,
            templateTarget: selectedTemplate ? selectedTemplate.target : templateId,
            subject: emailData.subject,
            text: emailData.text,
            html: emailData.html,
            resumeAttachment: emailData.attachments?.[0]?.filename || null,
            confidence: bestContact ? bestContact.confidence : "NONE",
            emailType: bestContact ? bestContact.email_type : "N/A"
          }
        });
        return;
      }

      // 8. Email Send API — now uses the resumable batch system.
      // The old synchronous loop has been replaced: the API returns immediately
      // with a batchId and a self-resume loop keeps the batch going in the background.
      if (pathname === "/api/email/send" && req.method === "POST") {
        const body = await parseBody(req);
        const limit = body.limit !== undefined ? (body.limit === "all" ? null : parseInt(body.limit, 10)) : null;
        const dryRun = body.dryRun !== undefined ? body.dryRun : config.dryRun;
        const leadIds = Array.isArray(body.leadIds) ? body.leadIds.map(Number) : null;
        const templateId = body.templateId || await emailTemplates.getActiveTemplateId();

        let eligibleLeads = db.getFinalQualifiedLeads(limit ? limit * 3 : null).filter(
          (l) => l.email && ["HIGH", "MEDIUM"].includes(l.email_confidence) && !db.hasBeenContacted(l.email, l.id)
        );

        if (leadIds && leadIds.length > 0) {
          eligibleLeads = eligibleLeads.filter((l) => leadIds.includes(l.id));
        }

        if (eligibleLeads.length === 0) {
          sendError(res, 400, "No eligible uncontacted leads found to send.");
          return;
        }

        const selectedLeads = limit ? eligibleLeads.slice(0, limit) : eligibleLeads;
        const batchItems = await Promise.all(selectedLeads.map(async (l) => {
          const contact = {
            id: l.contact_id,
            name: l.contact_name,
            role: l.contact_role,
            email: l.email,
            email_type: l.email_type,
            confidence: l.email_confidence
          };
          return {
            company: l,
            contact,
            mailOptions: await outreachEmailGenerator.generateEmail(l, contact, { templateId })
          };
        }));

        // Validate SMTP credentials before accepting the batch.
        if (!dryRun) {
          const settingsService = require("./services/settingsService");
          const smtpTest = await settingsService.testSmtpConnection({});
          if (!smtpTest.success) {
            sendError(res, 400, `SMTP is not configured or credentials are invalid: ${smtpTest.error}`);
            return;
          }
        }

        // Create the batch — items are pre-loaded into email_batch_items as PENDING.
        const batchId = emailSender.createBatch(batchItems, { dryRun });

        // Process the first chunk synchronously within the Vercel function
        // budget. On serverless, the function may be killed before the chunk
        // completes — but progress is checkpointed after every email so a
        // cron-triggered resume picks up exactly where we left off. The
        // /api/email/batch/:id/resume endpoint also serves as a manual kick.
        // On a long-running local process, scheduleNextChunk chains additional
        // chunks automatically.
        let chunkResult;
        try {
          chunkResult = await emailSender.processBatchChunk(batchId, { verify: true });
        } catch (err) {
          logger.error(`First chunk failed for batch ${batchId}:`, err);
          db.failEmailBatch(batchId, err.message);
          sendError(res, 500, `Batch started but failed: ${err.message}`);
          return;
        }

        // On local (non-serverless) runs, chain additional chunks in-process.
        // On Vercel, this is a no-op because the process will be reaped.
        if (chunkResult && chunkResult.moreWork && !process.env.VERCEL) {
          emailSender.scheduleNextChunk(batchId, 500);
        }

        const finalBatch = db.getEmailBatch(batchId);
        sendJson(res, 200, {
          success: true,
          message: dryRun
            ? "Dry-run batch simulation started"
            : "Live batch outreach started",
          templateId,
          batchId,
          status: finalBatch ? finalBatch.status : "PROCESSING",
          results: {
            total: batchItems.length,
            sent: finalBatch ? finalBatch.sent : 0,
            failed: finalBatch ? finalBatch.failed : 0,
            pending: finalBatch ? finalBatch.pending : batchItems.length,
            dryRun
          }
        });
        return;
      }

      // ── NEW: Batch Status API ──────────────────────────────────────────────
      // GET /api/email/batch/:id
      if (pathname.match(/^\/api\/email\/batch\/([^/]+)$/) && req.method === "GET") {
        const batchId = pathname.match(/^\/api\/email\/batch\/([^/]+)$/)[1];
        const batch = db.getEmailBatch(batchId);
        if (!batch) {
          sendError(res, 404, `Batch "${batchId}" not found.`);
          return;
        }
        sendJson(res, 200, {
          success: true,
          batch: {
            id: batch.id,
            mode: batch.mode,
            status: batch.status,
            total: batch.total,
            sent: batch.sent,
            failed: batch.failed,
            pending: batch.pending,
            processing: batch.processing,
            startedAt: batch.started_at,
            updatedAt: batch.updated_at,
            completedAt: batch.completed_at,
            error: batch.error
          }
        });
        return;
      }

      // ── NEW: Manual Batch Resume API ───────────────────────────────────────
      // POST /api/email/batch/:id/resume
      if (pathname.match(/^\/api\/email\/batch\/([^/]+)\/resume$/) && req.method === "POST") {
        const batchId = pathname.match(/^\/api\/email\/batch\/([^/]+)\/resume$/)[1];
        const batch = db.getEmailBatch(batchId);
        if (!batch) {
          sendError(res, 404, `Batch "${batchId}" not found.`);
          return;
        }
        if (batch.status === "COMPLETED") {
          sendJson(res, 200, { success: true, message: "Batch is already completed", status: "COMPLETED" });
          return;
        }
        if (batch.status === "FAILED") {
          // Reset the batch so it can be retried.
          db.getRawDb().prepare(`
            UPDATE email_batch_items SET status = 'PENDING', attempts = 0, error = NULL
            WHERE batch_id = ? AND status IN ('FAILED', 'PROCESSING')
          `).run(batchId);
          db.getRawDb().prepare(`
            UPDATE email_batches SET status = 'PROCESSING', error = NULL, updated_at = datetime('now')
            WHERE id = ?
          `).run(batchId);
          const refreshed = db.refreshEmailBatchCounters(batchId);
          emailSender.scheduleNextChunk(batchId, 500);
          sendJson(res, 200, {
            success: true,
            message: "Batch reset and resumed",
            batchId,
            status: refreshed.status,
            results: { total: refreshed.total, sent: refreshed.sent, failed: refreshed.failed, pending: refreshed.pending }
          });
          return;
        }
        // Already processing — just trigger a chunk.
        const result = await emailSender.processBatchChunk(batchId, { verify: true });
        if (result.moreWork) {
          emailSender.scheduleNextChunk(batchId, 500);
        }
        const refreshed = db.getEmailBatch(batchId);
        sendJson(res, 200, {
          success: true,
          message: result.alreadyDone ? "Batch already complete" : "Chunk processed, batch continuing",
          batchId,
          status: refreshed ? refreshed.status : "UNKNOWN",
          results: {
            total: refreshed ? refreshed.total : 0,
            sent: refreshed ? refreshed.sent : 0,
            failed: refreshed ? refreshed.failed : 0,
            pending: refreshed ? refreshed.pending : 0
          }
        });
        return;
      }

      // ── NEW: List Active Batches API ──────────────────────────────────────
      // GET /api/email/batches
      if (pathname === "/api/email/batches" && req.method === "GET") {
        const database = db.getRawDb();
        const batches = database.prepare(`
          SELECT id, mode, status, total, sent, failed, pending,
                 started_at, updated_at, completed_at, error
          FROM email_batches
          ORDER BY started_at DESC
          LIMIT 20
        `).all();
        sendJson(res, 200, { success: true, batches });
        return;
      }

      // ── NEW: Batch Worker / Cron Endpoint ────────────────────────────────
      // POST /api/email/batch/worker
      // Designed for Vercel Cron. Requests require CRON_SECRET or an admin session.
      // Add to vercel.json:
      //   { "path": "/api/email/batch/worker", "schedule": "* * * * *" }
      if (pathname === "/api/email/batch/worker" && req.method === "POST") {
        const database = db.getRawDb();
        // Find batches stuck in PROCESSING that haven't been updated in 90s
        // (they may have been orphaned by a killed Vercel function).
        const staleBatches = database.prepare(`
          SELECT id, mode FROM email_batches
          WHERE status = 'PROCESSING'
            AND datetime(updated_at) < datetime('now', '-90 seconds')
          ORDER BY started_at ASC
          LIMIT 3
        `).all();

        if (staleBatches.length === 0) {
          sendJson(res, 200, { success: true, message: "No stale batches to resume", resumed: 0 });
          return;
        }

        let resumed = 0;
        let errors = 0;
        for (const batch of staleBatches) {
          try {
            // Reset stale PROCESSING items back to PENDING
            database.prepare(`
              UPDATE email_batch_items SET status = 'PENDING'
              WHERE batch_id = ? AND status = 'PROCESSING'
            `).run(batch.id);
            await emailSender.processBatchChunk(batch.id, { verify: false });
            resumed++;
          } catch (err) {
            logger.error(`Worker: failed to resume batch ${batch.id}:`, err);
            db.failEmailBatch(batch.id, err.message);
            errors++;
          }
        }
        sendJson(res, 200, {
          success: true,
          message: `Worker processed ${resumed} batch${resumed !== 1 ? "es" : ""}`,
          resumed,
          errors
        });
        return;
      }

      // 9. Email History API
      if (pathname === "/api/email/history" && req.method === "GET") {
        const history = db.getAllEmailLogs();
        sendJson(res, 200, { success: true, count: history.length, history });
        return;
      }

      // 10. WhatsApp Status & Connect APIs
      if (pathname === "/api/whatsapp/status" && req.method === "GET") {
        const evolutionGoClient = require("./services/evolutionGoClient");
        const health = await evolutionGoClient.checkHealth();
        let stateRes = { connected: false, state: "DISCONNECTED" };
        if (health.online && health.authenticated) {
          stateRes = await evolutionGoClient.getConnectionState();
        }
        const apiCfg = evolutionGoClient.getApiConfig();
        sendJson(res, 200, {
          success: true,
          online: health.online,
          authenticated: health.authenticated,
          version: health.version || null,
          profile: health.profile || null,
          connected: stateRes.connected,
          state: stateRes.state,
          error: health.error || stateRes.error || null,
          errorCode: health.error || stateRes.error || null,
          upstreamStatus: health.status || stateRes.status || 0,
          apiUrl: apiCfg.apiUrl,
          instanceName: apiCfg.instanceName,
          enabled: apiCfg.enabled,
          dryRun: apiCfg.dryRun,
          delayMs: apiCfg.delayMs
        });
        return;
      }

      if (pathname === "/api/whatsapp/connect" && req.method === "POST") {
        const evolutionGoClient = require("./services/evolutionGoClient");
        const qrRes = await evolutionGoClient.getQrCode();
        if (qrRes.ok) {
          sendJson(res, 200, { 
            success: true,
            connected: qrRes.connected || false,
            instanceName: qrRes.instanceName,
            qrcode: qrRes.qrcode, 
            pairingCode: qrRes.pairingCode, 
            simulation: qrRes.simulation, 
            message: qrRes.message,
            profile: qrRes.profile || null,
            version: qrRes.version || null
          });
        } else {
          sendEvolutionError(res, qrRes);
        }
        return;
      }

      if (pathname === "/api/whatsapp/disconnect" && req.method === "POST") {
        const evolutionGoClient = require("./services/evolutionGoClient");
        await evolutionGoClient.logoutInstance();
        sendJson(res, 200, { success: true, message: "WhatsApp session disconnected successfully" });
        return;
      }

      if (pathname === "/api/whatsapp/test-connection" && req.method === "POST") {
        const settingsService = require("./services/settingsService");
        const body = await parseBody(req);
        const result = await settingsService.testEvolutionConnection(body);
        if (result.success) {
          sendJson(res, 200, result);
        } else {
          sendEvolutionError(res, result);
        }
        return;
      }

      if (pathname === "/api/whatsapp/simulate-connect" && req.method === "POST") {
        const evolutionGoClient = require("./services/evolutionGoClient");
        const body = await parseBody(req);
        const connected = body.connected !== undefined ? Boolean(body.connected) : true;
        evolutionGoClient.setSimulatedConnected(connected);
        sendJson(res, 200, { success: true, connected, message: connected ? "Simulated WhatsApp connection activated" : "Simulated connection disconnected" });
        return;
      }

      // 11. WhatsApp Preview API
      if (pathname.startsWith("/api/whatsapp/preview/") && req.method === "GET") {
        const companyId = parseInt(pathname.replace("/api/whatsapp/preview/", ""), 10);
        if (isNaN(companyId)) {
          sendError(res, 400, "Invalid company ID");
          return;
        }

        const company = db.getCompanyById(companyId);
        if (!company) {
          sendError(res, 404, "Company not found");
          return;
        }

        const contacts = db.getContactsByCompanyId(companyId);
        const bestContact = contacts.length > 0 ? contacts[0] : null;

        const whatsappGenerator = require("./services/whatsappGenerator");
        const preview = await whatsappGenerator.generateActiveMessage(company, bestContact);
        sendJson(res, 200, { success: true, preview });
        return;
      }

      // 12. WhatsApp Send APIs
      if (pathname === "/api/whatsapp/send" && req.method === "POST") {
        const whatsappWorkflow = require("./workflows/whatsappWorkflow");
        const body = await parseBody(req);
        if (!body.leadId && !body.companyId) {
          sendError(res, 400, "leadId or companyId is required");
          return;
        }
        if (!body.phone) {
          sendError(res, 400, "Phone number is required");
          return;
        }
        if (!body.message || !String(body.message).trim()) {
          sendError(res, 400, "Message is required");
          return;
        }

        const leadId = body.leadId || body.companyId;
        const result = await whatsappWorkflow.sendSingleMessage(leadId, body.phone, body.message, {
          templateId: body.templateId
        });
        if (result.success) {
          sendJson(res, 200, result);
          return;
        }

        // Map workflow errors to the right HTTP status. The workflow's error
        // string is the human-readable reason (already normalized upstream).
        const errMsg = result.error || "Failed to send WhatsApp message";
        let httpStatus = 500;
        const errLower = String(errMsg).toLowerCase();
        if (errLower.includes("not found")) {
          httpStatus = 404;
        } else if (errLower.includes("opted out") || errLower.includes("already been contacted")) {
          httpStatus = 409;
        } else if (errLower.includes("not a registered whatsapp") || errLower.includes("not connected") || errLower.includes("disconnected")) {
          // Phone exists in the data but isn't on WhatsApp, or the instance is offline.
          httpStatus = 409;
        } else if (errLower.includes("invalid phone number") || errLower.includes("no valid phone")) {
          httpStatus = 400;
        } else if (errLower.includes("auth") || errLower.includes("unauthor") || errLower.includes("forbidden")) {
          httpStatus = 401;
        } else if (errLower.includes("rate limit") || errLower.includes("too many")) {
          httpStatus = 429;
        } else if (errLower.includes("resume") || errLower.includes("storage") || errLower.includes("could not be loaded")) {
          httpStatus = 400;
        } else if (errLower.includes("timed out") || errLower.includes("offline") || errLower.includes("unreachable")) {
          httpStatus = 503;
        }

        sendError(res, httpStatus, errMsg);
        return;
      }

      if (pathname === "/api/whatsapp/send-batch" && req.method === "POST") {
        const whatsappWorkflow = require("./workflows/whatsappWorkflow");
        const body = await parseBody(req);
        const leadIds = Array.isArray(body.leadIds) ? body.leadIds : [];
        if (leadIds.length === 0) {
          sendError(res, 400, "No lead IDs provided for WhatsApp batch send");
          return;
        }

        const results = await whatsappWorkflow.sendBatch(leadIds, null, {
          templateId: body.templateId
        });
        sendJson(res, 200, { success: true, results });
        return;
      }

      // 13. WhatsApp Logs API
      if (pathname === "/api/whatsapp/logs" && req.method === "GET") {
        const logs = db.getAllWhatsAppLogs();
        sendJson(res, 200, { success: true, count: logs.length, logs });
        return;
      }

      // 14. Webhook for Evolution Go (Incoming replies & status)
      if (pathname === "/api/webhooks/evolution" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          logger.info("[Evolution Go Webhook]", JSON.stringify(body).substring(0, 200));

          const event = body.event || body.type;
          const data = body.data || body;

          // Check for incoming message / reply
          const messageObj = data.message || (data.messages && data.messages[0]);
          const remoteJid = data.key?.remoteJid || (messageObj && messageObj.key?.remoteJid);
          const fromMe = data.key?.fromMe || (messageObj && messageObj.key?.fromMe);

          if (remoteJid && !fromMe) {
            const senderPhone = remoteJid.split("@")[0];
            const textContent =
              messageObj?.conversation ||
              messageObj?.extendedTextMessage?.text ||
              messageObj?.text ||
              "";

            const upperText = String(textContent).trim().toUpperCase();

            // Opt-out detection (STOP, UNSUBSCRIBE, DO NOT CONTACT, NO)
            const optOutKeywords = ["STOP", "UNSUBSCRIBE", "DO NOT CONTACT", "OPT OUT", "NO"];
            const isOptOut = optOutKeywords.some((kw) => upperText === kw || upperText.startsWith(kw + " ") || upperText.startsWith(kw + "."));

            if (isOptOut) {
              logger.warn(`WhatsApp opt-out detected from +${senderPhone}: "${textContent}"`);
              db.updateWhatsAppStatusByPhone(senderPhone, "OPTED_OUT");
            } else {
              logger.info(`WhatsApp reply received from +${senderPhone}: "${textContent}"`);
              db.updateWhatsAppStatusByPhone(senderPhone, "REPLIED");
            }
          }

          sendJson(res, 200, { success: true, received: true });
        } catch (err) {
          logger.error("Error processing Evolution Go webhook:", err.message);
          sendJson(res, 200, { success: false, error: err.message });
        }
        return;
      }

      // 10. Action Triggers (Discover, Research, Leads)
      if (pathname === "/api/actions/discover" && req.method === "POST") {
        const body = await parseBody(req);
        const rawCandidates = body.candidates;
        const fetchAllPages = body.fetchAllPages === true || rawCandidates === "all" || rawCandidates === -1;
        const parsedCandidates = rawCandidates === "all" || rawCandidates === -1 ? 5000 : (rawCandidates ? parseInt(rawCandidates, 10) : 150);
        const source = body.source || "appstore";

        if (!["freelancing", "appstore", "partner", "SHOPIFY_PARTNER_DIRECTORY"].includes(source)) {
          sendError(res, 400, "source must be 'freelancing', 'appstore', or 'partner'");
          return;
        }

        let result;
        if (source === "freelancing") {
          if (typeof body.keywords !== "string" || body.keywords.trim().length < 2 || body.keywords.length > 120) {
            sendError(res, 400, "keywords must contain between 2 and 120 characters for freelancing store discovery");
            return;
          }
          if (body.country !== undefined && (typeof body.country !== "string" || body.country.trim().length > 60)) {
            sendError(res, 400, "country must be text up to 60 characters");
            return;
          }
          const { runMerchantStoreDiscovery } = require("./workflows/merchantStoreDiscovery");
          result = await runMerchantStoreDiscovery({
            keywords: body.keywords,
            country: body.country,
            target: parsedCandidates
          });
        } else if (source === "partner" || source === "SHOPIFY_PARTNER_DIRECTORY") {
          result = await runDiscovery({ candidates: parsedCandidates, fetchAllPages, source: "SHOPIFY_PARTNER_DIRECTORY" });
        } else {
          // Default to App Store discovery
          const { runAppStoreDiscovery } = require("./workflows/appStoreDiscovery");
          result = await runAppStoreDiscovery({
            maxApps: parsedCandidates,
            indiaOnly: body.indiaOnly !== false,
            fetchAllPages,
            enrichWithDetails: body.enrichWithDetails !== false
          });
        }

        await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));
        sendJson(res, 200, { success: true, message: "Discovery finished", result });
        return;
      }

      // ── Remote Jobs API (Additive Only) ──────────────────────────────────────────
      // GET /api/remote-jobs/jobs — list jobs with optional filters
      if (pathname === "/api/remote-jobs/jobs" && req.method === "GET") {
        try {
          const jobs = db.getRawDb().prepare(`
            SELECT id, canonical_id, title, company_name, company_domain, employment_type,
                   experience_level, location, location_restrictions, salary_min, salary_max,
                   salary_currency, relevance_score, match_reason, status, application_url,
                   created_at, updated_at
            FROM jobs
          `).all();

          // Apply filters if provided via query params
          const query = new URLSearchParams(url.search);
          const statusFilter = query.get("status");
          const minScore = parseInt(query.get("minRelevance") || "0", 10);
          const employmentType = query.get("employmentType");
          const locationFilter = query.get("location");
          let results = jobs;
          if (statusFilter) {
            results = results.filter((j) => j.status === statusFilter);
          }
          if (minScore > 0) {
            results = results.filter((j) => (j.relevance_score || 0) >= minScore);
          }
          if (employmentType) {
            results = results.filter((j) => j.employment_type === employmentType);
          }
          if (locationFilter && locationFilter !== "all") {
            results = results.filter((j) => j.location && j.location.toLowerCase().includes(locationFilter.toLowerCase()));
          }

          sendJson(res, 200, { success: true, count: results.length, jobs: results });
        } catch (e) {
          sendError(res, 500, "Failed to fetch jobs", e.message);
        }
        return;
      }

      // POST /api/remote-jobs/jobs — bulk upsert jobs
      if (pathname === "/api/remote-jobs/jobs" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          if (!Array.isArray(body.jobs)) {
            sendError(res, 400, "jobs array is required");
            return;
          }
          const jobService = require("./services/jobService");
          const results = await jobService.upsertJobs(body.jobs);
          sendJson(res, 200, { success: true, message: `${results.inserted} inserted, ${results.updated} updated`, results });
        } catch (e) {
          sendError(res, 500, "Failed to upsert jobs", e.message);
        }
        return;
      }

      // GET /api/remote-jobs/job-runs — check job run status
      if (pathname === "/api/remote-jobs/job-runs" && req.method === "GET") {
        try {
          const runs = db.getRawDb().prepare(`
            SELECT id, type, status, last_cursor, processed_count, success_count,
                   error_message, started_at, completed_at, checkpoint_data
            FROM job_runs ORDER BY started_at DESC LIMIT 5
          `).all();
          sendJson(res, 200, { success: true, count: runs.length, runs });
        } catch (e) {
          sendError(res, 500, "Failed to fetch job runs", e.message);
        }
        return;
      }

      // POST /api/remote-jobs/discover/start — start a new discovery run
      if (pathname === "/api/remote-jobs/discover/start" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          const jobRunsService = require("./services/jobRunsService");
          const runId = await jobRunsService.createRun("DISCOVERY", body?.source || "himalayas", body?.candidates || 100);
          sendJson(res, 200, { success: true, runId, message: "Discovery run created" });
        } catch (e) {
          sendError(res, 500, "Failed to start discovery run", e.message);
        }
        return;
      }

      // POST /api/remote-jobs/discover/next — fetch next chunk and update checkpoint
      if (pathname === "/api/remote-jobs/discover/next" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          if (!body.runId) {
            sendError(res, 400, "runId is required");
            return;
          }
          const jobRunsService = require("./services/jobRunsService");
          const result = await jobRunsService.processNextChunk(body.runId, body?.chunkSize || 25);
          sendJson(res, 200, { success: true, ...result });
        } catch (e) {
          const msg = e.message || "";
          if (msg.includes("not found") || msg.includes("not found")) {
            sendError(res, 404, e.message);
          } else {
            sendError(res, 500, "Failed to process next chunk", e.message);
          }
        }
        return;
      }

      // POST /api/remote-jobs/score — score jobs without relevance scores
      if (pathname === "/api/remote-jobs/score" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          if (!Array.isArray(body.jobIds)) {
            sendError(res, 400, "jobIds array is required");
            return;
          }
          const jobService = require("./services/jobService");
          const results = await jobService.scoreJobs(body.jobIds);
          sendJson(res, 200, { success: true, ...results });
        } catch (e) {
          sendError(res, 500, "Failed to score jobs", e.message);
        }
        return;
      }

      // GET /api/remote-jobs/applications — list applications with optional filters
      if (pathname === "/api/remote-jobs/applications" && req.method === "GET") {
        try {
          const applications = db.getRawDb().prepare(`
            SELECT a.id, a.job_id, a.status, a.applied_at, a.resume_version, a.cover_letter,
                   a.screening_answers, a.recruiter_email, a.recruiter_phone, a.notes,
                   j.title, j.company_name, j.relevance_score, j.status AS job_status,
                   j.application_url, j.created_at AS job_created
            FROM applications a
            JOIN jobs j ON a.job_id = j.id
          `).all();

          const query = new URLSearchParams(url.search);
          const statusFilter = query.get("status");
          const jobId = query.get("jobId");
          let results = applications;
          if (statusFilter) {
            results = results.filter((a) => a.status === statusFilter);
          }
          if (jobId) {
            results = results.filter((a) => a.job_id === parseInt(jobId, 10));
          }

          sendJson(res, 200, { success: true, count: results.length, applications: results });
        } catch (e) {
          sendError(res, 500, "Failed to fetch applications", e.message);
        }
        return;
      }

      // POST /api/remote-jobs/applications — create/update application
      if (pathname === "/api/remote-jobs/applications" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          if (!body || !body.job_id) {
            sendError(res, 400, "job_id is required");
            return;
          }
          const applicationService = require("./services/applicationService");
          const result = await applicationService.upsertApplication(body);
          sendJson(res, 200, { success: true, ...result });
        } catch (e) {
          const msg = e.message || "";
          if (msg.includes("not found") || msg.includes("Job not found")) {
            sendError(res, 404, e.message);
          } else if (msg.includes("is required") || msg.includes("Invalid")) {
            sendError(res, 400, e.message);
          } else {
            sendError(res, 500, "Failed to save application", e.message);
          }
        }
        return;
      }

      // POST /api/remote-jobs/applications/generate — generate cover letter + screening answers
      if (pathname === "/api/remote-jobs/applications/generate" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          if (!body || !body.job_id) {
            sendError(res, 400, "job_id is required");
            return;
          }
          const applicationAssetGenerator = require("./services/applicationAssetGenerator");
          const job = db.getRawDb().prepare("SELECT * FROM jobs WHERE id = ?").get(body.job_id);
          if (!job) {
            sendError(res, 404, "Job not found");
            return;
          }
          const letter = applicationAssetGenerator.generateCoverLetter(job);
          const screening = applicationAssetGenerator.generateScreeningAnswers(job);
          sendJson(res, 200, {
            success: true,
            coverLetter: letter.coverLetter,
            recommendedResumeVersion: letter.recommendedResumeVersion,
            resumeFilename: letter.resumeFilename,
            screeningAnswers: screening,
          });
        } catch (e) {
          sendError(res, 500, "Failed to generate application assets", e.message);
        }
        return;
      }

      // POST /api/remote-jobs/job-runs/:id/resume — resume a paused/failed run
      if (pathname.match(/^\/api\/remote-jobs\/job-runs\/([^/]+)\/resume$/) && req.method === "POST") {
        const runId = pathname.match(/^\/api\/remote-jobs\/job-runs\/([^/]+)\/resume$/)[1];
        try {
          const jobRunsService = require("./services/jobRunsService");
          const result = await jobRunsService.resumeRun(runId);
          sendJson(res, 200, { success: true, ...result });
        } catch (e) {
          sendError(res, 500, "Failed to resume run", e.message);
        }
        return;
      }

      // GET /api/remote-jobs/job-runs/:id — detailed run status
      if (pathname.match(/^\/api\/remote-jobs\/job-runs\/([^/]+)$/) && req.method === "GET") {
        const runId = pathname.match(/^\/api\/remote-jobs\/job-runs\/([^/]+)$/)[1];
        try {
          const jobRunsService = require("./services/jobRunsService");
          const run = db.getRawDb().prepare("SELECT * FROM job_runs WHERE id = ?").get(runId);
          if (!run) {
            sendError(res, 404, `Run "${runId}" not found`);
            return;
          }
          sendJson(res, 200, { success: true, run });
        } catch (e) {
          sendError(res, 500, "Failed to fetch run status", e.message);
        }
        return;
      }

      // GET /api/remote-jobs/settings — remote job settings
      if (pathname === "/api/remote-jobs/settings" && req.method === "GET") {
        try {
          const settingsService = require("./services/settingsService");
          const settings = settingsService.getSettings(true);
          sendJson(res, 200, { success: true, settings: {
            remoteJobDiscoveryEnabled: settings.remoteJobDiscoveryEnabled,
            minRemoteJobRelevanceScore: settings.minRemoteJobRelevanceScore,
            maxRemoteJobsPerSource: settings.maxRemoteJobsPerSource,
            autoApplyDefault: settings.autoApplyDefault
          }});
        } catch (e) {
          sendError(res, 500, "Failed to fetch settings", e.message);
        }
        return;
      }

      // POST /api/remote-jobs/settings — update remote job settings
      if (pathname === "/api/remote-jobs/settings" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          const settingsService = require("./services/settingsService");
          const updated = settingsService.updateSettings(body);
          sendJson(res, 200, { success: true, message: "Settings updated", settings: updated });
        } catch (e) {
          sendError(res, 500, "Failed to update settings", e.message);
        }
        return;
      }

      // ── End Remote Jobs API ───────────────────────────────────────────────────

      // ── App Store Discovery APIs ─────────────────────────────────────────────

      // POST /api/discovery/app-store
      // Run App Store discovery workflow
      if (pathname === "/api/discovery/app-store" && req.method === "POST") {
        const body = await parseBody(req);
        const { runAppStoreDiscovery } = require("./workflows/appStoreDiscovery");

        const maxApps = body.maxApps || body.candidates || 200;
        const indiaOnly = body.indiaOnly !== false;
        const fetchAllPages = body.fetchAllPages === true;
        const checkpoint = body.checkpoint || null;

        logger.info(`Starting App Store discovery (maxApps=${maxApps}, indiaOnly=${indiaOnly})...`);

        const result = await runAppStoreDiscovery({
          maxApps,
          indiaOnly,
          fetchAllPages,
          checkpoint,
          enrichWithDetails: body.enrichWithDetails !== false
        });

        await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));
        sendJson(res, 200, {
          success: true,
          message: "App Store discovery finished",
          result
        });
        return;
      }

      // GET /api/discovery/app-store/status
      // Get App Store discovery statistics
      if (pathname === "/api/discovery/app-store/status" && req.method === "GET") {
        const database = db.getRawDb();

        // Count by source
        const bySource = database.prepare(`
          SELECT source, COUNT(*) as count FROM companies GROUP BY source
        `).all();

        // Count by status for App Store
        const appStoreByStatus = database.prepare(`
          SELECT status, COUNT(*) as count FROM companies WHERE source = 'SHOPIFY_APP_STORE' GROUP BY status
        `).all();

        // App Store specific stats
        const appStoreStats = database.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN india_confidence = 'HIGH' THEN 1 ELSE 0 END) as high_confidence,
            SUM(CASE WHEN india_confidence = 'MEDIUM' THEN 1 ELSE 0 END) as medium_confidence,
            SUM(CASE WHEN india_confidence = 'LOW' THEN 1 ELSE 0 END) as low_confidence
          FROM companies WHERE source = 'SHOPIFY_APP_STORE'
        `).get();

        sendJson(res, 200, {
          success: true,
          bySource,
          appStoreByStatus,
          appStoreStats
        });
        return;
      }

      // GET /api/discovery/app-store/companies
      // Get companies discovered from App Store
      if (pathname === "/api/discovery/app-store/companies" && req.method === "GET") {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);
        const status = url.searchParams.get("status") || null;

        let query = "SELECT * FROM companies WHERE source = 'SHOPIFY_APP_STORE'";
        const params = [];

        if (status) {
          query += " AND status = ?";
          params.push(status);
        }

        query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const database = db.getRawDb();
        const companies = database.prepare(query).all(...params);

        const total = database.prepare(
          "SELECT COUNT(*) as count FROM companies WHERE source = 'SHOPIFY_APP_STORE'"
        ).get().count;

        sendJson(res, 200, {
          success: true,
          count: companies.length,
          total,
          companies
        });
        return;
      }

      // POST /api/discovery/app-store/quick-india
      // Quick India-only discovery (skips detail fetching)
      if (pathname === "/api/discovery/app-store/quick-india" && req.method === "POST") {
        const body = await parseBody(req);
        const { quickIndiaDiscovery } = require("./workflows/appStoreDiscovery");

        const maxApps = body.maxApps || 100;

        const result = await quickIndiaDiscovery({ maxApps });
        await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));

        sendJson(res, 200, {
          success: true,
          message: "Quick India discovery finished",
          result
        });
        return;
      }

      // ── End App Store Discovery APIs ─────────────────────────────────────────

      if (pathname === "/api/actions/research" && req.method === "POST") {
        const body = await parseBody(req);
        if (body.companyId) {
          const company = db.getCompanyById(parseInt(body.companyId, 10));
          if (!company) {
            sendError(res, 404, "Company not found");
            return;
          }
          const result = await researchCompany(company);
          await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));
          sendJson(res, 200, { success: true, message: "Company research finished", result });
          return;
        } else {
          const result = await runResearch(body);
          await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));
          sendJson(res, 200, { success: true, message: "Batch research finished", result });
          return;
        }
      }

      if (pathname === "/api/actions/leads" && req.method === "POST") {
        const body = await parseBody(req);
        const target = body.target ? parseInt(body.target, 10) : 100;
        if (!Number.isInteger(target) || target < 1 || target > 1000) {
          sendError(res, 400, "target must be an integer between 1 and 1000");
          return;
        }
        const source = body.source;
        if (source !== undefined && !["freelancing", "appstore", "partner"].includes(source)) {
          sendError(res, 400, "source must be 'freelancing', 'appstore', or 'partner'");
          return;
        }
        if (source === "freelancing") {
          if (typeof body.keywords !== "string" || body.keywords.trim().length < 2 || body.keywords.length > 120) {
            sendError(res, 400, "keywords must contain between 2 and 120 characters for freelancing store discovery");
            return;
          }
          if (body.country !== undefined && (typeof body.country !== "string" || body.country.trim().length > 60)) {
            sendError(res, 400, "country must be text up to 60 characters");
            return;
          }
        }
        const result = await runLeadGeneration({
          target,
          source,
          keywords: body.keywords,
          country: body.country
        });
        await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));
        sendJson(res, 200, { success: true, message: "Lead generation workflow finished", result });
        return;
      }

      // ─── Merchant B2B Pitching API Routes ───────────────────────────────────────

      // POST /api/merchant/ingest - Upload and parse CSV/JSON merchant leads
      if (pathname === "/api/merchant/ingest" && req.method === "POST") {
        const body = await parseBody(req);
        if (body.startQueue && !["email", "whatsapp"].includes(body.channel)) {
          sendError(res, 400, "channel must be 'email' or 'whatsapp' when startQueue is enabled");
          return;
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
          sendError(res, 400, "dryRun must be a boolean");
          return;
        }
        if (body.startQueue !== undefined && typeof body.startQueue !== "boolean") {
          sendError(res, 400, "startQueue must be a boolean");
          return;
        }
        try {
          const merchantIngestion = require("./services/merchantIngestion");
          const options = { skipDuplicates: body.skipDuplicates !== false };
          let results;

          if (body.content !== undefined) {
            const uploadName = body.fileName || body.filename;
            if (!uploadName || typeof body.content !== "string") {
              sendError(res, 400, "fileName and text content are required for file uploads");
              return;
            }
            if (![".csv", ".json"].includes(path.extname(uploadName).toLowerCase())) {
              sendError(res, 400, "Uploaded file must use a .csv or .json extension");
              return;
            }
            results = await merchantIngestion.ingestUploadedData(
              uploadName,
              body.content,
              options
            );
          } else if (body.data !== undefined) {
            const format = String(body.format || "json").toLowerCase();
            const extension = format.startsWith(".") ? format : `.${format}`;
            if (extension !== ".json" && extension !== ".csv") {
              sendError(res, 400, "format must be 'csv' or 'json'");
              return;
            }
            if (extension === ".csv" && typeof body.data !== "string") {
              sendError(res, 400, "CSV data must be provided as text content");
              return;
            }
            const content = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
            results = await merchantIngestion.ingestUploadedData(
              body.fileName || `merchant-leads${extension}`,
              content,
              options
            );
          } else if (body.filePath) {
            const resolved = path.resolve(config.rootDir, body.filePath);
            const allowedRoots = [config.dataDir, config.outputDir].map((root) => path.resolve(root));
            const allowed = allowedRoots.some((root) =>
              resolved === root || resolved.startsWith(`${root}${path.sep}`)
            );
            if (!allowed) {
              sendError(res, 400, "filePath must point inside the configured data or output directory");
              return;
            }
            if (![".csv", ".json"].includes(path.extname(resolved).toLowerCase())) {
              sendError(res, 400, "Uploaded file must use a .csv or .json extension");
              return;
            }
            if (!fs.existsSync(resolved)) {
              sendError(res, 400, "Uploaded file was not found");
              return;
            }
            results = await merchantIngestion.ingest(resolved, options);
          } else {
            sendError(res, 400, "Provide uploaded file content as { fileName, content } or JSON data as { data }");
            return;
          }

          let queue = null;
          if (body.startQueue) {
            const importedIds = results.leads
              .filter((lead) => lead.status === "IMPORTED")
              .map((lead) => lead.id);
            if (importedIds.length > 0) {
              const QueueProcessor = require("./services/merchantQueue");
              const processor = new QueueProcessor({
                channel: body.channel,
                dryRun: body.dryRun
              });
              queue = processor.startBatch(importedIds);
            }
          }

          sendJson(res, 200, {
            success: true,
            message: "Merchant lead ingestion complete",
            results: {
              imported: results.imported,
              skipped: results.skipped,
              errors: results.errors.length,
              leads: results.leads.length,
              errorDetails: results.errors.map(({ row, error }) => ({ row, error }))
            },
            queue
          });
        } catch (err) {
          logger.error("Merchant ingestion error:", err);
          const invalidInput = /Invalid JSON file|JSON input must|Unsupported file format|Uploaded file content/i.test(err.message || "");
          sendError(res, invalidInput ? 400 : 500, err.message || "Failed to process merchant ingestion");
        }
        return;
      }

      // POST /api/merchant/preview - Generate personalized message preview
      if (pathname === "/api/merchant/preview" && req.method === "POST") {
        const body = await parseBody(req);
        const { leadId, channel } = body;

        if (!leadId) {
          sendError(res, 400, "leadId is required");
          return;
        }

        if (!channel || (channel !== "email" && channel !== "whatsapp")) {
          sendError(res, 400, "channel must be 'email' or 'whatsapp'");
          return;
        }

        try {
          const merchantIngestion = require("./services/merchantIngestion");
          const merchantLead = merchantIngestion.getMerchantLeadById(leadId);
          if (!merchantLead) {
            sendError(res, 404, `Lead with ID ${leadId} not found`);
            return;
          }

          const contacts = db.getContactsByCompanyId(leadId);
          const contact = contacts.length > 0 ? contacts[0] : null;
          const leadData = {
            ...merchantLead,
            contact_name: contact && contact.name ? contact.name : null,
            contact_email: merchantLead.email || null,
            contact_phone: merchantLead.normalized_phone || merchantLead.phone || null
          };

          const merchantTemplate = require("./services/merchantTemplate");
          let preview = merchantTemplate.previewMessage(leadData, channel);

          let templateId = null;
          let templateTarget = null;
          let includeResume = false;
          if (channel === "email") {
            const emailTemplates = require("./services/emailTemplates");
            const outreachEmailGenerator = require("./services/outreachEmailGenerator");
            templateId = body.templateId || await emailTemplates.getActiveTemplateId();
            const selectedTemplate = (await emailTemplates.getTemplates()).find((item) => item.id === templateId);
            const rendered = await outreachEmailGenerator.generateEmail(leadData, contact, {
              templateId,
              baseMailOptions: preview
            });
            templateTarget = selectedTemplate ? selectedTemplate.target : templateId;
            preview = { ...preview, ...rendered, body: rendered.text };
          } else {
            const emailTemplates = require("./services/emailTemplates");
            const whatsappGenerator = require("./services/whatsappGenerator");
            templateId = body.templateId || await emailTemplates.getActiveTemplateId();
            preview = whatsappGenerator.generateMessage(leadData, contact, templateId);
            templateTarget = preview.templateTarget;
            includeResume = preview.includeResume;
            preview = { ...preview, to: preview.phone, body: preview.text };
          }

          if (!preview) {
            sendError(res, 400, "Could not generate message preview");
            return;
          }

          const details = merchantTemplate.getPersonalizationDetails(leadData);

          sendJson(res, 200, {
            success: true,
            preview: {
              to: preview.to,
              subject: channel === "email" ? preview.subject : null,
              body: preview.body || preview.text,
              html: preview.html || null,
              text: preview.text || preview.body,
              channel,
              templateId,
              templateTarget,
              includeResume,
              leadId,
              storeName: details.storeName,
              domain: details.domain,
              installedApps: details.installedApps,
              techStack: details.techStack,
              primaryApp: details.primaryApp,
              hasEmail: details.hasEmail,
              hasPhone: details.hasPhone
            }
          });
        } catch (err) {
          logger.error("Merchant preview error:", err);
          sendError(res, 500, err.message || "Failed to generate message preview");
        }
        return;
      }

      // POST /api/merchant/queue/start - Start queue processing with randomized delays
      if (pathname === "/api/merchant/queue/start" && req.method === "POST") {
        const body = await parseBody(req);
        const { leadIds, channel, dryRun, batchId, templateId } = body;

        if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
          sendError(res, 400, "leadIds array is required and must not be empty");
          return;
        }

        if (!channel || (channel !== "email" && channel !== "whatsapp")) {
          sendError(res, 400, "channel must be 'email' or 'whatsapp'");
          return;
        }
        if (dryRun !== undefined && typeof dryRun !== "boolean") {
          sendError(res, 400, "dryRun must be a boolean");
          return;
        }

        try {
          const QueueProcessor = require("./services/merchantQueue");
          const selectedTemplateId = templateId || await emailTemplates.getActiveTemplateId();
          const processor = new QueueProcessor({
            dryRun,
            channel,
            templateId: selectedTemplateId
          });
          const batch = processor.startBatch(leadIds, batchId);
          sendJson(res, 202, {
            success: true,
            message: `Merchant ${channel} batch queued`,
            batch
          });
        } catch (err) {
          logger.error("Merchant queue start error:", err);
          const invalidInput = /leadIds|Merchant lead \d+ was not found/i.test(err.message || "");
          sendError(res, invalidInput ? 400 : 500, err.message || "Failed to start queue processing");
        }
        return;
      }

      // GET /api/merchant/queue/status/:batchId - Get batch status
      if (pathname.match(/^\/api\/merchant\/queue\/status\/([^/]+)$/) && req.method === "GET") {
        const batchId = pathname.match(/^\/api\/merchant\/queue\/status\/([^/]+)$/)[1];

        const database = db.getRawDb();
        const batch = database.prepare(
          "SELECT * FROM merchant_outreach_batches WHERE id = ?"
        ).get(batchId);
        if (!batch) {
          sendError(res, 404, `Batch "${batchId}" not found`);
          return;
        }

        const items = database.prepare(`
          SELECT moi.*, c.name AS company_name
          FROM merchant_outreach_items moi
          LEFT JOIN companies c ON c.id = moi.company_id
          WHERE moi.batch_id = ?
          ORDER BY moi.position ASC
        `).all(batchId);

        sendJson(res, 200, {
          success: true,
          batch: {
            ...batch,
            dry_run: Boolean(batch.dry_run),
            results: {
              total: items.length,
              sent: items.filter((i) => i.status === "SENT").length,
              failed: items.filter((i) => i.status === "FAILED").length,
              skipped: items.filter((i) => i.status === "SKIPPED").length,
              pending: items.filter((i) => ["PENDING", "PROCESSING"].includes(i.status)).length
            },
            items
          }
        });
        return;
      }

      // POST /api/merchant/queue/resume/:batchId - Resume batch
      if (pathname.match(/^\/api\/merchant\/queue\/resume\/([^/]+)$/) && req.method === "POST") {
        const batchId = pathname.match(/^\/api\/merchant\/queue\/resume\/([^/]+)$/)[1];

        const database = db.getRawDb();
        const batch = database.prepare(
          "SELECT * FROM merchant_outreach_batches WHERE id = ?"
        ).get(batchId);
        if (!batch) {
          sendError(res, 404, `Batch "${batchId}" not found`);
          return;
        }
        const QueueProcessor = require("./services/merchantQueue");
        const processor = new QueueProcessor({
          dryRun: Boolean(batch.dry_run),
          channel: batch.channel
        });
        const resumedBatch = processor.resumeBatch(batchId);
        sendJson(res, 202, {
          success: true,
          message: "Merchant batch resume queued",
          batch: resumedBatch
        });
        return;
      }

      // GET /api/merchant/leads/eligible - Get eligible leads for outreach
      if (pathname === "/api/merchant/leads/eligible" && req.method === "GET") {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit ? parseInt(rawLimit, 10) : null;
        const channel = url.searchParams.get("channel") || "email";
        if (!["email", "whatsapp"].includes(channel)) {
          sendError(res, 400, "channel must be 'email' or 'whatsapp'");
          return;
        }

        try {
          const merchantIngestion = require("./services/merchantIngestion");
          const leads = merchantIngestion.getMerchantLeads({
            status: "DISCOVERED",
            hasEmail: channel === "email",
            hasPhone: channel === "whatsapp",
            limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : undefined
          });

          const transformed = leads.map((lead) => ({
            id: lead.id,
            name: lead.name,
            domain: lead.domain,
            store_name: lead.store_name,
            contact_email: lead.contact_email,
            contact_phone: lead.contact_phone,
            lead_score: lead.lead_score,
            app_relevance_score: lead.app_relevance_score,
            installed_apps: lead.installed_apps,
            tech_stack: lead.tech_stack,
            estimated_revenue: lead.estimated_revenue,
            store_description: lead.store_description,
            product_count: lead.product_count,
            status: lead.status
          }));

          sendJson(res, 200, {
            success: true,
            count: transformed.length,
            leads: transformed
          });
        } catch (err) {
          logger.error("Merchant eligible leads error:", err);
          sendError(res, 500, err.message || "Failed to fetch eligible leads");
        }
        return;
      }

      // GET /api/merchant/settings/delay - Get delay configuration
      if (pathname === "/api/merchant/settings/delay" && req.method === "GET") {
        sendJson(res, 200, {
          success: true,
          delay: {
            minSeconds: 120,
            maxSeconds: 300,
            description: "A random 2-5 minute delay is applied between merchant messages"
          }
        });
        return;
      }

      // 11. Download CSV & XLSX
      if (pathname === "/download/csv") {
        const filePath = path.join(config.outputDir, "shopify_leads.csv");
        if (fs.existsSync(filePath)) {
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": "attachment; filename=\"shopify_leads.csv\""
          });
          fs.createReadStream(filePath).pipe(res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("File not generated yet. Run lead generation first.");
        }
        return;
      }

      if (pathname === "/download/xlsx") {
        const filePath = path.join(config.outputDir, "shopify_leads.xlsx");
        if (fs.existsSync(filePath)) {
          res.writeHead(200, {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": "attachment; filename=\"shopify_leads.xlsx\""
          });
          fs.createReadStream(filePath).pipe(res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("File not generated yet. Run lead generation first.");
        }
        return;
      }

      // 12. Default HTML Dashboard
      const stats = db.getStatistics();
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shopify Lead Generation Backend API</title>
  <style>
    :root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --muted: #94a3b8; --accent: #38bdf8; --border: #334155; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { color: var(--accent); margin-bottom: 0.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
    .card-title { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; }
    .card-val { font-size: 1.6rem; font-weight: bold; margin-top: 0.25rem; color: #fff; }
    .btn { display: inline-block; padding: 0.5rem 1rem; background: var(--accent); color: #0f172a; text-decoration: none; border-radius: 6px; font-weight: 600; margin-right: 0.5rem; }
    .btn-sec { background: var(--card); color: var(--text); border: 1px solid var(--border); }
  </style>
</head>
<body>
  <div class="container">
    <h1>Shopify Partner Lead Generation Backend API</h1>
    <p style="color: var(--muted); margin-bottom: 1.5rem;">Connected to Next.js Frontend. Status: Active</p>
    <div class="grid">
      <div class="card"><div class="card-title">Discovered</div><div class="card-val">${stats.totalDiscovered}</div></div>
      <div class="card"><div class="card-title">Qualified Leads</div><div class="card-val" style="color: #34d399;">${stats.qualified}</div></div>
      <div class="card"><div class="card-title">Real Contacts</div><div class="card-val">${stats.totalContacts}</div></div>
      <div class="card"><div class="card-title">Ready to Send</div><div class="card-val" style="color: var(--accent);">${stats.readyToSend}</div></div>
      <div class="card"><div class="card-title">Emails Sent</div><div class="card-val">${stats.sent}</div></div>
    </div>
    <div style="margin-top: 1.5rem;">
      <a href="/download/csv" class="btn">Download CSV</a>
      <a href="/download/xlsx" class="btn">Download Excel</a>
      <a href="/api/stats" class="btn btn-sec">API Stats</a>
      <a href="/api/leads?limit=10" class="btn btn-sec">API Leads</a>
    </div>
  </div>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      logger.error(`API Error handling ${req.method} ${pathname}`, err);
      const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
      sendError(
        res,
        statusCode,
        statusCode === 500 ? "Internal server error" : err.message,
        statusCode === 500 ? err.message : null
      );
    }
  });

  server.listen(port, () => {
    logger.success(`REST API Server listening on port ${port} (Health check: http://localhost:${port}/health)`);
  });

  return server;
}

module.exports = { startServer };
