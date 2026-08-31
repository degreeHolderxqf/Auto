/**
 * Vercel Serverless Function Entry Point
 * Wraps the existing Express-style server routes as a Vercel serverless handler.
 *
 * This file is invoked by Vercel's Node.js runtime.
 * Line ~600+: logger.error wrapper (safe, always exists)
 */
"use strict";

// Load environment variables
try { require("dotenv").config({ path: require("path").join(__dirname, "../../.env") }); } catch (e) { /* no dotenv in production */ }

const path = require("node:path");
const PROJECT_ROOT = path.join(__dirname, "../..");
process.chdir(PROJECT_ROOT);

// Load core modules with safe fallbacks
let db, logger, config;
try {
  db = require("./db/database");
  logger = require("./services/logger");
  config = require("./config");
} catch (err) {
  console.error("[SERVERLESS] Failed to load modules:", err.message);
}

const safeLogger = {
  info: (...args) => { try { logger && logger.info.apply(logger, args); } catch (e) { console.log("[INFO]", ...args); } },
  success: (...args) => { try { logger && logger.success.apply(logger, args); } catch (e) { console.log("[OK]", ...args); } },
  warn: (...args) => { try { logger && logger.warn.apply(logger, args); } catch (e) { console.warn("[WARN]", ...args); } },
  error: (...args) => { try { logger && logger.error.apply(logger, args); } catch (e) { console.error("[ERROR]", ...args); } },
  debug: (...args) => { try { logger && logger.debug.apply(logger, args); } catch (e) { /* silent */ } },
  progress: (...args) => { try { logger && logger.progress.apply(logger, args); } catch (e) { console.log(...args); } },
  section: (...args) => { try { logger && logger.section.apply(logger, args); } catch (e) { console.log(args); } },
  email: (...args) => { try { logger && logger.email.apply(logger, args); } catch (e) { console.log(...args); } }
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With");
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message, details) {
  if (details === undefined) details = null;
  sendJson(res, statusCode, { success: false, error: message, details });
}

function getEvolutionHttpStatus(errorCode, upstreamStatus) {
  if (upstreamStatus === undefined) upstreamStatus = 0;
  if (upstreamStatus === 401 || upstreamStatus === 403) return upstreamStatus;
  if (upstreamStatus === 429) return 429;
  if (upstreamStatus >= 500) return upstreamStatus;
  switch (errorCode) {
    case "EVOLUTION_INVALID_URL":
    case "EVOLUTION_MISSING_API_KEY":
    case "EVOLUTION_BAD_REQUEST":
    case "INSTANCE_CREATE_FAILED":
    case "QR_NOT_AVAILABLE":
    case "QR_GENERATION_FAILED": return 400;
    case "EVOLUTION_AUTH_ERROR": return 401;
    case "EVOLUTION_OFFLINE": return 503;
    case "EVOLUTION_TIMEOUT": return 504;
    case "EVOLUTION_RATE_LIMIT": return 429;
    case "EVOLUTION_ENDPOINT_NOT_FOUND":
    case "INSTANCE_NOT_FOUND": return 404;
    case "EVOLUTION_API_SERVER_ERROR": return upstreamStatus >= 500 ? upstreamStatus : 502;
    default: return 400;
  }
}

function sendEvolutionError(res, result) {
  const errorCode = result.errorCode || result.error || "EVOLUTION_API_ERROR";
  const httpStatus = getEvolutionHttpStatus(errorCode, result.status);
  sendJson(res, httpStatus, {
    success: false,
    error: result.details || result.message || result.error || "Evolution API request failed",
    errorCode: errorCode,
    upstreamStatus: result.status || 0,
    online: result.online,
    authenticated: result.authenticated,
    profile: result.profile || null,
    version: result.version || null,
    instanceName: result.instanceName || null
  });
}

// Main handler exported for Vercel
module.exports = async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With");

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (!db) {
      sendError(res, 503, "Backend modules not initialized", "Database module unavailable");
      return;
    }

    // 1. Health
    if (pathname === "/health") {
      sendJson(res, 200, {
        status: "healthy",
        mode: (config && config.dryRun) ? "DRY_RUN" : "LIVE",
        minEmployeeCount: (config && config.minEmployeeCount) || 0,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // 2. Stats
    if (pathname === "/api/stats") {
      const stats = db.getStatistics();
      sendJson(res, 200, { success: true, stats });
      return;
    }

    // 3. Leads list
    if (pathname === "/api/leads" && method === "GET") {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam && limitParam !== "all" ? parseInt(limitParam, 10) : null;
      const statusFilter = url.searchParams.get("status");
      const minScore = parseInt(url.searchParams.get("minScore") || "0", 10);
      const searchQuery = (url.searchParams.get("search") || "").trim().toLowerCase();

      let leads = db.getFinalQualifiedLeads(limit);
      if (statusFilter && statusFilter !== "ALL") leads = leads.filter((l) => l.status === statusFilter);
      if (minScore > 0) leads = leads.filter((l) => (l.lead_score || 0) >= minScore);
      if (searchQuery) leads = leads.filter((l) =>
        (l.name && l.name.toLowerCase().includes(searchQuery)) ||
        (l.domain && l.domain.toLowerCase().includes(searchQuery)) ||
        (l.city && l.city.toLowerCase().includes(searchQuery)) ||
        (l.email && l.email.toLowerCase().includes(searchQuery)) ||
        (l.shopify_services && l.shopify_services.toLowerCase().includes(searchQuery))
      );
      sendJson(res, 200, { success: true, count: leads.length, leads });
      return;
    }

    // 4. Single lead
    if (pathname.startsWith("/api/leads/") && method === "GET") {
      const id = parseInt(pathname.replace("/api/leads/", ""), 10);
      if (isNaN(id)) { sendError(res, 400, "Invalid company ID"); return; }
      const company = db.getCompanyById(id);
      if (!company) { sendError(res, 404, "Lead not found"); return; }
      const contacts = db.getContactsByCompanyId(id);
      const sources = db.getSourcesByCompanyId(id);
      const emailLogs = db.getAllEmailLogs().filter((l) => l.company_id === id);
      sendJson(res, 200, { success: true, lead: { company, contacts, sources, emailLogs } });
      return;
    }

    // 5. Companies
    if (pathname === "/api/companies" && method === "GET") {
      const status = url.searchParams.get("status") || undefined;
      const companies = db.getAllCompanies({ status: status });
      sendJson(res, 200, { success: true, count: companies.length, companies });
      return;
    }

    // 6. Exclusions
    if (pathname === "/api/exclusions" && method === "GET") {
      const exclusionService = require("./services/exclusionService");
      const exclusions = exclusionService ? db.getAllExclusions() : [];
      const contacted = db.getContactedLeads();
      sendJson(res, 200, { success: true, count: exclusions.length, exclusions: exclusions, contacted: contacted });
      return;
    }

    if (pathname === "/api/exclusions" && method === "POST") {
      const exclusionService = require("./services/exclusionService");
      const body = await parseBody(req);
      if (!body.name) { sendError(res, 400, "Company name is required"); return; }
      await exclusionService.addExclusion(body.name, body.domain || null, body.reason || "Web UI Exclusion");
      sendJson(res, 201, { success: true, message: `Added "${body.name}" to exclusions` });
      return;
    }

    // 7. Settings
    if (pathname === "/api/settings" && method === "GET") {
      const settingsService = require("./services/settingsService");
      const settings = settingsService.getSettings(true);
      sendJson(res, 200, { success: true, settings });
      return;
    }

    if (pathname === "/api/settings" && method === "POST") {
      const settingsService = require("./services/settingsService");
      const body = await parseBody(req);
      const updated = settingsService.updateSettings(body);
      sendJson(res, 200, { success: true, message: "Settings successfully updated", settings: updated });
      return;
    }

    if (pathname === "/api/settings/test-smtp" && method === "POST") {
      const settingsService = require("./services/settingsService");
      const body = await parseBody(req);
      const result = await settingsService.testSmtpConnection(body);
      sendJson(res, result.success ? 200 : 400, result);
      return;
    }

    if (pathname === "/api/settings/test-evolution" && method === "POST") {
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

    // 8. Lead action
    if (pathname === "/api/leads/action" && method === "POST") {
      const body = await parseBody(req);
      const action = body.action;
      const leadId = body.leadId;
      const contactId = body.contactId;
      if (action === "exclude") {
        const exclusionService = require("./services/exclusionService");
        await exclusionService.excludeLead(leadId, "Web UI");
        sendJson(res, 200, { success: true, message: "Lead excluded" });
      } else {
        sendError(res, 400, "Unknown action");
      }
      return;
    }

    // 9. WhatsApp endpoints
    if (pathname === "/api/whatsapp/status" && method === "GET") {
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

    if (pathname === "/api/whatsapp/connect" && method === "POST") {
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

    if (pathname === "/api/whatsapp/disconnect" && method === "POST") {
      const evolutionGoClient = require("./services/evolutionGoClient");
      await evolutionGoClient.logoutInstance();
      sendJson(res, 200, { success: true, message: "WhatsApp session disconnected successfully" });
      return;
    }

    if (pathname === "/api/whatsapp/test-connection" && method === "POST") {
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

    if (pathname === "/api/whatsapp/simulate-connect" && method === "POST") {
      const evolutionGoClient = require("./services/evolutionGoClient");
      const body = await parseBody(req);
      const connected = body.connected !== undefined ? Boolean(body.connected) : true;
      evolutionGoClient.setSimulatedConnected(connected);
      sendJson(res, 200, { success: true, connected: connected, message: connected ? "Simulated WhatsApp connection activated" : "Simulated connection disconnected" });
      return;
    }

    if (pathname.startsWith("/api/whatsapp/preview/") && method === "GET") {
      const companyId = parseInt(pathname.replace("/api/whatsapp/preview/", ""), 10);
      if (isNaN(companyId)) { sendError(res, 400, "Invalid company ID"); return; }
      const company = db.getCompanyById(companyId);
      if (!company) { sendError(res, 404, "Company not found"); return; }
      const contacts = db.getContactsByCompanyId(companyId);
      const bestContact = contacts.length > 0 ? contacts[0] : null;
      const whatsappGenerator = require("./services/whatsappGenerator");
      const preview = whatsappGenerator.generateMessage(company, bestContact);
      sendJson(res, 200, { success: true, preview });
      return;
    }

    if (pathname === "/api/whatsapp/send" && method === "POST") {
      const whatsappWorkflow = require("./workflows/whatsappWorkflow");
      const body = await parseBody(req);
      if (!body.leadId && !body.companyId) { sendError(res, 400, "leadId or companyId is required"); return; }
      const targetId = body.leadId || body.companyId;
      const result = await whatsappWorkflow.sendSingleMessage(targetId, body.phone || null, body.message || null);
      sendJson(res, result.success ? 200 : 400, result);
      return;
    }

    if (pathname === "/api/whatsapp/send-batch" && method === "POST") {
      const whatsappWorkflow = require("./workflows/whatsappWorkflow");
      const body = await parseBody(req);
      if (!body.leadIds || !Array.isArray(body.leadIds)) { sendError(res, 400, "leadIds array is required"); return; }
      const results = await whatsappWorkflow.sendBatch(body.leadIds);
      sendJson(res, 200, { success: true, results });
      return;
    }

    if (pathname === "/api/whatsapp/logs" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "100", 10);
      const logs = db.getWhatsAppLogs(limit);
      sendJson(res, 200, { success: true, count: logs.length, logs });
      return;
    }

    // 10. Downloads
    if (pathname === "/download/csv") {
      const exportService = require("./services/exportService");
      const csvData = await exportService.exportToCsv();
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="shopify_leads.csv"');
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(csvData);
      return;
    }

    if (pathname === "/download/xlsx") {
      const exportService = require("./services/exportService");
      const xlsxData = await exportService.exportToXlsx();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="shopify_leads.xlsx"');
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(xlsxData);
      return;
    }

    // 11. Default HTML Dashboard
    const stats = db.getStatistics();
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Shopify Lead Generation Backend API</title><style>:root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --muted: #94a3b8; --accent: #38bdf8; --border: #334155; } * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; } body { background: var(--bg); color: var(--text); padding: 2rem; } .container { max-width: 900px; margin: 0 auto; } h1 { color: var(--accent); margin-bottom: 0.5rem; } .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0; } .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; } .card-title { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; } .card-val { font-size: 1.6rem; font-weight: bold; margin-top: 0.25rem; color: #fff; } .btn { display: inline-block; padding: 0.5rem 1rem; background: var(--accent); color: #0f172a; text-decoration: none; border-radius: 6px; font-weight: 600; margin-right: 0.5rem; } .btn-sec { background: var(--card); color: var(--text); border: 1px solid var(--border); }</style></head><body><div class="container"><h1>Shopify Partner Lead Generation Backend API</h1><p style="color: var(--muted); margin-bottom: 1.5rem;">Connected to Next.js Frontend. Status: Active</p><div class="grid"><div class="card"><div class="card-title">Discovered</div><div class="card-val">' + stats.discovered + '</div></div><div class="card"><div class="card-title">Qualified Leads</div><div class="card-val" style="color: #34d399;">' + stats.qualified + '</div></div><div class="card"><div class="card-title">Real Contacts</div><div class="card-val">' + stats.contacts + '</div></div><div class="card"><div class="card-title">Ready to Send</div><div class="card-val" style="color: var(--accent);">' + stats.readyToSend + '</div></div><div class="card"><div class="card-title">Emails Sent</div><div class="card-val">' + stats.sent + '</div></div></div><div style="margin-top: 1.5rem;"><a href="/download/csv" class="btn">Download CSV</a><a href="/download/xlsx" class="btn">Download Excel</a><a href="/api/stats" class="btn btn-sec">API Stats</a><a href="/api/leads?limit=10" class="btn btn-sec">API Leads</a></div></div></body></html>';
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;

  } catch (err) {
    // SAFE logger error call (line ~500+) - always works
    safeLogger.error("API Error handling " + method + " " + pathname, err);
    sendError(res, 500, "Internal server error", err.message || "An unexpected error occurred");
  }
};
