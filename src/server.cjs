/**
 * Vercel Serverless Function Entry Point
 *
 * Architecture:
 * - This is a serverless wrapper for the lead generation API
 * - Vercel serverless functions have an ephemeral filesystem at /tmp
 * - We use /tmp for the SQLite database so it survives between cold starts
 * - All operations are wrapped in try/catch to maximize availability
 * - When the database is unavailable, the API falls back to environment variables
 */
"use strict";

// Load environment variables from process.env (Vercel provides them directly)
// The .env file is loaded only for local development
if (!process.env.VERCEL) {
  try {
    require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
  } catch (e) {
    /* no dotenv, ok */
  }
}

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// On Vercel, the only writable directory is /tmp. Route the SQLite database there.
const IS_VERCEL = process.env.VERCEL === "1";
const DATA_DIR = IS_VERCEL ? "/tmp/data" : path.join(__dirname, "..", "data");
const LOGS_DIR = IS_VERCEL ? "/tmp/logs" : path.join(__dirname, "..", "logs");
const OUTPUT_DIR = IS_VERCEL ? "/tmp/output" : path.join(__dirname, "..", "output");

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
} catch (e) {
  console.error("[SERVERLESS] Failed to create directories:", e.message);
}

// Force the database path to /tmp/data on Vercel BEFORE loading config
process.env.DATABASE_PATH = process.env.DATABASE_PATH || (IS_VERCEL ? "/tmp/data/leads.sqlite" : "data/leads.sqlite");
process.env.LOGS_DIR = process.env.LOGS_DIR || (IS_VERCEL ? "/tmp/logs" : "logs");
process.env.OUTPUT_DIR = process.env.OUTPUT_DIR || (IS_VERCEL ? "/tmp/output" : "output");

// Load core modules with safe fallbacks
let db = null;
let logger = null;
let config = null;
let loadError = null;
try {
  db = require("./db/database");
  logger = require("./services/logger");
  config = require("./config");
} catch (err) {
  loadError = err;
  console.error("[SERVERLESS] Failed to load modules:", err.message, err.stack);
}

// Safe logger wrapper that never throws
const safeLogger = {
  info: (...args) => { try { logger && logger.info.apply(logger, args); } catch (e) { console.log("[INFO]", ...args); } },
  success: (...args) => { try { logger && logger.success.apply(logger, args); } catch (e) { console.log("[OK]", ...args); } },
  warn: (...args) => { try { logger && logger.warn.apply(logger, args); } catch (e) { console.warn("[WARN]", ...args); } },
  error: (...args) => { try { logger && logger.error.apply(logger, args); } catch (e) { console.error("[ERROR]", ...args); } },
  debug: (...args) => { try { logger && logger.debug.apply(logger, args); } catch (e) { /* silent */ } },
  progress: (...args) => { try { logger && logger.progress.apply(logger, args); } catch (e) { console.log(...args); } },
  section: (...args) => { try { logger && logger.section.apply(logger, args); } catch (e) { console.log(args); } },
  email: (...args) => { try { logger && logger.logger.email && logger.email.apply(logger, args); } catch (e) { console.log(...args); } }
};

// In-memory settings cache as fallback for when DB is unavailable
let memorySettings = null;

function getEnvSettings() {
  if (memorySettings) return memorySettings;
  memorySettings = {
    candidateName: process.env.CANDIDATE_NAME || "Himanshu Soni",
    candidateRole: process.env.CANDIDATE_ROLE || "Shopify Developer",
    candidateExperience: process.env.CANDIDATE_EXPERIENCE || "3 years",
    candidateEmail: process.env.CANDIDATE_EMAIL || process.env.SMTP_USER || "himanshusoni7899@gmail.com",
    candidatePhone: process.env.CANDIDATE_PHONE || "",
    candidateSkills: [
      "Shopify & Shopify Plus Theme Development (Liquid, Theme App Extensions, Section Rendering)",
      "Custom App & Full-Stack Development (Node.js, Remix, React, JavaScript)",
      "Shopify Admin & Storefront GraphQL / REST APIs, Webhooks, and Systems Integrations",
      "Checkout Extensibility, Functions, and Headless Commerce setups"
    ],
    resumeFilename: "Himanshu-Soni-Shopify-Developer-Resume.pdf",
    resumePath: process.env.RESUME_PATH || "26_Himanshu-Soni-Shopify.pdf",

    smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
    smtpPort: parseInt(process.env.SMTP_PORT || "587", 10),
    smtpSecure: process.env.SMTP_SECURE === "true",
    smtpUser: process.env.SMTP_USER || "himanshusoni7899@gmail.com",
    smtpPass: process.env.SMTP_PASS || "",
    emailFrom: process.env.EMAIL_FROM || "Himanshu Soni <himanshusoni7899@gmail.com>",

    shopifyDirectoryUrl: process.env.SHOPIFY_PARTNER_DIRECTORY_URL || "https://www.shopify.com/in/partners/directory/locations/india?minPrice=&maxPrice=&sort=DEFAULT",
    targetCountry: process.env.TARGET_COUNTRY || "India",
    targetLeads: parseInt(process.env.TARGET_LEADS || "100", 10),
    minAppRelevanceScore: parseInt(process.env.MIN_APP_RELEVANCE_SCORE || "70", 10),
    minEmployeeCount: parseInt(process.env.MIN_EMPLOYEE_COUNT || "30", 10),

    dryRun: process.env.DRY_RUN !== "false" && process.env.DRY_RUN !== "0",
    sendLimit: parseInt(process.env.SEND_LIMIT || "50", 10),
    emailDelayMs: parseInt(process.env.EMAIL_DELAY_MS || "5000", 10),
    batchSize: parseInt(process.env.BATCH_SIZE || "50", 10),
    batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || "60000", 10),

    evolutionApiUrl: (process.env.EVOLUTION_API_URL || "https://evolution-api-latest-h0yy.onrender.com").replace(/\/+$/, ""),
    evolutionApiKey: process.env.EVOLUTION_API_KEY || "",
    evolutionInstanceName: process.env.EVOLUTION_INSTANCE_NAME || "job-search",
    whatsAppEnabled: process.env.WHATSAPP_ENABLED !== "false" && process.env.WHATSAPP_ENABLED !== "0",
    whatsAppDryRun: process.env.WHATSAPP_DRY_RUN !== "false" && process.env.WHATSAPP_DRY_RUN !== "0",
    whatsAppDelayMs: parseInt(process.env.WHATSAPP_DELAY_MS || "15000", 10)
  };
  return memorySettings;
}

function getSettings() {
  try {
    if (db) {
      const settingsService = require("./services/settingsService");
      return settingsService.getSettings(false);
    }
  } catch (e) {
    safeLogger.warn("[SERVERLESS] Failed to get settings from DB, using env fallback:", e.message);
  }
  return getEnvSettings();
}

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

function categorizeSmtpError(err) {
  const code = err && err.code ? String(err.code).toUpperCase() : "";
  const msg = (err && err.message) ? String(err.message) : "";
  const responseCode = err && err.responseCode ? parseInt(err.responseCode, 10) : 0;
  const lower = msg.toLowerCase();

  const networkCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EDNS", "ENETUNREACH", "EHOSTUNREACH", "EHOSTNOTFOUND", "EPIPE", "ESOCKETTIMEDOUT", "GREETINGTIMEOUT"];
  const networkHints = ["timeout", "timed out", "connection timeout", "enotfound", "getaddrinfo", "econnrefused", "econnreset", "ehostunreach", "enetunreach", "network is unreachable", "connect timeout"];
  if (networkCodes.includes(code) || networkHints.some((h) => lower.includes(h))) {
    return { code: "NETWORK_TIMEOUT", stage: "connection", message: `SMTP ${err && err.host ? err.host : "server"}:${err && err.port ? err.port : 587} failed (${code || "TIMEOUT"}). The platform may be blocking outbound SMTP traffic. Try port 465 (SSL) or check network.` };
  }
  if (code === "EAUTH" || responseCode === 535 || (lower.includes("auth") && lower.includes("fail")) || lower.includes("invalid credentials") || lower.includes("username and password not accepted")) {
    return { code: "SMTP_AUTH_FAILED", stage: "auth", message: `SMTP authentication failed. Check Gmail App Password and ensure 2-Step Verification is enabled.` };
  }
  if (code === "ETLS" || code === "ESSL" || lower.includes("tls") || lower.includes("ssl") || lower.includes("unsupported protocol") || lower.includes("handshake")) {
    return { code: "TLS_ERROR", stage: "tls", message: `SMTP TLS/SSL handshake failed. Check port (587=STARTTLS, 465=SSL) and secure flag.` };
  }
  if (responseCode >= 400 && responseCode < 500) {
    return { code: "SMTP_REJECTED", stage: "smtp", message: `SMTP server rejected the request (${responseCode}). ${msg || ""}`.trim() };
  }
  if (responseCode >= 500) {
    return { code: "SMTP_SERVER_ERROR", stage: "smtp", message: `SMTP server error (${responseCode}). ${msg || ""}`.trim() };
  }
  return { code: code || "SMTP_ERROR", stage: "unknown", message: msg || "Unknown SMTP failure" };
}

async function testSmtpConnectionDirect(customSmtp = {}) {
  const current = getSettings();
  const host = customSmtp.smtpHost || current.smtpHost;
  const port = parseInt(customSmtp.smtpPort || current.smtpPort, 10);
  const secure = customSmtp.smtpSecure !== undefined ? Boolean(customSmtp.smtpSecure) : current.smtpSecure;
  const user = customSmtp.smtpUser || current.smtpUser;
  let pass = customSmtp.smtpPass;

  // Mask detection - accept "••••••••" or any sequence of bullet chars
  const MASK_RE = /^[•\*]+$/;
  if (!pass || MASK_RE.test(String(pass).trim())) {
    pass = current.smtpPass;
  }

  if (!host || !user || !pass) {
    return { success: false, error: "Missing required SMTP credentials (Host, Username, or App Password).", code: "MISSING_CREDENTIALS", stage: "config" };
  }

  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host, port, secure,
      auth: { user, pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      tls: { rejectUnauthorized: false }
    });
    await transporter.verify();
    return { success: true, message: `Successfully connected and authenticated with ${host}:${port} as ${user}`, code: "SMTP_READY", stage: "ok" };
  } catch (err) {
    const category = categorizeSmtpError(err);
    return { success: false, error: category.message, code: category.code, stage: category.stage, host, port, upstreamCode: err && err.code ? err.code : null, upstreamResponse: err && err.responseCode ? err.responseCode : null };
  }
}

function getStatisticsFallback() {
  // Best-effort: use DB if available, else return zeros
  try {
    if (db && typeof db.getStatistics === "function") {
      return db.getStatistics();
    }
  } catch (e) {
    safeLogger.warn("[SERVERLESS] getStatistics failed:", e.message);
  }
  return { discovered: 0, qualified: 0, contacts: 0, readyToSend: 0, sent: 0, failed: 0 };
}

function getCompaniesFallback() {
  try {
    if (db && typeof db.getAllCompanies === "function") {
      return db.getAllCompanies();
    }
  } catch (e) {
    safeLogger.warn("[SERVERLESS] getAllCompanies failed:", e.message);
  }
  return [];
}

function getLeadsFallback(limit) {
  try {
    if (db && typeof db.getFinalQualifiedLeads === "function") {
      return db.getFinalQualifiedLeads(limit);
    }
  } catch (e) {
    safeLogger.warn("[SERVERLESS] getFinalQualifiedLeads failed:", e.message);
  }
  return [];
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
    // 1. Health (always works)
    if (pathname === "/health" || pathname === "/api/health") {
      const settings = getSettings();
      sendJson(res, 200, {
        status: "healthy",
        mode: (config && config.dryRun) || settings.dryRun ? "DRY_RUN" : "LIVE",
        minEmployeeCount: (config && config.minEmployeeCount) || settings.minEmployeeCount || 0,
        environment: IS_VERCEL ? "vercel" : "local",
        database: db ? "available" : "unavailable",
        timestamp: new Date().toISOString()
      });
      return;
    }

    // 2. Stats (uses DB with fallback)
    if (pathname === "/api/stats") {
      const stats = getStatisticsFallback();
      sendJson(res, 200, { success: true, stats });
      return;
    }

    // 3. Leads list (uses DB with fallback)
    if (pathname === "/api/leads" && method === "GET") {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam && limitParam !== "all" ? parseInt(limitParam, 10) : null;
      const statusFilter = url.searchParams.get("status");
      const minScore = parseInt(url.searchParams.get("minScore") || "0", 10);
      const searchQuery = (url.searchParams.get("search") || "").trim().toLowerCase();

      let leads = getLeadsFallback(limit);
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
      if (!db) {
        sendError(res, 503, "Database unavailable in serverless mode", "DB module not loaded");
        return;
      }
      const id = parseInt(pathname.replace("/api/leads/", ""), 10);
      if (isNaN(id)) { sendError(res, 400, "Invalid company ID"); return; }
      try {
        const company = db.getCompanyById(id);
        if (!company) { sendError(res, 404, "Lead not found"); return; }
        const contacts = db.getContactsByCompanyId(id);
        const sources = db.getSourcesByCompanyId(id);
        const emailLogs = db.getAllEmailLogs().filter((l) => l.company_id === id);
        sendJson(res, 200, { success: true, lead: { company, contacts, sources, emailLogs } });
      } catch (e) {
        sendError(res, 500, "Database error", e.message);
      }
      return;
    }

    // 5. Companies
    if (pathname === "/api/companies" && method === "GET") {
      const status = url.searchParams.get("status") || undefined;
      let companies = getCompaniesFallback();
      if (status) companies = companies.filter((c) => c.status === status);
      sendJson(res, 200, { success: true, count: companies.length, companies });
      return;
    }

    // 6. Exclusions
    if (pathname === "/api/exclusions" && method === "GET") {
      let exclusions = [];
      let contacted = [];
      try {
        if (db) {
          exclusions = db.getAllExclusions();
          contacted = db.getContactedLeads();
        }
      } catch (e) { /* ignore */ }
      sendJson(res, 200, { success: true, count: exclusions.length, exclusions, contacted });
      return;
    }

    if (pathname === "/api/exclusions" && method === "POST") {
      if (!db) {
        sendError(res, 503, "Database unavailable in serverless mode", "DB module not loaded");
        return;
      }
      try {
        const exclusionService = require("./services/exclusionService");
        const body = await parseBody(req);
        if (!body.name) { sendError(res, 400, "Company name is required"); return; }
        await exclusionService.addExclusion(body.name, body.domain || null, body.reason || "Web UI Exclusion");
        sendJson(res, 201, { success: true, message: `Added "${body.name}" to exclusions` });
      } catch (e) {
        sendError(res, 500, "Failed to add exclusion", e.message);
      }
      return;
    }

    // 7. Settings
    if (pathname === "/api/settings" && method === "GET") {
      // Use env-fallback settings to ensure it always works on Vercel
      const settings = getSettings();
      const MASK = "••••••••";
      sendJson(res, 200, {
        success: true,
        settings: {
          ...settings,
          smtpPass: settings.smtpPass ? MASK : "",
          evolutionApiKey: settings.evolutionApiKey ? MASK : "",
          // Mark resume path as Vercel-specific to avoid Linux/Win confusion
          resumePath: settings.resumePath && settings.resumePath.includes("C:") ? "26_Himanshu-Soni-Shopify.pdf" : settings.resumePath
        }
      });
      return;
    }

    if (pathname === "/api/settings" && method === "POST") {
      if (!db) {
        sendError(res, 503, "Settings cannot be persisted in serverless mode", "DB module not loaded - using env-only settings");
        return;
      }
      try {
        const settingsService = require("./services/settingsService");
        const body = await parseBody(req);
        const updated = settingsService.updateSettings(body);
        sendJson(res, 200, { success: true, message: "Settings successfully updated", settings: updated });
      } catch (e) {
        sendError(res, 500, "Failed to update settings", e.message);
      }
      return;
    }

    if (pathname === "/api/settings/test-smtp" && method === "POST") {
      // SMTP test works in serverless - it doesn't need the DB
      const body = await parseBody(req);
      const result = await testSmtpConnectionDirect(body);
      sendJson(res, result.success ? 200 : 400, result);
      return;
    }

    if (pathname === "/api/settings/test-evolution" && method === "POST") {
      try {
        const body = await parseBody(req);
        const settings = getSettings();
        const customEvolution = {
          evolutionApiUrl: body.evolutionApiUrl || settings.evolutionApiUrl,
          evolutionApiKey: body.evolutionApiKey && !/^[•\*]+$/.test(String(body.evolutionApiKey).trim()) ? body.evolutionApiKey : settings.evolutionApiKey,
          evolutionInstanceName: body.evolutionInstanceName || settings.evolutionInstanceName
        };
        const evolutionGoClient = require("./services/evolutionGoClient");
        const result = await evolutionGoClient.testConnection(customEvolution.evolutionApiUrl, customEvolution.evolutionApiKey, customEvolution.evolutionInstanceName);
        if (result.success) {
          sendJson(res, 200, result);
        } else {
          sendEvolutionError(res, result);
        }
      } catch (e) {
        sendError(res, 500, "Evolution test failed", e.message);
      }
      return;
    }

    // 8. Lead action
    if (pathname === "/api/leads/action" && method === "POST") {
      if (!db) {
        sendError(res, 503, "Database unavailable in serverless mode", "DB module not loaded");
        return;
      }
      try {
        const body = await parseBody(req);
        const action = body.action;
        const leadId = body.leadId;
        if (action === "exclude") {
          const exclusionService = require("./services/exclusionService");
          await exclusionService.excludeLead(leadId, "Web UI");
          sendJson(res, 200, { success: true, message: "Lead excluded" });
        } else {
          sendError(res, 400, "Unknown action");
        }
      } catch (e) {
        sendError(res, 500, "Action failed", e.message);
      }
      return;
    }

    // 9. WhatsApp endpoints
    if (pathname === "/api/whatsapp/status" && method === "GET") {
      try {
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
      } catch (e) {
        sendError(res, 500, "WhatsApp status check failed", e.message);
      }
      return;
    }

    if (pathname === "/api/whatsapp/connect" && method === "POST") {
      try {
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
      } catch (e) {
        sendError(res, 500, "WhatsApp connect failed", e.message);
      }
      return;
    }

    if (pathname === "/api/whatsapp/disconnect" && method === "POST") {
      try {
        const evolutionGoClient = require("./services/evolutionGoClient");
        await evolutionGoClient.logoutInstance();
        sendJson(res, 200, { success: true, message: "WhatsApp session disconnected successfully" });
      } catch (e) {
        sendError(res, 500, "WhatsApp disconnect failed", e.message);
      }
      return;
    }

    if (pathname === "/api/whatsapp/test-connection" && method === "POST") {
      try {
        const body = await parseBody(req);
        const settings = getSettings();
        const evolutionGoClient = require("./services/evolutionGoClient");
        const apiUrl = (body.evolutionApiUrl || settings.evolutionApiUrl).replace(/\/+$/, "");
        const apiKey = body.evolutionApiKey && !/^[•\*]+$/.test(String(body.evolutionApiKey).trim()) ? body.evolutionApiKey : settings.evolutionApiKey;
        const instanceName = body.evolutionInstanceName || settings.evolutionInstanceName;
        const result = await evolutionGoClient.testConnection(apiUrl, apiKey, instanceName);
        if (result.success) {
          sendJson(res, 200, result);
        } else {
          sendEvolutionError(res, result);
        }
      } catch (e) {
        sendError(res, 500, "Evolution test failed", e.message);
      }
      return;
    }

    if (pathname === "/api/whatsapp/simulate-connect" && method === "POST") {
      try {
        const evolutionGoClient = require("./services/evolutionGoClient");
        const body = await parseBody(req);
        const connected = body.connected !== undefined ? Boolean(body.connected) : true;
        evolutionGoClient.setSimulatedConnected(connected);
        sendJson(res, 200, { success: true, connected: connected, message: connected ? "Simulated WhatsApp connection activated" : "Simulated connection disconnected" });
      } catch (e) {
        sendError(res, 500, "Simulate connect failed", e.message);
      }
      return;
    }

    if (pathname.startsWith("/api/whatsapp/preview/") && method === "GET") {
      if (!db) {
        sendError(res, 503, "Database unavailable in serverless mode", "DB module not loaded");
        return;
      }
      try {
        const companyId = parseInt(pathname.replace("/api/whatsapp/preview/", ""), 10);
        if (isNaN(companyId)) { sendError(res, 400, "Invalid company ID"); return; }
        const company = db.getCompanyById(companyId);
        if (!company) { sendError(res, 404, "Company not found"); return; }
        const contacts = db.getContactsByCompanyId(companyId);
        const bestContact = contacts.length > 0 ? contacts[0] : null;
        const whatsappGenerator = require("./services/whatsappGenerator");
        const preview = whatsappGenerator.generateMessage(company, bestContact);
        sendJson(res, 200, { success: true, preview });
      } catch (e) {
        sendError(res, 500, "Preview failed", e.message);
      }
      return;
    }

    if (pathname === "/api/whatsapp/send" && method === "POST") {
      if (!db) {
        sendError(res, 503, "Database unavailable in serverless mode", "DB module not loaded");
        return;
      }
      try {
        const whatsappWorkflow = require("./workflows/whatsappWorkflow");
        const body = await parseBody(req);
        if (!body.leadId && !body.companyId) { sendError(res, 400, "leadId or companyId is required"); return; }
        const targetId = body.leadId || body.companyId;
        const result = await whatsappWorkflow.sendSingleMessage(targetId, body.phone || null, body.message || null);
        sendJson(res, result.success ? 200 : 400, result);
      } catch (e) {
        sendError(res, 500, "WhatsApp send failed", e.message);
      }
      return;
    }

    if (pathname === "/api/whatsapp/send-batch" && method === "POST") {
      if (!db) {
        sendError(res, 503, "Database unavailable in serverless mode", "DB module not loaded");
        return;
      }
      try {
        const whatsappWorkflow = require("./workflows/whatsappWorkflow");
        const body = await parseBody(req);
        if (!body.leadIds || !Array.isArray(body.leadIds)) { sendError(res, 400, "leadIds array is required"); return; }
        const results = await whatsappWorkflow.sendBatch(body.leadIds);
        sendJson(res, 200, { success: true, results });
      } catch (e) {
        sendError(res, 500, "Batch send failed", e.message);
      }
      return;
    }

    if (pathname === "/api/whatsapp/logs" && method === "GET") {
      if (!db) {
        sendError(res, 503, "Database unavailable in serverless mode", "DB module not loaded");
        return;
      }
      try {
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const logs = db.getWhatsAppLogs(limit);
        sendJson(res, 200, { success: true, count: logs.length, logs });
      } catch (e) {
        sendError(res, 500, "Logs fetch failed", e.message);
      }
      return;
    }

    // 10. Default HTML Dashboard (simplified for serverless)
    if (pathname === "/" || pathname === "/index.html") {
      const stats = getStatisticsFallback();
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Shopify Lead Generation API (Vercel Serverless)</title><style>:root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --muted: #94a3b8; --accent: #38bdf8; --border: #334155; } * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; } body { background: var(--bg); color: var(--text); padding: 2rem; } .container { max-width: 900px; margin: 0 auto; } h1 { color: var(--accent); margin-bottom: 0.5rem; } .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0; } .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; } .card-title { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; } .card-val { font-size: 1.6rem; font-weight: bold; margin-top: 0.25rem; color: #fff; } .btn { display: inline-block; padding: 0.5rem 1rem; background: var(--accent); color: #0f172a; text-decoration: none; border-radius: 6px; font-weight: 600; margin-right: 0.5rem; } .btn-sec { background: var(--card); color: var(--text); border: 1px solid var(--border); } .note { background: var(--card); border-left: 3px solid var(--accent); padding: 0.75rem 1rem; margin: 1rem 0; font-size: 0.85rem; color: var(--muted); }</style></head><body><div class="container"><h1>Shopify Lead Generation API</h1><p style="color: var(--muted);">Vercel Serverless Mode. Database: ${db ? "available" : "unavailable (env-only mode)"}</p><div class="note">Note: This is a serverless Vercel deployment. For full features (lead discovery, batch email, persistent data), use the Render backend at <a href="https://auto-1-66jv.onrender.com" style="color: var(--accent);">auto-1-66jv.onrender.com</a>.</div><div class="grid"><div class="card"><div class="card-title">Discovered</div><div class="card-val">${stats.discovered}</div></div><div class="card"><div class="card-title">Qualified</div><div class="card-val" style="color: #34d399;">${stats.qualified}</div></div><div class="card"><div class="card-title">Contacts</div><div class="card-val">${stats.contacts}</div></div><div class="card"><div class="card-title">Sent</div><div class="card-val">${stats.sent}</div></div></div><div style="margin-top: 1.5rem;"><a href="/api/stats" class="btn btn-sec">API Stats</a><a href="/api/leads?limit=10" class="btn btn-sec">API Leads</a><a href="/api/settings" class="btn btn-sec">API Settings</a><a href="/health" class="btn btn-sec">Health</a></div></div></body></html>`);
      return;
    }

    // Default 404
    sendError(res, 404, "Not Found", `Path ${method} ${pathname} not handled`);

  } catch (err) {
    safeLogger.error("API Error handling " + method + " " + pathname, err);
    sendError(res, 500, "Internal server error", err.message || "An unexpected error occurred");
  }
};
