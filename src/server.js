const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db/database");
const logger = require("./services/logger");
const config = require("./config");
const exclusionService = require("./services/exclusionService");
const emailGenerator = require("./services/emailGenerator");
const emailSender = require("./services/emailSender");
const exportService = require("./services/exportService");
const { runDiscovery } = require("./workflows/discoverWorkflow");
const { runResearch, researchCompany } = require("./workflows/researchWorkflow");
const { runLeadGeneration } = require("./workflows/leadWorkflow");
const { runSend } = require("./workflows/sendWorkflow");

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({});
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Origin, X-Requested-With",
    "Access-Control-Max-Age": "86400"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message, details = null) {
  sendJson(res, statusCode, { success: false, error: message, details });
}

function startServer(port = process.env.PORT || 3000) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Origin, X-Requested-With",
        "Access-Control-Max-Age": "86400"
      });
      res.end();
      return;
    }

    try {
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
        sendJson(res, 200, { success: true, stats });
        return;
      }

      // 3. Leads List API (Filtered & Paginated)
      if (pathname === "/api/leads" && req.method === "GET") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam && limitParam !== "all" ? parseInt(limitParam, 10) : null;
        const statusFilter = url.searchParams.get("status");
        const minScoreParam = url.searchParams.get("minScore");
        const minScore = minScoreParam ? parseInt(minScoreParam, 10) : 0;
        const searchQuery = (url.searchParams.get("search") || "").trim().toLowerCase();

        let leads = db.getFinalQualifiedLeads(limit);

        if (statusFilter && statusFilter !== "ALL") {
          leads = leads.filter((l) => l.status === statusFilter);
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
        const companies = db.getAllCompanies({ status });
        sendJson(res, 200, { success: true, count: companies.length, companies });
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

      // 7. Email Preview API
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

        const emailData = emailGenerator.generateEmail(company, bestContact);
        sendJson(res, 200, {
          success: true,
          preview: {
            to: bestContact ? bestContact.email : "[No Public Email Found]",
            recipientName: bestContact && bestContact.name ? bestContact.name : `${company.name} Hiring Team`,
            companyName: company.name,
            subject: emailData.subject,
            text: emailData.text,
            html: emailData.html,
            resumeAttachment: path.basename(config.resumePath),
            confidence: bestContact ? bestContact.confidence : "NONE",
            emailType: bestContact ? bestContact.email_type : "N/A"
          }
        });
        return;
      }

      // 8. Email Send API
      if (pathname === "/api/email/send" && req.method === "POST") {
        const body = await parseBody(req);
        const limit = body.limit !== undefined ? (body.limit === "all" ? null : parseInt(body.limit, 10)) : null;
        const dryRun = body.dryRun !== undefined ? body.dryRun : config.dryRun;
        const leadIds = Array.isArray(body.leadIds) ? body.leadIds.map(Number) : null;

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
        const batchToSend = selectedLeads.map((l) => {
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
            mailOptions: emailGenerator.generateEmail(l, contact)
          };
        });

        // Execute Batch
        const result = await emailSender.sendBatch(batchToSend, { isDryRun: dryRun });
        await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));

        sendJson(res, 200, {
          success: true,
          message: dryRun ? "Dry-run simulation completed" : "Outreach batch sent successfully",
          results: {
            total: batchToSend.length,
            sent: result.sent,
            failed: result.failed,
            dryRun
          }
        });
        return;
      }

      // 9. Email History API
      if (pathname === "/api/email/history" && req.method === "GET") {
        const history = db.getAllEmailLogs();
        sendJson(res, 200, { success: true, count: history.length, history });
        return;
      }

      // 10. Action Triggers (Discover, Research, Leads)
      if (pathname === "/api/actions/discover" && req.method === "POST") {
        const body = await parseBody(req);
        const candidates = body.candidates ? parseInt(body.candidates, 10) : 150;
        const result = await runDiscovery({ candidates });
        await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));
        sendJson(res, 200, { success: true, message: "Discovery finished", result });
        return;
      }

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
        const result = await runLeadGeneration({ target });
        await exportService.exportAll().catch((e) => logger.warn("Export error:", e.message));
        sendJson(res, 200, { success: true, message: "Lead generation workflow finished", result });
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
      sendError(res, 500, "Internal server error", err.message);
    }
  });

  server.listen(port, () => {
    logger.success(`REST API Server listening on port ${port} (Health check: http://localhost:${port}/health)`);
  });

  return server;
}

module.exports = { startServer };
