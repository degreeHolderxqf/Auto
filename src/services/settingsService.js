const nodemailer = require("nodemailer");
const config = require("../config");
const db = require("../db/database");
const logger = require("./logger");

const MASKED_SECRET = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

function isMaskedSecret(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed === MASKED_SECRET ||
    trimmed === "********" ||
    /^\u2022+$/.test(trimmed) ||
    /^(?:\u00e2\u20ac\u00a2)+$/.test(trimmed)
  );
}

class SettingsService {
  constructor() {
    this.cachedSettings = null;
  }

  /**
   * Returns default system settings initialized from .env / config
   */
  getDefaults() {
    return {
      // 1. Candidate / User Profile
      candidateName: process.env.CANDIDATE_NAME || "Himanshu Soni",
      candidateRole: process.env.CANDIDATE_ROLE || "Shopify Developer",
      candidateExperience: process.env.CANDIDATE_EXPERIENCE || "3 years",
      candidateEmail: process.env.CANDIDATE_EMAIL || config.smtp.user || "himanshusoni7899@gmail.com",
      candidatePhone: process.env.CANDIDATE_PHONE || "",
      candidateSkills: [
        "Shopify & Shopify Plus Theme Development (Liquid, Theme App Extensions, Section Rendering)",
        "Custom App & Full-Stack Development (Node.js, Remix, React, JavaScript)",
        "Shopify Admin & Storefront GraphQL / REST APIs, Webhooks, and Systems Integrations",
        "Checkout Extensibility, Functions, and Headless Commerce setups"
      ],
      resumeFilename: "Himanshu-Soni-Shopify-Developer-Resume.pdf",
      resumePath: config.resumePath,

      // 2. SMTP Server Configuration
      smtpHost: config.smtp.host || "smtp.gmail.com",
      smtpPort: config.smtp.port || 587,
      smtpSecure: config.smtp.secure || false,
      smtpUser: config.smtp.user || "himanshusoni7899@gmail.com",
      smtpPass: config.smtp.pass || "",
      emailFrom: config.smtp.from || "Himanshu Soni <himanshusoni7899@gmail.com>",

      // 3. Lead Discovery & Targeting
      shopifyDirectoryUrl: config.shopifyDirectoryUrl || "https://www.shopify.com/in/partners/directory/locations/india?minPrice=&maxPrice=&sort=AVERAGE_RATING",
      targetCountry: config.targetCountry || "India",
      targetLeads: config.targetLeads || 100,
      minAppRelevanceScore: config.minAppRelevanceScore || 70,

      // 4. Employee Size Verification (Optional)
      minEmployeeCount: config.minEmployeeCount !== undefined ? config.minEmployeeCount : 30,

      // 5. Safety & Sending Controls
      dryRun: config.dryRun !== undefined ? config.dryRun : true,
      sendLimit: config.sendLimit || 50,
      emailDelayMs: config.emailDelayMs || 5000,
      batchSize: config.batchSize || 10,
      batchDelayMs: config.batchDelayMs || 60000,

      // 6. Evolution API WhatsApp Settings
      evolutionApiUrl: config.evolution.apiUrl || "https://evolution-api-latest-h0yy.onrender.com",
      evolutionApiKey: config.evolution.apiKey || "",
      evolutionInstanceName: config.evolution.instanceName || "job-search",
      whatsAppEnabled: config.evolution.enabled !== undefined ? config.evolution.enabled : true,
      whatsAppDryRun: config.evolution.dryRun !== undefined ? config.evolution.dryRun : true,
      whatsAppDelayMs: config.evolution.delayMs || 15000
    };
  }

  /**
   * Retrieves active settings, merging defaults with DB overrides.
   * @param {boolean} maskSecrets - Whether to mask passwords (e.g. for Web UI)
   */
  getSettings(maskSecrets = false) {
    const defaults = this.getDefaults();
    let dbOverrides = {};

    try {
      dbOverrides = db.getAllSettings();
      // Auto-migrate legacy localhost:8080 if user has updated config/env
      if (dbOverrides.evolutionApiUrl === "http://localhost:8080" && defaults.evolutionApiUrl !== "http://localhost:8080") {
        dbOverrides.evolutionApiUrl = defaults.evolutionApiUrl;
        db.saveSetting("evolutionApiUrl", defaults.evolutionApiUrl);
      }
    } catch {
      // Table might not be ready yet
    }

    const merged = {
      ...defaults,
      ...dbOverrides
    };

    // If evolutionApiKey was stored as empty string in DB, fallback to .env/defaults
    if (!merged.evolutionApiKey && defaults.evolutionApiKey) {
      merged.evolutionApiKey = defaults.evolutionApiKey;
    }

    // Ensure candidateSkills is an array
    if (typeof merged.candidateSkills === "string") {
      try {
        merged.candidateSkills = JSON.parse(merged.candidateSkills);
      } catch {
        merged.candidateSkills = merged.candidateSkills.split("\n").map((s) => s.trim()).filter(Boolean);
      }
    }

    // Ensure numeric types
    if (merged.smtpPort) merged.smtpPort = parseInt(merged.smtpPort, 10);
    if (merged.targetLeads) merged.targetLeads = parseInt(merged.targetLeads, 10);
    if (merged.minAppRelevanceScore) merged.minAppRelevanceScore = parseInt(merged.minAppRelevanceScore, 10);
    if (merged.sendLimit) merged.sendLimit = parseInt(merged.sendLimit, 10);
    if (merged.emailDelayMs) merged.emailDelayMs = parseInt(merged.emailDelayMs, 10);
    if (merged.batchSize) merged.batchSize = parseInt(merged.batchSize, 10);
    if (merged.batchDelayMs) merged.batchDelayMs = parseInt(merged.batchDelayMs, 10);

    // Normalize minEmployeeCount (null / 0 / false means disabled)
    if (merged.minEmployeeCount !== null && merged.minEmployeeCount !== undefined) {
      if (String(merged.minEmployeeCount).toLowerCase() === "false" || merged.minEmployeeCount === 0 || merged.minEmployeeCount === "0") {
        merged.minEmployeeCount = null;
      } else {
        merged.minEmployeeCount = parseInt(merged.minEmployeeCount, 10);
      }
    }

    // Ensure WhatsApp numeric fields
    if (merged.whatsAppDelayMs) merged.whatsAppDelayMs = parseInt(merged.whatsAppDelayMs, 10);

    // Sync to in-memory config object
    this.syncConfig(merged);

    if (maskSecrets) {
      return {
        ...merged,
        smtpPass: merged.smtpPass ? MASKED_SECRET : "",
        evolutionApiKey: merged.evolutionApiKey ? MASKED_SECRET : ""
      };
    }

    return merged;
  }

  /**
   * Updates settings and saves them to DB.
   * If smtpPass or evolutionApiKey is masked or empty, preserves existing.
   */
  updateSettings(newSettings = {}) {
    const current = this.getSettings(false);
    const updated = { ...current, ...newSettings };

    // Prevent overwriting actual passwords with masked placeholder
    if (isMaskedSecret(newSettings.smtpPass) || newSettings.smtpPass === undefined || newSettings.smtpPass === "") {
      updated.smtpPass = current.smtpPass;
    }
    if (isMaskedSecret(newSettings.evolutionApiKey) || newSettings.evolutionApiKey === undefined || newSettings.evolutionApiKey === "") {
      updated.evolutionApiKey = current.evolutionApiKey;
    }

    // Format candidateSkills array
    if (Array.isArray(updated.candidateSkills)) {
      updated.candidateSkills = updated.candidateSkills.filter((s) => typeof s === "string" && s.trim().length > 0);
    } else if (typeof updated.candidateSkills === "string") {
      updated.candidateSkills = updated.candidateSkills.split("\n").map((s) => s.trim()).filter(Boolean);
    }

    // Format numeric and boolean fields
    if (updated.smtpPort) updated.smtpPort = parseInt(updated.smtpPort, 10);
    if (updated.smtpSecure !== undefined) updated.smtpSecure = Boolean(updated.smtpSecure);
    if (updated.dryRun !== undefined) updated.dryRun = Boolean(updated.dryRun);
    if (updated.targetLeads) updated.targetLeads = parseInt(updated.targetLeads, 10);
    if (updated.minAppRelevanceScore) updated.minAppRelevanceScore = parseInt(updated.minAppRelevanceScore, 10);

    if (updated.whatsAppEnabled !== undefined) updated.whatsAppEnabled = Boolean(updated.whatsAppEnabled);
    if (updated.whatsAppDryRun !== undefined) updated.whatsAppDryRun = Boolean(updated.whatsAppDryRun);
    if (updated.whatsAppDelayMs) updated.whatsAppDelayMs = parseInt(updated.whatsAppDelayMs, 10);

    if (updated.minEmployeeCount === 0 || String(updated.minEmployeeCount).toLowerCase() === "false" || updated.minEmployeeCount === "" || updated.minEmployeeCount === null) {
      updated.minEmployeeCount = null;
    } else if (updated.minEmployeeCount) {
      updated.minEmployeeCount = parseInt(updated.minEmployeeCount, 10);
    }

    // Save to DB
    db.saveAllSettings(updated);

    // Sync in-memory config
    this.syncConfig(updated);

    logger.success("Dynamic settings successfully updated.");
    return this.getSettings(true);
  }

  /**
   * Updates global in-memory config dynamically
   */
  syncConfig(settings) {
    config.smtp.host = settings.smtpHost;
    config.smtp.port = settings.smtpPort;
    config.smtp.secure = settings.smtpSecure;
    config.smtp.user = settings.smtpUser;
    config.smtp.pass = settings.smtpPass;
    config.smtp.from = settings.emailFrom;

    config.shopifyDirectoryUrl = settings.shopifyDirectoryUrl;
    config.targetCountry = settings.targetCountry;
    config.targetLeads = settings.targetLeads;
    config.minAppRelevanceScore = settings.minAppRelevanceScore;
    config.minEmployeeCount = settings.minEmployeeCount;

    config.dryRun = settings.dryRun;
    config.sendLimit = settings.sendLimit;
    config.emailDelayMs = settings.emailDelayMs;
    config.batchSize = settings.batchSize;
    config.batchDelayMs = settings.batchDelayMs;

    if (!config.evolution) config.evolution = {};
    config.evolution.apiUrl = (settings.evolutionApiUrl || "https://evolution-api-latest-h0yy.onrender.com").replace(/\/+$/, "");
    config.evolution.apiKey = settings.evolutionApiKey || "";
    config.evolution.instanceName = settings.evolutionInstanceName || "job-search";
    config.evolution.enabled = settings.whatsAppEnabled !== undefined ? settings.whatsAppEnabled : true;
    config.evolution.dryRun = settings.whatsAppDryRun !== undefined ? settings.whatsAppDryRun : true;
    config.evolution.delayMs = settings.whatsAppDelayMs || 15000;

    if (settings.resumePath) {
      config.resumePath = settings.resumePath;
    }
  }

  /**
   * Categorize SMTP errors so the UI can show the right message.
   * Returns: { code, message, stage }
   * - NETWORK_TIMEOUT: TCP / DNS / firewall block (NOT an auth failure)
   * - SMTP_AUTH_FAILED: EAUTH / 535
   * - SMTP_REJECTED: 5xx
   * - SMTP_READY: 250
   */
  categorizeSmtpError(err) {
    const code = err && err.code ? String(err.code).toUpperCase() : "";
    const msg = (err && err.message) ? String(err.message) : "";
    const responseCode = err && err.responseCode ? parseInt(err.responseCode, 10) : 0;
    const lower = msg.toLowerCase();

    // Network / connectivity / DNS failures (NOT auth)
    const networkCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EDNS", "ENETUNREACH", "EHOSTUNREACH", "EHOSTNOTFOUND", "EPIPE", "ESOCKETTIMEDOUT", "GREETINGTIMEOUT"];
    const networkHints = ["timeout", "timed out", "connection timeout", "enotfound", "getaddrinfo", "econnrefused", "econnreset", "ehostunreach", "enetunreach", "network is unreachable", "connect timeout"];
    if (networkCodes.includes(code) || networkHints.some((h) => lower.includes(h))) {
      return {
        code: "NETWORK_TIMEOUT",
        stage: "connection",
        message: `SMTP connection to ${err && err.host ? err.host : "smtp server"}:${err && err.port ? err.port : 587} failed (${code || "TIMEOUT"}). The server may be blocking outbound SMTP traffic. Try port 465 (SSL) or check network/firewall.`
      };
    }

    // Authentication failure
    if (code === "EAUTH" || responseCode === 535 || (lower.includes("auth") && lower.includes("fail")) || lower.includes("invalid credentials") || lower.includes("username and password not accepted")) {
      return {
        code: "SMTP_AUTH_FAILED",
        stage: "auth",
        message: `SMTP authentication failed for user. Check Gmail App Password and ensure 2-Step Verification is enabled.`
      };
    }

    // TLS / SSL
    if (code === "ETLS" || code === "ESSL" || lower.includes("tls") || lower.includes("ssl") || lower.includes("unsupported protocol") || lower.includes("handshake")) {
      return {
        code: "TLS_ERROR",
        stage: "tls",
        message: `SMTP TLS/SSL handshake failed. Check port (587=STARTTLS, 465=SSL) and secure flag.`
      };
    }

    // SMTP 4xx rejection
    if (responseCode >= 400 && responseCode < 500) {
      return {
        code: "SMTP_REJECTED",
        stage: "smtp",
        message: `SMTP server rejected the request (${responseCode}). ${msg || ""}`.trim()
      };
    }

    // SMTP 5xx server error
    if (responseCode >= 500) {
      return {
        code: "SMTP_SERVER_ERROR",
        stage: "smtp",
        message: `SMTP server error (${responseCode}). ${msg || ""}`.trim()
      };
    }

    return {
      code: code || "SMTP_ERROR",
      stage: "unknown",
      message: msg || "Unknown SMTP failure"
    };
  }

  /**
   * Tests SMTP Connection live with nodemailer.verify()
   * Must match the production transporter in emailSender.js exactly so
   * "SMTP test" reflects what the actual send path will do.
   */
  async testSmtpConnection(customSmtp = {}) {
    const current = this.getSettings(false);
    const host = customSmtp.smtpHost || current.smtpHost;
    const port = parseInt(customSmtp.smtpPort || current.smtpPort, 10);
    const secure = customSmtp.smtpSecure !== undefined ? Boolean(customSmtp.smtpSecure) : current.smtpSecure;
    const user = customSmtp.smtpUser || current.smtpUser;
    let pass = customSmtp.smtpPass;

    if (!pass || isMaskedSecret(pass)) {
      pass = current.smtpPass;
    }

    if (!host || !user || !pass) {
      return {
        success: false,
        error: "Missing required SMTP credentials (Host, Username, or App Password).",
        code: "MISSING_CREDENTIALS",
        stage: "config"
      };
    }

    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
          user,
          pass
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
        tls: {
          rejectUnauthorized: false
        }
      });

      await transporter.verify();

      return {
        success: true,
        message: `Successfully connected and authenticated with ${host}:${port} as ${user}`,
        code: "SMTP_READY",
        stage: "ok"
      };
    } catch (err) {
      const category = this.categorizeSmtpError(err);
      logger.warn(`[SMTP Test] ${category.code} (${category.stage}) host=${host} port=${port} err=${category.message}`);
      return {
        success: false,
        error: category.message,
        code: category.code,
        stage: category.stage,
        host,
        port,
        upstreamCode: err && err.code ? err.code : null,
        upstreamResponse: err && err.responseCode ? err.responseCode : null
      };
    }
  }

  /**
   * Tests Evolution API Connection live
   */
  async testEvolutionConnection(customEvolution = {}) {
    const current = this.getSettings(false);
    const apiUrl = (customEvolution.evolutionApiUrl || current.evolutionApiUrl || "https://evolution-api-latest-h0yy.onrender.com").replace(/\/+$/, "");
    let apiKey = customEvolution.evolutionApiKey !== undefined ? customEvolution.evolutionApiKey : current.evolutionApiKey;
    if (isMaskedSecret(apiKey)) {
      apiKey = current.evolutionApiKey;
    }
    const instanceName = customEvolution.evolutionInstanceName || current.evolutionInstanceName || "job-search";

    const evolutionClient = require("./evolutionGoClient");
    return await evolutionClient.testConnection(apiUrl, apiKey, instanceName);
  }
}

module.exports = new SettingsService();
